import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Check,
  ChevronRight,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  HardDrive,
  LoaderCircle,
  Plus,
  RefreshCw,
  ScanSearch,
  ShieldCheck,
  Sparkles,
  Trash2,
} from "lucide-react";
import { api, call } from "../api";
import projectManagerIcon from "../assets/reflect-fold-app.svg";
import { isEndpointProvider } from "../aiProviders";
import {
  endpointSettings,
  openProvider,
  providerLabels,
  withNormalizedEndpoints,
  refreshAiPreferences,
  useAiPreferences,
  cacheProviderCatalog,
  type AiModel,
  type CloudProvider,
  type ModelChoice,
  type Provider,
} from "../ai";
import type { Bootstrap, Template } from "../types";
import { messageOf } from "../utils";
import { ProviderIcon } from "./AiModelPicker";
import Modal from "./Modal";
import TemplateBuilder from "./TemplateBuilder";
import "./onboarding.css";

const steps = [
  {
    title: "Project sources",
    detail: "Bring your work together",
    icon: HardDrive,
  },
  {
    title: "AI assistant",
    detail: "A little extra help, if you like",
    icon: Sparkles,
  },
  {
    title: "Project templates",
    detail: "A home for every new idea",
    icon: FolderPlus,
  },
  {
    title: "Meet the inspector",
    detail: "Turn a project into an overview",
    icon: ScanSearch,
  },
];

type Run = (task: () => Promise<unknown>) => Promise<boolean>;
type StepProps = {
  data: Bootstrap;
  busy: boolean;
  run: Run;
  onRefresh: () => Promise<void>;
  onNext: () => void;
};

