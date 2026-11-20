import { isTauri } from "@tauri-apps/api/core";
import { useEffect, useSyncExternalStore } from "react";
import { call } from "./api";
import type { AiEndpointSettings, EndpointProvider, Settings } from "./types";
import { messageOf } from "./utils";
import {
  defaultEndpoint,
  endpointPresets,
  endpointProviders,
  isEndpointProvider,
} from "./aiProviders";

export type CloudProvider = "codex" | "cursor" | "claude";
export type Provider = EndpointProvider | CloudProvider;
export type AiMode =
  "inspector" | "assistant" | "globalAssistant" | "wordParser";
export type ModelChoice = {
  provider: Exclude<Provider, "claude">;
  model: string | null;
};
export type AiModel = { id: string; label: string };

type Preferences = {
  preferredLocalModels: string[];
  preferredModels?: Partial<Record<EndpointProvider, string[]>>;
  selections: Partial<Record<AiMode, ModelChoice>>;
};
type Catalog = {
  connection: "ready" | "signIn" | "missing" | "setup" | "unavailable";
  models: AiModel[];
  detail: string | null;
};
type CatalogState = { pending: boolean; result?: Catalog };

// Setup tests the same native catalog as the model pickers. Publish successful
// and failed checks so a picker already mounted behind setup stays up to date.
export function cacheProviderCatalog(
  provider: Provider,
  result: Catalog,
  settings: Settings,
) {
  let key = provider as string;
  if (isEndpointProvider(provider)) {
    const endpoint = endpointSettings(settings, provider);
    key = JSON.stringify([
      provider,
      endpoint.enabled,
      endpoint.baseUrl,
      endpoint.hasKey,
    ]);
  }
  catalogs.set(key, { pending: false, result });
  notify();
}

export const providerLabels = {
  local: "LM Studio",
  unsloth: "Unsloth",
  ollama: endpointPresets.ollama.label,
  openai: endpointPresets.openai.label,
  gemini: endpointPresets.gemini.label,
  openrouter: endpointPresets.openrouter.label,
  deepseek: endpointPresets.deepseek.label,
  groq: endpointPresets.groq.label,
  mistral: endpointPresets.mistral.label,
  custom: "Custom",
  codex: "ChatGPT Codex",
  cursor: "Cursor",
  claude: "Claude Code",
} satisfies Record<Provider, string>;

const emptyPreferences: Preferences = {
  preferredLocalModels: [],
  selections: {},
};
const defaultChoice: ModelChoice = { provider: "local", model: null };
const initialCatalog: CatalogState = { pending: false };
const listeners = new Set<() => void>();
const catalogs = new Map<string, CatalogState>();
let preferences = {
  value: emptyPreferences,
  loaded: false,
  saving: false,
  error: "",
};
let loadingPreferences = false;

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify() {
  listeners.forEach((listener) => listener());
}

function loadPreferences() {
  if (!isTauri() || loadingPreferences || preferences.loaded) return;
  loadingPreferences = true;
  void call<Preferences>("ai_preferences")
    .then((value) => {
      preferences = { value, loaded: true, saving: false, error: "" };
    })
    .catch((error) => {
      preferences = { ...preferences, error: messageOf(error) };
    })
    .finally(() => {
      loadingPreferences = false;
      notify();
    });
}

async function savePreference(command: string, args: Record<string, unknown>) {
  if (!preferences.loaded || preferences.saving) return false;
  preferences = { ...preferences, saving: true, error: "" };
  notify();
  try {
    const value = await call<Preferences>(command, args);
    preferences = { ...preferences, value, saving: false };
    return true;
  } catch (error) {
    preferences = { ...preferences, saving: false, error: messageOf(error) };
    return false;
  } finally {
    notify();
  }
}

export const selectModel = (mode: AiMode, choice: ModelChoice) =>
  savePreference("set_ai_selection", { mode, choice });
export const savePreferredModels = (models: string[]) =>
  savePreference("save_preferred_local_models", { provider: "local", models });
export const saveProviderPreferredModels = (
  provider: EndpointProvider,
  models: string[],
) => savePreference("save_preferred_local_models", { provider, models });
export const openProvider = (provider: CloudProvider, signIn: boolean) =>
  call<void>("open_ai_provider", { provider, signIn });

