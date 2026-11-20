import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
} from "react";
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  ClipboardPaste,
  Copy,
  ExternalLink,
  File,
  FileCode2,
  FileImage,
  FilePlus2,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  GitBranch,
  GitCommitHorizontal,
  History,
  LoaderCircle,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  ScanSearch,
  Scissors,
  Sparkles,
  Terminal,
  Trash2,
  X,
} from "lucide-react";
import type { FileEntry, GitInfo, WorkspaceProps } from "../types";
import { api } from "../api";
import { enabledLaunchers } from "../launchers";
import { beforeNavigate } from "../navigation";
import { acceptFileDrag, containsFilePath } from "../fileOperations";
import { useChatScope } from "../useChatScope";
import { useStoredBoolean } from "../useStoredState";
import { useWorkspaceSession } from "../useWorkspaceSession";
import { useStoredScroll } from "../useStoredScroll";
import { fileSettings, isPreviewImage } from "../fileSettings";
import { clearFileZoom } from "../useFileZoom";
import ImagePreview from "./ImagePreview";
import Assistant from "./Assistant";
import DocumentPreview from "./DocumentPreview";
import Editor from "./Editor";
import ProjectInspector from "./ProjectInspector";
import FileTree from "./FileTree";
import useFileOperations from "./useFileOperations";
import { useContextMenu, type MenuAction } from "./ContextMenus";
import PanelResizeHandle, { usePanelWidth } from "./PanelResizeHandle";
import "./workspace.css";

