import type { FormEvent } from "react";
import { Save } from "lucide-react";
import type { FileSettings } from "../types";
import { fileSettings, FONT_SIZES } from "../fileSettings";
import AppSelect from "./AppSelect";

export default function FilePreferences({
  value,
  onChange,
  onSave,
  busy,
}: {
  value?: FileSettings;
  onChange: (value: FileSettings) => void;
  onSave: (event: FormEvent) => void;
  busy: boolean;
}) {
  const config = fileSettings(value);
  const update = (next: Partial<FileSettings>) =>
    onChange({ ...config, ...next });
  return (
    <>
      <header className="settings-section-title">
        <span className="eyebrow">READ AND EDIT</span>
        <h2>Files & editor</h2>
        <p>Choose how projects reopen and how files look.</p>
      </header>
      <form className="settings-card card file-preferences" onSubmit={onSave}>
        <h3>Session</h3>
        {(
          [
            [
              "rememberSession",
              "Remember project sessions",
              "Keep the last project view, current folder and expanded folders when you return or restart the app.",
            ],
            [
              "restoreOpenFiles",
              "Restore open file tabs",
              "Reopen your files and select the last active file when returning to a project.",
            ],
            [
              "rememberPositions",
              "Remember file positions and views",
              "Keep scroll positions, cursor selections and each file’s Preview, Edit or Split view.",
            ],
          ] as const
        ).map(([key, label, help]) => (
          <label className="file-preference-check" key={key}>
            <input
              type="checkbox"
              checked={config[key]}
              disabled={
                busy || (key !== "rememberSession" && !config.rememberSession)
              }
              onChange={(event) => update({ [key]: event.target.checked })}
            />
            <span>
              {label}
              <small>{help}</small>
            </span>
          </label>
        ))}
        <h3>Editor</h3>
        <div className="file-preferences-grid">
          <label className="field">
            Default Markdown view
            <AppSelect
              aria-label="Default Markdown view"
              value={config.defaultMode}
              onChange={(defaultMode) =>
                update({
                  defaultMode: defaultMode as FileSettings["defaultMode"],
                })
              }
              options={[
                { value: "preview", label: "Preview" },
                { value: "edit", label: "Edit" },
                { value: "split", label: "Split" },
              ]}
            />
          </label>
          <label className="field">
            Editor font size
            <AppSelect
              aria-label="Editor font size"
              value={String(config.editorFontSize)}
              onChange={(value) => update({ editorFontSize: Number(value) })}
              options={FONT_SIZES.map((size) => ({
                value: String(size),
                label: `${size} px${size === 12 ? " (default)" : ""}`,
              }))}
            />
          </label>
        </div>
        <label className="file-preference-check">
          <input
            type="checkbox"
            checked={config.wrapLines}
            onChange={(event) => update({ wrapLines: event.target.checked })}
          />
          <span>Wrap long lines by default</span>
        </label>
        <label className="file-preference-check">
          <input
            type="checkbox"
            checked={config.lineNumbers}
            onChange={(event) => update({ lineNumbers: event.target.checked })}
          />
          <span>Show line numbers</span>
        </label>
        <h3>Preview</h3>
        <div className="file-preferences-grid">
          <label className="field">
            Preview layout
            <AppSelect
              aria-label="Preview layout"
              value={config.previewLayout}
              onChange={(previewLayout) =>
                update({
                  previewLayout: previewLayout as FileSettings["previewLayout"],
                })
              }
              options={[
                { value: "boxed", label: "Boxed" },
                { value: "full", label: "Full width" },
              ]}
            />
          </label>
          <label className="field">
            Preview font size
            <AppSelect
              aria-label="Preview font size"
              value={String(config.previewFontSize)}
              onChange={(value) => update({ previewFontSize: Number(value) })}
              options={FONT_SIZES.map((size) => ({
                value: String(size),
                label: `${size} px${size === 13 ? " (default)" : ""}`,
              }))}
            />
          </label>
          <label className="field">
            Boxed preview width (px)
            <input
              type="number"
              required
              min={320}
              max={1800}
              step={10}
              value={config.previewWidth}
              onChange={(event) =>
                update({ previewWidth: Number(event.target.value) })
              }
            />
          </label>
          <label className="field">
            Full width side padding (px)
            <input
              type="number"
              required
              min={0}
              max={80}
              value={config.fullWidthPadding}
              onChange={(event) =>
                update({ fullWidthPadding: Number(event.target.value) })
              }
            />
          </label>
        </div>
        <p className="settings-help">
          Ctrl + + / − changes the active file’s font size from 9–46 px. In
          Split view, click a pane first. Ctrl + 0 or Reset zoom returns to
          these defaults. File zoom stays with its tab and resets when that tab
          is closed.
        </p>
        <button className="button primary" disabled={busy}>
          <Save size={15} />
          Save file preferences
        </button>
      </form>
    </>
  );
}
