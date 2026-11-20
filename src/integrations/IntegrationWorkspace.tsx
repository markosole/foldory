import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  FolderOpen,
  LoaderCircle,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import { integrationsApi } from "./api";
import type {
  Integration,
  IntegrationGroup,
  IntegrationProject,
  IntegrationWorkspaceData,
} from "./types";
import type { Project } from "../types";
import { messageOf } from "../utils";
import { useStoredBoolean } from "../useStoredState";
import "./integrations.css";

const normalizedPath = (path: string) =>
  path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

export default function IntegrationWorkspace({
  integration,
  projects,
  onOpenProject,
}: {
  integration: Integration;
  projects: Project[];
  onOpenProject: (project: Project) => void;
}) {
  const [data, setData] = useState<IntegrationWorkspaceData | null>(null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [openError, setOpenError] = useState("");
  const [opening, setOpening] = useState<string | null>(null);
  const request = useRef(0);
  const refresh = useCallback(async () => {
    const token = ++request.current;
    setBusy(true);
    setError("");
    try {
      const result = await integrationsApi.workspace(integration.id);
      if (request.current === token) setData(result);
    } catch (e) {
      if (request.current === token) setError(messageOf(e));
    } finally {
      if (request.current === token) setBusy(false);
    }
  }, [integration.id]);
  useEffect(() => {
    void refresh();
    return () => {
      request.current++;
    };
  }, [refresh]);
  const registered = useMemo(
    () => new Map(projects.map((p) => [normalizedPath(p.path), p])),
    [projects],
  );
  const search = query.trim().toLocaleLowerCase();
  const groups = useMemo(
    () =>
      (data?.groups ?? [])
        .map((group) => ({
          ...group,
          projects: group.name.toLocaleLowerCase().includes(search)
            ? group.projects
            : group.projects.filter((project) =>
                `${project.name} ${project.path}`
                  .toLocaleLowerCase()
                  .includes(search),
              ),
        }))
        .filter((group) => !search || group.projects.length > 0),
    [data, search],
  );
  const allProjects = data?.groups.flatMap((group) => group.projects) ?? [];
  const unavailable = allProjects.filter(
    (p) => p.pathStatus !== "available",
  ).length;
  async function open(project: IntegrationProject) {
    if (project.pathStatus !== "available" || busy || error || opening) return;
    setOpenError("");
    const libraryProject = registered.get(normalizedPath(project.path));
    if (libraryProject?.available) {
      onOpenProject(libraryProject);
      return;
    }
    setOpening(project.id);
    try {
      await integrationsApi.openProject(integration.id, project.id);
    } catch (e) {
      setOpenError(messageOf(e));
    } finally {
      setOpening(null);
    }
  }
  return (
    <div className="integration-workspace">
      <header className="workspace-page-heading integration-workspace-heading">
        <div>
          <div className="eyebrow">INTEGRATION WORKSPACE</div>
          <h1>{integration.name}</h1>
          <p className="muted">
            Your project groups, connected from an external app.
          </p>
        </div>
        <button
          className="button"
          disabled={busy}
          onClick={() => void refresh()}
        >
          <RefreshCw size={15} className={busy ? "spin" : ""} />
          Refresh workspace
        </button>
      </header>
      <div className="workspace-page-toolbar integration-workspace-toolbar">
        <div className="search-input">
          <Search size={16} />
          <input
            aria-label="Filter integration projects"
            placeholder="Find a project or group…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {query && (
            <button
              className="icon-button small"
              aria-label="Clear integration filter"
              onClick={() => setQuery("")}
            >
              <X size={14} />
            </button>
          )}
        </div>
        {data && (
          <span className="muted">
            {allProjects.length} projects · {data.groups.length} groups
            {unavailable > 0 && (
              <span className="integration-unavailable-count">
                {" "}
                · {unavailable} unavailable
              </span>
            )}
          </span>
        )}
        {data && (
          <small
            className="muted"
            title={new Date(data.checkedAt).toLocaleString()}
          >
            Checked{" "}
            {new Date(data.checkedAt).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </small>
        )}
      </div>
      {error && (
        <div className="integration-message inline-error" role="alert">
          {error}
          {data &&
            " Showing the previous snapshot; refresh successfully before opening projects."}
        </div>
      )}
      {openError && (
        <div className="integration-message inline-error" role="alert">
          {openError}
        </div>
      )}
      {data?.warnings.map((warning) => (
        <div className="integration-message" role="status" key={warning}>
          <AlertTriangle size={15} />
          {warning}
        </div>
      ))}
      <div className="integration-workspace-scroll" aria-busy={busy}>
        {busy && !data && (
          <div className="loading-state">
            <LoaderCircle className="spin" />
            <p>Reading project groups and checking folders…</p>
          </div>
        )}
        {data && !groups.length && (
          <div className="integration-empty">
            <FolderOpen size={32} />
            <h3>{search ? "No matching projects" : "No project groups yet"}</h3>
            <p>
              {search
                ? "Try a different project, group or path."
                : "Add projects in the connected app, then refresh this workspace."}
            </p>
          </div>
        )}
        {groups.map((group) => (
          <ProjectGroup
            key={group.id}
            group={group}
            integrationId={integration.id}
            searching={!!search}
            disabled={busy || !!error || !!opening}
            opening={opening}
            registered={registered}
            onOpen={open}
          />
        ))}
      </div>
    </div>
  );
}

