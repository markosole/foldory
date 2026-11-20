import AppSelect from "./AppSelect";
import { useState, type FormEvent } from "react";
import { FolderPlus, Folder, Info } from "lucide-react";
import type { Bootstrap, Project } from "../types";
import { api } from "../api";
import {
  messageOf,
  projectName,
  projectColors,
  validateProjectName,
} from "../utils";
import Modal from "./Modal";

export function CreateProject({
  data,
  onClose,
  onCreated,
  onSettings,
}: {
  data: Bootstrap;
  onClose: () => void;
  onCreated: (project: Project) => void;
  onSettings: () => void;
}) {
  const [name, setName] = useState("");
  const [client, setClient] = useState("");
  const [sourceId, setSourceId] = useState(
    data.sources.find(
      (source) => source.connected !== false && source.available,
    )?.id || "",
  );
  const [templateId, setTemplateId] = useState(
    data.templates.find((item) => item.id === data.settings.defaultTemplateId)
      ?.id ||
      data.templates[0]?.id ||
      "",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const template = data.templates.find((item) => item.id === templateId);
  const source = data.sources.find((item) => item.id === sourceId);
  async function create(event: FormEvent) {
    event.preventDefault();
    const invalid = validateProjectName(name);
    if (invalid) {
      setError(invalid);
      return;
    }
    if (!sourceId || !templateId) {
      setError("Choose a destination and template first.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      onCreated(
        await api.createProject(sourceId, name, templateId, client.trim()),
      );
    } catch (err) {
      setError(messageOf(err));
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Create project"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form onSubmit={create}>
        <p className="muted modal-description">
          A fresh workspace, with everything in its place.
        </p>
        <label className="field">
          Project name
          <input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="e.g. Website redesign"
            maxLength={100}
            disabled={busy}
            required
          />
        </label>
        <label className="field">
          Client <span className="optional">Optional</span>
          <input
            value={client}
            onChange={(event) => setClient(event.target.value)}
            placeholder="Client or organisation"
            maxLength={200}
            disabled={busy}
          />
        </label>
        <label className="field">
          Destination
          <AppSelect
            aria-label="Destination"
            value={sourceId}
            onChange={setSourceId}
            disabled={busy}
            required
            searchable
            placeholder="Choose a source folder"
            options={data.sources.map((source) => ({
              value: source.id,
              label: `${source.path}${source.connected === false ? " (disconnected)" : !source.available ? " (offline)" : ""}`,
              disabled: source.connected === false || !source.available,
              keywords: source.name,
            }))}
          />
        </label>
        {!data.sources.some((source) => source.connected !== false) && (
          <div className="inline-note">
            {data.sources.length
              ? "Reconnect a saved project source to create a project. "
              : "Add a project source to choose where projects live. "}
            <button type="button" className="text-button" onClick={onSettings}>
              Open settings
            </button>
          </div>
        )}
        <label className="field">
          Project template
          <AppSelect
            aria-label="Project template"
            value={templateId}
            onChange={setTemplateId}
            disabled={busy}
            required
            searchable
            placeholder="Choose a project template"
            options={data.templates.map((template) => ({
              value: template.id,
              label: template.name,
            }))}
          />
        </label>
        {template && (
          <div className="template-preview">
            <div className="eyebrow">YOUR STARTING STRUCTURE</div>
            <div className="template-items">
              {template.directories.map((path) => (
                <span key={path}>
                  <Folder size={13} />
                  {path}
                </span>
              ))}
              {template.files.map((file) => (
                <span key={file.path}>
                  <Info size={13} />
                  {file.path}
                </span>
              ))}
            </div>
          </div>
        )}
        {source && name && (
          <div
            className="destination-preview"
            title={`${source.path}\\${name}`}
          >
            {source.path.replace(/[\\/]$/, "")}\{name}
          </div>
        )}
        {error && (
          <p className="inline-error" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button
            type="button"
            className="button"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            className="button primary"
            disabled={busy || !sourceId || !templateId}
          >
            <FolderPlus size={15} />
            {busy ? "Creating…" : "Create project"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function RenameProject({
  project,
  onClose,
  onSaved,
}: {
  project: Project;
  onClose: () => void;
  onSaved: (project: Project) => void;
}) {
  const [alias, setAlias] = useState(project.alias || project.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      onSaved(
        await api.updateProject(project.id, {
          alias: alias.trim() === project.name ? "" : alias.trim(),
        }),
      );
    } catch (error) {
      setError(messageOf(error));
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Rename display label"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form onSubmit={save}>
        <p className="muted modal-description">
          This changes the name shown in Foldory. Your folder stays named “
          {project.name}”.
        </p>
        <label className="field">
          Display name
          <input
            autoFocus
            value={alias}
            onFocus={(event) => event.target.select()}
            onChange={(event) => setAlias(event.target.value)}
            maxLength={200}
            disabled={busy}
          />
          <span className="field-help">
            Leave empty to use the original folder name.
          </span>
        </label>
        {error && (
          <p className="inline-error" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button
            type="button"
            className="button"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button className="button primary" disabled={busy}>
            {busy ? "Saving…" : "Save label"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
export function EditProject({
  project,
  onClose,
  onSaved,
}: {
  project: Project;
  onClose: () => void;
  onSaved: (project: Project) => void;
}) {
  const [alias, setAlias] = useState(project.alias);
  const [client, setClient] = useState(project.client);
  const [tags, setTags] = useState(project.tags.join(", "));
  const [color, setColor] = useState(project.color);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      onSaved(
        await api.updateProject(project.id, {
          alias: alias.trim(),
          client: client.trim(),
          tags: [
            ...new Set(
              tags
                .split(",")
                .map((tag) => tag.trim())
                .filter(Boolean),
            ),
          ],
          color,
        }),
      );
    } catch (err) {
      setError(messageOf(err));
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Project details"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form onSubmit={save}>
        <p className="muted modal-description">
          Make {projectName(project)} easy to find.
        </p>
        <label className="field">
          Display name
          <input
            autoFocus
            value={alias}
            onChange={(event) => setAlias(event.target.value)}
            placeholder={project.name}
            maxLength={200}
          />
          <span className="field-help">
            Your folder keeps its original name: {project.name}
          </span>
        </label>
        <label className="field">
          Client
          <input
            value={client}
            onChange={(event) => setClient(event.target.value)}
            maxLength={200}
            placeholder="Client or organisation"
          />
        </label>
        <label className="field">
          Tags
          <input
            value={tags}
            onChange={(event) => setTags(event.target.value)}
            maxLength={500}
            placeholder="design, website, active"
          />
          <span className="field-help">Separate tags with commas.</span>
        </label>
        <div className="field">
          Project colour
          <div className="color-picker">
            {projectColors.map((value) => (
              <button
                key={value}
                type="button"
                aria-label={`Colour ${value}`}
                aria-pressed={value === color}
                className={value === color ? "chosen" : ""}
                style={{ background: value }}
                onClick={() => setColor(value)}
              />
            ))}
          </div>
        </div>
        <p className="destination-preview">{project.path}</p>
        {error && (
          <p className="inline-error" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button
            type="button"
            className="button"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button className="button primary" disabled={busy}>
            {busy ? "Saving…" : "Save details"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
