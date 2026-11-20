import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import {
  Archive,
  ArchiveRestore,
  ArrowUp,
  Copy,
  FileText,
  Folder,
  Globe2,
  History,
  LoaderCircle,
  MessageSquare,
  Maximize2,
  Minimize2,
  Plus,
  Pin,
  PinOff,
  ScanSearch,
  Sparkles,
  Square,
  Trash2,
  X,
} from "lucide-react";
import { api, desktop } from "../api";
import {
  activePathReference,
  ASSISTANT_FILES_MIME,
  draggedSourcePaths,
  isCoveredPath,
  pathReferences,
} from "../assistantSources";
import { useModelChoice } from "../ai";
import type {
  AssistantSource,
  ChatMessage,
  FileEntry,
  Project,
  Settings,
  SourceApproval,
} from "../types";
import type { ChatScope } from "../useChatScope";
import { useStoredBoolean } from "../useStoredState";
import { messageOf, relativeTime } from "../utils";
import { Markdown } from "./Editor";
import Modal from "./Modal";
import AiModelPicker from "./AiModelPicker";
import SourceApprovalModal from "./SourceApprovalModal";
import AssistantErrorCard from "./AssistantErrorCard";
import AssistantAccessPicker, {
  useAssistantAccess,
} from "./AssistantAccessPicker";
import AssistantFileAction from "./AssistantFileAction";
import GlobalContextPicker, {
  contextKey,
  type GlobalContextItem,
} from "./GlobalContextPicker";
import PanelResizeHandle, { usePanelWidth } from "./PanelResizeHandle";
import "./assistant.css";

type Props = {
  scope: ChatScope;
  projectName?: string;
  projectId?: string;
  sourceRequest?: { token: number; paths: string[]; wordResultId?: string };
  docked?: boolean;
  pinned?: boolean;
  onTogglePin?: () => void;
  beforePrepareSources?: () => Promise<void>;
  onFilesChanged?: (paths: string[]) => void;
  settings: Settings;
  projects?: Project[];
  onError: (message: string) => void;
  onInspect?: () => void;
};

type SourceSuggestion = FileEntry & {
  sourceProjectId?: string;
  sourceProjectName?: string;
  projectRoot?: boolean;
};

function namedProject(projects: Project[], name: string) {
  const key = name.trim().toLowerCase();
  return projects.find(
    (project) =>
      !project.hidden &&
      [project.alias, project.name]
        .filter(Boolean)
        .some((candidate) => candidate.toLowerCase() === key),
  );
}

function globalSourceReference(projects: Project[], path: string) {
  const normalized = path.replaceAll("\\", "/");
  const slash = normalized.indexOf("/");
  if (slash < 1) return null;
  const project = namedProject(projects, normalized.slice(0, slash));
  const sourcePath = normalized.slice(slash + 1).replace(/^\/+/, "");
  if (!project || !sourcePath) return null;
  return { project, path: sourcePath };
}

