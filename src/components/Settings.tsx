import AppSelect from "./AppSelect";
import { useEffect, useRef, useState } from "react";
import {
  Check,
  BookOpen,
  ChevronRight,
  ExternalLink,
  Files,
  FolderOpen,
  FolderPlus,
  HardDrive,
  LoaderCircle,
  Power,
  PowerOff,
  Plus,
  Plug,
  RefreshCw,
  ScanSearch,
  Save,
  Settings2,
  ShieldCheck,
  Sparkles,
  Terminal,
  Trash2,
  X,
} from "lucide-react";
import { api } from "../api";
import { endpointSettings, withNormalizedEndpoints } from "../ai";
import SupportedLaunchers from "./SupportedLaunchers";
import { version } from "../../package.json";
import type {
  Settings as AppSettings,
  SettingsProps,
  Template,
  Tool,
} from "../types";
import InspectorPreferences from "./InspectorPreferences";
import IndexingSettings, { normalizeIndexSettings } from "./IndexingSettings";
import type { EndpointProvider } from "../types";
import {
  CustomProvidersSettings,
  SubscriptionProviders,
} from "./AiConnectionSettings";
import StarterFilesEditor, { parseStarterFiles } from "./StarterFilesEditor";
import { useAppDialog } from "./AppDialog";
import "./settings.css";
import IntegrationSettings from "../integrations/IntegrationSettings";
import { beforeNavigate } from "../navigation";
import FilePreferences from "./FilePreferences";
import HelpPage from "./HelpPage";

type Section =
  | "files"
  | "integrations"
  | "sources"
  | "indexing"
  | "templates"
  | "tools"
  | "ai"
  | "inspector"
  | "help"
  | "general";
const sections = [
  { id: "files", label: "Files & editor", icon: Files },
  { id: "sources", label: "Project sources", icon: HardDrive },
  { id: "indexing", label: "Search & indexing", icon: ScanSearch },
  { id: "templates", label: "Project templates", icon: Files },
  { id: "tools", label: "Tools & launchers", icon: Terminal },
  { id: "integrations", label: "Integrations", icon: Plug },
  { id: "ai", label: "AI connection", icon: Sparkles },
  { id: "inspector", label: "Project inspector", icon: ScanSearch },
  { id: "general", label: "General", icon: Settings2 },
  { id: "help", label: "How To & Help", icon: BookOpen },
] as const;

