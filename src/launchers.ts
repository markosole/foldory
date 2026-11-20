import cursorLogo from "./assets/cursor.png";
import claudeLogo from "./assets/claude.png";
import codexLogo from "./assets/chatgpt.png";
import type { Settings, SupportedToolId } from "./types";

export const supportedTools = [
  { id: "cursor", name: "Cursor", logo: cursorLogo },
  { id: "claude", name: "Claude", logo: claudeLogo },
  { id: "codex", name: "Codex", logo: codexLogo },
] as const;

export const defaultSupportedTools = {
  cursor: { enabled: true, desktop: true, cli: false },
  claude: { enabled: false, desktop: false, cli: false },
  codex: { enabled: false, desktop: false, cli: false },
};

export function supportedToolSettings(
  settings: Pick<Settings, "supportedTools">,
  id: SupportedToolId,
) {
  return settings.supportedTools?.[id] ?? defaultSupportedTools[id];
}

export function enabledLaunchers(settings: Pick<Settings, "supportedTools">) {
  return supportedTools.flatMap((tool) => {
    const preference = supportedToolSettings(settings, tool.id);
    return preference.enabled
      ? (["desktop", "cli"] as const)
          .filter((mode) => preference[mode])
          .map((mode) => ({
            ...tool,
            id: `${tool.id}-${mode}`,
            name: `${tool.name} ${mode === "desktop" ? "Desktop" : "CLI"}`,
          }))
      : [];
  });
}
