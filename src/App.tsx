import AppSelect from "./components/AppSelect";
import projectManagerIcon from "./assets/reflect-fold-app.svg";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type CSSProperties,
} from "react";
import {
  AlertCircle,
  ArrowDownWideNarrow,
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  Folder,
  FolderOpen,
  FolderPlus,
  HardDrive,
  Info,
  LayoutDashboard,
  LoaderCircle,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Pin,
  Plus,
  RefreshCw,
  Search,
  Settings as SettingsIcon,
  Sparkles,
  X,
  EyeOff,
  Eye,
} from "lucide-react";
import { api, desktop } from "./api";
import type { Bootstrap, Project, ProjectPatch, SearchResult } from "./types";
import { matchesProject, messageOf, projectName, relativeTime } from "./utils";
import { beforeNavigate } from "./navigation";
import { useStoredBoolean } from "./useStoredState";
import { integrationsApi } from "./integrations/api";
import type { Integration, IntegrationManifest } from "./integrations/types";
import { useChatScope } from "./useChatScope";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import {
  CreateProject,
  EditProject,
  RenameProject,
} from "./components/ProjectDialogs";
import ProjectContextMenu, {
  type ProjectMenuAnchor,
} from "./components/ProjectContextMenu";
import FileSearch from "./components/FileSearch";
import SidebarFolderSearch from "./components/SidebarFolderSearch";
import SidebarProjectSources from "./components/SidebarProjectSources";
import ContextMenus from "./components/ContextMenus";
import PanelResizeHandle, {
  usePanelWidth,
} from "./components/PanelResizeHandle";
const Workspace = lazy(() => import("./components/Workspace"));
const Settings = lazy(() => import("./components/Settings"));
const Onboarding = lazy(() => import("./components/Onboarding"));
const Assistant = lazy(() => import("./components/Assistant"));
const IntegrationWorkspace = lazy(
  () => import("./integrations/IntegrationWorkspace"),
);
type View =
  "dashboard" | "project" | "settings" | "search" | "assistant" | "integration";
const empty: Bootstrap = {
  sources: [],
  projects: [],
  templates: [],
  settings: {
    tools: [],
    aiBaseUrl: "http://localhost:1234/v1",
    aiModel: "",
    aiHasKey: false,
    scanIntervalSeconds: 60,
  },
  indexStatus: {
    running: false,
    files: 0,
    projects: 0,
    lastIndexed: 0,
    message: "",
  },
};

