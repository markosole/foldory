import { useEffect, useState } from "react";
import { ChevronRight, RefreshCw } from "lucide-react";
import { api } from "../api";
import {
  defaultSupportedTools,
  supportedTools,
  supportedToolSettings,
} from "../launchers";
import type {
  Settings,
  SupportedToolDetection,
  SupportedToolId,
  SupportedToolSettings,
} from "../types";

export default function SupportedLaunchers({
  settings,
  busy,
  onChange,
}: {
  settings: Settings;
  busy: boolean;
  onChange: (settings: Settings) => Promise<void>;
}) {
  const [detected, setDetected] = useState<SupportedToolDetection>();
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [expanded, setExpanded] = useState<
    Partial<Record<SupportedToolId, boolean>>
  >({});
  useEffect(() => {
    let active = true;
    setChecking(true);
    setError("");
    setDetected(undefined);
    api
      .detectSupportedTools()
      .then((result) => {
        if (active) setDetected(result);
      })
      .catch((reason) => {
        if (active) setError(String(reason));
      })
      .finally(() => {
        if (active) setChecking(false);
      });
    return () => {
      active = false;
    };
  }, [revision]);

  function update(id: SupportedToolId, value: SupportedToolSettings) {
    return onChange({
      ...settings,
      supportedTools: {
        ...defaultSupportedTools,
        ...settings.supportedTools,
        [id]: value,
      },
    });
  }

  return (
    <section className="settings-card card">
      <div className="settings-card-heading">
        <div>
          <h3>Supported tools</h3>
          <p>
            Choose your apps. Expand a row to enable Desktop and CLI separately.
          </p>
        </div>
        <button
          className="button small"
          disabled={checking || busy}
          onClick={() => setRevision((value) => value + 1)}
        >
          <RefreshCw size={13} className={checking ? "spin" : ""} /> Detect
          installed
        </button>
      </div>
      {error && (
        <p className="inline-error" role="alert">
          Could not detect installed tools. {error}
        </p>
      )}
      {supportedTools.map((tool) => {
        const value = supportedToolSettings(settings, tool.id);
        const installed = detected?.[tool.id];
        const available = installed?.desktop || installed?.cli;
        const status = checking
          ? "Checking…"
          : !installed
            ? "Detection unavailable"
            : available
              ? [installed.desktop && "Desktop", installed.cli && "CLI"]
                  .filter(Boolean)
                  .join(" and ") + " installed"
              : "Not installed";
        return (
          <div className="supported-tool" key={tool.id}>
            <div className="supported-tool-row">
              <button
                className="supported-tool-expand"
                aria-label={`${tool.name} launch options`}
                aria-expanded={!!expanded[tool.id]}
                aria-controls={`launcher-${tool.id}`}
                onClick={() =>
                  setExpanded({ ...expanded, [tool.id]: !expanded[tool.id] })
                }
              >
                <ChevronRight
                  size={14}
                  className={expanded[tool.id] ? "expanded" : ""}
                />
                <img className="launcher-logo" src={tool.logo} alt="" />
                <span>
                  <strong>{tool.name}</strong>
                  <small>{status}</small>
                </span>
              </button>
              <span className="muted">
                {value.enabled ? "Enabled" : "Disabled"}
              </span>
              <label className="switch">
                <input
                  type="checkbox"
                  role="switch"
                  aria-label={`Enable ${tool.name} launcher`}
                  checked={value.enabled}
                  disabled={busy || checking || (!available && !value.enabled)}
                  onChange={() => {
                    let next = { ...value, enabled: !value.enabled };
                    if (next.enabled && installed) {
                      next = {
                        ...next,
                        desktop: value.desktop && installed.desktop,
                        cli: value.cli && installed.cli,
                      };
                      if (!next.desktop && !next.cli) {
                        next.desktop = installed.desktop;
                        next.cli = !installed.desktop && installed.cli;
                      }
                    }
                    void update(tool.id, next);
                  }}
                />
                <span aria-hidden="true" />
              </label>
            </div>
            {expanded[tool.id] && (
              <div
                className="supported-tool-options"
                id={`launcher-${tool.id}`}
              >
                {(["desktop", "cli"] as const).map((mode) => {
                  const label = mode === "desktop" ? "Desktop" : "CLI";
                  return (
                    <div className="supported-tool-option" key={mode}>
                      <div>
                        <strong>{label}</strong>
                        <small>
                          {checking
                            ? "Checking…"
                            : !installed
                              ? "Detection unavailable"
                              : installed[mode]
                                ? "Installed"
                                : "Not installed"}
                        </small>
                      </div>
                      <label className="switch">
                        <input
                          type="checkbox"
                          role="switch"
                          aria-label={`Enable ${tool.name} ${label}`}
                          checked={value[mode]}
                          disabled={
                            busy ||
                            checking ||
                            (!installed?.[mode] && !value[mode])
                          }
                          onChange={() => {
                            const next = { ...value, [mode]: !value[mode] };
                            if (next[mode] && installed) {
                              next.desktop = next.desktop && installed.desktop;
                              next.cli = next.cli && installed.cli;
                            }
                            next.enabled =
                              next[mode] ||
                              (value.enabled && (next.desktop || next.cli));
                            void update(tool.id, next);
                          }}
                        />
                        <span aria-hidden="true" />
                      </label>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
      <p className="settings-help">
        Changes save automatically. CLI opens a terminal in the project folder.
        Desktop opens the project in the app.
      </p>
    </section>
  );
}
