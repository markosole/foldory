import { useEffect, useRef, useState } from "react";
import {
  Database,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Trash2,
} from "lucide-react";
import { api } from "../api";
import type {
  ExclusionProfile,
  IndexSettings,
  IndexStatus,
  ProjectIndexStats,
} from "../types";
import { messageOf } from "../utils";
import ProjectIndexTable from "./ProjectIndexTable";

const clean = (patterns: string[]) => [
  ...new Set(patterns.map((line) => line.trim()).filter(Boolean)),
];
export function normalizeIndexSettings(settings: IndexSettings): IndexSettings {
  return {
    ...settings,
    folderPatterns: clean(settings.folderPatterns),
    filePatterns: clean(settings.filePatterns),
    profiles: settings.profiles.map((profile) => ({
      ...profile,
      name: profile.name.trim(),
      folderPatterns: clean(profile.folderPatterns),
      filePatterns: clean(profile.filePatterns),
    })),
  };
}
function PatternFields({
  label,
  value,
  onChange,
}: {
  label: string;
  value: Pick<IndexSettings, "folderPatterns" | "filePatterns">;
  onChange: (
    patch: Pick<IndexSettings, "folderPatterns" | "filePatterns">,
  ) => void;
}) {
  return (
    <div className="index-pattern-fields">
      <label className="field">
        Folder patterns
        <textarea
          aria-label={`${label} folder patterns`}
          rows={5}
          spellCheck={false}
          placeholder={"node_modules\n**/build\nlibrary"}
          value={value.folderPatterns.join("\n")}
          onChange={(event) =>
            onChange({
              ...value,
              folderPatterns: event.target.value.split("\n"),
            })
          }
        />
      </label>
      <label className="field">
        File patterns
        <textarea
          aria-label={`${label} file patterns`}
          rows={5}
          spellCheck={false}
          placeholder={"*.tmp\n*.log"}
          value={value.filePatterns.join("\n")}
          onChange={(event) =>
            onChange({ ...value, filePatterns: event.target.value.split("\n") })
          }
        />
      </label>
    </div>
  );
}