function FileIcon({ entry }: { entry: FileEntry }) {
  if (entry.directory) return <Folder size={17} className="file-icon folder" />;
  if (/\.(md|txt|log|csv|xlsx|docx)$/i.test(entry.name))
    return <FileText size={16} className="file-icon text" />;
  if (/\.(png|jpe?g|gif|svg|webp|ico)$/i.test(entry.name))
    return <FileImage size={16} className="file-icon image" />;
  if (
    /\.(js|jsx|ts|tsx|json|css|html|rs|py|c|cpp|cs|yml|yaml|toml)$/i.test(
      entry.name,
    )
  )
    return <FileCode2 size={16} className="file-icon code" />;
  return <File size={16} className="file-icon" />;
}
export default function Workspace({
  project,
  settings,
  openFile,
  onError,
  onProjectContextMenu,
}: WorkspaceProps) {
  const [workspaceSession, setWorkspaceSession] = useWorkspaceSession(
    project.id,
    settings.files,
  );
  const filesConfig = fileSettings(settings.files);
  const rememberPositions =
    filesConfig.rememberSession && filesConfig.rememberPositions;
  const {
    tab,
    directory,
    openFiles,
    activeFile: file,
    expandedFolders,
    explorerVisible,
  } = workspaceSession;
  const setTab = (tab: typeof workspaceSession.tab) =>
    setWorkspaceSession((current) => ({ ...current, tab }));
  const setDirectory = (next: import("react").SetStateAction<string>) =>
    setWorkspaceSession((current) => ({
      ...current,
      directory: typeof next === "function" ? next(current.directory) : next,
    }));
  const setExplorerVisible = (explorerVisible: boolean) =>
    setWorkspaceSession((current) => ({ ...current, explorerVisible }));
  function openFileTab(path: string) {
    setWorkspaceSession((current) => {
      if (!current.openFiles.includes(path)) clearFileZoom(project.id, path);
      return {
        ...current,
        activeFile: path,
        openFiles: current.openFiles.includes(path)
          ? current.openFiles
          : [...current.openFiles, path],
      };
    });
  }
  function closeFileTab(path: string) {
    void navigate(() =>
      setWorkspaceSession((current) => {
        clearFileZoom(project.id, path);
        const openFiles = current.openFiles.filter((file) => file !== path);
        const index = current.openFiles.indexOf(path);
        return {
          ...current,
          openFiles,
          activeFile:
            current.activeFile === path
              ? (openFiles[Math.min(index, openFiles.length - 1)] ?? "")
              : current.activeFile,
        };
      }),
    );
  }
  const explorerScroll = useStoredScroll(
    `foldory:workspace:${project.id}:explorer:${directory}`,
    rememberPositions,
  );
  const tabsScroll = useStoredScroll(
    `foldory:workspace:${project.id}:tabs`,
    rememberPositions,
  );
  const tabList = useRef<HTMLDivElement | null>(null);
  const attachTabs = useCallback(
    (node: HTMLDivElement | null) => {
      tabList.current = node;
      tabsScroll(node);
    },
    [tabsScroll],
  );
  const workspaceBody = useRef<HTMLDivElement | null>(null);
  const [bodyWidth, setBodyWidth] = useState(0);
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [selection, setSelection] = useState<FileEntry[]>([]);
  const [assistantPinned, setAssistantPinned] = useStoredBoolean(
    "foldory.assistant-pinned",
  );
  const [assistantWidth, setAssistantWidth] = usePanelWidth(
    "foldory.assistant-width",
    420,
    150,
    Number.MAX_SAFE_INTEGER,
  );
  const [assistantResized, setAssistantResized] = useStoredBoolean(
    "foldory.assistant-resized",
    assistantWidth !== 420,
  );
  const [sourceRequest, setSourceRequest] = useState<{
    token: number;
    paths: string[];
    wordResultId?: string;
  }>();
  const sourceRequestId = useRef(0);
  const [loadedDirectory, setLoadedDirectory] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [directoryError, setDirectoryError] = useState("");
  const [create, setCreate] = useState<"file" | "folder" | null>(null);
  const [entryName, setEntryName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createDirectory, setCreateDirectory] = useState("");
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [explorerWidth, setExplorerWidth] = usePanelWidth(
    "foldory.explorer-width",
    238,
  );
  const showMenu = useContextMenu();
  const [toolsOpen, setToolsOpen] = useState(false);
  const [git, setGit] = useState<GitInfo | null>(null);
  const [gitBusy, setGitBusy] = useState(false);
  const [gitError, setGitError] = useState("");
  const [overviewExists, setOverviewExists] = useState<boolean | null>(null);
  const [overviewError, setOverviewError] = useState("");
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [overviewVersion, setOverviewVersion] = useState(0);
  const [assistantFileVersions, setAssistantFileVersions] = useState<
    Record<string, number>
  >({});
  const request = useRef(0);
  const assistant = useChatScope(project.id);
  const assistantPending = assistant.chats.some((chat) => chat.pending);
  const name = project.alias || project.name;
  const assistantDocked = assistantPinned && tab !== "assistant";
  const fileOperations = useFileOperations({
    projectId: project.id,
    onError,
    onChanged: (operation, result) => {
      if (operation.kind !== "copy") {
        const remap = (path: string) => {
          const item = result.completed.find((item) =>
            containsFilePath(item.source, path),
          );
          if (item)
            return item.destination
              ? `${item.destination}${path.slice(item.source.length)}`
              : "";
          // A folder deletion can fail after removing some children. Close any
          // affected editor so autosave cannot recreate a deleted child.
          if (
            operation.kind === "delete" &&
            operation.paths.some((source) => containsFilePath(source, path))
          )
            return "";
          return path;
        };
        setWorkspaceSession((current) => {
          const openFiles = [
            ...new Set(current.openFiles.map(remap).filter(Boolean)),
          ];
          return {
            ...current,
            openFiles,
            activeFile: remap(current.activeFile) || openFiles[0] || "",
            expandedFolders: current.expandedFolders.map(remap).filter(Boolean),
          };
        });
        setDirectory((current) => {
          const mapped = remap(current);
          if (mapped || !current) return mapped;
          const source = operation.paths.find((source) =>
            containsFilePath(source, current),
          );
          return source?.split("/").slice(0, -1).join("/") ?? "";
        });
      }
      setSelection([]);
      setRefreshVersion((value) => value + 1);
    },
  });

  useEffect(() => {
    const body = workspaceBody.current;
    if (!body) return;
    const observer = new ResizeObserver(() => setBodyWidth(body.clientWidth));
    setBodyWidth(body.clientWidth);
    observer.observe(body);
    return () => observer.disconnect();
  }, []);
  const maxAssistantWidth = Math.max(150, bodyWidth - 150);
  const visibleAssistantWidth = Math.max(
    150,
    Math.min(
      assistantResized
        ? assistantWidth
        : Math.min(assistantWidth, bodyWidth * 0.55),
      maxAssistantWidth,
    ),
  );

  useEffect(() => {
    tabList.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({
      block: "nearest",
      inline: "nearest",
    });
  }, [file, tab]);

  function folderDropProps(destination: string) {
    return {
      onDragOver: (event: import("react").DragEvent<HTMLElement>) => {
        if (!fileOperations.busy && acceptFileDrag(event))
          event.currentTarget.classList.add("file-drop-target");
      },
      onDragLeave: (event: import("react").DragEvent<HTMLElement>) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          event.currentTarget.classList.remove("file-drop-target");
      },
      onDrop: (event: import("react").DragEvent<HTMLElement>) => {
        event.currentTarget.classList.remove("file-drop-target");
        if (!fileOperations.busy) fileOperations.drop(event, destination);
      },
    };
  }

  function assistantFilesChanged(paths: string[]) {
    setRefreshVersion((version) => version + 1);
    setAssistantFileVersions((versions) => {
      const next = { ...versions };
      for (const path of paths)
        next[path.toLowerCase()] = (next[path.toLowerCase()] ?? 0) + 1;
      return next;
    });
    if (paths.some((path) => path.toLowerCase() === "project.md"))
      setOverviewExists(true);
  }

  useEffect(() => setSelection([]), [project.id, directory, tab]);

  function includeInAssistant(paths: string[], wordResultId?: string) {
    setAssistantPinned(true);
    setSourceRequest({ token: ++sourceRequestId.current, paths, wordResultId });
  }

  useEffect(() => setOverviewExists(null), [project.id]);

  useEffect(() => {
    let cancelled = false;
    setOverviewError("");
    api
      .listDirectory(project.id, "")
      .then((result) => {
        if (!cancelled)
          setOverviewExists(
            result.some(
              (entry) =>
                !entry.directory && entry.name.toLowerCase() === "project.md",
            ),
          );
      })
      .catch((error) => {
        if (!cancelled) {
          setOverviewError(String(error));
          setOverviewExists(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [project.id, refreshVersion]);

  useEffect(() => {
    if (!openFile) return;
    setTab("files");
    if (!openFile.directory) openFileTab(openFile.path);
    setDirectory(
      openFile.directory
        ? openFile.path
        : openFile.path.split("/").slice(0, -1).join("/"),
    );
  }, [openFile?.token, openFile?.path, openFile?.directory]);

  useEffect(() => {
    if (tab !== "files") return;
    const id = ++request.current;
    setBusy(true);
    setDirectoryError("");
    api
      .listDirectory(project.id, directory)
      .then((result) => {
        if (id === request.current) {
          setEntries(result);
          setLoadedDirectory(directory);
        }
      })
      .catch((error) => {
        if (id === request.current) {
          setEntries([]);
          setDirectoryError(String(error));
        }
      })
      .finally(() => {
        if (id === request.current) setBusy(false);
      });
    return () => {
      ++request.current;
    };
  }, [project.id, directory, tab, refreshVersion]);

  useEffect(() => {
    if (tab === "git") void loadGit();
  }, [tab, project.id]);

  async function navigate(action: () => void) {
    try {
      await beforeNavigate();
      action();
    } catch (error) {
      onError(
        `Finish saving the current file before navigating. ${String(error)}`,
      );
    }
  }
  async function loadGit() {
    setGitBusy(true);
    setGitError("");
    try {
      setGit(await api.gitInfo(project.id));
    } catch (error) {
      setGitError(String(error));
    } finally {
      setGitBusy(false);
    }
  }
  async function refreshFiles() {
    setSelection([]);
    setRefreshVersion((value) => value + 1);
  }
  async function createEntry(event: React.FormEvent) {
    event.preventDefault();
    if (!entryName.trim() || !create) return;
    setCreating(true);
    const path = [createDirectory, entryName.trim()].filter(Boolean).join("/");
    try {
      await api.createEntry(project.id, path, create === "folder");
      setCreate(null);
      setEntryName("");
      await refreshFiles();
      if (create === "file") await navigate(() => openFileTab(path));
    } catch (error) {
      onError(String(error));
    } finally {
      setCreating(false);
    }
  }
  async function makeOverview() {
    try {
      await api.createEntry(project.id, "PROJECT.md", false);
      setOverviewExists(true);
    } catch (error) {
      onError(String(error));
    }
  }
  function launch(id: string) {
    setToolsOpen(false);
    void api
      .launchTool(project.id, id)
      .catch((error) => onError(String(error)));
  }

  function startCreate(kind: "file" | "folder", parent = directory) {
    setCreate(kind);
    setCreateDirectory(parent);
    setEntryName("");
  }
  function fileMenu(
    event: MouseEvent<HTMLElement>,
    entry?: FileEntry,
    toggle?: () => void,
    expanded?: boolean,
    selectedEntries?: FileEntry[],
  ) {
    const path = entry?.path ?? directory;
    const parent = entry?.directory ? path : directory;
    const toolPath =
      entry && !entry.directory ? path.split("/").slice(0, -1).join("/") : path;
    const actions: MenuAction[] = [];
    const sources = selectedEntries?.length
      ? selectedEntries
      : entry
        ? [entry]
        : [];
    if (sources.length)
      actions.push({
        label: "Include in Assistant",
        icon: <Sparkles size={14} />,
        run: () => includeInAssistant(sources.map((source) => source.path)),
      });
    if (entry)
      actions.push({
        label: entry.directory ? "Open folder" : "Open file",
        icon: entry.directory ? <FolderOpen size={14} /> : <File size={14} />,
        run: () =>
          entry.directory
            ? setDirectory(path)
            : navigate(() => openFileTab(path)),
      });
    if (toggle)
      actions.push({
        label: expanded ? "Collapse folder" : "Expand folder",
        icon: expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />,
        run: toggle,
      });
    if (sources.length)
      actions.push(
        {
          label: "Cut",
          shortcut: "Ctrl+X",
          icon: <Scissors size={14} />,
          disabled: fileOperations.busy,
          run: () => fileOperations.cut(sources),
        },
        {
          label: "Copy",
          shortcut: "Ctrl+C",
          icon: <Copy size={14} />,
          disabled: fileOperations.busy,
          run: () => fileOperations.copy(sources),
        },
      );
    actions.push({
      label: entry?.directory ? "Paste into folder" : "Paste",
      shortcut: "Ctrl+V",
      icon: <ClipboardPaste size={14} />,
      disabled: !fileOperations.clipboard || fileOperations.busy,
      run: () => {
        void fileOperations.paste(entry?.directory ? path : toolPath);
      },
    });
    if (sources.length)
      actions.push({
        label: "Delete…",
        shortcut: "Del",
        icon: <Trash2 size={14} />,
        disabled: fileOperations.busy,
        run: () => fileOperations.remove(sources),
      });
    actions.push(
      {
        label: "Copy relative path",
        icon: <Copy size={14} />,
        run: () => navigator.clipboard.writeText(path || "."),
      },
      {
        label: "Copy full path",
        icon: <Copy size={14} />,
        run: () =>
          navigator.clipboard.writeText(
            [project.path.replace(/[\\/]$/, ""), path.replaceAll("/", "\\")]
              .filter(Boolean)
              .join("\\"),
          ),
      },
      {
        label:
          entry && !entry.directory
            ? "Open containing folder"
            : "Open in Explorer",
        icon: <FolderOpen size={14} />,
        run: () => api.launchTool(project.id, "explorer", toolPath),
      },
    );
    if (!entry || entry.directory)
      actions.push(
        {
          label: "New file…",
          icon: <FilePlus2 size={14} />,
          run: () => startCreate("file", parent),
        },
        {
          label: "New folder…",
          icon: <FolderPlus size={14} />,
          run: () => startCreate("folder", parent),
        },
      );
    actions.push({
      label: "Refresh files",
      icon: <RefreshCw size={14} />,
      run: refreshFiles,
    });
    actions.push(
      {
        label: "Start CMD here",
        icon: <Terminal size={14} />,
        run: () => api.launchTool(project.id, "cmd", toolPath),
      },
      {
        label: "Open PowerShell",
        icon: <Terminal size={14} />,
        run: () => api.launchTool(project.id, "powershell", toolPath),
      },
    );
    actions.push(
      ...enabledLaunchers(settings).map((tool, index) => ({
        label: `Start ${tool.name} here`,
        icon: <img className="launcher-logo" src={tool.logo} alt="" />,
        section: index === 0 ? "Supported tools" : undefined,
        run: () => api.launchTool(project.id, tool.id, toolPath),
      })),
    );
    showMenu(
      event,
      sources.length > 1
        ? `${sources.length} selected items`
        : entry?.name || "Project files",
      actions,
    );
  }

  return (
    <div className="workspace">
      <header className="workspace-header">
        <div
          className="workspace-project-title"
          onContextMenu={(event) => {
            if (
              !(event.target instanceof Element) ||
              !event.target.closest(".selectable")
            )
              onProjectContextMenu?.(event);
          }}
        >
          <span
            className="project-marker"
            style={{ background: project.color || "#8da4ec" }}
          >
            <FolderOpen size={18} />
          </span>
          <div>
            <h1>{name}</h1>
            <p className="selectable" title={project.path}>
              {project.path}
            </p>
          </div>
          {!project.available && <span className="badge warning">Offline</span>}
        </div>
        <div className="workspace-actions">
          <button
            className="button"
            onClick={() => launch("explorer")}
            title="Open project in Explorer"
          >
            <FolderOpen size={15} />
            <span>Explorer</span>
          </button>
          <div className="tools-dropdown">
            <button
              className="icon-button"
              aria-label="More project tools"
              aria-expanded={toolsOpen}
              onClick={() => setToolsOpen(!toolsOpen)}
            >
              <MoreHorizontal size={19} />
            </button>
            {toolsOpen && (
              <>
                <button
                  className="dropdown-scrim"
                  tabIndex={-1}
                  aria-label="Close tools"
                  onClick={() => setToolsOpen(false)}
                />
                <div className="tools-menu">
                  <button onClick={() => launch("cmd")}>
                    <Terminal size={15} /> Command Prompt
                  </button>
                  <button onClick={() => launch("powershell")}>
                    <Terminal size={15} /> PowerShell
                  </button>
                  {enabledLaunchers(settings).length > 0 && (
                    <div className="launcher-menu-label">Supported tools</div>
                  )}
                  {enabledLaunchers(settings).map((tool) => (
                    <button
                      key={tool.id}
                      disabled={!project.available}
                      onClick={() => launch(tool.id)}
                    >
                      <img className="launcher-logo" src={tool.logo} alt="" />
                      {tool.name}
                    </button>
                  ))}
                  {settings.tools.length > 0 && (
                    <div className="launcher-menu-label">Custom tools</div>
                  )}
                  {settings.tools.map((tool) => (
                    <button key={tool.id} onClick={() => launch(tool.id)}>
                      <ExternalLink size={15} />
                      {tool.name}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      </header>
      <nav className="workspace-tabs" aria-label="Project views">
        {(
          [
            ["overview", FileText, "Overview"],
            ["files", FolderOpen, "Files"],
            ["git", GitBranch, "Git"],
            ["assistant", Sparkles, "Assistant"],
          ] as const
        ).map(([id, Icon, label]) => (
          <button
            key={id}
            className={tab === id ? "active" : ""}
            aria-current={tab === id ? "page" : undefined}
            title={
              id === "assistant" && assistantPending
                ? "Assistant · Waiting for response"
                : undefined
            }
            onClick={() => void navigate(() => setTab(id))}
          >
            {id === "assistant" && assistantPending ? (
              <LoaderCircle
                size={15}
                className="spin chat-pending-indicator"
                aria-hidden="true"
              />
            ) : (
              <Icon size={15} />
            )}
            {label}
          </button>
        ))}
        <span className="workspace-tab-meta">
          {project.client || "Personal project"}
        </span>
      </nav>
      <div
        ref={workspaceBody}
        className={`workspace-body ${assistantDocked ? "assistant-pinned" : ""}`}
      >
        <div
          className="workspace-primary"
          hidden={tab === "assistant"}
          inert={fileOperations.busy}
        >
          {tab === "overview" && (
            <div className="overview-content">
              {overviewExists === null ? (
                <div className="workspace-loading">
                  <LoaderCircle size={19} className="spin" /> Loading project
                  overview…
                </div>
              ) : overviewExists ? (
                <>
                  <div className="overview-inspector-bar">
                    <button
                      className="button"
                      onClick={() =>
                        void navigate(() => setInspectorOpen(true))
                      }
                    >
                      <ScanSearch size={15} /> Project inspector
                    </button>
                  </div>
                  <Editor
                    key={`${project.id}:overview:${overviewVersion}`}
                    projectId={project.id}
                    path="PROJECT.md"
                    preferences={settings.files}
                    refreshVersion={assistantFileVersions["project.md"] ?? 0}
                    onError={onError}
                  />
                </>
              ) : (
                <div className="empty-state overview-empty">
                  <FileText size={38} />
                  <h2>A home for your project</h2>
                  <p>
                    {overviewError ||
                      "Add an overview, useful links and next steps in PROJECT.md. The file stays with your project."}
                  </p>
                  <div className="overview-empty-actions">
                    {!overviewError && (
                      <button
                        className="button primary"
                        onClick={() => void makeOverview()}
                      >
                        <FilePlus2 size={15} /> Create PROJECT.md
                      </button>
                    )}
                    <button
                      className="button"
                      onClick={() => setInspectorOpen(true)}
                    >
                      <ScanSearch size={15} /> Project inspector
                    </button>
                  </div>
                </div>
              )}
              {inspectorOpen && (
                <ProjectInspector
                  projectId={project.id}
                  projectName={name}
                  available={project.available}
                  aiSettings={settings}
                  onClose={() => setInspectorOpen(false)}
                  onSaved={() => {
                    setInspectorOpen(false);
                    setOverviewExists(true);
                    setOverviewVersion((version) => version + 1);
                  }}
                />
              )}
            </div>
          )}
          {tab === "files" && (
            <div
              className={`files-workspace ${explorerVisible ? "" : "explorer-collapsed"}`}
              style={
                { "--explorer-width": `${explorerWidth}px` } as CSSProperties
              }
            >
              {explorerVisible && (
                <aside
                  id="project-files"
                  className="file-explorer"
                  aria-label="Project files"
                  tabIndex={0}
                  aria-busy={fileOperations.busy}
                  onKeyDown={(event) => {
                    if (
                      event.target instanceof Element &&
                      event.target.closest(
                        "input, textarea, [contenteditable='true']",
                      )
                    )
                      return;
                    if (fileOperations.busy || event.altKey) return;
                    const modifier = event.ctrlKey || event.metaKey;
                    const key = event.key.toLowerCase();
                    if (
                      modifier &&
                      !event.shiftKey &&
                      (key === "x" || key === "c")
                    ) {
                      if (!selection.length) return;
                      event.preventDefault();
                      if (key === "x") fileOperations.cut(selection);
                      else fileOperations.copy(selection);
                    } else if (modifier && !event.shiftKey && key === "v") {
                      if (!fileOperations.clipboard) return;
                      event.preventDefault();
                      void fileOperations.paste(
                        selection.length === 1
                          ? selection[0].directory
                            ? selection[0].path
                            : selection[0].path
                                .split("/")
                                .slice(0, -1)
                                .join("/")
                          : directory,
                      );
                    } else if (
                      !modifier &&
                      event.key === "Delete" &&
                      selection.length
                    ) {
                      event.preventDefault();
                      void fileOperations.remove(selection);
                    } else if (event.key === "Escape") fileOperations.clear();
                  }}
                  onContextMenu={(event) => {
                    if (
                      !(event.target instanceof Element) ||
                      !event.target.closest(
                        "input, textarea, .explorer-message.error",
                      )
                    )
                      fileMenu(event);
                  }}
                >
                  <div className="explorer-heading">
                    <span>PROJECT FILES</span>
                    <div>
                      {fileOperations.clipboard && (
                        <button
                          className="icon-button small"
                          title={`Paste ${fileOperations.clipboard.paths.length} item(s) into ${directory || name}`}
                          aria-label="Paste into current folder"
                          disabled={fileOperations.busy}
                          onClick={() => void fileOperations.paste(directory)}
                        >
                          <ClipboardPaste size={15} />
                        </button>
                      )}
                      <button
                        className="icon-button small"
                        title="New file"
                        aria-label="New file"
                        onClick={() => startCreate("file")}
                      >
                        <FilePlus2 size={15} />
                      </button>
                      <button
                        className="icon-button small"
                        title="New folder"
                        aria-label="New folder"
                        onClick={() => startCreate("folder")}
                      >
                        <FolderPlus size={15} />
                      </button>
                      <button
                        className="icon-button small"
                        title="Refresh files"
                        aria-label="Refresh files"
                        onClick={() => void refreshFiles()}
                      >
                        <RefreshCw size={14} className={busy ? "spin" : ""} />
                      </button>
                    </div>
                  </div>
                  <div className="file-breadcrumbs">
                    <button
                      onClick={() => setDirectory("")}
                      title={name}
                      aria-label="Project root"
                      {...folderDropProps("")}
                    >
                      <Folder size={13} />
                    </button>
                    {directory
                      .split("/")
                      .filter(Boolean)
                      .map((part, index, parts) => (
                        <span key={index}>
                          <ChevronRight size={11} />
                          <button
                            {...folderDropProps(
                              parts.slice(0, index + 1).join("/"),
                            )}
                            onClick={() =>
                              setDirectory(parts.slice(0, index + 1).join("/"))
                            }
                          >
                            {part}
                          </button>
                        </span>
                      ))}
                  </div>
                  {directory && (
                    <button
                      className="parent-folder"
                      {...folderDropProps(
                        directory.split("/").slice(0, -1).join("/"),
                      )}
                      onClick={() =>
                        setDirectory(
                          directory.split("/").slice(0, -1).join("/"),
                        )
                      }
                    >
                      <ArrowLeft size={14} /> Parent folder
                    </button>
                  )}
                  {create && (
                    <form
                      className="new-entry-form"
                      onSubmit={(event) => void createEntry(event)}
                    >
                      <label>
                        {create === "folder" ? "New folder" : "New file"}
                        <small title={createDirectory || name}>
                          In {createDirectory || name}
                        </small>
                        <input
                          autoFocus
                          value={entryName}
                          onChange={(event) => setEntryName(event.target.value)}
                          placeholder={
                            create === "folder" ? "Folder name" : "notes.md"
                          }
                          required
                        />
                      </label>
                      <div>
                        <button
                          className="button small primary"
                          disabled={creating}
                        >
                          {creating ? "Creating…" : "Create"}
                        </button>
                        <button
                          type="button"
                          className="button small"
                          onClick={() => setCreate(null)}
                        >
                          Cancel
                        </button>
                      </div>
                    </form>
                  )}
                  <div
                    ref={explorerScroll}
                    className="file-entry-list"
                    {...folderDropProps(directory)}
                  >
                    {busy &&
                    (!entries.length || loadedDirectory !== directory) ? (
                      <div className="explorer-message">
                        <LoaderCircle size={16} className="spin" /> Loading…
                      </div>
                    ) : directoryError ? (
                      <div className="explorer-message error">
                        {directoryError}
                      </div>
                    ) : !entries.length ? (
                      <div className="explorer-message muted">
                        This folder is empty.
                      </div>
                    ) : (
                      <FileTree
                        key={`${project.id}:${directory}`}
                        projectId={project.id}
                        entries={entries}
                        selected={file}
                        expandedPaths={expandedFolders}
                        onToggleFolder={(path, expanded) =>
                          setWorkspaceSession((current) => ({
                            ...current,
                            expandedFolders: expanded
                              ? [...current.expandedFolders, path]
                              : current.expandedFolders.filter(
                                  (folder) => folder !== path,
                                ),
                          }))
                        }
                        selection={selection}
                        onSelectionChange={setSelection}
                        refreshVersion={refreshVersion}
                        onOpen={(entry) =>
                          entry.directory
                            ? setDirectory(entry.path)
                            : void navigate(() => openFileTab(entry.path))
                        }
                        onMenu={fileMenu}
                        onDrop={fileOperations.drop}
                        cutPaths={
                          fileOperations.clipboard?.kind === "move"
                            ? fileOperations.clipboard.paths
                            : []
                        }
                        operationsDisabled={fileOperations.busy}
                        icon={(entry) => <FileIcon entry={entry} />}
                      />
                    )}
                  </div>
                  {fileOperations.status && (
                    <div className="file-operation-status" role="status">
                      {fileOperations.busy ? "Working… " : ""}
                      {fileOperations.status}
                    </div>
                  )}
                  <footer className="explorer-footer">
                    {selection.length
                      ? `${selection.length} selected`
                      : `${entries.length.toLocaleString()} items`}
                    <span title="Red file and folder icons are excluded from AI by default. Explicit inclusion asks for permission.">
                      Red icons: excluded from AI
                    </span>
                  </footer>
                  <PanelResizeHandle
                    width={explorerWidth}
                    onResize={setExplorerWidth}
                    label="Resize file explorer"
                    controls="project-files"
                  />
                </aside>
              )}
              <div className="file-content">
                <div className="file-content-heading">
                  <button
                    className="icon-button small"
                    aria-label={
                      explorerVisible
                        ? "Hide file explorer"
                        : "Show file explorer"
                    }
                    title={
                      explorerVisible
                        ? "Hide file explorer"
                        : "Show file explorer"
                    }
                    onClick={() => setExplorerVisible(!explorerVisible)}
                  >
                    {explorerVisible ? (
                      <PanelLeftClose size={15} />
                    ) : (
                      <PanelLeftOpen size={15} />
                    )}
                  </button>
                  {openFiles.length ? (
                    <div
                      className="file-tabs"
                      role="tablist"
                      aria-label="Open files"
                      ref={attachTabs}
                      onKeyDown={(event) => {
                        if (
                          !(event.target instanceof HTMLElement) ||
                          event.target.getAttribute("role") !== "tab"
                        )
                          return;
                        const buttons = [
                          ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
                            '[role="tab"]',
                          ),
                        ];
                        const index = buttons.indexOf(
                          event.target as HTMLButtonElement,
                        );
                        const next =
                          event.key === "Home"
                            ? 0
                            : event.key === "End"
                              ? buttons.length - 1
                              : event.key === "ArrowLeft"
                                ? (index + buttons.length - 1) % buttons.length
                                : event.key === "ArrowRight"
                                  ? (index + 1) % buttons.length
                                  : null;
                        if (next === null) return;
                        event.preventDefault();
                        void navigate(() => {
                          openFileTab(openFiles[next]);
                          buttons[next].focus();
                        });
                      }}
                      onWheel={(event) => {
                        if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
                          event.currentTarget.scrollLeft += event.deltaY;
                        }
                      }}
                    >
                      {openFiles.map((path) => (
                        <div
                          className={`file-tab ${file === path ? "active" : ""}`}
                          key={path}
                        >
                          <button
                            id={`file-tab-${encodeURIComponent(path)}`}
                            role="tab"
                            aria-selected={file === path}
                            tabIndex={file === path ? 0 : -1}
                            aria-controls="active-file-panel"
                            title={path}
                            onClick={() =>
                              void navigate(() => openFileTab(path))
                            }
                          >
                            <span>{path.split("/").pop()}</span>
                          </button>
                          <button
                            className="file-tab-close"
                            aria-label={`Close ${path}`}
                            title={`Close ${path}`}
                            onClick={() => closeFileTab(path)}
                          >
                            <X size={12} />
                          </button>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <span className="muted">Select a file</span>
                  )}
                  {file && (
                    <button
                      className="icon-button small file-external"
                      aria-label="Open file in default app"
                      title="Open file in default app"
                      onClick={() =>
                        void api
                          .launchTool(project.id, "default", file)
                          .catch((error) => onError(String(error)))
                      }
                    >
                      <ExternalLink size={14} />
                    </button>
                  )}
                </div>
                <div
                  id="active-file-panel"
                  className="file-panel"
                  role="tabpanel"
                  aria-labelledby={
                    file ? `file-tab-${encodeURIComponent(file)}` : undefined
                  }
                >
                  {file ? (
                    isPreviewImage(file) ? (
                      <ImagePreview
                        key={`${project.id}:${file}`}
                        projectId={project.id}
                        path={file}
                        refreshVersion={
                          refreshVersion +
                          (assistantFileVersions[file.toLowerCase()] ?? 0)
                        }
                        onNavigate={(path) =>
                          void navigate(() =>
                            setWorkspaceSession((current) => ({
                              ...current,
                              activeFile: path,
                              openFiles: current.openFiles.includes(path)
                                ? current.openFiles
                                : current.openFiles.map((open) =>
                                    open === current.activeFile ? path : open,
                                  ),
                            })),
                          )
                        }
                      />
                    ) : /\.(csv|xlsx|docx)$/i.test(file) ? (
                      <DocumentPreview
                        key={`${project.id}:${file}`}
                        projectId={project.id}
                        path={file}
                        refreshVersion={
                          assistantFileVersions[file.toLowerCase()] ?? 0
                        }
                        settings={settings}
                        onInclude={(resultId) =>
                          includeInAssistant([file], resultId)
                        }
                        onSaved={(saved) => assistantFilesChanged([saved])}
                        onError={onError}
                      />
                    ) : (
                      <Editor
                        key={`${project.id}:${file}`}
                        projectId={project.id}
                        path={file}
                        preferences={settings.files}
                        refreshVersion={
                          assistantFileVersions[file.toLowerCase()] ?? 0
                        }
                        onError={onError}
                      />
                    )
                  ) : (
                    <div className="empty-state">
                      <FolderOpen size={38} />
                      <h2>Your project, within reach</h2>
                      <p>
                        Choose a file to read or edit it. Markdown supports a
                        live split preview, and your edits save automatically.
                      </p>
                      <span className="muted">
                        Browse folders on the left to get started.
                      </span>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
          {tab === "git" && (
            <div className="git-view">
              <div className="section-heading">
                <div>
                  <h2>Repository activity</h2>
                  <p className="muted">
                    A read-only view of your working tree and recent commits.
                  </p>
                </div>
                <button
                  className="button"
                  disabled={gitBusy}
                  onClick={() => void loadGit()}
                >
                  <RefreshCw size={14} className={gitBusy ? "spin" : ""} />
                  Refresh
                </button>
              </div>
              {gitError ? (
                <div className="inline-error" role="alert">
                  {gitError}
                </div>
              ) : gitBusy && !git ? (
                <div className="workspace-loading">
                  <LoaderCircle size={19} className="spin" /> Reading Git
                  repository…
                </div>
              ) : git && (!git.available || !git.isRepo) ? (
                <div className="empty-state">
                  <GitBranch size={36} />
                  <h3>
                    {!git.available
                      ? "Git is unavailable"
                      : "No Git repository"}
                  </h3>
                  <p>{git.message}</p>
                </div>
              ) : (
                git && (
                  <>
                    <div className="git-summary card">
                      <GitBranch size={19} />
                      <strong>{git.branch || "Unborn branch"}</strong>
                      <span className="badge">
                        {git.changes.length
                          ? `${git.changes.length} changes`
                          : "Working tree clean"}
                      </span>
                    </div>
                    {git.message && <p className="muted">{git.message}</p>}
                    {git.changes.length > 0 && (
                      <section className="git-changes card">
                        <h3>Working tree</h3>
                        {git.changes.map((change, i) => (
                          <div className="git-change" key={`${i}:${change}`}>
                            <span className="git-change-code">
                              {change.slice(0, 2)}
                            </span>
                            <code>{change.slice(3) || change}</code>
                          </div>
                        ))}
                      </section>
                    )}
                    <section className="git-history">
                      <h3>
                        <History size={16} /> Recent commits
                      </h3>
                      {!git.commits.length ? (
                        <p className="muted">There are no commits yet.</p>
                      ) : (
                        git.commits.map((commit) => (
                          <article className="commit-row" key={commit.hash}>
                            <GitCommitHorizontal size={18} />
                            <div>
                              <strong>{commit.subject}</strong>
                              <p>
                                {commit.author}
                                <span>·</span>
                                {commit.date}
                              </p>
                            </div>
                            <code title={commit.hash}>
                              {commit.hash.slice(0, 7)}
                            </code>
                          </article>
                        ))
                      )}
                    </section>
                  </>
                )
              )}
            </div>
          )}
        </div>
        <div
          id="project-assistant"
          className={`workspace-assistant ${assistantDocked ? "docked" : ""}`}
          hidden={tab !== "assistant" && !assistantPinned}
          style={
            {
              "--assistant-width": `${visibleAssistantWidth}px`,
            } as CSSProperties
          }
        >
          {assistantDocked && (
            <PanelResizeHandle
              width={visibleAssistantWidth}
              onResize={(width) => {
                setAssistantResized(true);
                setAssistantWidth(width);
              }}
              min={150}
              max={maxAssistantWidth}
              edge="left"
              label="Resize assistant"
              controls="project-assistant"
            />
          )}
          <Assistant
            scope={assistant}
            projectName={name}
            projectId={project.id}
            sourceRequest={sourceRequest}
            beforePrepareSources={beforeNavigate}
            onFilesChanged={assistantFilesChanged}
            pinned={assistantPinned}
            docked={assistantDocked}
            onTogglePin={() =>
              void navigate(() => {
                setAssistantPinned(!assistantPinned);
                setTab(assistantPinned ? "assistant" : "files");
              })
            }
            settings={settings}
            onError={onError}
            onInspect={() =>
              void navigate(() => {
                setTab("overview");
                setInspectorOpen(true);
              })
            }
          />
        </div>
      </div>
      {fileOperations.dialog}
    </div>
  );
}
