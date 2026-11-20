import type { AiEndpointSettings, EndpointProvider } from "./types";

// Each preset is an independent OpenAI-compatible connection. URLs and models
// remain editable; credentials are stored separately by the native backend.
export const endpointPresets = {
  local: {
    label: "LM Studio",
    baseUrl: "http://127.0.0.1:1234/v1",
    local: true,
  },
  unsloth: {
    label: "Unsloth",
    baseUrl: "http://127.0.0.1:8888/v1",
    local: true,
  },
  ollama: {
    label: "Ollama",
    baseUrl: "http://127.0.0.1:11434/v1",
    local: true,
  },
  openai: {
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    local: false,
  },
  gemini: {
    label: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    local: false,
  },
  openrouter: {
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    local: false,
  },
  deepseek: {
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    local: false,
  },
  groq: {
    label: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    local: false,
  },
  mistral: {
    label: "Mistral",
    baseUrl: "https://api.mistral.ai/v1",
    local: false,
  },
  custom: { label: "Custom", baseUrl: "", local: false },
} satisfies Record<
  EndpointProvider,
  { label: string; baseUrl: string; local: boolean }
>;

export const endpointProviders = Object.keys(
  endpointPresets,
) as EndpointProvider[];

export function isEndpointProvider(
  provider: string,
): provider is EndpointProvider {
  return Object.hasOwn(endpointPresets, provider);
}

export function defaultEndpoint(
  provider: EndpointProvider,
): AiEndpointSettings {
  return {
    provider,
    enabled: provider === "local",
    baseUrl: endpointPresets[provider].baseUrl,
    model: "",
    hasKey: false,
  };
}