export default function Onboarding({
  data,
  onRefresh,
  onClose,
}: {
  data: Bootstrap;
  onRefresh: () => Promise<void>;
  onClose: () => void;
}) {
  const [step, setStep] = useState(0);
  const [visited, setVisited] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [finishing, setFinishing] = useState(false);
  const content = useRef<HTMLDivElement>(null);
  // Also prevents double submissions before React has rendered the busy state.
  const working = useRef(false);

  async function run(task: () => Promise<unknown>) {
    if (working.current) return false;
    working.current = true;
    setBusy(true);
    setError("");
    try {
      await task();
      return true;
    } catch (error) {
      setError(messageOf(error));
      return false;
    } finally {
      working.current = false;
      setBusy(false);
    }
  }
  function go(next: number) {
    setStep(next);
    setVisited((previous) => Math.max(previous, next));
    setError("");
  }
  async function finish() {
    if (working.current) return;
    setFinishing(true);
    const done = await run(async () => {
      const latest = await api.bootstrap();
      await api.saveSettings({ ...latest.settings, onboardingCompleted: true });
      await onRefresh();
    });
    setFinishing(false);
    if (done) onClose();
  }
  useEffect(() => {
    content.current?.scrollTo?.({ top: 0 });
    content.current
      ?.querySelector<HTMLElement>(`[data-step="${step}"] h1`)
      ?.focus();
  }, [step]);
  const props: StepProps = {
    data,
    busy,
    run,
    onRefresh,
    onNext: () => go(step + 1),
  };

  return (
    <Modal
      title="Set up your workspace"
      className="onboarding-modal"
      hideCloseButton
      onClose={() => {
        if (!busy) void finish();
      }}
    >
      <div className="onboarding-layout">
        <aside className="onboarding-sidebar">
          <div className="onboarding-brand">
            <span>
              <img src={projectManagerIcon} alt="" />
            </span>
            Foldory
          </div>
          <div className="onboarding-welcome">
            <span className="eyebrow">MAKE ROOM FOR GOOD WORK</span>
            <h2>
              Your workspace.
              <br />
              Your way.
            </h2>
            <p>
              A few small steps.
              <br />
              Everything in its place.
            </p>
          </div>
          <nav aria-label="Onboarding steps">
            {steps.map(({ title, detail, icon: Icon }, index) => (
              <button
                key={title}
                type="button"
                disabled={busy || index > visited}
                aria-current={index === step ? "step" : undefined}
                className={`${index === step ? "active" : ""} ${index < step ? "complete" : ""}`}
                onClick={() => go(index)}
              >
                <span className="onboarding-step-icon">
                  {index < step ? <Check size={17} /> : <Icon size={17} />}
                </span>
                <span>
                  <strong>{title}</strong>
                  <small>{detail}</small>
                </span>
              </button>
            ))}
          </nav>
          <p className="onboarding-local">
            <ShieldCheck size={16} />
            <span>
              Local by default.
              <br />
              Your projects stay on your drives.
            </span>
          </p>
        </aside>
        <div className="onboarding-main">
          <header className="onboarding-topbar">
            <span>
              GETTING STARTED <b>{String(step + 1).padStart(2, "0")} / 04</b>
            </span>
            <button
              type="button"
              className="text-button"
              disabled={busy}
              onClick={() => void finish()}
            >
              Skip setup
            </button>
          </header>
          <div className="onboarding-progress" aria-hidden="true">
            <span style={{ width: `${((step + 1) / steps.length) * 100}%` }} />
          </div>
          <div className="onboarding-content" ref={content}>
            {visited >= 0 && (
              <div
                data-step="0"
                hidden={step !== 0}
                className="onboarding-step"
              >
                <SourcesStep {...props} />
              </div>
            )}
            {visited >= 1 && (
              <div
                data-step="1"
                hidden={step !== 1}
                className="onboarding-step"
              >
                <AiStep {...props} />
              </div>
            )}
            {visited >= 2 && (
              <div
                data-step="2"
                hidden={step !== 2}
                className="onboarding-step"
              >
                <TemplatesStep {...props} />
              </div>
            )}
            {visited >= 3 && (
              <div
                data-step="3"
                hidden={step !== 3}
                className="onboarding-step"
              >
                <InspectorStep busy={busy} onFinish={() => void finish()} />
              </div>
            )}
          </div>
          {error && (
            <div className="onboarding-error" role="alert">
              {error}
            </div>
          )}
          <footer className="onboarding-footer">
            <button
              type="button"
              className="button"
              disabled={busy || step === 0}
              onClick={() => go(step - 1)}
            >
              <ArrowLeft size={15} />
              Back
            </button>
            <span>
              {step === 3
                ? "You can revisit setup anytime in Settings."
                : "Each step saves when you continue."}
            </span>
            <button
              type="submit"
              form={`onboarding-step-${step}`}
              className="button primary"
              disabled={busy}
            >
              {busy ? <LoaderCircle className="spin" size={16} /> : null}
              {finishing
                ? "Saving…"
                : step === 3
                  ? "Start working"
                  : "Continue"}
              {!busy && <ArrowRight size={16} />}
            </button>
          </footer>
        </div>
      </div>
    </Modal>
  );
}

function StepHeading({
  eyebrow,
  title,
  children,
}: {
  eyebrow: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <header className="onboarding-heading">
      <span className="eyebrow">{eyebrow}</span>
      <h1 tabIndex={-1}>{title}</h1>
      <p>{children}</p>
    </header>
  );
}

