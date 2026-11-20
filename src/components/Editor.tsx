import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  AlertTriangle,
  Check,
  Code2,
  Columns2,
  ExternalLink,
  Eye,
  FileText,
  LoaderCircle,
  RotateCcw,
  WrapText,
} from "lucide-react";
import { api } from "../api";
import { useAppDialog } from "./AppDialog";
import type { FileDocument, FileSettings } from "../types";
import { fileSettings } from "../fileSettings";
import { useFileZoom } from "../useFileZoom";
import FileZoomControls from "./FileZoomControls";
import { readPreference, writePreference } from "../useWorkspaceSession";
import { useStoredScroll } from "../useStoredScroll";
import MarkdownCodeBlock from "./MarkdownCodeBlock";
import "./workspace.css";
const CodeSurface = lazy(() => import("./CodeSurface"));

interface Props {
  projectId: string;
  path: string;
  onError: (message: string) => void;
  refreshVersion?: number;
  preferences?: FileSettings;
}
interface Draft {
  content: string;
  revision: string;
  savedAt: number;
}
interface Session {
  key: string;
  projectId: string;
  path: string;
  content: string;
  savedContent: string;
  revision: string;
  error: string;
  saving: boolean;
  disposed: boolean;
}
const pendingWrites = new Map<string, Promise<void>>();
const storageKey = (key: string) => `foldory:draft:${key}`;
function readDraft(key: string): Draft | null {
  try {
    const value = localStorage.getItem(storageKey(key));
    return value ? (JSON.parse(value) as Draft) : null;
  } catch {
    return null;
  }
}
function storeDraft(session: Session): boolean {
  try {
    if (session.content === session.savedContent)
      localStorage.removeItem(storageKey(session.key));
    else
      localStorage.setItem(
        storageKey(session.key),
        JSON.stringify({
          content: session.content,
          revision: session.revision,
          savedAt: Date.now(),
        } satisfies Draft),
      );
    return true;
  } catch {
    return false;
  }
}
export function Markdown({
  content,
  allowImages = true,
  allowLinks = true,
}: {
  content: string;
  allowImages?: boolean;
  allowLinks?: boolean;
}) {
  const [linkError, setLinkError] = useState("");
  return (
    <div className="markdown">
      {linkError && (
        <p role="alert" className="inline-error">
          {linkError}
        </p>
      )}
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        disallowedElements={allowImages ? undefined : ["img"]}
        components={{
          pre: ({ children }) => (
            <MarkdownCodeBlock>{children}</MarkdownCodeBlock>
          ),
          a: ({ children, href }) =>
            !allowLinks ? (
              <span>{children}</span>
            ) : (
              <a
                href={href}
                target="_blank"
                rel="noreferrer"
                onClick={(event) => {
                  event.preventDefault();
                  if (!href || !/^https?:\/\//i.test(href)) {
                    setLinkError(
                      "This link is not a web URL. Open local files through the Files view.",
                    );
                    return;
                  }
                  void api
                    .openExternalUrl(href)
                    .catch((error) => setLinkError(String(error)));
                }}
              >
                {children}
              </a>
            ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

export default function Editor({
  projectId,
  path,
  onError,
  refreshVersion = 0,
  preferences,
}: Props) {
  const dialog = useAppDialog();
  const config = fileSettings(preferences);
  const rememberPositions = config.rememberSession && config.rememberPositions;
  const [wrapLines, setWrapLines] = useState(config.wrapLines);
  const editorRoot = useRef<HTMLElement | null>(null);
  const [document, setDocument] = useState<FileDocument | null>(null);
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [status, setStatus] = useState<
    "saved" | "pending" | "saving" | "error"
  >("saved");
  const [saveError, setSaveError] = useState("");
  const [recovery, setRecovery] = useState<Draft | null>(null);
  const [externalNotice, setExternalNotice] = useState("");
  const seenRefresh = useRef(refreshVersion);
  const isMarkdown = /\.(md|mdx|markdown)$/i.test(path);
  const viewKey = `foldory:workspace:${projectId}:file:${path}`;
  const previewScroll = useStoredScroll(
    `${viewKey}:preview`,
    rememberPositions,
  );
  const initialMode = () => {
    const saved = rememberPositions
      ? readPreference<string>(`${viewKey}:mode`, "")
      : "";
    return saved === "edit" || saved === "preview" || saved === "split"
      ? saved
      : isMarkdown
        ? config.defaultMode
        : "edit";
  };
  const [mode, setMode] = useState<"edit" | "preview" | "split">(initialMode);
  useEffect(() => {
    if (rememberPositions) writePreference(`${viewKey}:mode`, mode);
  }, [viewKey, mode, rememberPositions]);
  const zoom = useFileZoom(
    projectId,
    path,
    config,
    editorRoot,
    isMarkdown && mode === "preview" ? "preview" : "editor",
  );
  const session = useRef<Session | null>(null);
  const timeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const reportError = useRef(onError);
  reportError.current = onError;

  const updateState = useCallback((active: Session) => {
    if (!active.disposed && session.current === active) {
      setStatus(
        active.error
          ? "error"
          : active.saving
            ? "saving"
            : active.content === active.savedContent
              ? "saved"
              : "pending",
      );
      setSaveError(active.error);
    }
  }, []);

  const flush = useCallback(
    async (active: Session, force = false) => {
      if (pendingWrites.has(active.key)) await pendingWrites.get(active.key);
      if (active.content === active.savedContent) return;
      if (active.error && !force) throw new Error(active.error);
      const task = (async () => {
        active.saving = true;
        active.error = "";
        updateState(active);
        try {
          while (active.content !== active.savedContent) {
            const writing = active.content;
            const result = await api.writeFile(
              active.projectId,
              active.path,
              writing,
              active.revision,
              force,
            );
            force = false;
            active.savedContent = writing;
            active.revision = result.revision;
            storeDraft(active);
          }
        } catch (error) {
          active.error = String(error instanceof Error ? error.message : error);
          storeDraft(active);
          throw error;
        } finally {
          active.saving = false;
          updateState(active);
        }
      })();
      pendingWrites.set(active.key, task);
      try {
        await task;
      } finally {
        if (pendingWrites.get(active.key) === task)
          pendingWrites.delete(active.key);
      }
    },
    [updateState],
  );

  useEffect(() => {
    let cancelled = false;
    const key = `${projectId}:${path}`;
    setLoading(true);
    setDocument(null);
    setLoadError("");
    setSaveError("");
    setRecovery(null);
    setMode(initialMode());
    void (async () => {
      try {
        try {
          await pendingWrites.get(key);
        } catch {
          /* Keep the draft available for recovery. */
        }
        const doc = await api.readFile(projectId, path);
        if (cancelled) return;
        const active: Session = {
          key,
          projectId,
          path,
          content: doc.content,
          savedContent: doc.content,
          revision: doc.revision,
          error: "",
          saving: false,
          disposed: false,
        };
        session.current = active;
        setDocument(doc);
        setContent(doc.content);
        setStatus("saved");
        const draft = readDraft(key);
        if (draft && draft.content !== doc.content) setRecovery(draft);
        else if (draft) localStorage.removeItem(storageKey(key));
      } catch (error) {
        if (!cancelled)
          setLoadError(error instanceof Error ? error.message : String(error));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      clearTimeout(timeout.current);
      const active = session.current;
      if (active?.key === key) {
        active.disposed = true;
        void flush(active).catch(() => {
          /* Draft survives navigation or application closure. */
        });
        session.current = null;
      }
    };
  }, [projectId, path, flush]);

  useEffect(() => {
    if (seenRefresh.current === refreshVersion || loading) return;
    const active = session.current;
    if (!active || active.disposed) return;
    seenRefresh.current = refreshVersion;
    let cancelled = false;
    void api
      .readFile(projectId, path)
      .then((latest) => {
        if (
          cancelled ||
          session.current !== active ||
          active.disposed ||
          latest.revision === active.revision
        )
          return;
        if (
          active.content !== active.savedContent ||
          active.saving ||
          active.error ||
          recovery
        ) {
          active.error =
            "CONFLICT: The assistant changed this file on disk. Your local edits are preserved. Reload the disk version or review your edits before overwriting.";
          storeDraft(active);
          updateState(active);
          return;
        }
        active.content = latest.content;
        active.savedContent = latest.content;
        active.revision = latest.revision;
        setDocument(latest);
        setContent(latest.content);
        setExternalNotice("");
        updateState(active);
      })
      .catch((cause) => {
        if (!cancelled)
          setExternalNotice(
            `The assistant updated this file, but the preview could not refresh. ${cause instanceof Error ? cause.message : String(cause)}`,
          );
      });
    return () => {
      cancelled = true;
    };
  }, [refreshVersion, projectId, path, loading, recovery, updateState]);

  useEffect(() => {
    const beforeNavigate = (event: Event) => {
      const active = session.current;
      if (active)
        (
          event as CustomEvent<{ promises: Promise<unknown>[] }>
        ).detail.promises.push(flush(active));
    };
    const beforeUnload = (event: BeforeUnloadEvent) => {
      const active = session.current;
      if (active && active.content !== active.savedContent) {
        storeDraft(active);
        event.preventDefault();
      }
    };
    window.addEventListener("foldory:before-navigate", beforeNavigate);
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      window.removeEventListener("foldory:before-navigate", beforeNavigate);
      window.removeEventListener("beforeunload", beforeUnload);
    };
  }, [flush]);

  function edit(next: string) {
    const active = session.current;
    if (!active) return;
    active.content = next;
    setContent(next);
    if (!storeDraft(active))
      reportError.current(
        "Local draft storage is full. Keep this file open until it is saved to disk.",
      );
    updateState(active);
    clearTimeout(timeout.current);
    timeout.current = setTimeout(() => {
      void flush(active).catch(() => {});
    }, 650);
  }
  async function reload() {
    try {
      const doc = await api.readFile(projectId, path);
      const active = session.current;
      if (!active) return;
      const previous: Draft = {
        content: active.content,
        revision: active.revision,
        savedAt: Date.now(),
      };
      active.content = doc.content;
      active.savedContent = doc.content;
      active.revision = doc.revision;
      active.error = "";
      setDocument(doc);
      setContent(doc.content);
      setExternalNotice("");
      updateState(active);
      if (previous.content !== doc.content) setRecovery(previous);
    } catch (error) {
      reportError.current(String(error));
    }
  }
  async function overwrite() {
    if (
      !(await dialog.confirm({
        title: "Replace file on disk?",
        message:
          "Replace the current file on disk with your edited version? Your local draft will be kept if saving fails.",
        confirmLabel: "Replace file",
        danger: true,
      }))
    )
      return;
    const active = session.current;
    if (active) {
      active.error = "";
      try {
        await flush(active, true);
      } catch {
        /* Error shown in editor. */
      }
    }
  }
  function restore() {
    const active = session.current;
    if (!active || !recovery) return;
    active.revision = recovery.revision;
    active.error = "";
    edit(recovery.content);
    setRecovery(null);
    setMode(isMarkdown ? "split" : "edit");
  }

  if (loading)
    return (
      <div className="workspace-loading">
        <LoaderCircle className="spin" size={19} /> Opening {path}…
      </div>
    );
  if (loadError || !document)
    return (
      <div className="empty-state editor-error">
        <FileText size={32} />
        <h3>Unable to open this file</h3>
        <p>{loadError}</p>
        <button
          className="button"
          onClick={() =>
            void api
              .launchTool(projectId, "default", path)
              .catch((error) => onError(String(error)))
          }
        >
          <ExternalLink size={15} /> Open in default app
        </button>
      </div>
    );

  return (
    <section
      ref={editorRoot}
      className="document-editor file-editor"
      aria-label={`Editor for ${path}`}
      style={
        {
          "--editor-font-size": `${zoom.editor}px`,
          "--preview-font-size": `${zoom.preview}px`,
          "--preview-width": `${config.previewWidth}px`,
          "--preview-padding": `${config.fullWidthPadding}px`,
        } as CSSProperties
      }
      onPointerDownCapture={(event) => {
        if ((event.target as HTMLElement).closest(".preview-pane"))
          zoom.setTarget("preview");
        else if ((event.target as HTMLElement).closest(".code-pane"))
          zoom.setTarget("editor");
      }}
      onFocusCapture={(event) => {
        if (event.target.closest(".preview-pane")) zoom.setTarget("preview");
        else if (event.target.closest(".code-pane")) zoom.setTarget("editor");
      }}
    >
      <div className="editor-toolbar">
        <span className="editor-filename">
          <FileText size={15} />
          {path}
        </span>
        <span className={`save-state ${status}`} role="status">
          {status === "saving" ? (
            <LoaderCircle size={13} className="spin" />
          ) : status === "error" ? (
            <AlertTriangle size={13} />
          ) : (
            <Check size={13} />
          )}{" "}
          {status === "saved"
            ? "Saved"
            : status === "pending"
              ? "Unsaved changes"
              : status === "saving"
                ? "Saving…"
                : "Save needs attention"}
        </span>
        <FileZoomControls {...zoom} />
        {(!isMarkdown || mode !== "preview") && (
          <button
            type="button"
            className="editor-wrap-toggle"
            aria-label="Text wrap"
            aria-pressed={wrapLines}
            title={wrapLines ? "Disable text wrap" : "Enable text wrap"}
            onClick={() => setWrapLines((value) => !value)}
          >
            <WrapText size={16} />
          </button>
        )}
        {isMarkdown && (
          <div className="view-switch" aria-label="Markdown view">
            {(
              [
                ["preview", Eye, "Preview"],
                ["edit", Code2, "Edit"],
                ["split", Columns2, "Split"],
              ] as const
            ).map(([value, Icon, label]) => (
              <button
                key={value}
                className={mode === value ? "active" : ""}
                title={label}
                aria-label={label}
                aria-pressed={mode === value}
                onClick={() => setMode(value)}
              >
                <Icon size={14} />
                <span>{label}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      {recovery && (
        <div className="editor-notice">
          <RotateCcw size={16} />
          <span>
            A recovered local draft is available from{" "}
            {new Date(recovery.savedAt).toLocaleString()}.
          </span>
          <button className="button small" onClick={restore}>
            Restore draft
          </button>
          <button
            className="button small ghost"
            onClick={() => {
              localStorage.removeItem(storageKey(`${projectId}:${path}`));
              setRecovery(null);
            }}
          >
            Discard draft
          </button>
        </div>
      )}
      {saveError && (
        <div className="editor-notice error" role="alert">
          <AlertTriangle size={17} />
          <span>
            {saveError} Your edited text remains here and in a local recovery
            draft.
          </span>
          <button
            className="button small"
            onClick={() => {
              const active = session.current;
              if (active) {
                active.error = "";
                void flush(active).catch(() => {});
              }
            }}
          >
            Retry
          </button>
          <button className="button small" onClick={() => void reload()}>
            Reload disk version
          </button>
          <button className="button small" onClick={() => void overwrite()}>
            Overwrite disk
          </button>
        </div>
      )}
      {externalNotice && (
        <div className="editor-notice error" role="alert">
          <AlertTriangle size={17} />
          <span>{externalNotice}</span>
          <button className="button small" onClick={() => void reload()}>
            Reload disk version
          </button>
        </div>
      )}
      <div className={`editor-body mode-${isMarkdown ? mode : "edit"}`}>
        {(!isMarkdown || mode !== "preview") && (
          <div className="code-pane">
            <Suspense
              fallback={
                <div className="workspace-loading">
                  <LoaderCircle size={17} className="spin" />
                  Loading editor…
                </div>
              }
            >
              <CodeSurface
                path={path}
                content={content}
                onChange={edit}
                wrapLines={wrapLines}
                stateKey={viewKey}
                rememberPosition={rememberPositions}
                lineNumbers={config.lineNumbers}
              />
            </Suspense>
          </div>
        )}
        {isMarkdown && mode !== "edit" && (
          <div
            className={`preview-pane file-preview preview-${config.previewLayout}`}
            ref={previewScroll}
            tabIndex={0}
            aria-label="File preview"
          >
            <Markdown
              content={
                content ||
                "*This document is empty. Switch to Edit to start writing.*"
              }
            />
          </div>
        )}
      </div>
      <footer className="editor-footer">
        <span>UTF-8</span>
        <span>
          {isMarkdown
            ? "Markdown"
            : path.split(".").pop()?.toUpperCase() || "Plain text"}
        </span>
        <span>{content.split("\n").length.toLocaleString()} lines</span>
        <span>Autosave · Ctrl+Z undo · Ctrl+F find</span>
      </footer>
    </section>
  );
}
