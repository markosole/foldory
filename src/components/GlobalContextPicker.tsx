import {
  ChevronDown,
  ChevronRight,
  FileText,
  Folder,
  LoaderCircle,
  Plus,
  Search,
  X,
} from "lucide-react";
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
import { api } from "../api";
import type { FileEntry, Project } from "../types";
import { messageOf } from "../utils";

export type GlobalContextItem = {
  projectId: string;
  projectName: string;
  path: string;
  directory: boolean;
};

type Props = {
  projects: Project[];
  includeAll: boolean;
  selections: GlobalContextItem[];
  disabled: boolean;
  onChange: (includeAll: boolean, selections: GlobalContextItem[]) => void;
};

const includableExtensions = new Set([
  "md",
  "mdx",
  "markdown",
  "txt",
  "rst",
  "adoc",
  "csv",
  "tsv",
  "xlsx",
  "docx",
  "json",
  "jsonc",
  "jsonl",
  "ndjson",
  "xml",
  "yaml",
  "yml",
  "toml",
  "ini",
  "cfg",
  "conf",
  "js",
  "jsx",
  "ts",
  "tsx",
  "mjs",
  "cjs",
  "html",
  "css",
  "scss",
  "less",
  "rs",
  "py",
  "c",
  "h",
  "cpp",
  "hpp",
  "cs",
  "java",
  "kt",
  "go",
  "rb",
  "php",
  "swift",
  "sh",
  "ps1",
  "bat",
  "sql",
  "log",
  "env",
  "key",
  "pem",
  "lock",
]);
const includableNames = new Set([
  "dockerfile",
  "makefile",
  "license",
  "readme",
  ".gitignore",
  ".inspectorignore",
  ".ignore",
]);

function includableEntry(entry: FileEntry) {
  if (entry.directory) return true;
  const name = entry.name.toLowerCase();
  const extension = name.includes(".") ? name.split(".").pop() || "" : "";
  return includableNames.has(name) || includableExtensions.has(extension);
}

export function contextKey(projectId: string, path: string) {
  return `${projectId}:${path.toLowerCase()}`;
}