export default function IndexingSettings({
  value,
  busy,
  indexStatus,
  onChange,
  onSave,
  onRefresh,
  onError,
}: {
  value: IndexSettings | undefined;
  busy: boolean;
  indexStatus: IndexStatus;
  onChange: (value: IndexSettings) => void;
  onSave: (event: React.FormEvent) => void;
  onRefresh: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const [defaults, setDefaults] = useState<IndexSettings>();
  const [loadError, setLoadError] = useState("");
  const [retry, setRetry] = useState(0);
  const [statistics, setStatistics] = useState<ProjectIndexStats[]>([]);
  const [statsError, setStatsError] = useState("");
  const [statsLoaded, setStatsLoaded] = useState(false);
  const [operation, setOperation] = useState("");
  const [notice, setNotice] = useState("");
  const callbacks = useRef({ value, onChange, onError });
  callbacks.current = { value, onChange, onError };
  const statsRequest = useRef(0);
  useEffect(() => {
    let active = true;
    setLoadError("");
    api
      .indexDefaults()
      .then((next) => {
        if (!active) return;
        setDefaults(next);
        if (!callbacks.current.value) callbacks.current.onChange(next);
      })
      .catch((reason) => {
        if (active) setLoadError(messageOf(reason));
      });
    return () => {
      active = false;
    };
  }, [retry]);
  async function loadStats() {
    const request = ++statsRequest.current;
    try {
      const rows = await api.indexStatistics();
      if (request !== statsRequest.current) return;
      setStatistics(rows);
      setStatsError("");
      setStatsLoaded(true);
    } catch (reason) {
      if (request === statsRequest.current) setStatsError(messageOf(reason));
    }
  }
  useEffect(() => {
    void loadStats();
    const timer = setInterval(
      () => void loadStats(),
      indexStatus.running ? 1500 : 5000,
    );
    return () => {
      clearInterval(timer);
      ++statsRequest.current;
    };
  }, [indexStatus.running, indexStatus.lastIndexed]);
  async function manage(
    action: "clear" | "reindex" | "all",
    project?: ProjectIndexStats,
  ) {
    setOperation(project?.projectId || "all");
    setNotice("");
    try {
      if (action === "clear" && project)
        await api.clearProjectIndex(project.projectId);
      else if (project) await api.reindexProject(project.projectId);
      else await api.rebuildIndex();
      await loadStats();
      await onRefresh();
      setNotice(
        action === "clear"
          ? `Cleared cached search data for ${project?.projectName}. Reindex it to restore results.`
          : `${project?.projectName || "Workspace"} indexing requested.`,
      );
    } catch (reason) {
      onError(messageOf(reason));
    } finally {
      setOperation("");
    }
  }
  function patchProfile(id: string, patch: Partial<ExclusionProfile>) {
    if (value)
      onChange({
        ...value,
        profiles: value.profiles.map((profile) =>
          profile.id === id ? { ...profile, ...patch } : profile,
        ),
      });
  }
  const disabled = busy || !!operation || indexStatus.running;
  return (
    <>
      <header className="settings-section-title">
        <span className="eyebrow">FIND WHAT MATTERS</span>
        <h2>Search & indexing</h2>
        <p>
          Search project names, folders and text. Choose which generated files
          and dependencies to leave out.
        </p>
      </header>
      <section className="settings-card card index-overview">
        <div className="settings-card-heading">
          <div>
            <h3>
              <Database size={17} /> Local search index
            </h3>
            <p>SQLite · name and content indexes · incremental refresh</p>
          </div>
          <button
            className="button small"
            disabled={disabled}
            onClick={() => void manage("all")}
          >
            <RefreshCw
              size={14}
              className={indexStatus.running ? "spin" : ""}
            />
            {indexStatus.running ? "Indexing…" : "Reindex all"}
          </button>
        </div>
        <div className="index-stats">
          <span>
            <strong>{indexStatus.files.toLocaleString()}</strong> files
          </span>
          <span>
            <strong>{indexStatus.projects.toLocaleString()}</strong> projects
          </span>
          <span>
            {indexStatus.lastIndexed
              ? `Updated ${new Date(indexStatus.lastIndexed).toLocaleString()}`
              : "Not indexed yet"}
          </span>
        </div>
        {indexStatus.message && (
          <p className="settings-help" role="status">
            {indexStatus.message}
          </p>
        )}
        <p className="settings-help">
          Archives and binary files are searchable by name. Content search reads
          supported text files; it does not unpack ZIP files. Indexing reads
          your project files and stores its cache separately in app data.
        </p>
      </section>
      {notice && (
        <p className="index-action-notice" role="status">
          {notice}
        </p>
      )}
      <section className="settings-card card project-index-card">
        <div className="settings-card-heading">
          <div>
            <h3>Index by project</h3>
            <p>
              Clear pauses indexing for that project until you reindex it. Only
              cached search records are removed; project files are never
              changed.
            </p>
          </div>
          <button className="button small" onClick={() => void loadStats()}>
            <RefreshCw size={14} />
            Refresh stats
          </button>
        </div>
        {statsError && (
          <p role="alert" className="index-settings-error">
            Could not load index statistics: {statsError}
          </p>
        )}
        {statistics.length > 0 && (
          <ProjectIndexTable
            statistics={statistics}
            disabled={disabled}
            operation={operation}
            onReindex={(project) => void manage("reindex", project)}
            onClear={(project) => void manage("clear", project)}
          />
        )}
        {!statistics.length && (
          <p className="muted">
            {statsLoaded
              ? "Add a connected project source to see index statistics."
              : "Loading project statistics…"}
          </p>
        )}
        <p className="settings-help">
          Excluded entries count items encountered before pruning a folder; its
          unvisited descendants and .gitignore omissions are not counted.
          Names-only files remain searchable by name but have no indexed text.
          Folder counts include the project root.
        </p>
      </section>
      <form onSubmit={onSave} className="index-exclusions-form">
        <section className="settings-card card">
          <div className="settings-card-heading">
            <div>
              <h3>Exclusion rules</h3>
              <p>
                Folder rules skip that folder and its descendants. File rules
                skip matching files.
              </p>
            </div>
            <button
              className="button small"
              type="button"
              disabled={busy || !defaults}
              onClick={() => defaults && onChange(structuredClone(defaults))}
            >
              <RotateCcw size={13} />
              Reset all defaults
            </button>
          </div>
          {loadError && (
            <p role="alert" className="index-settings-error">
              Could not load defaults: {loadError}{" "}
              <button
                type="button"
                className="text-button"
                onClick={() => setRetry((current) => current + 1)}
              >
                Retry
              </button>
            </p>
          )}
          {value ? (
            <>
              <label className="index-toggle">
                <input
                  type="checkbox"
                  checked={value.followGitignore}
                  disabled={busy}
                  onChange={(event) =>
                    onChange({
                      ...value,
                      followGitignore: event.target.checked,
                    })
                  }
                />
                <span>
                  <strong>Follow .gitignore files</strong>
                  <small>
                    Apply each project's ignore rules, including nested
                    .gitignore files. Turn off to find files excluded by Git.
                  </small>
                </span>
              </label>
              <p className="settings-help">
                Use one pattern per line. A name matches at any depth; use / for
                a project-relative path and * or ** for globs. Rules apply to
                all projects. Broad names such as library, packages, bin, and
                dist can also contain source files, so review them before
                enabling.
              </p>
              <h4>Additional exclusions</h4>
              <PatternFields
                label="Additional"
                value={value}
                onChange={(patterns) => onChange({ ...value, ...patterns })}
              />
            </>
          ) : (
            !loadError && <p className="muted">Loading exclusion defaults…</p>
          )}
        </section>
        {value && (
          <section className="settings-card card">
            <div className="settings-card-heading">
              <div>
                <h3>Language & tool presets</h3>
                <p>
                  Enable the groups you use. Expand any group to edit its lists.
                </p>
              </div>
              <button
                type="button"
                className="button small"
                disabled={busy}
                onClick={() =>
                  onChange({
                    ...value,
                    profiles: [
                      ...value.profiles,
                      {
                        id: `custom-${crypto.randomUUID()}`,
                        name: "Custom exclusions",
                        description: "Your own reusable exclusion list",
                        enabled: true,
                        folderPatterns: [],
                        filePatterns: [],
                      },
                    ],
                  })
                }
              >
                <Plus size={14} />
                Add list
              </button>
            </div>
            <div className="index-profiles">
              {value.profiles.map((profile) => {
                const defaultProfile = defaults?.profiles.find(
                  (entry) => entry.id === profile.id,
                );
                return (
                  <details
                    className="index-profile"
                    key={profile.id}
                    open={profile.name === "Custom exclusions" || undefined}
                  >
                    <summary>
                      <span
                        className={`index-profile-state ${profile.enabled ? "enabled" : ""}`}
                      >
                        {profile.enabled ? "On" : "Off"}
                      </span>
                      <span className="index-profile-title">
                        {profile.name}
                        <small>{profile.description}</small>
                      </span>
                      <span className="index-profile-count">
                        {profile.folderPatterns.filter(Boolean).length +
                          profile.filePatterns.filter(Boolean).length}{" "}
                        rules
                      </span>
                    </summary>
                    <div className="index-profile-body">
                      <label className="index-toggle">
                        <input
                          type="checkbox"
                          aria-label={`Enable ${profile.name}`}
                          checked={profile.enabled}
                          disabled={busy}
                          onChange={(event) =>
                            patchProfile(profile.id, {
                              enabled: event.target.checked,
                            })
                          }
                        />
                        <span>Enable this exclusion list</span>
                      </label>
                      {!defaultProfile && (
                        <label className="field">
                          List name
                          <input
                            aria-label={`Name for ${profile.name}`}
                            value={profile.name}
                            required
                            maxLength={120}
                            onChange={(event) =>
                              patchProfile(profile.id, {
                                name: event.target.value,
                              })
                            }
                          />
                        </label>
                      )}
                      <PatternFields
                        label={profile.name}
                        value={profile}
                        onChange={(patterns) =>
                          patchProfile(profile.id, patterns)
                        }
                      />
                      <div className="settings-form-actions">
                        {defaultProfile ? (
                          <button
                            className="button small"
                            type="button"
                            disabled={busy}
                            onClick={() =>
                              patchProfile(
                                profile.id,
                                structuredClone(defaultProfile),
                              )
                            }
                          >
                            <RotateCcw size={13} />
                            Reset {profile.name}
                          </button>
                        ) : (
                          <button
                            className="button small"
                            type="button"
                            disabled={busy}
                            onClick={() =>
                              onChange({
                                ...value,
                                profiles: value.profiles.filter(
                                  (entry) => entry.id !== profile.id,
                                ),
                              })
                            }
                          >
                            <Trash2 size={13} />
                            Remove list
                          </button>
                        )}
                      </div>
                    </div>
                  </details>
                );
              })}
            </div>
            <div className="index-save-row">
              <button className="button primary" disabled={busy}>
                <Save size={15} />
                {busy ? "Saving…" : "Save exclusions"}
              </button>
              <span className="settings-help">
                Saving applies the rules and refreshes the index.
              </span>
            </div>
          </section>
        )}
      </form>
    </>
  );
}