function SourcesStep({ data, busy, run, onRefresh, onNext }: StepProps) {
  const [path, setPath] = useState("");
  async function add(value: string) {
    await api.addSource(value.trim());
    setPath("");
    await onRefresh();
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (
      await run(async () => {
        if (path.trim()) await add(path);
      })
    )
      onNext();
  }
  return (
    <form id="onboarding-step-0" onSubmit={(event) => void submit(event)}>
      <StepHeading
        eyebrow="01 / A PLACE FOR YOUR PROJECTS"
        title="Bring your work together."
      >
        Choose a parent folder. Each folder inside it becomes a project — right
        where it already lives.
      </StepHeading>
      <fieldset disabled={busy}>
        <div
          className="onboarding-source-illustration"
          aria-label="A source folder contains your projects"
        >
          <div>
            <HardDrive size={21} />
            <strong>My projects</strong>
            <span>project source</span>
          </div>
          <ChevronRight size={20} />
          <ul>
            {["Website redesign", "Brand identity", "Next big idea"].map(
              (name, index) => (
                <li key={name} style={{ animationDelay: `${index * 100}ms` }}>
                  <Folder size={17} />
                  {name}
                  <span>project</span>
                </li>
              ),
            )}
          </ul>
        </div>
        <div className="onboarding-section-label">
          <strong>Your sources</strong>
          <span>{data.sources.length} added</span>
        </div>
        <ul className="onboarding-sources">
          {data.sources.map((source) => (
            <li key={source.id}>
              <FolderOpen size={19} />
              <span>
                <strong>{source.name}</strong>
                <small title={source.path}>{source.path}</small>
              </span>
              <small>
                {!source.connected
                  ? "Disconnected"
                  : source.available
                    ? "Connected"
                    : "Offline"}
              </small>
              <button
                type="button"
                className="icon-button"
                aria-label={`Remove source ${source.name}`}
                onClick={() =>
                  void run(async () => {
                    await api.removeSource(source.id);
                    await onRefresh();
                  })
                }
              >
                <Trash2 size={14} />
              </button>
            </li>
          ))}
        </ul>
        <button
          type="button"
          className="onboarding-add-source"
          onClick={() =>
            void run(async () => {
              const selected = await api.chooseDirectory();
              if (selected) await add(selected);
            })
          }
        >
          <Plus size={18} />
          <span>Add a project source</span>
          <small>Choose a folder</small>
        </button>
        <label className="field onboarding-path">
          Or enter a folder path
          <div>
            <input
              value={path}
              onChange={(event) => setPath(event.target.value)}
              placeholder="D:\Projects"
            />
            <button
              type="button"
              className="button"
              disabled={!path.trim()}
              onClick={() => void run(() => add(path))}
            >
              Add
            </button>
          </div>
        </label>
        <p className="onboarding-note">
          <ShieldCheck size={16} />
          Add as many sources as you need. Adding or removing a source never
          moves or deletes your files. Sources cannot overlap.
        </p>
      </fieldset>
    </form>
  );
}

type ProviderCatalog = {
  connection: "ready" | "signIn" | "missing" | "setup" | "unavailable";
  models: AiModel[];
  detail: string | null;
};
const providerInstructions: Record<CloudProvider, string> = {
  codex: "https://learn.chatgpt.com/docs/cli",
  cursor: "https://cursor.com/docs/cli/overview",
  claude: "https://code.claude.com/docs/en/quickstart",
};

export function normalizeOnboardingEndpoint(value: string) {
  let url = value.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
  const parsed = new URL(url);
  if (
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  )
    throw new Error(
      "Use an endpoint URL without credentials, query parameters or a fragment.",
    );
  if (
    parsed.protocol !== "https:" &&
    !(
      parsed.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)
    )
  )
    throw new Error(
      "Use HTTPS for other servers, or HTTP for localhost / 127.0.0.1.",
    );
  if (parsed.pathname === "/" || !parsed.pathname) parsed.pathname = "/v1";
  return parsed.toString().replace(/\/+$/, "");
}

