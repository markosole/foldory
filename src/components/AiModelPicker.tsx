import { Code2 } from "lucide-react";
import AppSelect, { type SelectOption } from "./AppSelect";
import {
  endpointSettings,
  providerLabels,
  selectModel,
  type ModelChoice,
  type useModelChoice,
} from "../ai";
import chatgptLogo from "../assets/chatgpt.png";
import claudeLogo from "../assets/claude.png";
import cursorLogo from "../assets/cursor.png";
import lmStudioLogo from "../assets/lm-studio.webp";
import unslothLogo from "../assets/unsloth.png";
import type { Provider } from "../ai";
import type { Settings } from "../types";
import "./ai.css";
import {
  endpointProviders,
  endpointPresets,
  isEndpointProvider,
} from "../aiProviders";

// Provider icons from the official ChatGPT and Claude sites and the Cursor brand kit.
const logos: Partial<Record<Provider, string>> = {
  local: lmStudioLogo,
  unsloth: unslothLogo,
  codex: chatgptLogo,
  claude: claudeLogo,
  cursor: cursorLogo,
  openai: chatgptLogo,
};

export function ProviderIcon({ provider }: { provider: Provider }) {
  return logos[provider] ? (
    <img className="ai-provider-icon" src={logos[provider]} alt="" />
  ) : provider === "custom" ? (
    <Code2 size={16} aria-hidden="true" />
  ) : (
    <span className={`ai-provider-monogram ${provider}`} aria-hidden="true">
      {provider === "openrouter"
        ? "OR"
        : provider === "deepseek"
          ? "DS"
          : providerLabels[provider].charAt(0)}
    </span>
  );
}

function valueOf(choice: ModelChoice) {
  return JSON.stringify([choice.provider, choice.model]);
}

export default function AiModelPicker({
  model,
  settings,
  disabled,
  endpointsOnly = false,
}: {
  model: ReturnType<typeof useModelChoice>;
  settings: Settings;
  disabled?: boolean;
  endpointsOnly?: boolean;
}) {
  const { choices, choice, mode, prefs } = model;
  const providers: ModelChoice["provider"][] = endpointsOnly
    ? endpointProviders
    : ["codex", "cursor", ...endpointProviders];
  const connected = (provider: ModelChoice["provider"]) => {
    if (isEndpointProvider(provider)) {
      const endpoint = endpointSettings(settings, provider);
      return endpoint.enabled && !!endpoint.baseUrl.trim();
    }
    return choices[provider].result?.connection === "ready";
  };
  const providerOptions: SelectOption[] = providers.map((provider) => ({
    value: provider,
    label: providerLabels[provider],
    icon: <ProviderIcon provider={provider} />,
    group: !isEndpointProvider(provider)
      ? "Subscriptions"
      : endpointPresets[provider].local
        ? "Local servers"
        : "Cloud APIs",
    disabled: !connected(provider),
    description: connected(provider)
      ? `${choices[provider].result?.models.length ?? 0} models available`
      : "Set up in Settings → AI connection",
  }));
  const allowed = providers.includes(choice.provider);
  const endpoint = isEndpointProvider(choice.provider)
    ? endpointSettings(settings, choice.provider)
    : null;
  const catalog = allowed ? choices[choice.provider] : undefined;
  const models = catalog?.result?.models ?? [];
  const preferred = endpoint
    ? (prefs.value.preferredModels?.[endpoint.provider] ??
      (endpoint.provider === "local" ? prefs.value.preferredLocalModels : []))
    : [];
  const current = valueOf(choice);
  const options: SelectOption[] = allowed
    ? [
        {
          value: valueOf({ provider: choice.provider, model: null }),
          label: endpoint
            ? endpoint.model || "Choose a model"
            : choice.provider === "cursor"
              ? "Auto (recommended)"
              : "Provider default",
          disabled:
            !connected(choice.provider) ||
            (!!endpoint && !endpoint.model.trim()),
          group: "Default",
        },
        ...preferred.map((id) => ({
          value: valueOf({ provider: choice.provider, model: id }),
          label: models.find((model) => model.id === id)?.label ?? id,
          keywords: id,
          group: `Preferred · ${providerLabels[choice.provider]}`,
        })),
        ...models
          .filter(({ id }) => !preferred.includes(id))
          .map(({ id, label }) => ({
            value: valueOf({ provider: choice.provider, model: id }),
            label,
            keywords: id,
            group: providerLabels[choice.provider],
          })),
      ]
    : [];
  if (
    allowed &&
    choice.model &&
    !options.some((option) => option.value === current)
  ) {
    options.push({
      value: current,
      label: choice.model,
      group: "Current selection",
    });
  }
  const label =
    options.find((option) => option.value === current)?.label ??
    "Choose a model";
  const locked = disabled || !prefs.loaded || prefs.saving;
  const providerHint = `1 Provider · ${providerLabels[choice.provider]}`;
  const modelHint = `2 Model · ${providerLabels[choice.provider]} · ${label} · ${catalog?.pending ? "Loading models…" : `${models.length} available`}`;

  return (
    <div className="ai-picker" aria-label="AI provider and model selection">
      <div className="ai-picker-step ai-picker-provider" title={providerHint}>
        <AppSelect
          aria-label="AI provider"
          title={providerHint}
          icon={<ProviderIcon provider={choice.provider} />}
          compact
          searchable={false}
          value={allowed ? choice.provider : ""}
          options={providerOptions}
          placeholder="Choose provider"
          disabled={locked}
          onChange={(provider) =>
            void selectModel(mode, {
              provider: provider as ModelChoice["provider"],
              model: null,
            })
          }
        />
      </div>
      <div className="ai-picker-step ai-picker-model" title={modelHint}>
        <AppSelect
          aria-label="AI model"
          title={modelHint}
          compact
          searchable
          value={current}
          options={options}
          placeholder="Choose model"
          disabled={locked || !allowed || !connected(choice.provider)}
          onChange={(value) => {
            const [provider, selected] = JSON.parse(value) as [
              ModelChoice["provider"],
              ModelChoice["model"],
            ];
            void selectModel(mode, { provider, model: selected });
          }}
        />
      </div>
      {prefs.error && <small role="alert">{prefs.error}</small>}
    </div>
  );
}
