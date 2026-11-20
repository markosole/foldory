import AppSelect from "./AppSelect";
import { useMemo, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  RefreshCw,
  Trash2,
} from "lucide-react";
import type { ProjectIndexStats } from "../types";

type SortKey =
  | "projectName"
  | "status"
  | "files"
  | "folders"
  | "contentFiles"
  | "excludedEntries"
  | "skippedFiles"
  | "truncatedFiles"
  | "lastIndexed"
  | "durationMs";
const columns: {
  key: SortKey;
  label: string;
  numeric?: boolean;
  help?: string;
}[] = [
  { key: "projectName", label: "Project" },
  { key: "status", label: "Status" },
  { key: "files", label: "Files", numeric: true },
  {
    key: "folders",
    label: "Folders",
    numeric: true,
    help: "Includes the project root",
  },
  { key: "contentFiles", label: "With content", numeric: true },
  {
    key: "excludedEntries",
    label: "Excluded",
    numeric: true,
    help: "Encountered excluded entries; pruned descendants and .gitignore omissions are not counted",
  },
  {
    key: "skippedFiles",
    label: "Names only",
    numeric: true,
    help: "Files searchable by name with no indexed text",
  },
  {
    key: "truncatedFiles",
    label: "Truncated",
    numeric: true,
    help: "Text files indexed only up to the content limit",
  },
  { key: "lastIndexed", label: "Updated" },
  { key: "durationMs", label: "Duration", numeric: true },
];
export function indexStatusLabel(status: string) {
  return (
    (
      {
        neverIndexed: "Not indexed",
        indexed: "Indexed",
        running: "Indexing…",
        error: "Error",
        cleared: "Cleared",
        unavailable: "Unavailable",
        stale: "Out of date",
      } as Record<string, string>
    )[status] || status
  );
}