function Composer({
  scope,
  projectName,
  projectId,
  sourceRequest,
  beforePrepareSources,
  settings,
  projects = [],
  onInspect,
  model,
  resetVersion,
  actionBusy,
}: Omit<Props, "onError"> & {
  model: ReturnType<typeof useModelChoice>;
  resetVersion: number;
  actionBusy: boolean;
}) {
  const [prompt, setPrompt] = useState("");
  const [includeOverview, setIncludeOverview] = useState(false);
  const [globalSelections, setGlobalSelections] = useState<GlobalContextItem[]>(
    [],
  );
  const access = useAssistantAccess(projectId);
  type PreparedSource = AssistantSource & {
    projectId: string;
    projectName: string;
  };
  const [sources, setSources] = useState<PreparedSource[]>([]);
  const [sourceError, setSourceError] = useState<unknown>(null);
  const [sourceApproval, setSourceApproval] = useState<SourceApproval | null>(
    null,
  );
  const [preparing, setPreparing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [caret, setCaret] = useState(0);
  const [suggestions, setSuggestions] = useState<SourceSuggestion[]>([]);
  const [suggestionIndex, setSuggestionIndex] = useState(0);
  const [lookupError, setLookupError] = useState<unknown>(null);
  const [dismissedReference, setDismissedReference] = useState<string | null>(
    null,
  );
  const textarea = useRef<HTMLTextAreaElement>(null);
  const inputWrap = useRef<HTMLDivElement>(null);
  const [lookupPosition, setLookupPosition] = useState<CSSProperties>({});
  const currentSources = useRef<PreparedSource[]>([]);
  const generation = useRef(0);
  const mounted = useRef(true);
  const pendingApproval = useRef<{ resolve: (allow: boolean) => void } | null>(
    null,
  );
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const outstanding = useRef(0);
  const lastSourceRequest = useRef<number | null>(null);
  const previousReset = useRef(resetVersion);
  const helpId = useId();
  const suggestionsId = useId();
  const chat = scope.thread?.chat;
  const reference = activePathReference(prompt, caret);
  const referenceKey = reference
    ? `${reference.start}:${reference.path}`
    : null;
  const showSuggestions = Boolean(
    reference && referenceKey !== dismissedReference,
  );
  const referencePath = reference?.path ?? "";
  const referenceStart = reference?.start;

  const resizePrompt = useCallback(() => {
    const input = textarea.current;
    if (!input) return;
    const scrollTop = input.scrollTop;
    input.style.height = "auto";
    input.style.overflowY = "hidden";
    const height = input.scrollHeight;
    input.style.height = `${Math.min(height, 350)}px`;
    input.style.overflowY = height > 350 ? "auto" : "hidden";
    input.scrollTop = scrollTop;
  }, []);

  useLayoutEffect(resizePrompt, [prompt, resizePrompt]);

  useLayoutEffect(() => {
    const input = textarea.current;
    if (!input || typeof ResizeObserver === "undefined") return;
    let width = input.clientWidth;
    const observer = new ResizeObserver(() => {
      if (width === input.clientWidth) return;
      width = input.clientWidth;
      resizePrompt();
    });
    observer.observe(input);
    return () => observer.disconnect();
  }, [resizePrompt]);

  useLayoutEffect(() => {
    if (!showSuggestions) return;
    const place = () => {
      const rect = inputWrap.current?.getBoundingClientRect();
      if (rect)
        setLookupPosition({
          left: Math.max(8, rect.left),
          bottom: Math.max(8, window.innerHeight - rect.top + 7),
          width: Math.min(rect.width, window.innerWidth - 16),
        });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [showSuggestions, referencePath]);

  const discard = useCallback((items: PreparedSource[]) => {
    const groups = new Map<string, string[]>();
    for (const item of items)
      groups.set(item.projectId, [
        ...(groups.get(item.projectId) || []),
        item.id,
      ]);
    for (const [sourceProjectId, sourceIds] of groups)
      void api
        .discardAssistantSources(sourceProjectId, sourceIds)
        .catch(() => {});
  }, []);

  const answerApproval = useCallback((allow: boolean) => {
    const pending = pendingApproval.current;
    if (!pending) return;
    pendingApproval.current = null;
    if (mounted.current) setSourceApproval(null);
    pending.resolve(allow);
  }, []);

  function updateSources(items: PreparedSource[]) {
    currentSources.current = items;
    setSources(items);
  }

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current += 1;
      answerApproval(false);
      discard(currentSources.current);
    };
  }, [discard, answerApproval]);

  useEffect(() => {
    if (previousReset.current === resetVersion) return;
    previousReset.current = resetVersion;
    generation.current += 1;
    answerApproval(false);
    discard(currentSources.current);
    updateSources([]);
    setPrompt("");
    setCaret(0);
    setSourceError(null);
    setSuggestions([]);
  }, [resetVersion, discard, answerApproval]);

  const addPaths = useCallback(
    (paths: string[], wordResultId?: string, sourceProjectId = projectId) => {
      if (chat?.archived)
        return Promise.reject(
          new Error("Restore this archived chat before including sources."),
        );
      const expectedGeneration = generation.current;
      outstanding.current += 1;
      setPreparing(true);
      setSourceError(null);
      const operation = queue.current
        .then(async () => {
          if (!sourceProjectId)
            throw new Error("Choose a project before including its files.");
          if (!mounted.current || expectedGeneration !== generation.current)
            return null;
          const project = projects.find((item) => item.id === sourceProjectId);
          const sourceProjectName =
            project?.alias || project?.name || projectName || "Project";
          const projectSources = currentSources.current.filter(
            (item) => item.projectId === sourceProjectId,
          );
          const missing = [...new Set(paths)].filter(
            (path) => wordResultId || !isCoveredPath(path, projectSources),
          );
          if (!missing.length) return currentSources.current;
          let prepared: PreparedSource[];
          try {
            await beforePrepareSources?.();
            if (!mounted.current || expectedGeneration !== generation.current)
              return null;
            let result = wordResultId
              ? await api.prepareWordSource(sourceProjectId, wordResultId)
              : await api.prepareAssistantSources(sourceProjectId, missing);
            while (result.status === "approvalRequired") {
              const approval = result.approval;
              const current = () =>
                mounted.current && expectedGeneration === generation.current;
              const allow = current()
                ? await new Promise<boolean>((resolve) => {
                    pendingApproval.current = { resolve };
                    setSourceApproval(approval);
                  })
                : false;
              result = await api.approveAssistantSources(
                sourceProjectId,
                approval.id,
                allow && current(),
              );
              if (!allow) {
                if (result.status === "ready")
                  discard(
                    result.sources.map((source) => ({
                      ...source,
                      projectId: sourceProjectId,
                      projectName: sourceProjectName,
                    })),
                  );
                return null;
              }
            }
            if (result.status === "cancelled") return null;
            prepared = result.sources.map((source) => ({
              ...source,
              projectId: sourceProjectId,
              projectName: sourceProjectName,
            }));
          } catch (error) {
            if (!mounted.current || expectedGeneration !== generation.current)
              return null;
            throw error;
          }
          if (!mounted.current || expectedGeneration !== generation.current) {
            discard(prepared);
            return null;
          }
          const kept = currentSources.current.filter(
            (item) =>
              item.projectId !== sourceProjectId ||
              !isCoveredPath(item.path, prepared),
          );
          discard(
            currentSources.current.filter((item) => !kept.includes(item)),
          );
          const next = wordResultId
            ? [...prepared, ...kept]
            : [...kept, ...prepared];
          currentSources.current = next;
          setSources(next);
          setSourceError(null);
          return next;
        })
        .finally(() => {
          outstanding.current -= 1;
          if (mounted.current) setPreparing(outstanding.current > 0);
        });
      queue.current = operation.catch(() => {});
      return operation;
    },
    [
      projectId,
      projectName,
      projects,
      discard,
      beforePrepareSources,
      chat?.archived,
    ],
  );

  useEffect(() => {
    if (!sourceRequest || lastSourceRequest.current === sourceRequest.token)
      return;
    lastSourceRequest.current = sourceRequest.token;
    void addPaths(sourceRequest.paths, sourceRequest.wordResultId).catch(
      (error) => {
        if (mounted.current) setSourceError(error);
      },
    );
  }, [sourceRequest, addPaths]);

  useEffect(() => {
    if (projectId) return;
    const selected = new Set(
      globalSelections.map((item) => contextKey(item.projectId, item.path)),
    );
    const kept = currentSources.current.filter((source) =>
      selected.has(contextKey(source.projectId, source.path)),
    );
    const removed = currentSources.current.filter(
      (source) => !kept.includes(source),
    );
    if (removed.length) {
      discard(removed);
      updateSources(kept);
    }
  }, [projectId, globalSelections, discard]);

  useEffect(() => {
    if (referenceStart === undefined || !showSuggestions) {
      setSuggestions([]);
      setLookupError(null);
      return;
    }
    let active = true;
    const normalized = referencePath.replaceAll("\\", "/");
    setSuggestions([]);
    setSuggestionIndex(0);
    setLookupError(null);
    if (!projectId) {
      const firstSlash = normalized.indexOf("/");
      const projectPrefix =
        firstSlash < 0 ? normalized : normalized.slice(0, firstSlash);
      const project = namedProject(projects, projectPrefix);
      if (!project || firstSlash < 0) {
        const query = projectPrefix.toLowerCase();
        setSuggestions(
          projects
            .filter(
              (item) =>
                !item.hidden &&
                item.available &&
                [item.alias, item.name, item.path]
                  .join(" ")
                  .toLowerCase()
                  .includes(query),
            )
            .sort((a, b) =>
              (a.alias || a.name).localeCompare(b.alias || b.name),
            )
            .slice(0, 30)
            .map((item) => ({
              name: item.alias || item.name,
              path: item.alias || item.name,
              directory: true,
              size: 0,
              modifiedAt: item.modifiedAt,
              sourceProjectId: item.id,
              sourceProjectName: item.alias || item.name,
              projectRoot: true,
            })),
        );
        return;
      }
      const sourcePath = normalized.slice(firstSlash + 1);
      const slash = sourcePath.lastIndexOf("/");
      const parent = slash < 0 ? "" : sourcePath.slice(0, slash);
      const query = sourcePath.slice(slash + 1).toLowerCase();
      void api
        .listDirectory(project.id, parent)
        .then((items) => {
          if (active)
            setSuggestions(
              items
                .filter((item) => item.name.toLowerCase().includes(query))
                .sort(
                  (a, b) =>
                    Number(b.directory) - Number(a.directory) ||
                    a.name.localeCompare(b.name),
                )
                .slice(0, 30)
                .map((item) => ({
                  ...item,
                  sourceProjectId: project.id,
                  sourceProjectName: project.alias || project.name,
                })),
            );
        })
        .catch((error) => {
          if (active) setLookupError(error);
        });
      return () => {
        active = false;
      };
    }
    const slash = normalized.lastIndexOf("/");
    const parent = slash < 0 ? "" : normalized.slice(0, slash);
    const query = normalized.slice(slash + 1).toLowerCase();
    void api
      .listDirectory(projectId, parent)
      .then((items) => {
        if (active)
          setSuggestions(
            items
              .filter((item) => item.name.toLowerCase().includes(query))
              .sort(
                (a, b) =>
                  Number(b.directory) - Number(a.directory) ||
                  a.name.localeCompare(b.name),
              )
              .slice(0, 30),
          );
      })
      .catch((error) => {
        if (active) setLookupError(error);
      });
    return () => {
      active = false;
    };
  }, [projectId, projects, referenceStart, referencePath, showSuggestions]);

  async function chooseSource(entry: SourceSuggestion) {
    if (!reference) return;
    const selected = reference;
    setDismissedReference(referenceKey);
    if (entry.projectRoot) {
      const name = entry.sourceProjectName || entry.name;
      const value = /\s/.test(name) ? `@"${name}/` : `@${name}/`;
      setPrompt(
        (text) =>
          text.slice(0, selected.start) + value + text.slice(selected.end),
      );
      setCaret(selected.start + value.length);
      setDismissedReference(null);
      requestAnimationFrame(() => {
        textarea.current?.focus();
        textarea.current?.setSelectionRange(
          selected.start + value.length,
          selected.start + value.length,
        );
      });
      return;
    }
    try {
      if (
        await addPaths(
          [entry.path],
          undefined,
          entry.sourceProjectId || projectId,
        )
      ) {
        if (!projectId && entry.sourceProjectId) {
          const nextItem: GlobalContextItem = {
            projectId: entry.sourceProjectId,
            projectName: entry.sourceProjectName || "Project",
            path: entry.path,
            directory: entry.directory,
          };
          setIncludeOverview(false);
          setGlobalSelections((items) => [
            ...items.filter(
              (item) =>
                contextKey(item.projectId, item.path) !==
                contextKey(nextItem.projectId, nextItem.path),
            ),
            nextItem,
          ]);
        }
        setPrompt((text) =>
          text === prompt
            ? text.slice(0, selected.start) + text.slice(selected.end)
            : text,
        );
        if (textarea.current?.value === prompt) setCaret(selected.start);
        textarea.current?.focus();
      }
    } catch (error) {
      if (mounted.current) setSourceError(error);
    }
  }

  const canSend = Boolean(
    desktop &&
    model.ready &&
    !model.prefs.saving &&
    !scope.loading &&
    !scope.busy &&
    !actionBusy &&
    (!projectId || (access.loaded && !access.saving)) &&
    !preparing &&
    !submitting &&
    !chat?.pending &&
    !chat?.archived &&
    prompt.trim(),
  );

  return (
    <form
      className="chat-composer"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!canSend) return;
        setSubmitting(true);
        setSourceError(null);
        try {
          const expectedGeneration = generation.current;
          await beforePrepareSources?.();
          if (!mounted.current || expectedGeneration !== generation.current)
            return;
          let prepared = currentSources.current;
          if (projectId) {
            const references = pathReferences(prompt);
            if (references.length)
              prepared =
                (await addPaths(references.map((item) => item.path))) || [];
          } else {
            const requested = new Map(
              globalSelections.map((item) => [
                contextKey(item.projectId, item.path),
                item,
              ]),
            );
            for (const reference of pathReferences(prompt)) {
              const resolved = globalSourceReference(projects, reference.path);
              if (!resolved) continue;
              const item: GlobalContextItem = {
                projectId: resolved.project.id,
                projectName: resolved.project.alias || resolved.project.name,
                path: resolved.path,
                directory: false,
              };
              requested.set(contextKey(item.projectId, item.path), item);
            }
            const requestedSelections = [...requested.values()];
            if (requestedSelections.length && !globalSelections.length) {
              setIncludeOverview(false);
              setGlobalSelections(requestedSelections);
            }
            const byProject = new Map<string, string[]>();
            for (const selection of requestedSelections)
              byProject.set(selection.projectId, [
                ...(byProject.get(selection.projectId) || []),
                selection.path,
              ]);
            for (const [selectionProjectId, paths] of byProject) {
              const next = await addPaths(paths, undefined, selectionProjectId);
              if (!next) return;
              prepared = next;
            }
          }
          if (!prepared || expectedGeneration !== generation.current) return;
          const ids = prepared.map((item) => item.id);
          const scopeProjectIds = [
            ...new Set(
              prepared.filter(() => !projectId).map((item) => item.projectId),
            ),
          ];
          const sent = scopeProjectIds.length
            ? await scope.send(
                prompt.trim(),
                includeOverview,
                ids,
                scopeProjectIds,
              )
            : await scope.send(prompt.trim(), includeOverview, ids);
          if (
            sent &&
            mounted.current &&
            expectedGeneration === generation.current
          ) {
            setPrompt((current) => (current === prompt ? "" : current));
            setCaret(0);
            updateSources(
              currentSources.current.filter((item) => !ids.includes(item.id)),
            );
          }
        } catch (error) {
          if (mounted.current) setSourceError(error);
        } finally {
          if (mounted.current) setSubmitting(false);
        }
      }}
      onDragOver={(event) => {
        if (
          !projectId ||
          !event.dataTransfer.types.includes(ASSISTANT_FILES_MIME)
        )
          return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        setDragActive(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          setDragActive(false);
      }}
      onDrop={(event) => {
        if (
          !projectId ||
          !event.dataTransfer.types.includes(ASSISTANT_FILES_MIME)
        )
          return;
        event.preventDefault();
        setDragActive(false);
        try {
          const paths = draggedSourcePaths(
            event.dataTransfer.getData(ASSISTANT_FILES_MIME),
            projectId,
          );
          void addPaths(paths).catch((error) => {
            if (mounted.current) setSourceError(error);
          });
        } catch (error) {
          setSourceError(error);
        }
      }}
    >
      <div className="chat-composer-feedback">
        {chat?.archived && (
          <p className="chat-archived-notice" role="status">
            <Archive size={15} aria-hidden="true" />
            Archived chat. Restore it to send messages or apply file changes.
          </p>
        )}
        {(scope.errorInfo || scope.error) && (
          <AssistantErrorCard
            error={scope.errorInfo || scope.error}
            context="send"
          />
        )}
        {Boolean(sourceError) && (
          <AssistantErrorCard error={sourceError} context="sources" />
        )}
        {Boolean(access.error) && (
          <AssistantErrorCard
            error={access.error}
            context="sources"
            onRetry={() => void access.load()}
          />
        )}
      </div>
      <div
        className={`chat-composer-box ${dragActive ? "chat-drop-active" : ""}`}
      >
        {!projectId && (includeOverview || globalSelections.length > 0) && (
          <div
            className="global-scope-chips"
            aria-label="Included project context"
          >
            {globalSelections.length ? (
              globalSelections.map((selection) => {
                return (
                  <span
                    key={contextKey(selection.projectId, selection.path)}
                    title={`${selection.projectName} / ${selection.path}`}
                  >
                    {selection.directory ? (
                      <Folder size={13} />
                    ) : (
                      <FileText size={13} />
                    )}
                    {selection.projectName} › {selection.path}
                    <button
                      type="button"
                      aria-label={`Remove ${selection.projectName} ${selection.path} from context`}
                      onClick={() =>
                        setGlobalSelections((items) =>
                          items.filter(
                            (item) =>
                              contextKey(item.projectId, item.path) !==
                              contextKey(selection.projectId, selection.path),
                          ),
                        )
                      }
                    >
                      <X size={12} />
                    </button>
                  </span>
                );
              })
            ) : (
              <span>
                <Globe2 size={13} /> Relevant docs from all projects
                <button
                  type="button"
                  aria-label="Remove all project docs from context"
                  onClick={() => setIncludeOverview(false)}
                >
                  <X size={12} />
                </button>
              </span>
            )}
          </div>
        )}
        {sources.length > 0 && (
          <div className="chat-sources" aria-label="Included sources">
            {sources.map((source) => (
              <div className="chat-source" key={source.id}>
                <details>
                  <summary title={source.path || "."}>
                    {source.directory ? (
                      <Folder size={14} />
                    ) : (
                      <FileText size={14} />
                    )}
                    <span>{source.path || "Project folder"}</span>
                    <small>
                      {source.fileCount}{" "}
                      {source.fileCount === 1 ? "file" : "files"}
                      {source.warnings.length
                        ? ` · ${source.warnings.length} warnings`
                        : ""}
                    </small>
                  </summary>
                  <div className="chat-source-details">
                    <p>
                      Included with your next message and available for
                      follow-up questions in this chat. Remove and add again
                      before sending to refresh the snapshot.
                    </p>
                    {source.files.map((path) => (
                      <div key={path}>{path}</div>
                    ))}
                    {source.warnings.map((warning, index) => (
                      <p className="chat-source-warning" key={index}>
                        {warning}
                      </p>
                    ))}
                  </div>
                </details>
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`Remove source ${source.path || "."}`}
                  disabled={submitting}
                  onClick={() => {
                    discard([source]);
                    updateSources(
                      currentSources.current.filter(
                        (item) => item.id !== source.id,
                      ),
                    );
                  }}
                >
                  <X size={13} />
                </button>
              </div>
            ))}
          </div>
        )}
        {preparing && (
          <p className="chat-source-preparing" role="status">
            <LoaderCircle size={14} className="spin" /> Preparing sources…
          </p>
        )}
        {dragActive && (
          <p className="chat-drop-hint">Drop to include files and folders</p>
        )}
        <div className="chat-input-wrap" ref={inputWrap}>
          <textarea
            ref={textarea}
            aria-label="Your question"
            aria-describedby={helpId}
            aria-autocomplete="list"
            aria-controls={showSuggestions ? suggestionsId : undefined}
            aria-activedescendant={
              showSuggestions && suggestions[suggestionIndex]
                ? `${suggestionsId}-${suggestionIndex}`
                : undefined
            }
            placeholder={
              projectId
                ? "Ask anything · @ or / to include files"
                : "Ask anything · @ or / to include project files"
            }
            rows={2}
            maxLength={16000}
            value={prompt}
            disabled={chat?.archived}
            readOnly={submitting}
            onChange={(event) => {
              setPrompt(event.target.value);
              setCaret(event.target.selectionStart);
              setDismissedReference(null);
            }}
            onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
            onKeyDown={(event) => {
              if (
                showSuggestions &&
                !event.nativeEvent.isComposing &&
                event.nativeEvent.keyCode !== 229
              ) {
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  setSuggestionIndex((index) =>
                    suggestions.length
                      ? (index +
                          (event.key === "ArrowDown" ? 1 : -1) +
                          suggestions.length) %
                        suggestions.length
                      : 0,
                  );
                  return;
                }
                if (
                  (event.key === "Enter" || event.key === "Tab") &&
                  !event.shiftKey &&
                  suggestions[suggestionIndex]
                ) {
                  event.preventDefault();
                  void chooseSource(suggestions[suggestionIndex]);
                  return;
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  setDismissedReference(referenceKey);
                  return;
                }
              }
              if (
                event.key === "Enter" &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing &&
                event.nativeEvent.keyCode !== 229
              ) {
                event.preventDefault();
                if (canSend) event.currentTarget.form?.requestSubmit();
              }
            }}
          />
          {showSuggestions &&
            createPortal(
              <div className="chat-path-lookup" style={lookupPosition}>
                <div
                  id={suggestionsId}
                  role="listbox"
                  aria-label={
                    projectId
                      ? "Project files and folders"
                      : "Workspace projects and files"
                  }
                >
                  {suggestions.map((entry, index) => (
                    <button
                      id={`${suggestionsId}-${index}`}
                      key={entry.path}
                      type="button"
                      role="option"
                      aria-selected={index === suggestionIndex}
                      className={entry.aiExcluded ? "ai-excluded" : undefined}
                      title={
                        entry.aiExclusionReason ||
                        (entry.projectRoot
                          ? `Browse ${entry.sourceProjectName}`
                          : entry.path)
                      }
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => void chooseSource(entry)}
                    >
                      {entry.directory ? (
                        <Folder size={14} />
                      ) : (
                        <FileText size={14} />
                      )}
                      <span>
                        {entry.projectRoot
                          ? entry.sourceProjectName
                          : entry.path}
                      </span>
                      {entry.projectRoot ? (
                        <small>Project</small>
                      ) : entry.aiExcluded ? (
                        <small>Permission required</small>
                      ) : (
                        !projectId && <small>{entry.sourceProjectName}</small>
                      )}
                    </button>
                  ))}
                </div>
                {lookupError ? (
                  <AssistantErrorCard error={lookupError} context="sources" />
                ) : !suggestions.length ? (
                  <p>No matching paths. Use a project-relative path.</p>
                ) : (
                  <p>↑↓ to choose · Enter to include · Esc to dismiss</p>
                )}
              </div>,
              document.body,
            )}
        </div>
        <div className="chat-composer-tools">
          {projectId && onInspect && (
            <button
              className="chat-tool-button"
              type="button"
              onClick={onInspect}
            >
              <ScanSearch size={14} aria-hidden="true" /> Inspect
            </button>
          )}
          {projectId ? (
            <button
              type="button"
              className="chat-context-toggle"
              aria-pressed={includeOverview}
              disabled={chat?.archived}
              onClick={() => setIncludeOverview((included) => !included)}
              title="Share this project’s PROJECT.md or README with the AI endpoint"
            >
              <FileText size={14} aria-hidden="true" />
              <span>Include docs</span>
            </button>
          ) : (
            <GlobalContextPicker
              projects={projects}
              includeAll={includeOverview && globalSelections.length === 0}
              selections={globalSelections}
              disabled={Boolean(chat?.archived)}
              onChange={(all, selections) => {
                setIncludeOverview(all);
                setGlobalSelections(selections);
              }}
            />
          )}
          {projectId && (
            <AssistantAccessPicker
              access={access}
              disabled={
                scope.loading ||
                scope.busy ||
                Boolean(chat?.pending) ||
                preparing ||
                submitting ||
                actionBusy ||
                Boolean(chat?.archived)
              }
            />
          )}
          <AiModelPicker
            model={model}
            settings={settings}
            disabled={
              scope.busy || chat?.pending || actionBusy || chat?.archived
            }
          />
          {chat?.pending ? (
            <button
              className="chat-submit chat-stop"
              type="button"
              aria-label="Stop request"
              title="Stop request"
              disabled={scope.busy}
              onClick={() => void scope.stop(chat.id)}
            >
              <Square size={13} fill="currentColor" />
            </button>
          ) : (
            <button
              className="chat-submit"
              type="submit"
              aria-label="Send question"
              title="Send question (Enter)"
              disabled={!canSend}
            >
              <ArrowUp size={19} />
            </button>
          )}
        </div>
      </div>
      <p id={helpId} className="chat-composer-hint">
        <span>
          @ or / for sources · Enter to send · Shift+Enter for a new line
        </span>
        {model.ready && model.destination && (
          <span title={model.destination}>Sends to {model.destination}</span>
        )}
      </p>
      {sourceApproval && (
        <SourceApprovalModal
          approval={sourceApproval}
          destination={model.destination}
          onDecision={answerApproval}
        />
      )}
    </form>
  );
}