export function useAiPreferences() {
  useEffect(loadPreferences, []);
  return useSyncExternalStore(subscribe, () => preferences);
}

export async function refreshAiPreferences() {
  const value = await call<Preferences>("ai_preferences");
  preferences = { value, loaded: true, saving: false, error: "" };
  notify();
}

export function useCatalog(provider: Provider, key = provider as string) {
  async function refresh() {
    if (!isTauri() || catalogs.get(key)?.pending) return;
    catalogs.set(key, { pending: true, result: catalogs.get(key)?.result });
    notify();
    let result: Catalog;
    try {
      result = await call<Catalog>("ai_provider_catalog", { provider });
    } catch (error) {
      result = {
        connection: "unavailable",
        models: [],
        detail: messageOf(error),
      };
    }
    catalogs.set(key, { pending: false, result });
    notify();
  }

  useEffect(() => {
    if (!catalogs.has(key)) void refresh();
  }, [key]);

  const state = useSyncExternalStore(
    subscribe,
    () => catalogs.get(key) ?? initialCatalog,
  );
  return { ...state, refresh };
}

export function endpointSettings(
  settings: Settings,
  provider: EndpointProvider,
): AiEndpointSettings {
  const configured = settings.aiProviders?.find(
    (entry) => entry.provider === provider,
  );
  if (configured) return configured;
  if (provider === "local")
    return {
      provider,
      enabled: !!settings.aiBaseUrl.trim(),
      baseUrl: settings.aiBaseUrl,
      model: settings.aiModel,
      hasKey: settings.aiHasKey,
    };
  return defaultEndpoint(provider);
}

export function withNormalizedEndpoints(settings: Settings): Settings {
  return {
    ...settings,
    aiProviders: endpointProviders.map((provider) =>
      endpointSettings(settings, provider),
    ),
    aiProvider: settings.aiProvider ?? "local",
  };
}

export function useEndpointCatalog(
  settings: Settings,
  provider: EndpointProvider,
) {
  const endpoint = endpointSettings(settings, provider);
  return useCatalog(
    provider,
    JSON.stringify([
      provider,
      endpoint.enabled,
      endpoint.baseUrl,
      endpoint.hasKey,
    ]),
  );
}

export const useLocalCatalog = (settings: Settings) =>
  useEndpointCatalog(settings, "local");

export function useModelChoice(mode: AiMode, settings: Settings) {
  const prefs = useAiPreferences();
  const local = useEndpointCatalog(settings, "local");
  const unsloth = useEndpointCatalog(settings, "unsloth");
  const custom = useEndpointCatalog(settings, "custom");
  const ollama = useEndpointCatalog(settings, "ollama");
  const openai = useEndpointCatalog(settings, "openai");
  const gemini = useEndpointCatalog(settings, "gemini");
  const openrouter = useEndpointCatalog(settings, "openrouter");
  const deepseek = useEndpointCatalog(settings, "deepseek");
  const groq = useEndpointCatalog(settings, "groq");
  const mistral = useEndpointCatalog(settings, "mistral");
  const codex = useCatalog("codex");
  const cursor = useCatalog("cursor");
  const choices = {
    local,
    unsloth,
    custom,
    ollama,
    openai,
    gemini,
    openrouter,
    deepseek,
    groq,
    mistral,
    codex,
    cursor,
  };
  const choice = prefs.value.selections[mode] ?? defaultChoice;
  const ready =
    (!isTauri() || prefs.loaded) &&
    (isEndpointProvider(choice.provider)
      ? (() => {
          const endpoint = endpointSettings(
            settings,
            choice.provider as EndpointProvider,
          );
          return (
            endpoint.enabled &&
            !!endpoint.baseUrl.trim() &&
            !!(choice.model ?? endpoint.model).trim()
          );
        })()
      : choices[choice.provider].result?.connection === "ready");
  const destination = isEndpointProvider(choice.provider)
    ? endpointSettings(settings, choice.provider as EndpointProvider).baseUrl
    : providerLabels[choice.provider];
  return { prefs, choices, choice, ready, destination, mode };
}
