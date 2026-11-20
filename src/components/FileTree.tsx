import {
  useEffect,
  useState,
  type DragEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import { ChevronDown, ChevronRight, LoaderCircle } from "lucide-react";
import { api } from "../api";
import type { FileEntry } from "../types";
import { acceptFileDrag, containsFilePath } from "../fileOperations";

interface Props {
  projectId: string;
  entries: FileEntry[];
  selected: string;
  selection?: FileEntry[];
  onSelectionChange?: (entries: FileEntry[]) => void;
  refreshVersion: number;
  onOpen: (entry: FileEntry) => void;
  onMenu: (
    event: MouseEvent<HTMLElement>,
    entry: FileEntry,
    toggle?: () => void,
    expanded?: boolean,
    selection?: FileEntry[],
  ) => void;
  icon: (entry: FileEntry) => ReactNode;
  onDrop?: (event: DragEvent<HTMLElement>, destination: string) => void;
  cutPaths?: string[];
  operationsDisabled?: boolean;
  expandedPaths?: string[];
  onToggleFolder?: (path: string, expanded: boolean) => void;
}

export default function FileTree(props: Props) {
  const [selection, setSelection] = useState<FileEntry[]>([]);
  return (
    <ul className="file-tree" aria-label="Files and folders">
      {props.entries.map((entry) => (
        <FileTreeNode
          key={entry.path}
          {...props}
          selection={props.selection ?? selection}
          onSelectionChange={(entries) => {
            setSelection(entries);
            props.onSelectionChange?.(entries);
          }}
          entry={entry}
          depth={0}
        />
      ))}
    </ul>
  );
}

function FileTreeNode({
  entry,
  depth,
  ...props
}: Omit<Props, "selection" | "onSelectionChange"> & {
  entry: FileEntry;
  depth: number;
  selection: FileEntry[];
  onSelectionChange: (entries: FileEntry[]) => void;
}) {
  const [localExpanded, setExpanded] = useState(false);
  const expanded = props.expandedPaths
    ? props.expandedPaths.includes(entry.path)
    : localExpanded;
  const [children, setChildren] = useState<FileEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [dropTarget, setDropTarget] = useState(false);
  useEffect(() => {
    if (!expanded || !entry.directory) return;
    let active = true;
    setBusy(true);
    setError("");
    api
      .listDirectory(props.projectId, entry.path)
      .then((result) => {
        if (active) setChildren(result);
      })
      .catch((reason) => {
        if (active) setError(String(reason));
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [
    expanded,
    entry.directory,
    entry.path,
    props.projectId,
    props.refreshVersion,
    retry,
  ]);
  const toggle = () => {
    setExpanded(!expanded);
    props.onToggleFolder?.(entry.path, !expanded);
  };
  const multiSelected = props.selection.some(
    (item) => item.path === entry.path,
  );
  const selectForAction = () => {
    const selected = multiSelected ? props.selection : [entry];
    if (!multiSelected) props.onSelectionChange(selected);
    return selected;
  };
  const size =
    entry.size >= 1048576
      ? `${(entry.size / 1048576).toFixed(1)} MB`
      : entry.size >= 1024
        ? `${Math.round(entry.size / 1024)} KB`
        : `${entry.size} B`;
  return (
    <li>
      <div
        className={`file-entry ${props.selected === entry.path ? "selected" : ""} ${multiSelected ? "multi-selected" : ""} ${entry.aiExcluded ? "ai-excluded" : ""} ${props.cutPaths?.some((path) => containsFilePath(path, entry.path)) ? "cut" : ""} ${dropTarget ? "file-drop-target" : ""}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        draggable={!props.operationsDisabled}
        onDragOver={(event) => {
          if (
            entry.directory &&
            props.onDrop &&
            !props.operationsDisabled &&
            acceptFileDrag(event)
          )
            setDropTarget(true);
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null))
            setDropTarget(false);
        }}
        onDrop={(event) => {
          setDropTarget(false);
          if (entry.directory && !props.operationsDisabled)
            props.onDrop?.(event, entry.path);
        }}
        onDragStart={(event) => {
          event.stopPropagation();
          const selected = selectForAction();
          event.dataTransfer.effectAllowed = "copyMove";
          event.dataTransfer.setData(
            "application/x-foldory-files",
            JSON.stringify({
              projectId: props.projectId,
              paths: selected.map((item) => item.path),
            }),
          );
          event.dataTransfer.setData(
            "text/plain",
            selected.map((item) => item.path).join("\n"),
          );
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          props.onMenu(
            event,
            entry,
            entry.directory ? toggle : undefined,
            expanded,
            selectForAction(),
          );
        }}
      >
        <button
          className="file-entry-open"
          title={`${entry.path}${entry.directory ? "" : ` · ${size}`}${entry.aiExcluded ? ` · Excluded from Assistant by default${entry.aiExclusionReason ? `: ${entry.aiExclusionReason}` : ""}` : ""}`}
          aria-pressed={multiSelected}
          onClick={(event) => {
            if (event.ctrlKey || event.metaKey) {
              props.onSelectionChange(
                multiSelected
                  ? props.selection.filter((item) => item.path !== entry.path)
                  : [...props.selection, entry],
              );
              return;
            }
            props.onSelectionChange([entry]);
            props.onOpen(entry);
          }}
        >
          {props.icon(entry)}
          <span>{entry.name}</span>
        </button>
        {entry.directory && (
          <button
            className="file-tree-toggle"
            aria-label={`${expanded ? "Collapse" : "Expand"} ${entry.name}`}
            aria-expanded={expanded}
            onClick={toggle}
          >
            {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          </button>
        )}
      </div>
      {expanded && (
        <ul className="file-tree" aria-label={`Contents of ${entry.name}`}>
          {busy && (
            <li className="explorer-message">
              <LoaderCircle size={14} className="spin" /> Loading…
            </li>
          )}
          {error ? (
            <li className="explorer-message error">
              {error}
              <button
                className="text-button"
                onClick={() => setRetry((value) => value + 1)}
              >
                Retry
              </button>
            </li>
          ) : children.length ? (
            children.map((child) => (
              <FileTreeNode
                key={child.path}
                {...props}
                entry={child}
                depth={depth + 1}
              />
            ))
          ) : !busy ? (
            <li className="explorer-message muted">Empty folder</li>
          ) : null}
        </ul>
      )}
    </li>
  );
}