function ProjectGroup({
  group,
  integrationId,
  searching,
  disabled,
  opening,
  registered,
  onOpen,
}: {
  group: IntegrationGroup;
  integrationId: string;
  searching: boolean;
  disabled: boolean;
  opening: string | null;
  registered: Map<string, Project>;
  onOpen: (project: IntegrationProject) => void;
}) {
  const [folded, setFolded] = useStoredBoolean(
    `foldory.integration.${integrationId}.group.${group.id}.folded`,
  );
  const collapsed = folded && !searching;
  const panelId = `integration-group-${group.id}`;
  return (
    <section className="integration-group">
      <button
        className="integration-group-heading"
        aria-expanded={!collapsed}
        aria-controls={panelId}
        onClick={() => setFolded(!folded)}
        disabled={searching}
      >
        {collapsed ? <ChevronRight size={17} /> : <ChevronDown size={17} />}
        <span>{group.name}</span>
        <small>{group.projects.length}</small>
      </button>
      <div id={panelId} hidden={collapsed}>
        {!group.projects.length && (
          <p className="muted">This group has no projects.</p>
        )}
        <div className="integration-project-grid">
          {!collapsed &&
            group.projects.map((project) => {
              const exists = project.pathStatus === "available";
              const action = registered.get(normalizedPath(project.path))
                ?.available
                ? "Open project"
                : "Open folder";
              return (
                <button
                  key={project.id}
                  className={`integration-project-card ${exists ? "" : "unavailable"}`}
                  style={{ "--project-color": project.color } as CSSProperties}
                  title={`${project.name}\n${project.path}\n${project.pathMessage}${exists ? ` · ${action}` : ""}`}
                  aria-label={`${project.name} — ${project.pathMessage}${exists ? ` — ${action}` : ""}`}
                  disabled={!exists || disabled}
                  onClick={() => onOpen(project)}
                >
                  <span className="integration-project-status">
                    {opening === project.id ? (
                      <LoaderCircle size={16} className="spin" />
                    ) : exists ? (
                      <CheckCircle2 size={16} />
                    ) : (
                      <AlertTriangle size={16} />
                    )}
                    <span>{project.pathMessage}</span>
                  </span>
                  <strong>{project.name}</strong>
                  <span className="integration-project-path" dir="rtl">
                    {project.path}
                  </span>
                  <span className="integration-project-action">
                    {exists ? (
                      <>
                        <FolderOpen size={13} />
                        {action}
                      </>
                    ) : (
                      "Check the path or reconnect its drive"
                    )}
                  </span>
                </button>
              );
            })}
        </div>
      </div>
    </section>
  );
}
