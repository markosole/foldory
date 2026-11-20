import { useId, useMemo, useState, type ReactNode } from "react";
import {
  Check,
  ChevronDown,
  ExternalLink,
  KeyRound,
  LoaderCircle,
  Plus,
  RefreshCw,
  Save,
  Search,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import { useAppDialog } from "./AppDialog";
import {
  endpointSettings,
  openProvider,
  providerLabels,
  saveProviderPreferredModels,
  useAiPreferences,
  useCatalog,
  useEndpointCatalog,
  withNormalizedEndpoints,
  type CloudProvider,
} from "../ai";
import { api, call } from "../api";
import type { AiEndpointSettings, EndpointProvider, Settings } from "../types";
import { messageOf } from "../utils";
import { ProviderIcon } from "./AiModelPicker";

import { endpointPresets, endpointProviders } from "../aiProviders";

function SearchableModelInput({
  label,
  value,
  options,
  placeholder,
  loading = false,
  emptyMessage = "No models available.",
  onOpen,
  onChange,
}: {
  label: string;
  value: string;
  options: string[];
  placeholder: string;
  loading?: boolean;
  emptyMessage?: string;
  onOpen?: () => void;
  onChange: (value: string) => void;
}) {
  const id = useId();
  const listId = `${id}-listbox`;
  const [open, setOpen] = useState(false);
  const [filtering, setFiltering] = useState(false);
  const filtered = useMemo(() => {
    const query = filtering ? value.trim().toLocaleLowerCase() : "";
    return options
      .filter((option) => !query || option.toLocaleLowerCase().includes(query))
      .slice(0, 10);
  }, [filtering, options, value]);
  const openMenu = (filter: boolean) => {
    setFiltering(filter);
    setOpen(true);
    onOpen?.();
  };
  const status = loading
    ? "Loading models…"
    : options.length > 0 && filtered.length === 0
      ? "No matching models. You can still enter this model ID manually."
      : emptyMessage;

  return (
    <div
      className="field ai-model-combobox"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <label htmlFor={id}>{label}</label>
      <div className="ai-model-input-wrap">
        <Search size={14} aria-hidden="true" />
        <input
          id={id}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={listId}
          value={value}
          placeholder={placeholder}
          maxLength={200}
          spellCheck={false}
          onFocus={() => openMenu(true)}
          onChange={(event) => {
            onChange(event.target.value);
            setFiltering(true);
            setOpen(true);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") setOpen(false);
            if (event.key === "ArrowDown") openMenu(false);
            if (event.key === "Enter" && open && filtered[0]) {
              event.preventDefault();
              onChange(filtered[0]);
              setOpen(false);
            }
          }}
        />
        <button
          className="ai-model-toggle"
          type="button"
          aria-label={`${open ? "Hide" : "Show"} ${label} options`}
          aria-expanded={open}
          aria-controls={listId}
          onClick={() => (open ? setOpen(false) : openMenu(false))}
        >
          <ChevronDown size={14} aria-hidden="true" />
        </button>
        {open && (
          <div className="ai-model-options" id={listId} role="listbox">
            {filtered.length > 0 ? (
              filtered.map((option) => (
                <button
                  type="button"
                  role="option"
                  aria-selected={option === value}
                  key={option}
                  title={option}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    onChange(option);
                    setOpen(false);
                  }}
                >
                  <span>{option}</span>
                  {option === value && <Check size={14} />}
                </button>
              ))
            ) : (
              <p className="ai-model-options-empty" role="status">
                {status}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function ProviderModelSettings({
  provider,
  saved,
  model,
  baseUrl,
  credential,
  onChange,
}: {
  provider: EndpointProvider;
  saved: Settings;
  model: string;
  baseUrl: string;
  credential: ReactNode;
  onChange: (model: string) => void;
}) {
  const [modelToAdd, setModelToAdd] = useState("");
  const prefs = useAiPreferences();
  const catalog = useEndpointCatalog(saved, provider);
  const savedEndpoint = endpointSettings(saved, provider);
  const preferred =
    prefs.value.preferredModels?.[provider] ??
    (provider === "local" ? prefs.value.preferredLocalModels : []);
  const available = catalog.result?.models ?? [];
  const options = [
    ...new Set([...preferred, ...available.map(({ id }) => id)]),
  ];
  const next = modelToAdd.trim();
  const canAdd =
    prefs.loaded && !prefs.saving && next && !preferred.includes(next);
  const canRefresh =
    savedEndpoint.enabled &&
    !!savedEndpoint.baseUrl.trim() &&
    baseUrl === savedEndpoint.baseUrl;
  const refresh = () => {
    if (canRefresh && !catalog.pending) void catalog.refresh();
  };

  return (
    <>
      <div className="ai-default-model">
        <SearchableModelInput
          label="Model"
          value={model}
          options={options}
          placeholder="Search or enter a model ID"
          loading={catalog.pending}
          emptyMessage={
            catalog.result?.detail ||
            "Enter a model ID, or save and refresh to discover models."
          }
          onOpen={() => {
            if (available.length === 0) refresh();
          }}
          onChange={onChange}
        />
        {canRefresh && available.length > 0 && (
          <span className="ai-model-count" aria-hidden="true">
            {available.length} available
          </span>
        )}
        <button
          className="icon-button small ai-refresh-models"
          type="button"
          title={
            canRefresh
              ? "Refresh models"
              : "Save and enable this provider to discover models"
          }
          aria-label="Refresh models"
          disabled={catalog.pending || !canRefresh}
          onClick={refresh}
        >
          <RefreshCw
            size={13}
            className={catalog.pending ? "spin" : undefined}
          />
        </button>
      </div>
      {credential}
      <div className="ai-preferred-field">
        <div className="ai-preferred-add">
          <SearchableModelInput
            label="Preferred models"
            value={modelToAdd}
            options={options.filter((id) => !preferred.includes(id))}
            placeholder="Add a model to quick pickers"
            loading={catalog.pending}
            emptyMessage="Enter any model ID to add it to your quick pickers."
            onOpen={() => {
              if (available.length === 0) refresh();
            }}
            onChange={setModelToAdd}
          />
          <button
            className="icon-button small"
            type="button"
            title="Add preferred model"
            aria-label="Add preferred model"
            disabled={!canAdd}
            onClick={async () => {
              if (
                await saveProviderPreferredModels(provider, [
                  ...preferred,
                  next,
                ])
              )
                setModelToAdd("");
            }}
          >
            <Plus size={14} />
          </button>
        </div>
        {preferred.length > 0 && (
          <ul
            className="ai-preferred-models"
            aria-label="Saved preferred models"
          >
            {preferred.map((id) => (
              <li key={id}>
                <span title={id}>{id}</span>
                <button
                  type="button"
                  className="icon-button small"
                  aria-label={`Remove preferred model ${id}`}
                  disabled={prefs.saving}
                  onClick={() =>
                    void saveProviderPreferredModels(
                      provider,
                      preferred.filter((entry) => entry !== id),
                    )
                  }
                >
                  <X size={12} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {(catalog.pending || !canRefresh || catalog.result?.detail) && (
        <div className="ai-catalog-status settings-help" role="status">
          {catalog.pending
            ? "Checking models…"
            : !canRefresh
              ? "Save and enable to discover models, or enter a model ID."
              : catalog.result?.detail}
        </div>
      )}
      {prefs.error && (
        <p className="settings-help ai-catalog-status" role="alert">
          {prefs.error}
        </p>
      )}
    </>
  );
}

function updateEndpoint(
  settings: Settings,
  provider: EndpointProvider,
  patch: Partial<AiEndpointSettings>,
): Settings {
  const normalized = withNormalizedEndpoints(settings);
  const aiProviders = normalized.aiProviders!.map((entry) =>
    entry.provider === provider ? { ...entry, ...patch } : entry,
  );
  const local = aiProviders.find((entry) => entry.provider === "local")!;
  return {
    ...normalized,
    aiProviders,
    aiBaseUrl: local.baseUrl,
    aiModel: local.model,
    aiHasKey: local.hasKey,
  };
}

export function CustomProvidersSettings({
  value,
  saved,
  busy,
  onChange,
  onSave,
  onSaveKey,
}: {
  value: Settings;
  saved: Settings;
  busy: boolean;
  onChange: (value: Settings) => void;
  onSave: (event: React.FormEvent) => void;
  onSaveKey: (provider: EndpointProvider, key: string) => Promise<boolean>;
}) {
  const dialog = useAppDialog();
  const [selected, setSelected] = useState<EndpointProvider>(
    () =>
      endpointProviders.find(
        (provider) => endpointSettings(value, provider).enabled,
      ) ?? "local",
  );
  const [keys, setKeys] = useState<Partial<Record<EndpointProvider, string>>>(
    {},
  );
  const endpoint = endpointSettings(value, selected);
  const savedEndpoint = endpointSettings(saved, selected);
  const catalog = useEndpointCatalog(saved, selected);
  const preset = endpointPresets[selected];
  const key = keys[selected] ?? "";

  async function saveKey() {
    const provider = selected;
    if (await onSaveKey(provider, keys[provider] ?? "")) {
      setKeys((current) => ({ ...current, [provider]: "" }));
      void catalog.refresh();
    }
  }

  return (
    <section className="ai-custom-providers" aria-label="Custom providers">
      <div className="ai-section-heading">
        <div>
          <h3>Custom providers</h3>
          <p className="settings-help">
            Local servers & cloud APIs. Choose a preset, then make it yours.
          </p>
        </div>
        <span className="badge">
          {
            endpointProviders.filter(
              (provider) => endpointSettings(value, provider).enabled,
            ).length
          }
          /{endpointProviders.length} enabled
        </span>
      </div>
      <div className="ai-endpoint-tabs" aria-label="Provider presets">
        {endpointProviders.map((provider) => {
          const item = endpointSettings(value, provider);
          return (
            <button
              type="button"
              className={`ai-endpoint-tab${selected === provider ? " selected" : ""}`}
              key={provider}
              aria-label={providerLabels[provider]}
              aria-pressed={selected === provider}
              aria-controls="ai-endpoint-editor"
              onClick={() => setSelected(provider)}
            >
              <ProviderIcon provider={provider} />
              <span>{providerLabels[provider]}</span>
              <span
                className={`ai-endpoint-dot${item.enabled ? " on" : ""}`}
                aria-hidden="true"
                title={item.enabled ? "Enabled" : "Disabled"}
              />
            </button>
          );
        })}
      </div>
      <div
        className="settings-card card ai-endpoint-panel"
        id="ai-endpoint-editor"
      >
        <div className="settings-card-heading ai-endpoint-panel-heading">
          <div>
            <h3>
              <ProviderIcon provider={selected} /> {providerLabels[selected]}
            </h3>
            <p>
              {selected === "custom"
                ? "Any OpenAI-compatible endpoint"
                : preset.local
                  ? "Local server · API key optional"
                  : "Cloud API · use your provider API key"}
            </p>
          </div>
          <label className="ai-endpoint-enable">
            <span>{endpoint.enabled ? "Enabled" : "Disabled"}</span>
            <span className="switch">
              <input
                type="checkbox"
                checked={endpoint.enabled}
                disabled={busy}
                aria-label={`Enable ${providerLabels[selected]}`}
                onChange={(event) =>
                  onChange(
                    updateEndpoint(value, selected, {
                      enabled: event.target.checked,
                    }),
                  )
                }
              />
              <span />
            </span>
          </label>
        </div>
        <form onSubmit={onSave}>
          <fieldset disabled={busy}>
            <div className="ai-endpoint-fields">
              <label className="field">
                Base URL
                <input
                  type="url"
                  value={endpoint.baseUrl}
                  maxLength={2000}
                  spellCheck={false}
                  autoComplete="off"
                  placeholder={preset.baseUrl || "https://api.example.com/v1"}
                  title="Include the API prefix. Remote endpoints must use HTTPS."
                  onChange={(event) =>
                    onChange(
                      updateEndpoint(value, selected, {
                        baseUrl: event.target.value,
                      }),
                    )
                  }
                />
              </label>
              <ProviderModelSettings
                key={selected}
                provider={selected}
                saved={saved}
                baseUrl={endpoint.baseUrl}
                model={endpoint.model}
                onChange={(model) =>
                  onChange(updateEndpoint(value, selected, { model }))
                }
                credential={
                  <div className="ai-compact-key">
                    <label className="field">
                      <span className="ai-key-label">
                        API key{" "}
                        {savedEndpoint.hasKey && (
                          <span title="Stored securely in Windows Credential Manager">
                            <ShieldCheck size={12} /> Saved
                          </span>
                        )}
                      </span>
                      <input
                        type="password"
                        autoComplete="off"
                        aria-label="API key"
                        value={key}
                        placeholder={
                          savedEndpoint.hasKey
                            ? "•••••••• · enter to replace"
                            : preset.local
                              ? "Optional for local servers"
                              : "Paste your API key"
                        }
                        maxLength={8192}
                        onChange={(event) =>
                          setKeys((current) => ({
                            ...current,
                            [selected]: event.target.value,
                          }))
                        }
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            if (key.trim()) void saveKey();
                          }
                        }}
                      />
                    </label>
                    <button
                      className="icon-button small"
                      type="button"
                      title="Save key securely"
                      aria-label="Save key"
                      disabled={!key.trim() || busy}
                      onClick={() => void saveKey()}
                    >
                      <KeyRound size={14} />
                    </button>
                    {savedEndpoint.hasKey && (
                      <button
                        type="button"
                        className="icon-button small ai-remove-key"
                        title="Remove stored key"
                        aria-label="Remove key"
                        disabled={busy}
                        onClick={async () => {
                          const provider = selected;
                          if (
                            await dialog.confirm({
                              title: `Remove ${providerLabels[provider]} API key?`,
                              message: "You can add a new key at any time.",
                              confirmLabel: "Remove key",
                              danger: true,
                            })
                          ) {
                            if (await onSaveKey(provider, ""))
                              void catalog.refresh();
                          }
                        }}
                      >
                        <Trash2 size={13} />
                      </button>
                    )}
                  </div>
                }
              />
            </div>
            <div className="ai-endpoint-footer">
              <span className="settings-help">
                <ShieldCheck size={12} /> Keys stay in Windows Credential
                Manager.
              </span>
              <button className="button small primary" disabled={busy}>
                <Save size={13} /> Save provider
              </button>
            </div>
          </fieldset>
        </form>
      </div>
    </section>
  );
}

const instructions: Record<CloudProvider, string> = {
  codex: "https://learn.chatgpt.com/docs/cli",
  cursor: "https://cursor.com/docs/cli/overview",
  claude: "https://code.claude.com/docs/en/quickstart",
};

function ProviderCard({ provider }: { provider: CloudProvider }) {
  const { pending, result, refresh } = useCatalog(provider);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [testResult, setTestResult] = useState("");
  const connection = result?.connection;
  const label = providerLabels[provider];
  const nativeOnly = provider === "claude";
  const missing = connection === "missing" || connection === "setup";
  const status =
    pending || !connection
      ? "Checking installation…"
      : connection === "ready"
        ? "Signed in"
        : connection === "signIn"
          ? "Installed · sign in required"
          : missing
            ? "CLI installation required"
            : "Connection unavailable";

  async function run(task: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    setTestResult("");
    try {
      await task();
    } catch (error) {
      setError(messageOf(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="settings-card card ai-provider-card">
      <div className="settings-card-heading">
        <div>
          <h3>
            <ProviderIcon provider={provider} /> {label}
          </h3>
          <p>{status}</p>
        </div>
        <button
          type="button"
          className="icon-button"
          title={`Refresh ${label} connection`}
          aria-label={`Refresh ${label} connection`}
          disabled={pending || busy}
          onClick={() => void refresh()}
        >
          <RefreshCw size={15} className={pending ? "spin" : undefined} />
        </button>
      </div>
      {result?.detail && <p className="settings-help">{result.detail}</p>}
      {nativeOnly && (
        <p className="settings-help">
          Claude Code opens in its own terminal. Use /model there to choose a
          model.
        </p>
      )}
      {provider === "cursor" && (
        <details className="ai-provider-help">
          <summary>Connection setup & troubleshooting</summary>
          <ol>
            <li>Sign in here to connect Foldory's separate Cursor profile.</li>
            <li>
              In the Inspector or Assistant, choose{" "}
              <strong>1 Provider → Cursor</strong>, then{" "}
              <strong>2 Model → Auto (recommended)</strong>.
            </li>
            <li>
              Use <strong>Test connection</strong> below. It sends one short
              prompt using Auto, without project content.
            </li>
          </ol>
          <p>
            This subscription connection uses your Cursor account. No base URL
            or API key is needed here. If only one model fails, try Auto and
            check your Cursor account Usage. A team administrator may also need
            to enable CLI headless mode.
          </p>
        </details>
      )}
      {result?.connection === "ready" && !nativeOnly && (
        <>
          <p className="settings-help">
            Choose {label} and a model in the Inspector or either Assistant.
          </p>
          {result.models.length > 0 && (
            <details className="ai-provider-models">
              <summary>{result.models.length} available models</summary>
              <ul>
                {result.models.map(({ id, label }) => (
                  <li key={id}>{label}</li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
      <div className="settings-form-actions">
        {provider === "cursor" && !missing && connection && (
          <button
            type="button"
            className="button small"
            aria-label="Test Cursor connection"
            disabled={busy || pending || connection !== "ready"}
            onClick={() =>
              void run(async () => {
                setTestResult(
                  await call<string>("test_ai_provider", { provider }),
                );
              })
            }
          >
            {busy ? (
              <LoaderCircle size={13} className="spin" />
            ) : (
              <Check size={13} />
            )}
            Test connection
          </button>
        )}
        {missing && (
          <button
            type="button"
            className="button"
            disabled={busy}
            onClick={() =>
              void run(() => api.openExternalUrl(instructions[provider]))
            }
          >
            <ExternalLink size={14} /> Installation instructions
          </button>
        )}
        {!missing && connection && (connection !== "ready" || !nativeOnly) && (
          <button
            type="button"
            className="button"
            disabled={busy || pending}
            onClick={() =>
              void run(async () => {
                try {
                  await openProvider(provider, true);
                } finally {
                  await refresh();
                }
              })
            }
          >
            {busy && <LoaderCircle size={14} className="spin" />}
            {connection === "ready" ? "Sign in again" : "Sign in"}
          </button>
        )}
        {nativeOnly && connection && !missing && (
          <button
            type="button"
            className="button"
            disabled={busy}
            onClick={() => void run(() => openProvider(provider, false))}
          >
            <ExternalLink size={14} /> Open Claude Code
          </button>
        )}
      </div>
      {testResult && (
        <p className="settings-help ai-provider-test-result" role="status">
          {testResult}
        </p>
      )}
      {error && (
        <p className="settings-help" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

export function SubscriptionProviders() {
  return (
    <section
      aria-label="Subscription providers"
      className="ai-provider-section"
    >
      <h3>Subscription providers</h3>
      <p className="settings-help">
        Use your provider account to sign in. Codex and Cursor use separate
        Foldory sign-ins.
      </p>
      <div className="ai-provider-grid">
        <ProviderCard provider="codex" />
        <ProviderCard provider="cursor" />
        <ProviderCard provider="claude" />
      </div>
    </section>
  );
}