function AiStep({ data, busy, run, onRefresh, onNext }: StepProps) {
  const [provider, setProvider] = useState<Provider | null>(null);
  const [baseUrl, setBaseUrl] = useState("");
  const [key, setKey] = useState("");
  const [removeKey, setRemoveKey] = useState(false);
  const [model, setModel] = useState("");
  const [catalog, setCatalog] = useState<ProviderCatalog>();
  const [testing, setTesting] = useState(false);
  const [notice, setNotice] = useState("");
  const prefs = useAiPreferences();
  const initialized = useRef(false);
  const request = useRef(0);
  const endpoint = provider && isEndpointProvider(provider) ? provider : null;

  async function test(selected: Provider) {
    const token = ++request.current;
    setTesting(true);
    try {
      const saved = await api.bootstrap();
      const result = await call<ProviderCatalog>("ai_provider_catalog", {
        provider: selected,
      });
      if (token === request.current) {
        setCatalog(result);
        cacheProviderCatalog(selected, result, saved.settings);
        if (result.models[0])
          setModel((previous) => previous || result.models[0].id);
      }
      return result;
    } catch (error) {
      if (token === request.current)
        setCatalog({
          connection: "unavailable",
          models: [],
          detail: messageOf(error),
        });
    } finally {
      if (token === request.current) setTesting(false);
    }
  }
  useEffect(() => {
    if (
      provider &&
      (!endpoint || endpointSettings(data.settings, endpoint).baseUrl.trim())
    )
      void test(provider);
    return () => {
      request.current++;
    };
  }, [provider]);
  useEffect(() => {
    if (initialized.current || !prefs.loaded) return;
    initialized.current = true;
    const existing = prefs.value.selections.assistant;
    if (existing) {
      choose(existing.provider);
      setModel(
        existing.model ||
          (isEndpointProvider(existing.provider)
            ? endpointSettings(data.settings, existing.provider).model
            : ""),
      );
    } else if (data.settings.aiModel)
      choose(data.settings.aiProvider || "local");
  }, [prefs.loaded]);

  function choose(selected: Provider) {
    initialized.current = true;
    request.current++;
    setProvider(selected);
    setCatalog(undefined);
    setTesting(false);
    setNotice("");
    setKey("");
    setRemoveKey(false);
    if (isEndpointProvider(selected)) {
      const configured = endpointSettings(data.settings, selected);
      setBaseUrl(configured.baseUrl);
      setModel(configured.model);
    } else setModel("");
  }
  async function saveEndpoint() {
    if (!endpoint) return;
    if (!baseUrl.trim())
      throw new Error("Enter an endpoint URL, or choose Set up later.");
    const normalizedUrl = normalizeOnboardingEndpoint(baseUrl);
    const latest = await api.bootstrap();
    const settings = withNormalizedEndpoints(latest.settings);
    const providers = settings.aiProviders!.map((entry) =>
      entry.provider === endpoint
        ? { ...entry, enabled: true, baseUrl: normalizedUrl, model }
        : entry,
    );
    const local = providers.find((entry) => entry.provider === "local")!;
    await api.saveSettings({
      ...settings,
      aiProviders: providers,
      aiProvider: endpoint,
      aiBaseUrl: local.baseUrl,
      aiModel: local.model,
    });
    if (key.trim() || removeKey) {
      await api.saveAiKey(endpoint, removeKey ? "" : key.trim());
      setKey("");
      setRemoveKey(false);
    }
    setBaseUrl(normalizedUrl);
    await onRefresh();
    // Always test against the saved endpoint and its credential, including no-key servers.
    const result = await test(endpoint);
    const selectedModel = model.trim() || result?.models[0]?.id || "";
    if (selectedModel && selectedModel !== model) {
      const latest = await api.bootstrap();
      const normalized = withNormalizedEndpoints(latest.settings);
      await api.saveSettings({
        ...normalized,
        aiModel: endpoint === "local" ? selectedModel : normalized.aiModel,
        aiProviders: normalized.aiProviders!.map((entry) =>
          entry.provider === endpoint
            ? { ...entry, model: selectedModel }
            : entry,
        ),
      });
      setModel(selectedModel);
      await onRefresh();
    }
    setNotice("Connection saved. Model discovery tested automatically.");
    return selectedModel;
  }
  async function saveChoice(selectedModel = model) {
    if (!provider || provider === "claude") return;
    const choice: ModelChoice = {
      provider,
      model: selectedModel.trim() || null,
    };
    for (const mode of ["assistant", "globalAssistant", "inspector"]) {
      await call("set_ai_selection", { mode, choice });
    }
    await refreshAiPreferences();
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (
      await run(async () => {
        const selectedModel = endpoint ? await saveEndpoint() : model;
        await saveChoice(selectedModel);
      })
    )
      onNext();
  }
  return (
    <form id="onboarding-step-1" onSubmit={(event) => void submit(event)}>
      <StepHeading
        eyebrow="02 / A LITTLE EXTRA HELP"
        title="Choose your AI companion."
      >
        Connect a provider for project conversations and overviews. AI is
        optional; your library works without it.
      </StepHeading>
      <fieldset disabled={busy}>
        <div
          className="onboarding-providers"
          role="group"
          aria-label="Choose AI provider"
        >
          {(["claude", "codex", "cursor", "local", "custom"] as const).map(
            (id) => (
              <button
                key={id}
                type="button"
                aria-pressed={provider === id}
                className={provider === id ? "selected" : ""}
                onClick={() => choose(id)}
              >
                <ProviderIcon provider={id} />
                <strong>{id === "codex" ? "Codex" : providerLabels[id]}</strong>
                <small>
                  {id === "local"
                    ? "On your computer"
                    : id === "custom"
                      ? "Your endpoint"
                      : "Provider sign-in"}
                </small>
                {provider === id && (
                  <Check className="onboarding-provider-check" size={13} />
                )}
              </button>
            ),
          )}
        </div>
        {provider && (
          <div className="onboarding-connection">
            <h3>
              <ProviderIcon provider={provider} />
              {providerLabels[provider]}
            </h3>
            {endpoint ? (
              <>
                <label className="field">
                  Endpoint URL or IP:port
                  <input
                    value={baseUrl}
                    onChange={(event) => {
                      setBaseUrl(event.target.value);
                      request.current++;
                      setTesting(false);
                      setCatalog(undefined);
                      setNotice("");
                    }}
                    placeholder={
                      endpoint === "local"
                        ? "127.0.0.1:1234"
                        : "https://api.example.com/v1"
                    }
                    spellCheck={false}
                  />
                  <span className="settings-help">
                    We add /v1 when no path is given. HTTP works for localhost;
                    other servers require HTTPS.
                  </span>
                </label>
                <label className="field">
                  API key <span className="optional">Optional</span>
                  <input
                    type="password"
                    autoComplete="off"
                    value={key}
                    disabled={removeKey}
                    onChange={(event) => setKey(event.target.value)}
                    placeholder={
                      endpointSettings(data.settings, endpoint).hasKey
                        ? "A key is stored — leave blank to keep it"
                        : "Leave blank for a server without authentication"
                    }
                  />
                </label>
                {endpointSettings(data.settings, endpoint).hasKey && (
                  <label className="onboarding-checkbox">
                    <input
                      type="checkbox"
                      checked={removeKey}
                      onChange={(event) => setRemoveKey(event.target.checked)}
                    />
                    Remove the stored key and connect without one
                  </label>
                )}
                <button
                  type="button"
                  className="button"
                  disabled={testing}
                  onClick={() =>
                    void run(async () => {
                      await saveEndpoint();
                    })
                  }
                >
                  <RefreshCw
                    size={14}
                    className={testing ? "spin" : undefined}
                  />
                  Save & test connection
                </button>
                <p className="settings-help">
                  Keys are stored in Windows Credential Manager.
                </p>
              </>
            ) : (
              <>
                <p className="settings-help">
                  {provider === "claude"
                    ? "Claude Code runs in its own terminal and uses its CLI sign-in. Choose models there with /model. Codex, Cursor, LM Studio and Custom also work inside the app."
                    : "Sign in with your provider account. The app opens the supported authentication flow; return here and check the connection after signing in."}
                </p>
                <div className="onboarding-inline-actions">
                  <button
                    type="button"
                    className="button"
                    onClick={() =>
                      void run(async () => {
                        await openProvider(provider as CloudProvider, true);
                        await test(provider);
                      })
                    }
                  >
                    Sign in to{" "}
                    {provider === "codex" ? "Codex" : providerLabels[provider]}
                  </button>
                  <button
                    type="button"
                    className="button"
                    disabled={testing}
                    onClick={() => void run(() => test(provider))}
                  >
                    <RefreshCw size={14} />
                    Check connection
                  </button>
                  {(catalog?.connection === "missing" ||
                    catalog?.connection === "setup") && (
                    <button
                      type="button"
                      className="text-button"
                      onClick={() =>
                        void run(() =>
                          api.openExternalUrl(
                            providerInstructions[provider as CloudProvider],
                          ),
                        )
                      }
                    >
                      Installation instructions
                    </button>
                  )}
                </div>
              </>
            )}
            {testing && (
              <p role="status" className="onboarding-note">
                <LoaderCircle className="spin" size={15} />
                Checking connection and fetching models…
              </p>
            )}
            {!testing && catalog && (
              <div
                className={`onboarding-catalog ${catalog.connection === "ready" ? "ready" : ""}`}
                role="status"
              >
                <strong>
                  {catalog.connection === "ready"
                    ? `Connected · ${catalog.models.length} models available`
                    : catalog.connection === "signIn"
                      ? "Sign-in required"
                      : catalog.connection === "missing" ||
                          catalog.connection === "setup"
                        ? "Install the provider CLI to continue"
                        : "Could not connect — you can retry or set up later"}
                </strong>
                {catalog.detail && <p>{catalog.detail}</p>}
              </div>
            )}
            {provider !== "claude" && (
              <label className="field">
                Model
                {catalog?.models.length ? (
                  <select
                    value={model}
                    onChange={(event) => setModel(event.target.value)}
                  >
                    <option value="">Provider default</option>
                    {model &&
                      !catalog.models.some(({ id }) => id === model) && (
                        <option value={model}>{model}</option>
                      )}
                    {catalog.models.map(({ id, label }) => (
                      <option key={id} value={id}>
                        {label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    value={model}
                    onChange={(event) => setModel(event.target.value)}
                    placeholder={
                      endpoint
                        ? "Model ID, or save & test to discover models"
                        : "Provider default"
                    }
                    maxLength={200}
                  />
                )}
              </label>
            )}
            {notice && (
              <p className="settings-help" role="status">
                {notice}
              </p>
            )}
          </div>
        )}
        <button
          type="button"
          className="text-button onboarding-later"
          onClick={onNext}
        >
          Skip AI / set up later
          <ArrowRight size={14} />
        </button>
      </fieldset>
    </form>
  );
}

function TemplatesStep({ data, busy, run, onRefresh, onNext }: StepProps) {
  const [selected, setSelected] = useState(
    data.templates.find(
      (template) => template.id === data.settings.defaultTemplateId,
    )?.id ||
      data.templates[0]?.id ||
      "",
  );
  const [draft, setDraft] = useState<Template>();
  const [savedNote, setSavedNote] = useState("");
  async function saveDraft() {
    if (!draft) return selected;
    const saved = await api.saveTemplate({
      ...draft,
      name: draft.name.trim(),
      directories: draft.directories
        .map((path) => path.trim().replace(/\\/g, "/"))
        .filter(Boolean),
      files: draft.files.map((file) => ({
        ...file,
        path: file.path.trim().replace(/\\/g, "/"),
      })),
    });
    setSelected(saved.id);
    setDraft(undefined);
    setSavedNote(
      `“${saved.name}” saved. Add another template, or continue to use this one by default.`,
    );
    return saved.id;
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (
      await run(async () => {
        const id = await saveDraft();
        if (!id)
          throw new Error("Choose a template or create one, or skip setup.");
        const latest = await api.bootstrap();
        await api.saveSettings({ ...latest.settings, defaultTemplateId: id });
        await onRefresh();
      })
    )
      onNext();
  }
  return (
    <form id="onboarding-step-2" onSubmit={(event) => void submit(event)}>
      <StepHeading
        eyebrow="03 / START WITH A LITTLE STRUCTURE"
        title="Make your next project feel familiar."
      >
        Pick your default template, or build one in a few simple steps.
        Templates create folders and starter files for new projects.
      </StepHeading>
      <fieldset disabled={busy}>
        <div className="onboarding-template-choices">
          {data.templates.map((template) => (
            <button
              key={template.id}
              type="button"
              className={!draft && selected === template.id ? "selected" : ""}
              aria-pressed={!draft && selected === template.id}
              onClick={() => {
                setSelected(template.id);
                setDraft(undefined);
              }}
            >
              <Folder size={18} />
              <span>
                <strong>{template.name}</strong>
                <small>
                  {template.directories.length} folders ·{" "}
                  {template.files.length} starter files
                </small>
              </span>
              {!draft && selected === template.id && <Check size={15} />}
            </button>
          ))}
          <button
            type="button"
            className={draft ? "selected" : ""}
            onClick={() =>
              setDraft({
                id: crypto.randomUUID(),
                name: "My project template",
                directories: ["Docs", "App", "Secure"],
                files: [
                  {
                    path: "PROJECT.md",
                    content:
                      "# {{name}}\n\nClient: {{client}}\n\n## Overview\n\n## Tasks\n\n- [ ] First step\n",
                  },
                ],
              })
            }
          >
            <Plus size={18} />
            <span>
              <strong>Create a template</strong>
              <small>Build your own starting structure</small>
            </span>
          </button>
        </div>
        <TemplateBuilder
          key={draft?.id || selected}
          template={
            draft || data.templates.find((template) => template.id === selected)
          }
          editing={!!draft}
          onChange={setDraft}
          onEdit={(template) => setDraft(structuredClone(template))}
        />
        {draft && (
          <button
            type="button"
            className="button onboarding-save-template"
            onClick={() =>
              void run(async () => {
                await saveDraft();
                await onRefresh();
              })
            }
          >
            <Check size={14} />
            Save template
          </button>
        )}
        {savedNote && !draft && (
          <p className="settings-help" role="status">
            {savedNote}
          </p>
        )}
        <p className="onboarding-note">
          <Check size={16} />
          Continue saves this as the default for new projects. Existing project
          files stay as they are.
        </p>
      </fieldset>
    </form>
  );
}

export function InspectorPreview() {
  return (
    <div
      className="onboarding-inspector-preview"
      aria-label="Illustration: scan project files, review context, then draft PROJECT.md"
    >
      <div className="onboarding-preview-toolbar">
        <span>
          <Folder size={14} />
          Website redesign
        </span>
        <span className="onboarding-preview-tab">Overview</span>
        <span className="onboarding-preview-inspect">
          <ScanSearch size={14} />
          Project inspector
        </span>
      </div>
      <div className="onboarding-preview-body">
        <div className="onboarding-preview-files">
          <span>
            <Folder size={14} />
            App
          </span>
          <span>
            <FileText size={14} />
            package.json
          </span>
          <span>
            <FileText size={14} />
            README.md
          </span>
          <span className="secure">
            <ShieldCheck size={14} />
            Secure <small>excluded</small>
          </span>
          <i className="onboarding-scan-line" />
        </div>
        <div className="onboarding-preview-document">
          <span className="eyebrow">
            <Sparkles size={12} /> PROJECT.md DRAFT
          </span>
          <strong>Website redesign</strong>
          <i />
          <i />
          <i />
          <span className="onboarding-preview-chips">
            <span>Purpose</span>
            <span>Structure</span>
            <span>Next steps</span>
          </span>
        </div>
      </div>
      <div className="onboarding-preview-status">
        <span />
        <span>Scan locally</span>
        <ArrowRight size={12} />
        <span>Review context</span>
        <ArrowRight size={12} />
        <span>Generate draft</span>
      </div>
    </div>
  );
}

function InspectorStep({
  busy,
  onFinish,
}: {
  busy: boolean;
  onFinish: () => void;
}) {
  return (
    <form
      id="onboarding-step-3"
      onSubmit={(event) => {
        event.preventDefault();
        onFinish();
      }}
    >
      <StepHeading
        eyebrow="04 / GET TO KNOW YOUR PROJECT"
        title="Less digging. More understanding."
      >
        The project inspector turns a folder of work into a useful overview,
        with you in control of every step.
      </StepHeading>
      <InspectorPreview />
      <div className="onboarding-inspector-instructions">
        <span className="onboarding-big-icon">
          <ScanSearch size={24} />
        </span>
        <div>
          <h3>Look for Project inspector</h3>
          <p>
            Open a project → <strong>Overview</strong> →{" "}
            <strong>Project inspector</strong>. The <ScanSearch size={14} />{" "}
            icon opens it. Adjust prompts and exclusions in Settings → Project
            inspector.
          </p>
        </div>
      </div>
      <ol className="onboarding-inspector-steps">
        <li>
          <span>1</span>
          <div>
            <strong>Scan locally</strong>
            <p>
              Collect a bounded snapshot of project files. Secure and excluded
              paths stay out by default.
            </p>
          </div>
        </li>
        <li>
          <span>2</span>
          <div>
            <strong>Review what the model will see</strong>
            <p>
              Check the context before sending it to your selected provider.
            </p>
          </div>
        </li>
        <li>
          <span>3</span>
          <div>
            <strong>Review a draft, then approve saving</strong>
            <p>
              AI drafts PROJECT.md. Saving requires your separate confirmation.
            </p>
          </div>
        </li>
      </ol>
      <div className="onboarding-help-hint">
        <BookOpen size={20} />
        <span>
          <strong>A guide, whenever you need one</strong>
          <small>
            Settings → How To & Help covers the whole app, with illustrated
            setup instructions.
          </small>
        </span>
      </div>
      <button type="submit" hidden disabled={busy}>
        Finish onboarding
      </button>
    </form>
  );
}