export default function Settings({
  data,
  onRefresh,
  onError,
  onIntegrationsChanged,
  onOpenIntegration,
  onRunOnboarding,
}: SettingsProps) {
  const dialog = useAppDialog();
  const [section, setSection] = useState<Section>("sources");
  const [sourcePath, setSourcePath] = useState("");
  const [busy, setBusy] = useState(false);
  const [success, setSuccess] = useState("");
  const [config, setConfig] = useState<AppSettings>(data.settings);
  const [templateId, setTemplateId] = useState("");
  const [templateName, setTemplateName] = useState("");
  const [directories, setDirectories] = useState("");
  const [files, setFiles] = useState("[]");
  const [toolId, setToolId] = useState("");
  const [toolName, setToolName] = useState("");
  const [executable, setExecutable] = useState("");
  const [args, setArgs] = useState('["{{project}}"]');
  const [editingTool, setEditingTool] = useState(false);
  const templateInitialised = useRef(false);
  const templateBaseline = useRef("");
  const toolBaseline = useRef("");
  const persistedConfig = JSON.stringify(data.settings);
  const previousSettings = useRef(data.settings);

  async function runOnboarding() {
    try {
      await beforeNavigate();
      setConfig(data.settings);
      selectTemplate(
        data.templates.find((template) => template.id === templateId) ||
          data.templates[0],
      );
      setEditingTool(false);
      onRunOnboarding?.();
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    }
  }

  useEffect(() => {
    const previous = previousSettings.current;
    previousSettings.current = data.settings;
    const withoutKeys = (settings: AppSettings) => {
      const normalized = withNormalizedEndpoints(settings);
      return JSON.stringify({
        ...normalized,
        aiHasKey: false,
        aiProviders: normalized.aiProviders!.map((entry) => ({
          ...entry,
          hasKey: false,
        })),
      });
    };
    // Saving a credential must not erase the URL/model currently being edited.
    setConfig((current) => {
      if (
        JSON.stringify(current) === JSON.stringify(previous) ||
        withoutKeys(previous) !== withoutKeys(data.settings)
      )
        return data.settings;
      const normalized = withNormalizedEndpoints(current);
      return {
        ...normalized,
        aiHasKey: data.settings.aiHasKey,
        aiProviders: normalized.aiProviders!.map((entry) => ({
          ...entry,
          hasKey: endpointSettings(data.settings, entry.provider).hasKey,
        })),
      };
    });
  }, [persistedConfig]);
  useEffect(() => {
    if (!data.templates.length) return;
    if (!templateInitialised.current) {
      templateInitialised.current = true;
      selectTemplate(
        data.templates.find(
          (template) => template.id === data.settings.defaultTemplateId,
        ) || data.templates[0],
      );
      return;
    }
    // Onboarding can edit a saved template while Settings stays mounted.
    // Refresh clean forms, but keep any draft the user is still editing.
    const current = JSON.stringify({ name: templateName, directories, files });
    if (current !== templateBaseline.current || !templateId) return;
    const saved = data.templates.find((template) => template.id === templateId);
    if (!saved) {
      selectTemplate(data.templates[0]);
      return;
    }
    const next = JSON.stringify({
      name: saved.name,
      directories: saved.directories.join("\n"),
      files: JSON.stringify(saved.files, null, 2),
    });
    if (next !== templateBaseline.current) selectTemplate(saved);
  }, [data.templates]);
  useEffect(() => {
    const currentTemplate = JSON.stringify({
      name: templateName,
      directories,
      files,
    });
    const currentTool = JSON.stringify({ name: toolName, executable, args });
    const dirty =
      JSON.stringify(config) !== persistedConfig ||
      (!!templateBaseline.current &&
        currentTemplate !== templateBaseline.current) ||
      (editingTool && currentTool !== toolBaseline.current);
    const listener = (event: Event) => {
      if (dirty)
        (
          event as CustomEvent<{ promises: Promise<unknown>[] }>
        ).detail.promises.push(
          dialog
            .confirm({
              title: "Discard unsaved changes?",
              message:
                "Leave Settings and discard your unsaved changes? Save the current form first to keep them.",
              confirmLabel: "Discard changes",
              danger: true,
            })
            .then((confirmed) => {
              if (!confirmed)
                throw new Error("Settings still have unsaved changes.");
            }),
        );
    };
    window.addEventListener("foldory:before-navigate", listener);
    return () =>
      window.removeEventListener("foldory:before-navigate", listener);
  }, [
    config,
    persistedConfig,
    templateName,
    directories,
    files,
    editingTool,
    toolName,
    executable,
    args,
    dialog,
  ]);

  async function action(task: () => Promise<void>, message = "") {
    setBusy(true);
    setSuccess("");
    try {
      await task();
      if (message) setSuccess(message);
      return true;
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function addSource(event: React.FormEvent) {
    event.preventDefault();
    if (!sourcePath.trim()) return;
    await action(async () => {
      await api.addSource(sourcePath.trim());
      setSourcePath("");
      await onRefresh();
    }, "Source added. Its immediate child folders are now projects.");
  }
  async function pickSource() {
    try {
      const path = await api.chooseDirectory();
      if (path) setSourcePath(path);
    } catch (error) {
      onError(String(error));
    }
  }
  function selectTemplate(template?: Template) {
    const name = template?.name || "";
    const dirs = template
      ? template.directories.join("\n")
      : "Docs\nDesign\nApp";
    const starterFiles = JSON.stringify(
      template?.files || [
        {
          path: "PROJECT.md",
          content:
            "# {{name}}\n\nClient: {{client}}\n\n## Overview\n\n## Tasks\n\n- [ ] First step\n",
        },
      ],
      null,
      2,
    );
    templateBaseline.current = JSON.stringify({
      name,
      directories: dirs,
      files: starterFiles,
    });
    setTemplateId(template?.id || "");
    setTemplateName(name);
    setDirectories(dirs);
    setFiles(starterFiles);
    setSuccess("");
  }
  async function saveTemplate(event: React.FormEvent) {
    event.preventDefault();
    await action(async () => {
      const result = await api.saveTemplate({
        id: templateId || crypto.randomUUID(),
        name: templateName.trim(),
        directories: directories
          .split("\n")
          .map((path) => path.trim())
          .filter(Boolean),
        files: parseStarterFiles(files),
      });
      setTemplateId(result.id);
      templateBaseline.current = JSON.stringify({
        name: templateName,
        directories,
        files,
      });
      await onRefresh();
    }, "Template saved. It is available when creating a project.");
  }
  function editTool(tool?: Tool) {
    const name = tool?.name || "";
    const exec = tool?.executable || "";
    const toolArgs = JSON.stringify(tool?.args || ["{{project}}"], null, 2);
    toolBaseline.current = JSON.stringify({
      name,
      executable: exec,
      args: toolArgs,
    });
    setToolId(tool?.id || "");
    setToolName(name);
    setExecutable(exec);
    setArgs(toolArgs);
    setEditingTool(true);
  }
  async function saveTool(event: React.FormEvent) {
    event.preventDefault();
    await action(async () => {
      const parsed: unknown = JSON.parse(args);
      if (
        !Array.isArray(parsed) ||
        !parsed.every((arg) => typeof arg === "string")
      )
        throw new Error(
          'Arguments must be a JSON array of strings, for example ["{{project}}"].',
        );
      const tool: Tool = {
        id: toolId || crypto.randomUUID(),
        name: toolName.trim(),
        executable: executable.trim(),
        args: parsed,
      };
      const next = {
        ...config,
        tools: [...config.tools.filter((item) => item.id !== tool.id), tool],
      };
      await api.saveSettings(next);
      setEditingTool(false);
      await onRefresh();
    }, "Tool saved. Find it in the project’s more-tools menu.");
  }
  async function saveConfig(event: React.FormEvent) {
    event.preventDefault();
    await action(async () => {
      const saved = await api.saveSettings({
        ...config,
        ...(config.indexing
          ? { indexing: normalizeIndexSettings(config.indexing) }
          : {}),
      });
      setConfig(saved);
      await onRefresh();
    }, "Settings saved.");
  }

  return (
    <div className="settings-page">
      <aside className="settings-nav">
        <h1>Settings</h1>
        <p>Your workspace, your way.</p>
        <nav aria-label="Settings sections">
          {sections.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              className={section === id ? "active" : ""}
              aria-current={section === id ? "page" : undefined}
              onClick={() =>
                void (async () => {
                  try {
                    if (section === "integrations" && id !== section)
                      await beforeNavigate();
                    setSection(id);
                    setSuccess("");
                  } catch (error) {
                    onError(
                      error instanceof Error ? error.message : String(error),
                    );
                  }
                })()
              }
            >
              <Icon size={17} />
              {label}
              <ChevronRight size={13} />
            </button>
          ))}
        </nav>
        <div className="settings-local">
          <ShieldCheck size={18} />
          <span>
            Local by default<small>Your projects stay on your drives.</small>
          </span>
        </div>
      </aside>
      <main className="settings-content">
        {section === "help" && (
          <HelpPage
            onRunOnboarding={
              onRunOnboarding ? () => void runOnboarding() : undefined
            }
          />
        )}
        {section === "integrations" && (
          <IntegrationSettings
            onChanged={onIntegrationsChanged}
            onOpen={onOpenIntegration}
          />
        )}
        {success && (
          <div className="settings-success" role="status">
            <Check size={16} />
            {success}
            <button
              className="icon-button small"
              aria-label="Dismiss confirmation"
              onClick={() => setSuccess("")}
            >
              <X size={14} />
            </button>
          </div>
        )}
        {section === "sources" && (
          <>
            <header className="settings-section-title">
              <span className="eyebrow">LIBRARY</span>
              <h2>Project sources</h2>
              <p>
                Add and manage sources of your projects. Each source is a folder
                on your disk.
              </p>
            </header>
            <section className="settings-card card">
              <div className="settings-card-heading">
                <div>
                  <h3>Connected folders</h3>
                  <p>Use multiple drives, and keep everything within reach.</p>
                </div>
                <button
                  className="button small"
                  disabled={busy}
                  onClick={() =>
                    void action(async () => {
                      await api.scanSources();
                      await onRefresh();
                    }, "Project library refreshed.")
                  }
                >
                  <RefreshCw size={14} className={busy ? "spin" : ""} />
                  Scan now
                </button>
              </div>
              {!data.sources.length ? (
                <div className="settings-source-empty">
                  <FolderPlus size={27} />
                  <p>No sources yet. Add your main projects folder below.</p>
                </div>
              ) : (
                <div className="source-list">
                  {data.sources.map((source) => {
                    const connected = source.connected !== false;
                    return (
                      <div className="source-row" key={source.id}>
                        <HardDrive size={21} />
                        <div className="source-details">
                          <strong>{source.name}</strong>
                          <code>{source.path}</code>
                        </div>
                        <span
                          className={`badge ${!connected || !source.available ? "warning" : ""}`}
                        >
                          {!connected
                            ? "Disconnected"
                            : source.available
                              ? "Connected"
                              : "Offline"}
                        </span>
                        <div className="source-actions">
                          {connected ? (
                            <button
                              className="button small"
                              disabled={busy}
                              onClick={() => {
                                void (async () => {
                                  if (
                                    !(await dialog.confirm({
                                      title: `Disconnect “${source.name}”?`,
                                      message:
                                        "The source will stay saved but its projects will be disabled. You can reconnect it here at any time, with all project data preserved.",
                                      confirmLabel: "Disconnect",
                                    }))
                                  )
                                    return;
                                  await action(async () => {
                                    await api.setSourceConnected(
                                      source.id,
                                      false,
                                    );
                                    await onRefresh();
                                  }, "Source disconnected and saved for later.");
                                })();
                              }}
                            >
                              <PowerOff size={14} />
                              Disconnect
                            </button>
                          ) : (
                            <button
                              className="button small"
                              disabled={busy}
                              onClick={() =>
                                void action(async () => {
                                  await api.setSourceConnected(source.id, true);
                                  await onRefresh();
                                }, "Source reconnected with its saved project data.")
                              }
                            >
                              <Power size={14} />
                              Reconnect
                            </button>
                          )}
                          <button
                            className="icon-button small"
                            title={`Remove ${source.name} source`}
                            aria-label={`Remove ${source.name} source`}
                            disabled={busy}
                            onClick={() => {
                              void (async () => {
                                if (
                                  !(await dialog.confirm({
                                    title: `Remove “${source.name}”?`,
                                    message:
                                      "This permanently removes the saved source, project annotations, chats, inspector access, and search data from Foldory. Project folders and files remain on disk.",
                                    confirmLabel: "Remove source",
                                    danger: true,
                                  }))
                                )
                                  return;
                                await action(async () => {
                                  await api.removeSource(source.id);
                                  await onRefresh();
                                }, "Saved source and app data removed. Files remain on disk.");
                              })();
                            }}
                          >
                            <Trash2 size={15} />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
              <form
                className="source-add-form"
                onSubmit={(event) => void addSource(event)}
              >
                <label className="field">
                  Source folder
                  <div className="source-path-input">
                    <input
                      value={sourcePath}
                      onChange={(event) => setSourcePath(event.target.value)}
                      placeholder="D:\Projects"
                      required
                    />
                    <button
                      className="button"
                      type="button"
                      disabled={busy}
                      onClick={() => void pickSource()}
                    >
                      <FolderOpen size={15} />
                      Browse
                    </button>
                  </div>
                </label>
                <button
                  className="button primary"
                  disabled={busy || !sourcePath.trim()}
                >
                  {busy ? (
                    <LoaderCircle size={15} className="spin" />
                  ) : (
                    <Plus size={15} />
                  )}
                  Add source
                </button>
              </form>
            </section>
            <div className="settings-note">
              <ShieldCheck size={18} />
              <p>
                Disconnecting keeps the source and its project data saved for
                later. Removing clears its saved app data. Neither action
                changes your folders or files on disk.
              </p>
            </div>
            <section className="settings-card card">
              <div className="settings-card-heading">
                <div>
                  <h3>Search index</h3>
                  <p>
                    File, folder and text-content search across your projects.
                  </p>
                </div>
                <button
                  className="button small"
                  disabled={busy || data.indexStatus.running}
                  onClick={() =>
                    void action(async () => {
                      await api.rebuildIndex();
                      await onRefresh();
                    }, "Search indexing requested.")
                  }
                >
                  <RefreshCw
                    size={14}
                    className={data.indexStatus.running ? "spin" : ""}
                  />
                  Rebuild index
                </button>
              </div>
              <div className="index-stats">
                <span>
                  <strong>{data.indexStatus.files.toLocaleString()}</strong>{" "}
                  indexed files
                </span>
                <span>
                  <strong>{data.indexStatus.projects.toLocaleString()}</strong>{" "}
                  projects
                </span>
                <span>
                  {data.indexStatus.running
                    ? "Indexing…"
                    : data.indexStatus.lastIndexed
                      ? `Updated ${new Date(data.indexStatus.lastIndexed).toLocaleString()}`
                      : "Not indexed yet"}
                </span>
              </div>
              {data.indexStatus.message && (
                <p className="muted">{data.indexStatus.message}</p>
              )}
              <p className="settings-help">
                Choose exclusions and inspect each project in{" "}
                <button
                  className="text-button"
                  onClick={() => setSection("indexing")}
                >
                  Search & indexing
                </button>
                .
              </p>
            </section>
          </>
        )}
        {section === "indexing" && (
          <IndexingSettings
            value={config.indexing}
            busy={busy}
            indexStatus={data.indexStatus}
            onChange={(indexing) =>
              setConfig((current) => ({ ...current, indexing }))
            }
            onSave={(event) => void saveConfig(event)}
            onRefresh={onRefresh}
            onError={onError}
          />
        )}
        {section === "templates" && (
          <>
            <header className="settings-section-title">
              <span className="eyebrow">START CONSISTENTLY</span>
              <h2>Project templates</h2>
              <p>
                Define the folders and starter files a new project needs.
                Templates create structure without running scripts.
              </p>
            </header>
            <div className="template-selector">
              <label className="field">
                Template
                <AppSelect
                  aria-label="Template"
                  value={templateId}
                  onChange={(id) =>
                    selectTemplate(
                      data.templates.find((template) => template.id === id),
                    )
                  }
                  searchable
                  options={[
                    { value: "", label: "New template" },
                    ...data.templates.map((template) => ({
                      value: template.id,
                      label: template.name,
                    })),
                  ]}
                />
              </label>
              <button className="button" onClick={() => selectTemplate()}>
                <Plus size={15} />
                New template
              </button>
            </div>
            <form
              className="settings-card card template-form"
              onSubmit={(event) => void saveTemplate(event)}
            >
              <label className="field">
                Template name
                <input
                  value={templateName}
                  onChange={(event) => setTemplateName(event.target.value)}
                  placeholder="Client project"
                  maxLength={120}
                  required
                />
              </label>
              <label className="field">
                Folders
                <span className="settings-help">
                  One relative path per line. Use / for nested folders.
                </span>
                <textarea
                  value={directories}
                  onChange={(event) => setDirectories(event.target.value)}
                  rows={8}
                  spellCheck={false}
                  placeholder={"Docs\nDesign\nSecure/Access\nApp"}
                />
              </label>
              <StarterFilesEditor
                key={templateId}
                value={files}
                onChange={setFiles}
              />
              <div className="settings-form-actions">
                <button className="button primary" disabled={busy}>
                  <Save size={15} />
                  {busy ? "Saving…" : "Save template"}
                </button>
                {templateId && (
                  <button
                    type="button"
                    className="button danger"
                    disabled={busy}
                    onClick={() => {
                      void (async () => {
                        if (
                          !(await dialog.confirm({
                            title: "Delete template?",
                            message:
                              "Delete this template? Existing projects are unaffected.",
                            confirmLabel: "Delete template",
                            danger: true,
                          }))
                        )
                          return;
                        await action(async () => {
                          await api.deleteTemplate(templateId);
                          selectTemplate();
                          await onRefresh();
                        }, "Template deleted.");
                      })();
                    }}
                  >
                    <Trash2 size={14} />
                    Delete template
                  </button>
                )}
              </div>
            </form>
          </>
        )}
        {section === "tools" && (
          <>
            <header className="settings-section-title">
              <span className="eyebrow">WORK IN YOUR FAVOURITE APPS</span>
              <h2>Tools & launchers</h2>
              <p>
                Open tools in a selected project’s directory. Your configured
                executable receives arguments directly.
              </p>
            </header>
            <section className="settings-card card">
              <div className="settings-card-heading">
                <div>
                  <h3>Built-in launchers</h3>
                  <p>Available from the project toolbar.</p>
                </div>
              </div>
              <div className="builtin-tools">
                {[
                  "Windows Explorer",
                  "Command Prompt",
                  "PowerShell",
                  "Default file app",
                ].map((name) => (
                  <span className="badge" key={name}>
                    {name}
                  </span>
                ))}
              </div>
              <p className="settings-help">
                Open folders, terminals, and files with Windows tools.
              </p>
            </section>
            <SupportedLaunchers
              settings={config}
              busy={busy}
              onChange={async (next) => {
                await action(async () => {
                  const saved = await api.saveSettings(next);
                  setConfig(saved);
                  await onRefresh();
                });
              }}
            />
            <section className="settings-card card">
              <div className="settings-card-heading">
                <div>
                  <h3>Custom tools</h3>
                  <p>Add an editor, terminal, or your own executable.</p>
                </div>
                <button className="button small" onClick={() => editTool()}>
                  <Plus size={14} />
                  Add tool
                </button>
              </div>
              {!config.tools.length ? (
                <p className="muted">No custom tools yet.</p>
              ) : (
                <div className="custom-tool-list">
                  {config.tools.map((tool) => (
                    <div className="custom-tool-row" key={tool.id}>
                      <Terminal size={18} />
                      <div>
                        <strong>{tool.name}</strong>
                        <code>{tool.executable}</code>
                      </div>
                      <button
                        className="button small"
                        onClick={() => editTool(tool)}
                      >
                        Edit
                      </button>
                      <button
                        className="icon-button small"
                        aria-label={`Remove ${tool.name}`}
                        disabled={busy}
                        onClick={() => {
                          void (async () => {
                            if (
                              !(await dialog.confirm({
                                title: "Remove launcher?",
                                message: `Remove the “${tool.name}” launcher?`,
                                confirmLabel: "Remove launcher",
                                danger: true,
                              }))
                            )
                              return;
                            await action(async () => {
                              await api.saveSettings({
                                ...config,
                                tools: config.tools.filter(
                                  (item) => item.id !== tool.id,
                                ),
                              });
                              await onRefresh();
                            }, "Tool removed.");
                          })();
                        }}
                      >
                        <Trash2 size={15} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </section>
            {editingTool && (
              <form
                className="settings-card card tool-form"
                onSubmit={(event) => void saveTool(event)}
              >
                <div className="settings-card-heading">
                  <h3>{toolId ? "Edit tool" : "New tool"}</h3>
                  <button
                    type="button"
                    className="icon-button small"
                    aria-label="Close tool editor"
                    onClick={() => setEditingTool(false)}
                  >
                    <X size={16} />
                  </button>
                </div>
                <label className="field">
                  Display name
                  <input
                    value={toolName}
                    onChange={(event) => setToolName(event.target.value)}
                    placeholder="Visual Studio Code"
                    required
                  />
                </label>
                <label className="field">
                  Executable
                  <input
                    value={executable}
                    onChange={(event) => setExecutable(event.target.value)}
                    placeholder="code.exe or C:\Tools\editor.exe"
                    required
                  />
                </label>
                <label className="field">
                  Arguments
                  <span className="settings-help">
                    JSON array of strings. {"{{project}}"} expands to the full
                    project path as one argument.
                  </span>
                  <textarea
                    className="json-input"
                    value={args}
                    onChange={(event) => setArgs(event.target.value)}
                    rows={4}
                    spellCheck={false}
                    required
                  />
                </label>
                <p className="settings-help">
                  Working directory is always the selected project. Shell
                  operators such as &gt; and &amp;&amp; are ordinary arguments;
                  use a dedicated script executable when needed.
                </p>
                <button className="button primary" disabled={busy}>
                  <Save size={15} />
                  Save tool
                </button>
              </form>
            )}
          </>
        )}
        {section === "ai" && (
          <div className="ai-connection-page">
            <header className="settings-section-title">
              <span className="eyebrow">OPTIONAL INTEGRATION</span>
              <h2>AI connection</h2>
              <p>
                Connect a subscription account, or bring your own local model or
                API key.
              </p>
            </header>
            <SubscriptionProviders />
            <CustomProvidersSettings
              value={config}
              saved={data.settings}
              busy={busy}
              onChange={setConfig}
              onSave={(event) => void saveConfig(event)}
              onSaveKey={async (provider: EndpointProvider, key: string) => {
                return await action(
                  async () => {
                    await api.saveAiKey(provider, key);
                    await onRefresh();
                  },
                  key ? "API key saved securely." : "Stored API key removed.",
                );
              }}
            />
            <div className="settings-note">
              <ShieldCheck size={19} />
              <p>
                Chat requests send your message and recent conversation history
                to the selected provider. The global assistant also sends a
                project catalog. Project files are shared when you select
                project context or run the project inspector. Inspector drafts
                can be saved after enabling full access for the project and
                confirming the specific write.
              </p>
            </div>
          </div>
        )}
        {section === "inspector" && (
          <>
            <header className="settings-section-title">
              <span className="eyebrow">AI DRAFTING</span>
              <h2>Project inspector</h2>
              <p>
                Set the generation budget and save prompts for different
                PROJECT.md layouts.
              </p>
            </header>
            {config.inspector ? (
              <InspectorPreferences
                value={config.inspector}
                busy={busy}
                onChange={(inspector) =>
                  setConfig((current) => ({ ...current, inspector }))
                }
                onSave={(event) => void saveConfig(event)}
              />
            ) : (
              <p className="muted">
                Open the desktop app to manage inspector settings.
              </p>
            )}
          </>
        )}
        {section === "files" && (
          <FilePreferences
            value={config.files}
            busy={busy}
            onChange={(files) =>
              setConfig((current) => ({ ...current, files }))
            }
            onSave={(event) => void saveConfig(event)}
          />
        )}
        {section === "general" && (
          <>
            <header className="settings-section-title">
              <span className="eyebrow">APP PREFERENCES</span>
              <h2>General</h2>
              <p>A focused workspace that keeps your project files portable.</p>
            </header>
            <form
              className="settings-card card"
              onSubmit={(event) => void saveConfig(event)}
            >
              <label className="field">
                Automatic refresh interval (seconds)
                <input
                  type="number"
                  min={30}
                  max={3600}
                  step={1}
                  value={config.scanIntervalSeconds}
                  onChange={(event) =>
                    setConfig({
                      ...config,
                      scanIntervalSeconds: Number(event.target.value),
                    })
                  }
                  required
                />
                <span className="settings-help">
                  Refreshes sources and indexes while the app is open. Use
                  30–3600 seconds.
                </span>
              </label>
              <button className="button primary" disabled={busy}>
                <Save size={15} />
                Save preferences
              </button>
            </form>
            {onRunOnboarding && (
              <section className="settings-card card">
                <div className="settings-card-heading">
                  <div>
                    <h3>Set up your workspace</h3>
                    <p>
                      Revisit sources, AI connections, templates and the project
                      inspector.
                    </p>
                  </div>
                </div>
                <button className="button" onClick={() => void runOnboarding()}>
                  <Sparkles size={15} />
                  Run onboarding
                </button>
              </section>
            )}
            <section className="settings-card card">
              <div className="settings-card-heading">
                <h3>Foldory</h3>
                <span className="badge">Version {version}</span>
              </div>
              <p className="muted">
                A local workspace for projects, files and the tools you use
                every day.
              </p>
              <dl className="settings-details">
                <div>
                  <dt>Project information</dt>
                  <dd>PROJECT.md, kept inside each project</dd>
                </div>
                <div>
                  <dt>Organisation, search & chat history</dt>
                  <dd>Local SQLite database in app data</dd>
                </div>
                <div>
                  <dt>Editing</dt>
                  <dd>
                    Autosave with local recovery drafts and conflict detection
                  </dd>
                </div>
                <div>
                  <dt>Appearance</dt>
                  <dd>Dark, system typography, reduced-motion aware</dd>
                </div>
              </dl>
              <p className="settings-help">
                “Secure” folders are excluded from content indexing. This is an
                organisational convention, not encryption.
              </p>
            </section>
            <section className="settings-card card">
              <h3>Keyboard shortcuts</h3>
              <dl className="settings-details">
                <div>
                  <dt>Find files</dt>
                  <dd>
                    <kbd>Ctrl</kbd> + <kbd>K</kbd>
                  </dd>
                </div>
                <div>
                  <dt>Find in editor</dt>
                  <dd>
                    <kbd>Ctrl</kbd> + <kbd>F</kbd>
                  </dd>
                </div>
                <div>
                  <dt>Undo / redo</dt>
                  <dd>
                    <kbd>Ctrl</kbd> + <kbd>Z</kbd> / <kbd>Ctrl</kbd> +{" "}
                    <kbd>Y</kbd>
                  </dd>
                </div>
              </dl>
            </section>
          </>
        )}
        <footer className="settings-footer">
          <span>Foldory</span>
          <span>
            Built for your local workspace <ExternalLink size={11} />
          </span>
        </footer>
      </main>
    </div>
  );
}