export default function App() {
  const [data, setData] = useState<Bootstrap>(empty);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<View>("dashboard");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [create, setCreate] = useState(false);
  const [onboarding, setOnboarding] = useState(false);
  const [editing, setEditing] = useState<Project | null>(null);
  const [renaming, setRenaming] = useState<Project | null>(null);
  const [contextAnchor, setContextAnchor] = useState<ProjectMenuAnchor | null>(
    null,
  );
  const [showHidden, setShowHidden] = useState(false);
  const [sourceFilter, setSourceFilter] = useState("");
  const [sort, setSort] = useState("recent");
  const [scanning, setScanning] = useState(false);
  const [openFile, setOpenFile] = useState<{
    path: string;
    token: number;
    directory?: boolean;
  }>();
  const [collapsed, setCollapsed] = useState(false);
  const [allProjectsFolded, setAllProjectsFolded] = useStoredBoolean(
    "foldory.all-projects-folded",
  );
  const [workspacesFolded, setWorkspacesFolded] = useStoredBoolean(
    "foldory.workspaces-folded",
  );
  const [pinnedFolded, setPinnedFolded] = useStoredBoolean(
    "foldory.pinned-folded",
    true,
  );
  const [recentFolded, setRecentFolded] = useStoredBoolean(
    "foldory.recent-folded",
    true,
  );
  const [sourceView, setSourceView] = useStoredBoolean("foldory.source-view");
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [integrationCatalog, setIntegrationCatalog] = useState<
    IntegrationManifest[]
  >([]);
  const [integrationId, setIntegrationId] = useState<string | null>(null);
  const [integrationError, setIntegrationError] = useState("");
  const refreshIntegrations = useCallback(async () => {
    const [items, providers] = await Promise.all([
      integrationsApi.list(),
      integrationsApi.catalog(),
    ]);
    setIntegrations(items);
    setIntegrationCatalog(providers);
    setIntegrationError("");
  }, []);
  useEffect(() => {
    if (desktop)
      void refreshIntegrations().catch((e) =>
        setIntegrationError(messageOf(e)),
      );
  }, [refreshIntegrations]);
  const workspaceIntegrations = integrations.filter(
    (item) =>
      item.enabled &&
      integrationCatalog.some(
        (provider) =>
          provider.id === item.providerId &&
          provider.capabilities.includes("workspace"),
      ),
  );
  const activeIntegration = workspaceIntegrations.find(
    (item) => item.id === integrationId,
  );
  const [sidebarWidth, setSidebarWidth] = usePanelWidth(
    "foldory.sidebar-width",
    267,
  );
  const globalAssistant = useChatScope(null);
  const globalPending = globalAssistant.chats.some((chat) => chat.pending);
  const sidebarSearch = useRef<HTMLInputElement>(null);
  const sidebarBody = useRef<HTMLDivElement>(null);
  const libraryScroll = useRef<HTMLDivElement>(null);
  const shortcutPanelTrigger = useRef<HTMLButtonElement>(null);
  const shortcutPanelElement = useRef<HTMLElement>(null);
  const [shortcutPanel, setShortcutPanel] = useState<
    "pinned" | "recent" | null
  >(null);
  const [shortcutPreviewLimit, setShortcutPreviewLimit] = useState(3);
  const [libraryScrollEdges, setLibraryScrollEdges] = useState({
    overflow: false,
    scrolled: false,
    atEnd: true,
  });
  const libraryProjectButtons = useRef(new Map<string, HTMLButtonElement>());
  const measureLibraryScroll = useCallback(() => {
    const library = libraryScroll.current;
    if (!library) return;
    const next = {
      overflow: library.scrollHeight > library.clientHeight + 1,
      scrolled: library.scrollTop > 1,
      atEnd:
        library.scrollTop + library.clientHeight >= library.scrollHeight - 1,
    };
    setLibraryScrollEdges((current) =>
      Object.keys(next).every(
        (key) =>
          current[key as keyof typeof current] ===
          next[key as keyof typeof next],
      )
        ? current
        : next,
    );
  }, []);
  const onError = useCallback((message: string) => setError(message), []);
  const refresh = useCallback(async () => {
    const next = await api.bootstrap();
    setData(next);
  }, []);
  useEffect(() => {
    let disposed = false;
    api
      .bootstrap()
      .then((next) => {
        if (disposed) return;
        setData(next);
        if (next.settings.onboardingCompleted === false) setOnboarding(true);
      })
      .catch((error) => {
        if (!disposed) setError(messageOf(error));
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [refresh]);
  useEffect(() => {
    const library = libraryScroll.current;
    if (!library) return;
    const resize = new ResizeObserver(measureLibraryScroll);
    resize.observe(library);
    const mutation = new MutationObserver(measureLibraryScroll);
    mutation.observe(library, {
      attributes: true,
      childList: true,
      subtree: true,
    });
    library.addEventListener("scroll", measureLibraryScroll, {
      passive: true,
    });
    measureLibraryScroll();
    return () => {
      resize.disconnect();
      mutation.disconnect();
      library.removeEventListener("scroll", measureLibraryScroll);
    };
  }, [loading, measureLibraryScroll]);
  useEffect(() => {
    const body = sidebarBody.current;
    if (!body) return;
    const measure = () => {
      const height = body.clientHeight;
      setShortcutPreviewLimit(
        height >= 700 ? 4 : height >= 520 ? 3 : height >= 390 ? 2 : 1,
      );
    };
    const resize = new ResizeObserver(measure);
    resize.observe(body);
    measure();
    return () => resize.disconnect();
  }, [loading]);
  useEffect(() => {
    if (!shortcutPanel) return;
    const closeWithKeyboard = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setShortcutPanel(null);
      requestAnimationFrame(() => shortcutPanelTrigger.current?.focus());
    };
    const closeOutside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        shortcutPanelElement.current?.contains(target) ||
        shortcutPanelTrigger.current?.contains(target)
      )
        return;
      setShortcutPanel(null);
    };
    window.addEventListener("keydown", closeWithKeyboard);
    window.addEventListener("pointerdown", closeOutside, true);
    return () => {
      window.removeEventListener("keydown", closeWithKeyboard);
      window.removeEventListener("pointerdown", closeOutside, true);
    };
  }, [shortcutPanel]);
  useEffect(() => {
    if (!desktop) return;
    const timer = setInterval(() => {
      refresh().catch(() => {});
    }, 5000);
    return () => clearInterval(timer);
  }, [refresh]);
  useEffect(() => {
    if (!desktop) return;
    let disposed = false;
    const cleanup: (() => void)[] = [];
    let closing = false;
    void listen("library-changed", () => {
      void refresh().catch((error) => onError(messageOf(error)));
    }).then((stop) => {
      if (disposed) stop();
      else cleanup.push(stop);
    });
    void listen<string>("maintenance-error", (event) =>
      onError(event.payload),
    ).then((stop) => {
      if (disposed) stop();
      else cleanup.push(stop);
    });
    void getCurrentWindow()
      .onCloseRequested(async (event) => {
        event.preventDefault();
        if (closing) return;
        closing = true;
        try {
          await beforeNavigate();
          await getCurrentWindow().destroy();
        } catch (error) {
          onError(messageOf(error));
          closing = false;
        }
      })
      .then((stop) => {
        if (disposed) stop();
        else cleanup.push(stop);
      });
    return () => {
      disposed = true;
      cleanup.forEach((stop) => stop());
    };
  }, [refresh, onError]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 3500);
    return () => clearTimeout(timer);
  }, [notice]);
  const mergeProject = useCallback(
    (project: Project) =>
      setData((previous) => ({
        ...previous,
        projects: previous.projects.some((item) => item.id === project.id)
          ? previous.projects.map((item) =>
              item.id === project.id ? project : item,
            )
          : [...previous.projects, project],
      })),
    [],
  );
  const navigate = useCallback(
    async (target: View) => {
      try {
        await beforeNavigate();
        setView(target);
        setError("");
      } catch (error) {
        onError(messageOf(error));
      }
    },
    [onError],
  );
  async function openIntegration(id: string) {
    try {
      await beforeNavigate();
      setIntegrationId(id);
      setView("integration");
      setError("");
    } catch (error) {
      onError(messageOf(error));
    }
  }
  const selectProject = useCallback(
    async (project: Project, file?: string, directory = false) => {
      try {
        await beforeNavigate();
        if (!project.available)
          throw new Error(
            "This project is offline. Reconnect its drive and refresh your sources.",
          );
        const touched = await api.touchProject(project.id);
        mergeProject(touched);
        setSelectedId(project.id);
        setOpenFile(
          file !== undefined
            ? { path: file, directory, token: Date.now() }
            : undefined,
        );
        setView("project");
        setError("");
      } catch (error) {
        onError(messageOf(error));
      }
    },
    [mergeProject, onError],
  );
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (document.querySelector("dialog[open]")) return;
      if (!(event.ctrlKey || event.metaKey)) return;
      if (event.key.toLowerCase() === "k") {
        event.preventDefault();
        void navigate("search");
      }
      if (event.key.toLowerCase() === "p" && event.shiftKey) {
        event.preventDefault();
        sidebarSearch.current?.focus();
      }
      if (event.key.toLowerCase() === "n" && event.shiftKey) {
        event.preventDefault();
        setCreate(true);
      }
      if (event.key === ",") {
        event.preventDefault();
        void navigate("settings");
      }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [navigate]);
  const filtered = useMemo(
    () =>
      data.projects
        .filter(
          (project) =>
            (showHidden || !project.hidden) &&
            (!sourceFilter || project.sourceId === sourceFilter) &&
            matchesProject(project, filter),
        )
        .sort((a, b) =>
          sort === "name"
            ? projectName(a).localeCompare(projectName(b))
            : sort === "modified"
              ? b.modifiedAt - a.modifiedAt
              : b.lastOpened - a.lastOpened ||
                projectName(a).localeCompare(projectName(b)),
        ),
    [data.projects, filter, showHidden, sourceFilter, sort],
  );
  const sidebarProjects = useMemo(
    () =>
      data.projects
        .filter((project) => !project.hidden && matchesProject(project, filter))
        .sort((a, b) => projectName(a).localeCompare(projectName(b))),
    [data.projects, filter],
  );
  const pinned = sidebarProjects.filter((project) => project.pinned);
  const recent = sidebarProjects
    .filter((project) => project.lastOpened)
    .sort((a, b) => b.lastOpened - a.lastOpened)
    .slice(0, 5);
  const shortcutPreview = (projects: Project[]) => {
    const preview = projects.slice(0, shortcutPreviewLimit);
    const active = projects.find((project) => project.id === selectedId);
    if (
      active &&
      preview.length === shortcutPreviewLimit &&
      !preview.some((project) => project.id === active.id)
    )
      preview[preview.length - 1] = active;
    return preview;
  };
  const pinnedPreview = shortcutPreview(pinned);
  const recentPreview = shortcutPreview(recent);
  const selected = data.projects.find((project) => project.id === selectedId);
  const connectedSources = data.sources.filter(
    (source) => source.connected !== false,
  );
  async function update(project: Project, patch: ProjectPatch) {
    try {
      mergeProject(await api.updateProject(project.id, patch));
    } catch (error) {
      onError(messageOf(error));
    }
  }
  async function scan() {
    setScanning(true);
    try {
      setData(await api.scanSources());
      setNotice("Sources refreshed");
    } catch (error) {
      onError(messageOf(error));
    } finally {
      setScanning(false);
    }
  }
  async function launch(
    project: Project,
    tool: string,
    path: string | null = null,
  ) {
    try {
      await api.launchTool(project.id, tool, path);
      setNotice("Opened in your desktop app");
    } catch (error) {
      onError(messageOf(error));
    }
  }
  async function created(project: Project) {
    mergeProject(project);
    setCreate(false);
    await refresh().catch(() => {});
    await selectProject(project);
    setNotice("Project created");
  }
  function openResult(result: SearchResult) {
    const project = data.projects.find((item) => item.id === result.projectId);
    if (project) void selectProject(project, result.path, result.directory);
  }
  function showProjectMenu(
    project: Project,
    event: ReactMouseEvent<HTMLElement>,
    fromButton = false,
    folderPath?: string,
  ) {
    event.preventDefault();
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    setContextAnchor({
      projectId: project.id,
      folderPath,
      x:
        fromButton || (!event.clientX && !event.clientY)
          ? rect.left
          : event.clientX,
      y:
        fromButton || (!event.clientX && !event.clientY)
          ? rect.bottom + 4
          : event.clientY,
      trigger:
        event.currentTarget instanceof HTMLButtonElement
          ? event.currentTarget
          : (event.currentTarget.querySelector<HTMLElement>(
              ".folder-match-open",
            ) ?? event.currentTarget),
    });
  }
  const contextProject =
    contextAnchor &&
    data.projects.find((project) => project.id === contextAnchor.projectId);
  const renderProject = (
    project: Project,
    location: "shortcut" | "library" = "shortcut",
  ) => (
    <button
      key={project.id}
      ref={
        location === "library"
          ? (element) => {
              if (element)
                libraryProjectButtons.current.set(project.id, element);
              else libraryProjectButtons.current.delete(project.id);
            }
          : undefined
      }
      data-project-id={location === "library" ? project.id : undefined}
      title={project.path}
      className={`sidebar-project ${selectedId === project.id && view === "project" ? "active" : ""}`}
      onClick={() => void selectProject(project)}
      onContextMenu={(event) => showProjectMenu(project, event)}
    >
      <Folder size={16} style={{ color: project.color }} />
      <span>{projectName(project)}</span>
      {!project.available && <Circle size={7} className="offline-dot" />}
    </button>
  );

  function revealLibraryProject(project: Project) {
    setAllProjectsFolded(false);
    if (sourceView && !libraryProjectButtons.current.has(project.id))
      setSourceView(false);
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const scroller = libraryScroll.current;
        const target = libraryProjectButtons.current.get(project.id);
        if (!scroller || !target) return;
        const scrollRect = scroller.getBoundingClientRect();
        const targetRect = target.getBoundingClientRect();
        const top =
          scroller.scrollTop +
          targetRect.top -
          scrollRect.top -
          (scroller.clientHeight - targetRect.height) / 2;
        scroller.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
      }),
    );
  }

  const renderShortcutProject = (
    project: Project,
    reveal = false,
    keepShortcutPanel = false,
  ) => (
    <button
      key={project.id}
      title={project.path}
      className={`sidebar-project ${selectedId === project.id && view === "project" ? "active" : ""}`}
      onClick={() => {
        if (reveal && !filter.trim()) revealLibraryProject(project);
        if (!keepShortcutPanel) setShortcutPanel(null);
        void selectProject(project);
      }}
      onContextMenu={(event) => showProjectMenu(project, event)}
    >
      <Folder size={16} style={{ color: project.color }} />
      <span>{projectName(project)}</span>
      {!project.available && <Circle size={7} className="offline-dot" />}
    </button>
  );

  const content = (
    <div
      className={`app-shell ${collapsed ? "sidebar-collapsed" : ""}`}
      style={{ "--sidebar-width": `${sidebarWidth}px` } as CSSProperties}
    >
      <nav className="app-rail" aria-label="Main navigation">
        <button
          className="brand-mark"
          aria-label="Foldory home"
          title="Foldory"
          onClick={() => void navigate("dashboard")}
        >
          <img src={projectManagerIcon} alt="" />
        </button>
        <div className="rail-links">
          <button
            className={`rail-button ${view === "dashboard" || view === "project" || view === "integration" ? "active" : ""}`}
            title="Projects"
            aria-label="Projects dashboard"
            onClick={() => void navigate("dashboard")}
          >
            <LayoutDashboard size={20} />
          </button>
          <button
            className={`rail-button ${view === "search" ? "active" : ""}`}
            title="Find files (Ctrl K)"
            aria-label="Find files"
            onClick={() => void navigate("search")}
          >
            <Search size={20} />
          </button>
          <button
            className={`rail-button ${view === "assistant" ? "active" : ""} ${globalPending ? "assistant-running" : ""}`}
            title={
              globalPending
                ? "Global Assistant · Waiting for response"
                : "Global Assistant"
            }
            aria-label="Global Assistant"
            aria-current={view === "assistant" ? "page" : undefined}
            onClick={() => void navigate("assistant")}
          >
            {globalPending ? (
              <LoaderCircle size={20} className="spin" />
            ) : (
              <Sparkles size={20} />
            )}
          </button>
        </div>
        <div className="rail-bottom">
          <button
            className={`rail-button ${view === "settings" ? "active" : ""}`}
            title="Settings (Ctrl ,)"
            aria-label="Settings"
            onClick={() => void navigate("settings")}
          >
            <SettingsIcon size={20} />
          </button>
          <div className="local-avatar" title="Local workspace">
            <HardDrive size={16} />
          </div>
        </div>
      </nav>
      <aside
        id="project-library"
        className="project-sidebar"
        aria-label="Project library"
      >
        <div className="sidebar-brand">
          <span>
            Foldory <span className="version-label">v1</span>
          </span>
          <button
            className="icon-button"
            title="Collapse sidebar"
            aria-label="Collapse sidebar"
            onClick={() => setCollapsed(true)}
          >
            <PanelLeftClose size={17} />
          </button>
        </div>
        <div className="sidebar-search-row">
          <div className="search-input">
            <Search size={15} />
            <input
              ref={sidebarSearch}
              aria-label="Filter projects"
              placeholder="Find projects & folders…"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            />
            {filter && (
              <button
                className="icon-button tiny"
                aria-label="Clear project filter"
                onClick={() => setFilter("")}
              >
                <X size={12} />
              </button>
            )}
          </div>
          <button
            className="icon-button new-project-icon"
            title="New project (Ctrl Shift N)"
            aria-label="New project"
            onClick={() => setCreate(true)}
          >
            <Plus size={19} />
          </button>
        </div>
        <div ref={sidebarBody} className="sidebar-body">
          <div className="sidebar-shortcuts">
            {!!workspaceIntegrations.length && (
              <div className="sidebar-section integration-workspaces-nav">
                <button
                  className="sidebar-section-title sidebar-section-toggle"
                  aria-expanded={!workspacesFolded}
                  aria-controls="workspace-list"
                  onClick={() => setWorkspacesFolded(!workspacesFolded)}
                >
                  <span>Workspaces</span>
                  {workspacesFolded ? (
                    <ChevronRight size={13} />
                  ) : (
                    <ChevronDown size={13} />
                  )}
                </button>
                <div id="workspace-list" hidden={workspacesFolded}>
                  <button
                    className={`sidebar-project ${view === "dashboard" ? "active" : ""}`}
                    onClick={() => void navigate("dashboard")}
                  >
                    <LayoutDashboard size={16} />
                    <span>Your projects</span>
                  </button>
                  {workspaceIntegrations.map((item) => (
                    <button
                      key={item.id}
                      className={`sidebar-project ${view === "integration" && item.id === integrationId ? "active" : ""}`}
                      title={item.name}
                      onClick={() => void openIntegration(item.id)}
                    >
                      <LayoutDashboard size={16} />
                      <span>{item.name}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
            {integrationError && (
              <button
                className="sidebar-hint integration-retry"
                title={integrationError}
                onClick={() =>
                  void refreshIntegrations().catch((e) =>
                    setIntegrationError(messageOf(e)),
                  )
                }
              >
                Integrations unavailable · Retry
              </button>
            )}
            <div className="sidebar-section">
              <button
                className="sidebar-section-title sidebar-section-toggle"
                aria-expanded={filter.trim() ? true : !pinnedFolded}
                aria-controls="pinned-projects-list"
                onClick={() => {
                  if (!filter.trim()) setPinnedFolded(!pinnedFolded);
                }}
              >
                <span>Pinned</span>
                <span className="sidebar-section-count">
                  {pinned.length}
                  {filter.trim() || !pinnedFolded ? (
                    <ChevronDown size={13} />
                  ) : (
                    <ChevronRight size={13} />
                  )}
                </span>
              </button>
              <div
                id="pinned-projects-list"
                hidden={!filter.trim() && pinnedFolded}
              >
                {pinned.length ? (
                  pinnedPreview.map((project) =>
                    renderShortcutProject(project, true),
                  )
                ) : (
                  <p className="sidebar-hint">
                    {filter.trim()
                      ? "No pinned projects match."
                      : "Keep your favourites close."}
                  </p>
                )}
                {pinned.length > pinnedPreview.length && (
                  <button
                    type="button"
                    className="sidebar-shortcut-more"
                    aria-label={`View all ${pinned.length} pinned projects`}
                    onClick={(event) => {
                      shortcutPanelTrigger.current = event.currentTarget;
                      setShortcutPanel("pinned");
                    }}
                  >
                    <span>View all</span>
                    <span>
                      +{pinned.length - pinnedPreview.length}
                      <ChevronRight size={13} />
                    </span>
                  </button>
                )}
              </div>
            </div>
            <div className="sidebar-section">
              <button
                className="sidebar-section-title sidebar-section-toggle"
                aria-expanded={!recentFolded}
                aria-controls="recent-projects-list"
                onClick={() => setRecentFolded(!recentFolded)}
              >
                <span>Recently opened</span>
                <span className="sidebar-section-count">
                  {recent.length}
                  {recentFolded ? (
                    <ChevronRight size={13} />
                  ) : (
                    <ChevronDown size={13} />
                  )}
                </span>
              </button>
              <div id="recent-projects-list" hidden={recentFolded}>
                {recent.length ? (
                  recentPreview.map((project) =>
                    renderShortcutProject(project, true),
                  )
                ) : (
                  <p className="sidebar-hint">Your recent work appears here.</p>
                )}
                {recent.length > recentPreview.length && (
                  <button
                    type="button"
                    className="sidebar-shortcut-more"
                    aria-label={`View all ${recent.length} recently opened projects`}
                    onClick={(event) => {
                      shortcutPanelTrigger.current = event.currentTarget;
                      setShortcutPanel("recent");
                    }}
                  >
                    <span>View all</span>
                    <span>
                      +{recent.length - recentPreview.length}
                      <ChevronRight size={13} />
                    </span>
                  </button>
                )}
              </div>
            </div>
          </div>
          {shortcutPanel && (
            <section
              ref={shortcutPanelElement}
              className="sidebar-shortcut-panel"
              role="dialog"
              aria-label={
                shortcutPanel === "pinned"
                  ? "All pinned projects"
                  : "All recently opened projects"
              }
            >
              <div className="sidebar-shortcut-panel-heading">
                <div>
                  <strong>
                    {shortcutPanel === "pinned"
                      ? "Pinned projects"
                      : "Recently opened"}
                  </strong>
                  <span>
                    {(shortcutPanel === "pinned" ? pinned : recent).length}
                  </span>
                </div>
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Close project shortcuts"
                  onClick={() => {
                    setShortcutPanel(null);
                    requestAnimationFrame(() =>
                      shortcutPanelTrigger.current?.focus(),
                    );
                  }}
                >
                  <X size={15} />
                </button>
              </div>
              <div className="sidebar-shortcut-panel-list">
                {(shortcutPanel === "pinned" ? pinned : recent).map((project) =>
                  renderShortcutProject(project, true, true),
                )}
              </div>
            </section>
          )}
          <div className="sidebar-library-pane">
            {!filter.trim() && (
              <div className="all-projects-heading">
                <button
                  className="sidebar-section-title sidebar-section-toggle"
                  aria-expanded={!allProjectsFolded}
                  aria-controls="all-projects-list"
                  onClick={() => setAllProjectsFolded(!allProjectsFolded)}
                >
                  <span>All projects</span>
                  <span className="sidebar-section-count">
                    {sidebarProjects.length}
                    {allProjectsFolded ? (
                      <ChevronRight size={13} />
                    ) : (
                      <ChevronDown size={13} />
                    )}
                  </span>
                </button>
                <button
                  className="icon-button source-view-toggle"
                  aria-label="Source view"
                  aria-pressed={sourceView}
                  aria-controls="all-projects-list"
                  title={`Source view · ${sourceView ? "Show flat list" : "Group projects by source"}`}
                  onClick={() => {
                    setSourceView(!sourceView);
                    setAllProjectsFolded(false);
                  }}
                >
                  <Info size={14} />
                </button>
              </div>
            )}
            <div
              className={`sidebar-scroll-frame sidebar-projects-frame${libraryScrollEdges.scrolled ? " can-scroll-up" : ""}${libraryScrollEdges.overflow && !libraryScrollEdges.atEnd ? " can-scroll-down" : ""}`}
            >
              <div
                ref={libraryScroll}
                className="sidebar-scroll sidebar-projects-scroll"
              >
                {filter.trim() ? (
                  <SidebarFolderSearch
                    query={filter}
                    projects={data.projects}
                    indexStatus={data.indexStatus}
                    onOpen={openResult}
                    onContextMenu={(result, event) => {
                      const project = data.projects.find(
                        (item) => item.id === result.projectId,
                      );
                      if (project)
                        showProjectMenu(project, event, false, result.path);
                    }}
                  />
                ) : (
                  <div className="sidebar-section library-section">
                    <div id="all-projects-list" hidden={allProjectsFolded}>
                      {!allProjectsFolded &&
                        (sourceView ? (
                          <SidebarProjectSources
                            sources={connectedSources}
                            projects={sidebarProjects}
                            renderProject={(project) =>
                              renderProject(project, "library")
                            }
                          />
                        ) : (
                          sidebarProjects.map((project) =>
                            renderProject(project, "library"),
                          )
                        ))}
                      {!sidebarProjects.length &&
                        !(sourceView && connectedSources.length) && (
                          <p className="sidebar-hint">
                            {filter
                              ? "No projects match."
                              : "Add a source to get started."}
                          </p>
                        )}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
        <div className="sidebar-footer">
          <span
            className={`status-dot ${data.indexStatus.running ? "working" : ""}`}
          />
          <span>
            {data.indexStatus.running
              ? "Indexing your workspace…"
              : "Local workspace"}
          </span>
          <span className="sidebar-file-count">
            {data.indexStatus.files.toLocaleString()} files
          </span>
        </div>
        {!collapsed && (
          <PanelResizeHandle
            width={sidebarWidth}
            onResize={setSidebarWidth}
            label="Resize project library"
            controls="project-library"
          />
        )}
      </aside>
      <main className="main-panel">
        <header className="topbar">
          <div className="breadcrumb">
            {collapsed && (
              <button
                className="icon-button"
                title="Expand sidebar"
                aria-label="Expand sidebar"
                onClick={() => setCollapsed(false)}
              >
                <PanelLeftOpen size={18} />
              </button>
            )}
            <button onClick={() => void navigate("dashboard")}>
              Workspace
            </button>
            <span>/</span>
            <strong>
              {view === "project" && selected
                ? projectName(selected)
                : view === "settings"
                  ? "Settings"
                  : view === "search"
                    ? "Search"
                    : view === "assistant"
                      ? "Assistant"
                      : view === "integration" && activeIntegration
                        ? activeIntegration.name
                        : "Projects"}
            </strong>
          </div>
          <div className="topbar-actions">
            <span className="local-label">
              <span className="status-dot" />
              On your computer
            </span>
            <button
              className="icon-button"
              title="Refresh sources"
              aria-label="Refresh sources"
              onClick={() => void scan()}
              disabled={scanning}
            >
              <RefreshCw size={16} className={scanning ? "spin" : ""} />
            </button>
          </div>
        </header>
        {error && (
          <div className="error-banner" role="alert">
            <AlertCircle size={17} />
            <span>{error}</span>
            <button
              className="icon-button"
              title="Dismiss error"
              aria-label="Dismiss error"
              onClick={() => setError("")}
            >
              <X size={16} />
            </button>
          </div>
        )}
        {!desktop && (
          <div className="browser-banner">
            Desktop features require the native app. From the app folder, run{" "}
            <code>npm run tauri dev</code>.
          </div>
        )}
        {loading ? (
          <div className="loading-state">
            <LoaderCircle size={25} className="spin" />
            <p>Opening your workspace…</p>
          </div>
        ) : (
          <Suspense
            fallback={
              <div className="loading-state">
                <LoaderCircle className="spin" />
              </div>
            }
          >
            {view === "settings" ? (
              <Settings
                data={data}
                onRefresh={refresh}
                onError={onError}
                onIntegrationsChanged={refreshIntegrations}
                onOpenIntegration={(id) => void openIntegration(id)}
                onRunOnboarding={() => setOnboarding(true)}
              />
            ) : view === "integration" && activeIntegration ? (
              <IntegrationWorkspace
                key={activeIntegration.id}
                integration={activeIntegration}
                projects={data.projects}
                onOpenProject={(project) => void selectProject(project)}
              />
            ) : view === "assistant" ? (
              <Assistant
                scope={globalAssistant}
                projects={data.projects}
                settings={data.settings}
                onError={onError}
              />
            ) : view === "search" ? (
              <FileSearch
                data={data}
                selectedId={selectedId}
                onOpen={openResult}
                onRefresh={refresh}
                onError={onError}
              />
            ) : view === "project" && selected ? (
              <Workspace
                key={selected.id}
                project={selected}
                settings={data.settings}
                openFile={openFile}
                onError={onError}
                onProjectChange={mergeProject}
                onProjectContextMenu={(event) =>
                  showProjectMenu(selected, event)
                }
              />
            ) : (
              <div className="page dashboard">
                <header className="workspace-page-heading dashboard-workspace-heading">
                  <div>
                    <div className="eyebrow">
                      A LITTLE ORDER. A LOT OF POSSIBILITIES.
                    </div>
                    <h1>
                      Your projects<span className="heading-dot">.</span>
                    </h1>
                    <p className="muted">
                      Everything you’re working on, within reach.
                    </p>
                  </div>
                  <button
                    className="button primary"
                    onClick={() => setCreate(true)}
                  >
                    <Plus size={16} />
                    New project
                  </button>
                </header>
                <div className="workspace-page-toolbar workspace-stats">
                  <div>
                    <FolderOpen size={17} />
                    <strong>
                      {
                        data.projects.filter((project) => !project.hidden)
                          .length
                      }
                    </strong>
                    <span>projects</span>
                  </div>
                  <div>
                    <HardDrive size={17} />
                    <strong>{connectedSources.length}</strong>
                    <span>sources</span>
                  </div>
                  <div>
                    <Pin size={16} />
                    <strong>
                      {
                        data.projects.filter(
                          (project) => project.pinned && !project.hidden,
                        ).length
                      }
                    </strong>
                    <span>pinned</span>
                  </div>
                  <button
                    className="stats-search"
                    onClick={() => void navigate("search")}
                  >
                    <Search size={15} />
                    <span>Search inside your projects</span>
                    <kbd>Ctrl K</kbd>
                  </button>
                </div>
                {connectedSources.length === 0 ? (
                  <div className="onboarding card">
                    <div className="onboarding-art">
                      <FolderOpen size={44} strokeWidth={1} />
                      <span className="art-plus">
                        <Plus size={16} />
                      </span>
                    </div>
                    <span className="eyebrow">WELCOME TO YOUR WORKSPACE</span>
                    <h2>Good work starts with a clear desk.</h2>
                    <p>
                      {data.sources.length
                        ? "Reconnect a saved source to bring its projects back into your active library."
                        : "Connect a folder where your projects live. Foldory finds each project inside, so you can get straight to work."}
                    </p>
                    <button
                      className="button primary"
                      onClick={() => void navigate("settings")}
                    >
                      <FolderPlus size={16} />
                      {data.sources.length
                        ? "Manage saved sources"
                        : "Add your first source"}
                      <ArrowUpRight size={15} />
                    </button>
                    <div className="onboarding-footnote">
                      <HardDrive size={13} />
                      Your files stay right where they are.
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="library-toolbar">
                      <div className="library-title">
                        <h2>Project library</h2>
                        <span className="badge">{filtered.length}</span>
                      </div>
                      <div className="library-controls">
                        <AppSelect
                          title="Filter by source"
                          aria-label="Filter by source"
                          value={sourceFilter}
                          onChange={setSourceFilter}
                          searchable
                          compact
                          options={[
                            { value: "", label: "All sources" },
                            ...connectedSources.map((source) => ({
                              value: source.id,
                              label: source.name,
                              keywords: source.path,
                            })),
                          ]}
                        />
                        <button
                          className={`button subtle ${showHidden ? "selected" : ""}`}
                          title="Include hidden projects"
                          aria-pressed={showHidden}
                          onClick={() => setShowHidden((value) => !value)}
                        >
                          {showHidden ? (
                            <Eye size={14} />
                          ) : (
                            <EyeOff size={14} />
                          )}
                          Hidden
                        </button>
                        <div className="sort-select">
                          <AppSelect
                            aria-label="Sort projects"
                            value={sort}
                            onChange={setSort}
                            searchable={false}
                            compact
                            options={[
                              { value: "recent", label: "Recently opened" },
                              { value: "name", label: "Name" },
                              { value: "modified", label: "Last updated" },
                            ]}
                          />
                          <ArrowDownWideNarrow
                            size={14}
                            className="mr-2"
                            style={{ marginLeft: "8px" }}
                          />
                        </div>
                      </div>
                    </div>
                    <div
                      className="project-table"
                      role="region"
                      aria-label="Project list"
                      tabIndex={0}
                    >
                      <div className="project-table-heading">
                        <span>NAME</span>
                        <span>CLIENT / TAGS</span>
                        <span>LAST OPENED</span>
                        <span />
                      </div>
                      {filtered.map((project) => (
                        <div
                          className={`project-table-row ${project.hidden ? "hidden-project" : ""}`}
                          key={project.id}
                          tabIndex={-1}
                          onContextMenu={(event) =>
                            showProjectMenu(project, event)
                          }
                        >
                          <button
                            className="project-main"
                            onClick={() => void selectProject(project)}
                          >
                            <span
                              className="project-folder-icon"
                              style={{
                                color: project.color,
                                backgroundColor: `${project.color}12`,
                              }}
                            >
                              <Folder size={21} strokeWidth={1.5} />
                            </span>
                            <span>
                              <strong>
                                {projectName(project)}
                                {!project.available && (
                                  <span className="badge offline">Offline</span>
                                )}
                                {project.hidden && <EyeOff size={12} />}
                              </strong>
                              <small title={project.path}>{project.path}</small>
                            </span>
                          </button>
                          <div className="project-client">
                            <span>
                              {project.client || (
                                <span className="muted">—</span>
                              )}
                            </span>
                            <div>
                              {project.tags.slice(0, 2).map((tag) => (
                                <span className="tag" key={tag}>
                                  {tag}
                                </span>
                              ))}
                              {project.tags.length > 2 && (
                                <span className="muted">
                                  +{project.tags.length - 2}
                                </span>
                              )}
                            </div>
                          </div>
                          <span className="project-last-opened">
                            {relativeTime(project.lastOpened)}
                          </span>
                          <div className="project-actions">
                            <button
                              className={`icon-button ${project.pinned ? "pinned" : ""}`}
                              title={
                                project.pinned ? "Unpin project" : "Pin project"
                              }
                              aria-label={`${project.pinned ? "Unpin" : "Pin"} ${projectName(project)}`}
                              onClick={() =>
                                void update(project, {
                                  pinned: !project.pinned,
                                })
                              }
                            >
                              <Pin size={15} />
                            </button>
                            <button
                              className="icon-button"
                              aria-label={`Actions for ${projectName(project)}`}
                              aria-haspopup="menu"
                              aria-expanded={
                                contextAnchor?.projectId === project.id
                              }
                              title="Project actions"
                              onClick={(event) =>
                                showProjectMenu(project, event, true)
                              }
                            >
                              <MoreHorizontal size={18} />
                            </button>
                          </div>
                        </div>
                      ))}
                      {!filtered.length && (
                        <div className="empty-state">
                          <Search size={26} />
                          <h2>
                            {filter || sourceFilter
                              ? "No projects match"
                              : "Room for your next idea"}
                          </h2>
                          <p>
                            {filter || sourceFilter
                              ? "Try another search or change your filters."
                              : "Create a project or refresh your sources to discover existing folders."}
                          </p>
                          <button
                            className="button"
                            onClick={() => setCreate(true)}
                          >
                            <Plus size={15} />
                            New project
                          </button>
                        </div>
                      )}
                    </div>
                  </>
                )}
                <div className="dashboard-footer">
                  <span>
                    <Sparkles size={13} />
                    Built for focus. Ready for what’s next.
                  </span>
                  <button
                    className="text-button"
                    onClick={() => void navigate("settings")}
                  >
                    Manage workspace
                    <ChevronDown size={12} />
                  </button>
                </div>
              </div>
            )}
          </Suspense>
        )}
      </main>
      {onboarding && (
        <Suspense fallback={null}>
          <Onboarding
            data={data}
            onRefresh={refresh}
            onClose={() => setOnboarding(false)}
          />
        </Suspense>
      )}
      {create && (
        <CreateProject
          data={data}
          onClose={() => setCreate(false)}
          onCreated={(project) => void created(project)}
          onSettings={() => {
            setCreate(false);
            void navigate("settings");
          }}
        />
      )}
      {editing && (
        <EditProject
          project={editing}
          onClose={() => setEditing(null)}
          onSaved={(project) => {
            mergeProject(project);
            setEditing(null);
            setNotice("Project details saved");
          }}
        />
      )}
      {renaming && (
        <RenameProject
          project={renaming}
          onClose={() => setRenaming(null)}
          onSaved={(project) => {
            mergeProject(project);
            setRenaming(null);
            setNotice("Display label saved");
          }}
        />
      )}
      {contextAnchor && contextProject && (
        <ProjectContextMenu
          project={contextProject}
          settings={data.settings}
          anchor={contextAnchor}
          onClose={() => setContextAnchor(null)}
          onRename={() => setRenaming(contextProject)}
          onEdit={() => setEditing(contextProject)}
          onColor={(color) => void update(contextProject, { color })}
          onPin={() =>
            void update(contextProject, { pinned: !contextProject.pinned })
          }
          onHide={() =>
            void update(contextProject, { hidden: !contextProject.hidden })
          }
          onLaunch={(tool) =>
            void launch(contextProject, tool, contextAnchor.folderPath || null)
          }
          onOpenFolder={() =>
            void selectProject(
              contextProject,
              contextAnchor.folderPath ?? "",
              true,
            )
          }
          onCopyPath={() => {
            const path = [
              contextProject.path.replace(/[\\/]$/, ""),
              contextAnchor.folderPath?.replaceAll("/", "\\"),
            ]
              .filter(Boolean)
              .join("\\");
            void navigator.clipboard
              .writeText(path)
              .then(() => setNotice("Folder path copied"))
              .catch((error) => onError(messageOf(error)));
          }}
        />
      )}
      {notice && (
        <div className="toast" role="status">
          <Check size={16} />
          {notice}
        </div>
      )}
    </div>
  );
  return (
    <ContextMenus
      onError={onError}
      actions={[
        { label: "Find files", run: () => navigate("search") },
        { label: "New project…", run: () => setCreate(true) },
        { label: "Settings", run: () => navigate("settings") },
      ]}
    >
      {content}
    </ContextMenus>
  );
}