export default function ProjectIndexTable({
  statistics,
  disabled,
  operation,
  onReindex,
  onClear,
}: {
  statistics: ProjectIndexStats[];
  disabled: boolean;
  operation: string;
  onReindex: (project: ProjectIndexStats) => void;
  onClear: (project: ProjectIndexStats) => void;
}) {
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; descending: boolean }>({
    key: "projectName",
    descending: false,
  });
  const statuses = useMemo(
    () =>
      [
        ...new Set([
          ...statistics.map((project) => project.status),
          ...(statusFilter ? [statusFilter] : []),
        ]),
      ].sort((a, b) => indexStatusLabel(a).localeCompare(indexStatusLabel(b))),
    [statistics, statusFilter],
  );
  const rows = useMemo(() => {
    const filtered = statistics.filter(
      (project) =>
        project.projectName
          .toLocaleLowerCase()
          .includes(query.trim().toLocaleLowerCase()) &&
        (!statusFilter || project.status === statusFilter),
    );
    return filtered.sort((a, b) => {
      let order: number;
      if (sort.key === "projectName")
        order = a.projectName.localeCompare(b.projectName, undefined, {
          numeric: true,
          sensitivity: "base",
        });
      else if (sort.key === "status")
        order = indexStatusLabel(a.status).localeCompare(
          indexStatusLabel(b.status),
        );
      else order = a[sort.key] - b[sort.key];
      return (
        (sort.descending ? -order : order) ||
        a.projectName.localeCompare(b.projectName, undefined, {
          numeric: true,
          sensitivity: "base",
        }) ||
        a.projectId.localeCompare(b.projectId)
      );
    });
  }, [statistics, query, statusFilter, sort]);
  const totals = useMemo(
    () =>
      rows.reduce(
        (total, project) => ({
          files: total.files + project.files,
          folders: total.folders + project.folders,
        }),
        { files: 0, folders: 0 },
      ),
    [rows],
  );
  function sortBy(key: SortKey) {
    setSort((current) => ({
      key,
      descending:
        current.key === key
          ? !current.descending
          : key !== "projectName" && key !== "status",
    }));
  }
  return (
    <>
      <div className="index-table-toolbar">
        <label className="field index-project-filter">
          Filter projects
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Project name…"
          />
        </label>
        <label className="field index-status-filter">
          Status
          <AppSelect
            aria-label="Filter index status"
            value={statusFilter}
            onChange={setStatusFilter}
            searchable={false}
            options={[
              { value: "", label: "All statuses" },
              ...statuses.map((status) => ({
                value: status,
                label: indexStatusLabel(status),
              })),
            ]}
          />
        </label>
        <p className="index-table-count" role="status">
          Showing <strong>{rows.length.toLocaleString()}</strong> of{" "}
          {statistics.length.toLocaleString()} projects
          <span>
            {totals.files.toLocaleString()} files ·{" "}
            {totals.folders.toLocaleString()} folders in view
          </span>
        </p>
        {(query || statusFilter) && (
          <button
            className="button small"
            onClick={() => {
              setQuery("");
              setStatusFilter("");
            }}
          >
            Clear filters
          </button>
        )}
      </div>
      <div
        className="index-table-scroll"
        role="region"
        aria-label="Scrollable project index statistics"
        tabIndex={0}
      >
        <table className="project-index-table">
          <caption className="index-table-caption">
            Project index statistics
          </caption>
          <colgroup>
            <col className="index-col-project" />
            <col className="index-col-status" />
            {Array.from({ length: 6 }, (_, i) => (
              <col className="index-col-number" key={i} />
            ))}
            <col className="index-col-updated" />
            <col className="index-col-duration" />
            <col className="index-col-actions" />
          </colgroup>
          <thead>
            <tr>
              {columns.map(({ key, label, numeric, help }) => (
                <th
                  key={key}
                  scope="col"
                  className={`${numeric ? "numeric" : ""} ${key === "projectName" ? "index-project-column" : ""}`}
                  aria-sort={
                    sort.key === key
                      ? sort.descending
                        ? "descending"
                        : "ascending"
                      : "none"
                  }
                  title={help}
                >
                  <button
                    type="button"
                    onClick={() => sortBy(key)}
                    aria-label={`Sort by ${label.toLowerCase()}`}
                  >
                    {label}
                    {sort.key === key ? (
                      sort.descending ? (
                        <ArrowDown size={12} />
                      ) : (
                        <ArrowUp size={12} />
                      )
                    ) : (
                      <ArrowUpDown size={12} className="index-sort-idle" />
                    )}
                  </button>
                </th>
              ))}
              <th scope="col" className="index-actions-heading">
                Actions
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.length ? (
              rows.map((project) => (
                <tr key={project.projectId}>
                  <th scope="row" className="index-project-column">
                    <span className="index-project-name">
                      {project.projectName}
                    </span>
                    {project.message && project.status !== "indexed" && (
                      <small
                        className={`index-row-message ${project.status === "error" ? "error" : ""}`}
                      >
                        {project.message}
                      </small>
                    )}
                  </th>
                  <td>
                    <span className={`index-state status-${project.status}`}>
                      {indexStatusLabel(project.status)}
                    </span>
                  </td>
                  <td className="numeric">{project.files.toLocaleString()}</td>
                  <td className="numeric">
                    {project.folders.toLocaleString()}
                  </td>
                  <td className="numeric">
                    {project.contentFiles.toLocaleString()}
                  </td>
                  <td className="numeric">
                    {project.excludedEntries.toLocaleString()}
                  </td>
                  <td className="numeric">
                    {project.skippedFiles.toLocaleString()}
                  </td>
                  <td className="numeric">
                    {project.truncatedFiles.toLocaleString()}
                  </td>
                  <td className="index-updated">
                    {project.lastIndexed ? (
                      <time
                        dateTime={new Date(project.lastIndexed).toISOString()}
                        title={new Date(project.lastIndexed).toLocaleString()}
                      >
                        {new Date(project.lastIndexed).toLocaleString(
                          undefined,
                          { dateStyle: "short", timeStyle: "short" },
                        )}
                      </time>
                    ) : (
                      <span className="muted">Never</span>
                    )}
                  </td>
                  <td className="numeric">
                    {project.lastIndexed
                      ? `${(project.durationMs / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })} s`
                      : "—"}
                  </td>
                  <td>
                    <div className="index-row-actions">
                      <button
                        type="button"
                        className="icon-button small"
                        disabled={disabled}
                        onClick={() => onReindex(project)}
                        aria-label={`Reindex ${project.projectName}`}
                        title={`Reindex ${project.projectName}`}
                      >
                        <RefreshCw
                          size={14}
                          className={
                            operation === project.projectId ? "spin" : ""
                          }
                        />
                      </button>
                      <button
                        type="button"
                        className="icon-button small"
                        disabled={disabled}
                        onClick={() => onClear(project)}
                        aria-label={`Clear index for ${project.projectName}`}
                        title={`Clear index for ${project.projectName}`}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={11} className="index-table-empty">
                  No projects match these filters.{" "}
                  <button
                    className="text-button"
                    onClick={() => {
                      setQuery("");
                      setStatusFilter("");
                    }}
                  >
                    Clear filters
                  </button>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="index-table-scroll-hint">
        Columns can be sorted. Scroll within the table to see more projects and
        columns.
      </p>
    </>
  );
}
