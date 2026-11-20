import { useEffect, useMemo, useState, type MouseEvent } from "react";
import { ChevronDown, ChevronRight, Folder, LoaderCircle } from "lucide-react";
import { api } from "../api";
import type { IndexStatus, Project, SearchResult } from "../types";
import { matchesProject, messageOf, projectName } from "../utils";

export interface FolderMatchNode {
  result: SearchResult;
  matched: boolean;
  children: FolderMatchNode[];
}

export function folderMatchTree(results: SearchResult[]): FolderMatchNode[] {
  const roots = new Map<string, FolderMatchNode>();
  for (const result of results) {
    let root = roots.get(result.projectId);
    if (!root) {
      root = {
        result: {
          ...result,
          path: "",
          name: result.projectName,
          directory: true,
          depth: 0,
        },
        matched: false,
        children: [],
      };
      roots.set(result.projectId, root);
    }
    if (!result.path) {
      root.matched = true;
      root.result = result;
      continue;
    }
    let parent = root;
    const parts = result.path.replaceAll("\\", "/").split("/").filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
      const path = parts.slice(0, i + 1).join("/");
      let node = parent.children.find((child) => child.result.path === path);
      if (!node) {
        node = {
          result: {
            ...result,
            path,
            name: parts[i],
            directory: true,
            depth: i + 1,
          },
          matched: false,
          children: [],
        };
        parent.children.push(node);
      }
      if (i === parts.length - 1) {
        node.matched = true;
        node.result = result;
      }
      parent = node;
    }
  }
  const sort = (nodes: FolderMatchNode[]) => {
    nodes.sort((a, b) => a.result.name.localeCompare(b.result.name));
    nodes.forEach((node) => sort(node.children));
  };
  const tree = [...roots.values()];
  sort(tree);
  return tree;
}

function MatchNode({
  node,
  onOpen,
  onContextMenu,
  project,
}: {
  node: FolderMatchNode;
  onOpen: (result: SearchResult) => void;
  onContextMenu?: (
    result: SearchResult,
    event: MouseEvent<HTMLElement>,
  ) => void;
  project?: Project;
}) {
  const [expanded, setExpanded] = useState(true);
  const { result, matched, children } = node;
  return (
    <li>
      <div
        className={`folder-match-row ${matched ? "matched" : "ancestor"}`}
        onContextMenu={(event) => onContextMenu?.(result, event)}
      >
        {children.length ? (
          <button
            className="folder-match-toggle"
            onClick={() => setExpanded(!expanded)}
            aria-expanded={expanded}
            aria-label={`${expanded ? "Collapse" : "Expand"} ${result.name}`}
          >
            {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </button>
        ) : (
          <span className="folder-match-toggle" />
        )}
        <button
          className="folder-match-open"
          aria-haspopup={onContextMenu ? "menu" : undefined}
          title={`${result.projectName}${result.path ? ` / ${result.path}` : ""}${matched ? " · match" : " · parent folder"}`}
          onClick={() => onOpen(result)}
          onKeyDown={(event) => {
            if (
              onContextMenu &&
              (event.key === "ContextMenu" ||
                (event.shiftKey && event.key === "F10"))
            ) {
              event.preventDefault();
              event.currentTarget.dispatchEvent(
                new window.MouseEvent("contextmenu", {
                  bubbles: true,
                  cancelable: true,
                }),
              );
            }
          }}
        >
          <Folder size={14} style={{ color: project?.color }} />
          <span>{result.name}</span>
          {matched && (
            <span
              className={`depth-badge depth-${result.depth}`}
              aria-label={
                result.depth === 0 ? "Project root" : `Depth ${result.depth}`
              }
            >
              {result.depth === 0 ? "Root" : `L${result.depth}`}
            </span>
          )}
        </button>
      </div>
      {expanded && children.length > 0 && (
        <ul className="folder-match-children">
          {children.map((child) => (
            <MatchNode
              key={child.result.path}
              node={child}
              onOpen={onOpen}
              onContextMenu={onContextMenu}
              project={project}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

export default function SidebarFolderSearch({
  query,
  projects,
  indexStatus,
  onOpen,
  onContextMenu,
}: {
  query: string;
  projects: Project[];
  indexStatus: IndexStatus;
  onOpen: (result: SearchResult) => void;
  onContextMenu?: (
    result: SearchResult,
    event: MouseEvent<HTMLElement>,
  ) => void;
}) {
  const [results, setResults] = useState<SearchResult[]>([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    setBusy(true);
    setResults([]);
    setError("");
    const timer = setTimeout(() => {
      api
        .searchFolders(query.trim())
        .then((next) => {
          if (active) setResults(next);
        })
        .catch((reason) => {
          if (active) setError(messageOf(reason));
        })
        .finally(() => {
          if (active) setBusy(false);
        });
    }, 180);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [query, indexStatus.lastIndexed, indexStatus.running]);
  const matches = useMemo(() => {
    const visible = new Set(
      projects
        .filter((project) => !project.hidden)
        .map((project) => project.id),
    );
    const next = results
      .filter((result) => visible.has(result.projectId) && result.depth <= 3)
      .flatMap((result) => {
        const project = projects.find((item) => item.id === result.projectId)!;
        if (!result.path && !matchesProject(project, query)) return [];
        const name = projectName(project);
        return [
          {
            ...result,
            projectName: name,
            name: result.path ? result.name : name,
          },
        ];
      });
    for (const project of projects) {
      if (
        !project.hidden &&
        matchesProject(project, query) &&
        !next.some((result) => result.projectId === project.id && !result.path)
      ) {
        next.push({
          projectId: project.id,
          projectName: projectName(project),
          path: "",
          name: projectName(project),
          excerpt: "",
          directory: true,
          depth: 0,
          matchKind: "metadata",
        });
      }
    }
    return next;
  }, [results, projects, query]);
  const tree = useMemo(() => folderMatchTree(matches), [matches]);
  return (
    <div className="sidebar-section folder-match-section">
      <div className="sidebar-section-title">
        <span>Projects & folders</span>
        <span>
          {busy ? <LoaderCircle size={12} className="spin" /> : matches.length}
        </span>
      </div>
      <p className="sidebar-hint folder-search-help">
        Project root + 3 folder levels
      </p>
      <div className="folder-depth-legend" aria-label="Folder depth legend">
        <span className="depth-badge depth-0">Root</span>
        <span className="depth-badge depth-1">L1</span>
        <span className="depth-badge depth-2">L2</span>
        <span className="depth-badge depth-3">L3</span>
      </div>
      {tree.length > 0 && (
        <ul
          className="folder-match-tree"
          aria-label="Matching projects and folders"
          key={query}
        >
          {tree.map((node) => (
            <MatchNode
              key={node.result.projectId}
              node={node}
              onOpen={onOpen}
              onContextMenu={onContextMenu}
              project={projects.find(
                (project) => project.id === node.result.projectId,
              )}
            />
          ))}
        </ul>
      )}
      {!busy && !tree.length && (
        <p className="sidebar-hint">No matching projects or folders.</p>
      )}
      {error && (
        <p className="sidebar-hint error" role="alert">
          Folder search unavailable: {error}
        </p>
      )}
      {indexStatus.running && (
        <p className="sidebar-hint" role="status">
          Indexing… more folders may appear.
        </p>
      )}
      {results.length >= 300 && (
        <p className="sidebar-hint">
          Showing the first 300 folder matches. Narrow your search to see more.
        </p>
      )}
      {!indexStatus.lastIndexed && !indexStatus.running && (
        <p className="sidebar-hint">
          Index your projects to include subfolders.
        </p>
      )}
    </div>
  );
}
