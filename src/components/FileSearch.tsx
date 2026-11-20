import AppSelect from "./AppSelect";
import { useEffect, useRef, useState } from "react";
import {
  FileSearch as SearchIcon,
  Search,
  FileCode2,
  Folder,
  FolderOpen,
  RefreshCw,
  ArrowUpRight,
} from "lucide-react";
import { api } from "../api";
import type { Bootstrap, SearchResult } from "../types";
import { messageOf, projectName, relativeTime } from "../utils";
export default function FileSearch({
  data,
  selectedId,
  onOpen,
  onRefresh,
  onError,
}: {
  data: Bootstrap;
  selectedId: string | null;
  onOpen: (result: SearchResult) => void;
  onRefresh: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState("");
  const [mode, setMode] = useState("filename");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [busy, setBusy] = useState(false);
  const [searched, setSearched] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [indexing, setIndexing] = useState(false);
  const generation = useRef(0);
  useEffect(() => {
    const id = ++generation.current;
    setSearchError("");
    setResults([]);
    if (!query.trim()) {
      setResults([]);
      setSearched(false);
      setBusy(false);
      return;
    }
    setBusy(true);
    const timer = setTimeout(() => {
      api
        .searchFiles(query.trim(), scope || null, mode)
        .then((items) => {
          if (id === generation.current) {
            setResults(items);
            setSearched(true);
          }
        })
        .catch((error) => {
          if (id === generation.current) {
            setSearchError(messageOf(error));
            setResults([]);
            setSearched(true);
          }
        })
        .finally(() => {
          if (id === generation.current) setBusy(false);
        });
    }, 220);
    return () => {
      clearTimeout(timer);
      ++generation.current;
    };
  }, [
    query,
    scope,
    mode,
    data.indexStatus.lastIndexed,
    data.indexStatus.running,
  ]);
  async function rebuild() {
    setIndexing(true);
    try {
      await api.rebuildIndex();
      await onRefresh();
      setQuery((value) => (value ? `${value} ` : value));
    } catch (error) {
      onError(messageOf(error));
    } finally {
      setIndexing(false);
    }
  }
  return (
    <div className="page search-page">
      <div className="page-heading">
        <div>
          <div className="eyebrow">YOUR WORKSPACE, SEARCHABLE</div>
          <h1>Find files & folders</h1>
          <p className="muted">
            Across your projects, without opening another window.
          </p>
        </div>
        <button
          className="button"
          onClick={rebuild}
          disabled={indexing || data.indexStatus.running}
        >
          <RefreshCw size={15} className={indexing ? "spin" : ""} />
          {indexing || data.indexStatus.running ? "Indexing…" : "Rebuild index"}
        </button>
      </div>
      <div className="search-controls">
        <div className="search-input large">
          <Search size={19} />
          <input
            autoFocus
            aria-label="Search files"
            placeholder={
              mode === "content"
                ? "Search words inside text files…"
                : mode === "folder"
                  ? "Search folder names or paths…"
                  : "Search file and folder names…"
            }
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <kbd>Ctrl K</kbd>
        </div>
        <div className="search-filters">
          <div className="segmented">
            <button
              className={mode === "filename" ? "selected" : ""}
              onClick={() => setMode("filename")}
            >
              File & folder names
            </button>
            <button
              className={mode === "folder" ? "selected" : ""}
              onClick={() => setMode("folder")}
            >
              Folders
            </button>
            <button
              className={mode === "content" ? "selected" : ""}
              onClick={() => setMode("content")}
            >
              Text content
            </button>
          </div>
          <AppSelect
            aria-label="Search scope"
            value={scope}
            onChange={setScope}
            searchable
            compact
            options={[
              { value: "", label: "All projects" },
              ...data.projects
                .filter(
                  (project) => !project.hidden || project.id === selectedId,
                )
                .map((project) => ({
                  value: project.id,
                  label:
                    project.id === selectedId
                      ? `Current project · ${projectName(project)}`
                      : projectName(project),
                  keywords: `${project.name} ${project.path}`,
                })),
            ]}
          />
        </div>
      </div>
      <p className="search-mode-help">
        {mode === "content"
          ? "Find words and word prefixes in supported text files. Archives and binary contents are not searched."
          : "Includes archives such as .zip, project roots and nested folders. Exclusion rules apply."}
      </p>
      {searchError && (
        <p className="index-settings-error" role="alert">
          Search failed: {searchError}
        </p>
      )}
      <div className="search-summary">
        <span>
          {busy
            ? "Searching…"
            : searched
              ? `${results.length} result${results.length === 1 ? "" : "s"}${results.length >= 150 ? " · refine your search for more" : ""}`
              : `${data.indexStatus.files.toLocaleString()} indexed files`}
        </span>
        <span>
          {data.indexStatus.lastIndexed
            ? `Indexed ${relativeTime(data.indexStatus.lastIndexed).toLowerCase()}`
            : "Build the index to search your files"}
        </span>
      </div>
      {results.length > 0 ? (
        <div className="search-results">
          {results.map((result) => (
            <div
              className="search-result-row"
              key={`${result.projectId}/${result.path}`}
            >
              <button
                className="search-result"
                key={`${result.projectId}/${result.path}`}
                onClick={() => onOpen(result)}
              >
                {result.directory ? (
                  <Folder size={20} />
                ) : (
                  <FileCode2 size={20} />
                )}
                <span className="result-text">
                  <strong>
                    {result.name}
                    {result.directory && (
                      <span className="search-result-kind depth-badge depth-0">
                        {result.depth === 0 ? "Project root" : "Folder"}
                      </span>
                    )}
                  </strong>
                  <span className="muted">
                    {result.projectName} <span className="separator">/</span>{" "}
                    {result.path}
                  </span>
                  {result.excerpt && <code>{result.excerpt}</code>}
                </span>
                <ArrowUpRight size={16} />
              </button>
              {!result.directory && (
                <button
                  className="icon-button result-reveal"
                  title="Open containing folder"
                  aria-label={`Open containing folder for ${result.name}`}
                  onClick={() =>
                    onOpen({
                      ...result,
                      path: result.path.split("/").slice(0, -1).join("/"),
                      directory: true,
                      depth: Math.max(0, result.depth - 1),
                    })
                  }
                >
                  <FolderOpen size={17} />
                </button>
              )}
            </div>
          ))}
        </div>
      ) : (
        <div className="empty-state search-empty">
          <div className="empty-icon">
            <SearchIcon size={27} />
          </div>
          <h2>
            {searchError
              ? "Search unavailable"
              : busy
                ? "Searching…"
                : searched
                  ? "No matches"
                  : "Less looking. More doing."}
          </h2>
          <p>
            {searched
              ? "Try a shorter phrase, a different project, or rebuild the index after adding files."
              : "Search a filename, a folder path, or the words inside your project files."}
          </p>
          {!searched && (
            <span className="field-help">
              Manage exclusions and project coverage in Settings → Search &
              indexing.
            </span>
          )}
        </div>
      )}
      {data.indexStatus.message && (
        <p className="index-note">{data.indexStatus.message}</p>
      )}
    </div>
  );
}
