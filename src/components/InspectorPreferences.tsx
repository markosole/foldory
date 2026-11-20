import AppSelect from "./AppSelect";
import { useState } from "react";
import { Plus, Save, Trash2 } from "lucide-react";
import type { InspectorProfile, InspectorSettings } from "../types";
import { Markdown } from "./Editor";
import SettingsPreview from "./SettingsPreview";

export default function InspectorPreferences({
  value,
  onChange,
  onSave,
  busy,
}: {
  value: InspectorSettings;
  onChange: (value: InspectorSettings) => void;
  onSave: (event: React.FormEvent) => void;
  busy: boolean;
}) {
  const [selectedId, setSelectedId] = useState(value.defaultProfileId);
  const profile =
    value.profiles.find(({ id }) => id === selectedId) ??
    value.profiles.find(({ id }) => id === value.defaultProfileId) ??
    value.profiles[0];

  function editProfile(patch: Partial<InspectorProfile>) {
    onChange({
      ...value,
      profiles: value.profiles.map((item) =>
        item.id === profile.id ? { ...item, ...patch } : item,
      ),
    });
  }

  function addProfile() {
    const next = {
      id: crypto.randomUUID(),
      name: "New profile",
      prompt: profile.prompt,
      templates: [],
    };
    onChange({ ...value, profiles: [...value.profiles, next] });
    setSelectedId(next.id);
  }

  function removeProfile() {
    const profiles = value.profiles.filter(({ id }) => id !== profile.id);
    const defaultProfileId =
      profile.id === value.defaultProfileId
        ? profiles[0].id
        : value.defaultProfileId;
    onChange({ ...value, defaultProfileId, profiles });
    setSelectedId(defaultProfileId);
  }

  return (
    <form className="settings-card card" onSubmit={onSave}>
      <fieldset className="settings-inspector-fields" disabled={busy}>
        <div className="inspector-limits">
          <label className="field">
            Maximum output tokens
            <input
              type="number"
              min={1}
              max={200000}
              required
              value={value.outputTokens || ""}
              onChange={(event) =>
                onChange({ ...value, outputTokens: Number(event.target.value) })
              }
            />
          </label>
          <label className="field">
            Maximum time in minutes
            <input
              type="number"
              min={1}
              max={180}
              required
              value={value.timeoutMinutes || ""}
              onChange={(event) =>
                onChange({
                  ...value,
                  timeoutMinutes: Number(event.target.value),
                })
              }
            />
          </label>
        </div>
        <label className="field">
          Inspector exclusion patterns
          <textarea
            rows={3}
            value={value.excludePatterns?.join("\n") ?? ""}
            onChange={(event) =>
              onChange({
                ...value,
                excludePatterns: event.target.value.split("\n"),
              })
            }
            placeholder={"internal/\n**/customer-notes*.md"}
          />
          <span className="field-help">
            One Git-style pattern per line. These apply to every inspector scan.
            A project can add its own patterns in a root .inspectorignore file.
          </span>
        </label>
        <div className="template-selector">
          <label className="field">
            Prompt profile
            <AppSelect
              aria-label="Prompt profile"
              value={profile.id}
              onChange={setSelectedId}
              disabled={busy}
              searchable
              options={value.profiles.map(({ id, name }) => ({
                value: id,
                label: `${name}${id === value.defaultProfileId ? " (default)" : ""}`,
              }))}
            />
          </label>
          <button
            type="button"
            className="button"
            disabled={value.profiles.length >= 20}
            onClick={addProfile}
          >
            <Plus size={15} /> New profile
          </button>
        </div>
        <label className="field">
          Profile name
          <input
            required
            maxLength={120}
            value={profile.name}
            onChange={(event) => editProfile({ name: event.target.value })}
          />
        </label>
        <label className="field">
          Scan prompt
          <textarea
            required
            rows={5}
            value={profile.prompt}
            onChange={(event) => editProfile({ prompt: event.target.value })}
          />
        </label>
        <div className="settings-form-actions inspector-profile-actions">
          <button
            type="button"
            className="button"
            disabled={profile.id === value.defaultProfileId}
            onClick={() => onChange({ ...value, defaultProfileId: profile.id })}
          >
            Make default
          </button>
          <button
            type="button"
            className="button danger"
            disabled={value.profiles.length <= 1}
            onClick={removeProfile}
          >
            <Trash2 size={14} /> Remove profile
          </button>
        </div>
        <h3>Markdown attachments</h3>
        <p className="settings-help">
          Write the headings, order and formatting the model should follow.
          Attachments are included with this profile in the order shown.
        </p>
        {profile.templates.map((template, index) => (
          <section
            className="settings-markdown-block"
            key={`${profile.id}:${index}`}
          >
            <label className="field">
              Markdown template {index + 1}
              <textarea
                rows={5}
                required
                value={template}
                spellCheck={false}
                onChange={(event) =>
                  editProfile({
                    templates: profile.templates.map((text, i) =>
                      i === index ? event.target.value : text,
                    ),
                  })
                }
              />
            </label>
            <SettingsPreview title={`Preview template ${index + 1}`}>
              {() =>
                template.trim() ? (
                  <Markdown content={template} allowImages={false} />
                ) : (
                  <p className="settings-help">
                    Enter Markdown to see a preview.
                  </p>
                )
              }
            </SettingsPreview>
            <button
              type="button"
              className="button"
              onClick={() =>
                editProfile({
                  templates: profile.templates.filter((_, i) => i !== index),
                })
              }
            >
              <Trash2 size={14} /> Remove attachment {index + 1}
            </button>
          </section>
        ))}
        <div className="settings-form-actions">
          <button
            type="button"
            className="button"
            disabled={profile.templates.length >= 8}
            onClick={() =>
              editProfile({ templates: [...profile.templates, ""] })
            }
          >
            <Plus size={15} /> Add Markdown attachment
          </button>
          <button type="submit" className="button primary">
            <Save size={15} /> Save inspector settings
          </button>
        </div>
      </fieldset>
    </form>
  );
}