export default function GlobalContextPicker({
  projects,
  includeAll,
  selections,
  disabled,
  onChange,
}: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [position, setPosition] = useState<CSSProperties>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [directories, setDirectories] = useState<Record<string, FileEntry[]>>(
    {},
  );
  const [loading, setLoading] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const selected = new Map(
    selections.map((item) => [contextKey(item.projectId, item.path), item]),
  );
  const availableProjects = projects
    .filter((project) => !project.hidden)
    .sort((a, b) =>
      (a.alias || a.name).localeCompare(b.alias || b.name, undefined, {
        sensitivity: "base",
      }),
    );
  const filteredProjects = availableProjects.filter((project) => {
    const term = query.trim().toLowerCase();
    return (
      !term ||
      [
        project.alias,
        project.name,
        project.path,
        project.client,
        ...project.tags,
      ]
        .join(" ")
        .toLowerCase()
        .includes(term)
    );
  });

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = trigger.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(440, window.innerWidth - 16);
      setPosition({
        left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
        bottom: Math.max(8, window.innerHeight - rect.top + 8),
        width,
      });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!menu.current?.contains(target) && !trigger.current?.contains(target))
        setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  const loadDirectory = useCallback(
    async (projectId: string, path: string) => {
      const key = contextKey(projectId, path);
      if (directories[key] || loading.has(key)) return;
      setLoading((current) => new Set(current).add(key));
      setErrors((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });
      try {
        const entries = (await api.listDirectory(projectId, path)).filter(
          includableEntry,
        );
        setDirectories((current) => ({ ...current, [key]: entries }));
      } catch (error) {
        setErrors((current) => ({ ...current, [key]: messageOf(error) }));
      } finally {
        setLoading((current) => {
          const next = new Set(current);
          next.delete(key);
          return next;
        });
      }
    },
    [directories, loading],
  );

  function toggleExpanded(projectId: string, path: string) {
    const key = contextKey(projectId, path);
    const next = new Set(expanded);
    if (next.has(key)) next.delete(key);
    else {
      next.add(key);
      void loadDirectory(projectId, path);
    }
    setExpanded(next);
  }

  function setEntry(
    project: Project,
    entry: Pick<FileEntry, "path" | "directory">,
    checked: boolean,
  ) {
    const normalized = entry.path.toLowerCase();
    let next = selections.filter(
      (item) =>
        item.projectId !== project.id ||
        (item.path.toLowerCase() !== normalized &&
          !item.path.toLowerCase().startsWith(`${normalized}/`)),
    );
    if (checked)
      next = [
        ...next,
        {
          projectId: project.id,
          projectName: project.alias || project.name,
          path: entry.path,
          directory: entry.directory,
        },
      ];
    onChange(false, next);
  }

  function renderEntries(project: Project, parent = "", depth = 0) {
    const directoryKey = contextKey(project.id, parent);
    if (loading.has(directoryKey))
      return (
        <p className="global-scope-loading" role="status">
          <LoaderCircle size={13} className="spin" /> Loading project files…
        </p>
      );
    if (errors[directoryKey])
      return (
        <button
          className="global-scope-error"
          type="button"
          onClick={() => void loadDirectory(project.id, parent)}
        >
          {errors[directoryKey]} · Retry
        </button>
      );
    const entries = directories[directoryKey];
    if (!entries) return null;
    if (!entries.length)
      return <p className="global-scope-empty-folder">No includable files.</p>;
    return entries.map((entry) => {
      const key = contextKey(project.id, entry.path);
      const exact = selected.has(key);
      const coveredBy = selections.find(
        (item) =>
          item.projectId === project.id &&
          item.directory &&
          entry.path.toLowerCase().startsWith(`${item.path.toLowerCase()}/`),
      );
      const isExpanded = expanded.has(key);
      const rootName = entry.name.toLowerCase();
      const hint =
        depth === 0 && /^(project|readme)(\.|$)/i.test(entry.name)
          ? "Project overview"
          : depth === 0 && ["docs", "documentation", "doc"].includes(rootName)
            ? "Documentation folder"
            : entry.aiExcluded
              ? "Permission required"
              : "";
      return (
        <div className="global-scope-tree-item" key={entry.path}>
          <div
            className={`global-scope-entry ${entry.aiExcluded ? "ai-excluded" : ""}`}
            style={{ "--tree-depth": depth } as CSSProperties}
          >
            {entry.directory ? (
              <button
                className="global-scope-expand"
                type="button"
                aria-label={`${isExpanded ? "Collapse" : "Expand"} ${entry.name}`}
                aria-expanded={isExpanded}
                onClick={() => toggleExpanded(project.id, entry.path)}
              >
                {isExpanded ? (
                  <ChevronDown size={13} />
                ) : (
                  <ChevronRight size={13} />
                )}
              </button>
            ) : (
              <span className="global-scope-expand-spacer" />
            )}
            <input
              type="checkbox"
              aria-label={`Include ${project.alias || project.name} ${entry.path}`}
              checked={exact || Boolean(coveredBy)}
              disabled={Boolean(coveredBy)}
              title={
                coveredBy
                  ? `Already included by ${coveredBy.path}`
                  : entry.aiExclusionReason
              }
              onChange={(event) =>
                setEntry(project, entry, event.target.checked)
              }
            />
            {entry.directory ? (
              <Folder size={14} style={{ color: project.color }} />
            ) : (
              <FileText size={14} />
            )}
            <span title={entry.path}>
              <strong>{entry.name}</strong>
              {hint && <small>{hint}</small>}
            </span>
          </div>
          {entry.directory && isExpanded && (
            <div className="global-scope-tree-children">
              {renderEntries(project, entry.path, depth + 1)}
            </div>
          )}
        </div>
      );
    });
  }

  return (
    <>
      <button
        ref={trigger}
        className="chat-add-context"
        type="button"
        aria-label="Choose project context"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        title="Choose project context"
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
      >
        <Plus size={17} aria-hidden="true" />
      </button>
      {open &&
        createPortal(
          <div
            ref={menu}
            id={menuId}
            className="global-scope-picker"
            role="dialog"
            aria-label="Include project context"
            style={position}
          >
            <header>
              <div>
                <strong>Include project context</strong>
                <span>
                  Expand a project, then choose its overview, docs, or exact
                  files and folders. Selections are prepared when you send.
                </span>
              </div>
              <button
                className="icon-button"
                type="button"
                aria-label="Close project context picker"
                onClick={() => setOpen(false)}
              >
                <X size={15} />
              </button>
            </header>
            <label className="global-scope-search">
              <Search size={14} />
              <input
                autoFocus
                aria-label="Find projects to include"
                placeholder="Find projects…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            <label className="global-scope-option global-scope-all">
              <input
                type="checkbox"
                checked={includeAll}
                onChange={(event) => onChange(event.target.checked, [])}
              />
              <span>
                <strong>Relevant docs from all projects</strong>
                <small>Automatic overview and matching Markdown context</small>
              </span>
            </label>
            <div className="global-scope-list">
              {filteredProjects.map((project) => {
                const name = project.alias || project.name;
                const projectKey = contextKey(project.id, "");
                const isExpanded = expanded.has(projectKey);
                const selectionCount = selections.filter(
                  (item) => item.projectId === project.id,
                ).length;
                return (
                  <div className="global-scope-project" key={project.id}>
                    <button
                      className="global-scope-project-toggle"
                      type="button"
                      aria-expanded={isExpanded}
                      disabled={!project.available}
                      onClick={() => toggleExpanded(project.id, "")}
                      title={project.path}
                    >
                      {isExpanded ? (
                        <ChevronDown size={14} />
                      ) : (
                        <ChevronRight size={14} />
                      )}
                      <Folder size={15} style={{ color: project.color }} />
                      <span>
                        <strong>{name}</strong>
                        <small>
                          {project.available
                            ? project.path
                            : "Project is offline"}
                        </small>
                      </span>
                      {selectionCount > 0 && (
                        <em aria-label={`${selectionCount} selections`}>
                          {selectionCount}
                        </em>
                      )}
                    </button>
                    {isExpanded && (
                      <div className="global-scope-project-tree">
                        {renderEntries(project)}
                      </div>
                    )}
                  </div>
                );
              })}
              {!filteredProjects.length && (
                <p>No available projects match your search.</p>
              )}
            </div>
            <footer>
              <span>
                {includeAll
                  ? "Automatic context from all projects"
                  : selections.length
                    ? `${selections.length} source${selections.length === 1 ? "" : "s"} selected`
                    : "Catalog only"}
              </span>
              {(includeAll || selections.length > 0) && (
                <button type="button" onClick={() => onChange(false, [])}>
                  Clear context
                </button>
              )}
            </footer>
          </div>,
          document.body,
        )}
    </>
  );
}