function MessageContent({ message }: { message: ChatMessage }) {
  if (message.status === "pending") {
    return (
      <p className="chat-message-status" role="status">
        <LoaderCircle size={16} className="spin" /> Waiting for the AI response…
      </p>
    );
  }
  if (message.status === "stopped") {
    return (
      <p className="chat-message-status" role="status">
        {message.content || "Request stopped."}
      </p>
    );
  }
  if (message.status === "failed") {
    return (
      <AssistantErrorCard
        error={message.content || "The request failed."}
        context="response"
      />
    );
  }
  return message.role === "user" ? (
    <>
      <p className="chat-user-text">{message.content}</p>
      {!!message.sources?.length && (
        <ul className="chat-message-sources" aria-label="Message sources">
          {message.sources.map((source) => (
            <li key={source.path}>
              {source.directory ? <Folder size={13} /> : <FileText size={13} />}
              <span>{source.path || "Project folder"}</span>
              <small>
                {source.fileCount} {source.fileCount === 1 ? "file" : "files"}
              </small>
              {!!source.warnings?.length && (
                <details className="chat-message-source-warnings">
                  <summary>
                    {source.warnings.length} source{" "}
                    {source.warnings.length === 1 ? "warning" : "warnings"}
                  </summary>
                  <ul>
                    {source.warnings.map((warning, index) => (
                      <li key={index}>{warning}</li>
                    ))}
                  </ul>
                </details>
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  ) : (
    <Markdown content={message.content} allowImages={false} />
  );
}

export default function Assistant({
  scope,
  projectName,
  projectId,
  sourceRequest,
  docked = false,
  pinned = false,
  onTogglePin,
  beforePrepareSources,
  onFilesChanged,
  settings,
  projects = [],
  onError,
  onInspect,
}: Props) {
  const model = useModelChoice(
    projectName ? "assistant" : "globalAssistant",
    settings,
  );
  const [composerVersion, setComposerVersion] = useState(0);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [showArchived, setShowArchived] = useStoredBoolean(
    "foldory.assistant-show-archived",
  );
  const [fullWidth, setFullWidth] = useStoredBoolean(
    "foldory.assistant-full-width",
  );
  const [historyWidth, setHistoryWidth] = usePanelWidth(
    "foldory.chat-history-width",
    200,
    50,
    370,
  );
  const [composerHeight, setComposerHeight] = useState(180);
  const composerOverlay = useRef<HTMLDivElement>(null);
  const historyId = useId();
  const [actionBusy, setActionBusy] = useState(false);
  const decidingAction = useRef(false);
  const appliedActions = useRef(new Set<string>());
  const [deletion, setDeletion] = useState<{
    chatId: string;
    messageId?: string;
  } | null>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const lastMessage = useRef<HTMLElement>(null);
  const { thread } = scope;
  const chat = thread?.chat;
  const visibleChats = scope.chats.filter(
    (item) => showArchived || !item.archived,
  );
  const latest = thread?.messages.at(-1);

  useLayoutEffect(() => {
    const element = composerOverlay.current;
    if (!element) return;
    const measure = () => {
      const height = Math.ceil(element.getBoundingClientRect().height);
      if (height > 0) setComposerHeight(height);
    };
    measure();
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measure);
    observer?.observe(element);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);

  useEffect(() => {
    if (!projectId || !onFilesChanged) return;
    const paths = new Set<string>();
    for (const message of thread?.messages || [])
      for (const action of message.actions || []) {
        if (
          action.projectId === projectId &&
          action.status === "applied" &&
          !appliedActions.current.has(action.id)
        ) {
          appliedActions.current.add(action.id);
          paths.add(action.path);
        }
      }
    if (paths.size) onFilesChanged([...paths]);
  }, [projectId, thread?.messages, onFilesChanged]);

  async function decideAction(
    chatId: string,
    actionId: string,
    approve: boolean,
  ) {
    if (decidingAction.current) return false;
    decidingAction.current = true;
    setActionBusy(true);
    try {
      if (approve) await beforePrepareSources?.();
      return await scope.decideAction(chatId, actionId, approve);
    } finally {
      decidingAction.current = false;
      setActionBusy(false);
    }
  }

  useLayoutEffect(() => {
    if (viewport.current)
      viewport.current.scrollTop = lastMessage.current?.offsetTop ?? 0;
  }, [chat?.id, latest?.id, latest?.status]);

  async function changeConversation(operation: Promise<boolean>) {
    if (await operation) setComposerVersion((current) => current + 1);
  }

  return (
    <section
      className={`chat-shell ${docked ? "chat-docked" : ""} ${historyOpen ? "chat-history-open" : ""} ${fullWidth ? "chat-full-width" : ""} ${historyWidth < 110 ? "chat-history-compact" : ""}`}
      style={
        {
          "--chat-history-width": `${historyWidth}px`,
          "--composer-height": `${composerHeight}px`,
        } as CSSProperties
      }
      aria-label={projectName ? "Project Assistant" : "Global Assistant"}
    >
      <aside
        id={historyId}
        className="chat-history"
        aria-label="Chat history"
        hidden={docked && !historyOpen}
      >
        <div className="chat-history-header">
          <span>
            <History size={15} aria-hidden="true" /> History
          </span>
          <div className="chat-history-actions">
            <button
              className="icon-button"
              type="button"
              aria-label="New chat"
              title="New chat"
              disabled={!desktop || scope.loading || scope.busy}
              onClick={() => void changeConversation(scope.create())}
            >
              <Plus size={17} />
            </button>
            <button
              className="icon-button"
              type="button"
              aria-label={
                showArchived ? "Hide archived chats" : "Show archived chats"
              }
              aria-pressed={showArchived}
              title={
                showArchived ? "Hide archived chats" : "Show archived chats"
              }
              onClick={() => setShowArchived((shown) => !shown)}
            >
              <Archive size={16} />
            </button>
          </div>
        </div>
        <div className="chat-history-list">
          {visibleChats.map((item) => (
            <button
              key={item.id}
              className="chat-history-item"
              type="button"
              aria-current={item.id === chat?.id ? "true" : undefined}
              title={item.archived ? `${item.title} (Archived)` : item.title}
              aria-label={item.title || "New conversation"}
              disabled={scope.busy}
              onClick={() => {
                if (item.id !== chat?.id)
                  void changeConversation(scope.open(item.id));
              }}
            >
              {item.pending ? (
                <LoaderCircle
                  size={15}
                  className="spin"
                  aria-label="Waiting for response"
                />
              ) : item.archived ? (
                <Archive size={15} aria-label="Archived" />
              ) : (
                <MessageSquare size={15} aria-hidden="true" />
              )}
              <span className="chat-history-label">
                <span>{item.title || "New conversation"}</span>
                {item.updatedAt > 0 && (
                  <small>
                    {item.archived ? "Archived · " : ""}
                    {relativeTime(item.updatedAt)}
                  </small>
                )}
              </span>
            </button>
          ))}
          {!scope.loading && !visibleChats.length && (
            <p>
              {scope.chats.length
                ? "No active conversations. Show archived chats to view them."
                : "No conversations yet"}
            </p>
          )}
        </div>
        {!docked && (
          <PanelResizeHandle
            width={historyWidth}
            onResize={setHistoryWidth}
            label="Resize chat history"
            controls={historyId}
            min={50}
            max={370}
          />
        )}
      </aside>
      <div className="chat-main">
        <header className="chat-heading">
          {docked && (
            <button
              type="button"
              className="icon-button"
              aria-label="Toggle chat history"
              aria-expanded={historyOpen}
              title="Chat history"
              onClick={() => setHistoryOpen((open) => !open)}
            >
              <History size={16} />
            </button>
          )}
          {projectName ? <Sparkles size={19} /> : <Globe2 size={19} />}
          <div>
            <h2>{projectName ? "Project Assistant" : "Global Assistant"}</h2>
            <p>{projectName || "Project catalog included with each request"}</p>
          </div>
          <div className="chat-heading-actions">
            <button
              type="button"
              className="icon-button"
              aria-label={fullWidth ? "Use contained width" : "Use full width"}
              aria-pressed={fullWidth}
              title={fullWidth ? "Use contained width" : "Use full width"}
              onClick={() => setFullWidth((value) => !value)}
            >
              {fullWidth ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
            </button>
            {docked && (
              <button
                className="icon-button"
                type="button"
                aria-label="New chat"
                title="New chat"
                disabled={!desktop || scope.loading || scope.busy}
                onClick={() => void changeConversation(scope.create())}
              >
                <Plus size={16} />
              </button>
            )}
            {chat && (
              <button
                className="icon-button"
                type="button"
                aria-label={chat.archived ? "Restore chat" : "Archive chat"}
                title={
                  chat.pending
                    ? "Stop the request before archiving this chat"
                    : chat.archived
                      ? "Restore chat"
                      : "Archive chat"
                }
                disabled={scope.busy || chat.pending || actionBusy}
                onClick={() =>
                  void changeConversation(
                    scope.setArchived(chat.id, !chat.archived),
                  )
                }
              >
                {chat.archived ? (
                  <ArchiveRestore size={16} />
                ) : (
                  <Archive size={16} />
                )}
              </button>
            )}
            {onTogglePin && (
              <button
                type="button"
                className="icon-button"
                aria-label={
                  pinned ? "Unpin assistant" : "Pin assistant to side"
                }
                aria-pressed={pinned}
                title={
                  pinned
                    ? "Unpin assistant"
                    : "Keep this chat beside project files"
                }
                onClick={onTogglePin}
              >
                {pinned ? <PinOff size={16} /> : <Pin size={16} />}
              </button>
            )}
            {chat && (
              <button
                className="icon-button chat-delete"
                type="button"
                aria-label="Delete chat"
                title={
                  chat.pending
                    ? "Stop the request before deleting this chat"
                    : "Delete chat"
                }
                disabled={scope.busy || chat.pending}
                onClick={() => setDeletion({ chatId: chat.id })}
              >
                <Trash2 size={16} />
              </button>
            )}
          </div>
        </header>
        <div
          ref={viewport}
          className="assistant-view"
          role="region"
          aria-label="Conversation messages"
          tabIndex={0}
        >
          <div className="chat-transcript">
            {!thread?.messages.length && (
              <div className="chat-empty">
                <div className="chat-empty-symbol">
                  <Sparkles size={23} />
                </div>
                <h3>
                  {scope.loading
                    ? "Opening conversations…"
                    : projectName
                      ? "What are you working on?"
                      : "Ask across your workspace"}
                </h3>
                <p>
                  {!desktop
                    ? "Open the desktop app to use the Assistant."
                    : model.prefs.loaded && !model.ready
                      ? "Choose a connected provider and model, or open Settings → AI connection."
                      : projectName
                        ? "Drag project files or folders here, use Include in Assistant in Files, or type @ or / to choose sources."
                        : "Your project catalog is included automatically. Use + to choose exact project files, folders, or automatic docs from all projects."}
                </p>
              </div>
            )}
            {thread?.messages.map((message) => (
              <article
                ref={message.id === latest?.id ? lastMessage : undefined}
                key={message.id}
                className={`chat-message ${message.role}`}
                aria-label={
                  message.role === "user"
                    ? "Your message"
                    : "Assistant response"
                }
              >
                <header className="chat-message-heading">
                  <span>{message.role === "user" ? "You" : "Assistant"}</span>
                  {message.createdAt > 0 && (
                    <time
                      dateTime={new Date(message.createdAt).toISOString()}
                      title={new Date(message.createdAt).toLocaleString()}
                    >
                      {relativeTime(message.createdAt)}
                    </time>
                  )}
                  <div className="chat-message-actions">
                    {message.role === "assistant" &&
                      message.status === "complete" && (
                        <button
                          className="icon-button"
                          type="button"
                          aria-label="Copy response"
                          title="Copy response"
                          onClick={async () => {
                            try {
                              await navigator.clipboard.writeText(
                                message.content,
                              );
                            } catch (error) {
                              onError(messageOf(error));
                            }
                          }}
                        >
                          <Copy size={14} />
                        </button>
                      )}
                    <button
                      className="icon-button chat-delete"
                      type="button"
                      aria-label="Delete message"
                      title="Delete message"
                      disabled={scope.busy || thread.chat.pending}
                      onClick={() =>
                        setDeletion({
                          chatId: thread.chat.id,
                          messageId: message.id,
                        })
                      }
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </header>
                <MessageContent message={message} />
                {projectId &&
                  message.actions?.map((action) => (
                    <AssistantFileAction
                      key={action.id}
                      action={action}
                      disabled={
                        scope.busy ||
                        actionBusy ||
                        Boolean(chat?.pending) ||
                        Boolean(chat?.archived)
                      }
                      onDecision={(approve) =>
                        decideAction(thread.chat.id, action.id, approve)
                      }
                    />
                  ))}
              </article>
            ))}
          </div>
        </div>
        <div ref={composerOverlay} className="chat-composer-overlay">
          <Composer
            resetVersion={composerVersion}
            actionBusy={actionBusy}
            scope={scope}
            projectName={projectName}
            projectId={projectId}
            sourceRequest={sourceRequest}
            beforePrepareSources={beforePrepareSources}
            settings={settings}
            projects={projects}
            onInspect={onInspect}
            model={model}
          />
        </div>
      </div>
      {deletion && (
        <Modal
          title={
            deletion.messageId ? "Delete this message?" : "Delete this chat?"
          }
          onClose={() => setDeletion(null)}
        >
          <p>
            {deletion.messageId
              ? "The selected message will be removed from this chat’s history."
              : "All messages in this conversation will be removed from your local history."}
          </p>
          <div className="modal-actions">
            <button
              className="button"
              type="button"
              onClick={() => setDeletion(null)}
            >
              Cancel
            </button>
            <button
              className="button primary"
              type="button"
              disabled={scope.busy}
              onClick={async () => {
                if (deletion.messageId) {
                  await scope.removeMessage(
                    deletion.chatId,
                    deletion.messageId,
                  );
                } else {
                  await changeConversation(scope.remove(deletion.chatId));
                }
                setDeletion(null);
              }}
            >
              {deletion.messageId ? "Delete message" : "Delete chat"}
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}
