import { useEffect, useState } from "react";
import {
  FolderOpen,
  LayoutDashboard,
  LoaderCircle,
  Pencil,
  Plug,
  Plus,
  Power,
  Trash2,
} from "lucide-react";
import { integrationsApi } from "./api";
import type { Integration, IntegrationManifest } from "./types";
import { messageOf } from "../utils";
import { useAppDialog } from "../components/AppDialog";
import { beforeNavigate } from "../navigation";
import "./integrations.css";

export default function IntegrationSettings({
  onChanged,
  onOpen,
}: {
  onChanged?: () => Promise<void>;
  onOpen?: (id: string) => void;
}) {
  const [catalog, setCatalog] = useState<IntegrationManifest[]>([]);
  const [connections, setConnections] = useState<Integration[]>([]);
  const [editing, setEditing] = useState<Integration | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const dialog = useAppDialog();
  useEffect(() => {
    let active = true;
    Promise.all([integrationsApi.catalog(), integrationsApi.list()])
      .then(([providers, items]) => {
        if (active) {
          setCatalog(providers);
          setConnections(items);
        }
      })
      .catch((e) => {
        if (active) setError(messageOf(e));
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, []);

  async function action(task: () => Promise<unknown>, message: string) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await task();
      setConnections(await integrationsApi.list());
      await onChanged?.();
      setNotice(message);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }
  const manifest = catalog.find(
    (provider) => provider.id === editing?.providerId,
  );
  return (
    <>
      <header className="settings-section-title">
        <span className="eyebrow">CONNECTED TO YOUR WORK</span>
        <h2>Integrations</h2>
        <p>
          Connect apps and services, and give each connection its own place in
          your workspace.
        </p>
      </header>
      {error && (
        <div className="inline-error" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="settings-success" role="status">
          {notice}
        </div>
      )}
      <section className="settings-card card">
        <div className="settings-card-heading">
          <div>
            <h3>Your connections</h3>
            <p>Enable, configure or remove each integration independently.</p>
          </div>
          <Plug size={20} />
        </div>
        {busy && !connections.length && (
          <LoaderCircle className="spin" aria-label="Loading integrations" />
        )}
        {!busy && !connections.length && (
          <p className="muted">
            No integrations yet. Add a provider below to get started.
          </p>
        )}
        <div className="integration-connections">
          {connections.map((item) => {
            const provider = catalog.find((p) => p.id === item.providerId);
            return (
              <article className="integration-connection" key={item.id}>
                <div className="integration-connection-title">
                  <Plug size={19} />
                  <div>
                    <strong>{item.name}</strong>
                    <small>{provider?.name ?? "Provider unavailable"}</small>
                  </div>
                  <span
                    className={`badge ${!item.enabled || !provider ? "warning" : ""}`}
                  >
                    {!provider
                      ? "Unavailable"
                      : item.enabled
                        ? "Enabled"
                        : "Disabled"}
                  </span>
                </div>
                <div className="integration-actions">
                  {item.enabled &&
                    provider?.capabilities.includes("workspace") &&
                    onOpen && (
                      <button
                        className="button small"
                        disabled={busy}
                        onClick={() => onOpen(item.id)}
                      >
                        <LayoutDashboard size={14} />
                        Open workspace
                      </button>
                    )}
                  {provider && (
                    <>
                      <button
                        className="button small"
                        disabled={busy}
                        aria-label={`Configure ${item.name}`}
                        onClick={() =>
                          void (async () => {
                            if (editing && editing.id !== item.id) {
                              try {
                                await beforeNavigate();
                              } catch {
                                return;
                              }
                            }
                            setEditing(item);
                          })()
                        }
                      >
                        <Pencil size={14} />
                        Configure
                      </button>
                      <button
                        className="button small"
                        disabled={busy || editing?.id === item.id}
                        aria-label={`${item.enabled ? "Disable" : "Enable"} ${item.name}`}
                        onClick={() =>
                          void action(
                            () =>
                              integrationsApi.save({
                                ...item,
                                enabled: !item.enabled,
                              }),
                            item.enabled
                              ? "Integration disabled."
                              : "Integration enabled.",
                          )
                        }
                      >
                        <Power size={14} />
                        {item.enabled ? "Disable" : "Enable"}
                      </button>
                    </>
                  )}
                  <button
                    className="icon-button small"
                    disabled={busy}
                    aria-label={`Remove ${item.name}`}
                    title={`Remove ${item.name}`}
                    onClick={() =>
                      void (async () => {
                        if (
                          !(await dialog.confirm({
                            title: `Remove “${item.name}”?`,
                            message:
                              "This removes the connection and its workspace from Foldory. External settings and project folders are kept.",
                            confirmLabel: "Remove integration",
                            danger: true,
                          }))
                        )
                          return;
                        await action(async () => {
                          await integrationsApi.remove(item.id);
                          if (editing?.id === item.id) setEditing(null);
                        }, "Integration removed. External files were kept.");
                      })()
                    }
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      </section>
      {editing && manifest ? (
        <IntegrationForm
          key={editing.id}
          initial={editing}
          manifest={manifest}
          busy={busy}
          onCancel={() => setEditing(null)}
          onSave={(item) =>
            action(async () => {
              await integrationsApi.save(item);
              setEditing(null);
            }, "Integration saved. Its workspace is available in the sidebar.")
          }
        />
      ) : (
        <section className="settings-card card">
          <div className="settings-card-heading">
            <div>
              <h3>Available integrations</h3>
              <p>
                Add separate connections for different profiles or settings
                files.
              </p>
            </div>
          </div>
          {catalog.map((provider) => (
            <article className="integration-provider" key={provider.id}>
              <div>
                <h3>{provider.name}</h3>
                <p>{provider.description}</p>
                <span className="badge">
                  {provider.capabilities.includes("workspace")
                    ? "Workspace view"
                    : "Integration"}
                </span>
              </div>
              <button
                className="button"
                disabled={busy}
                onClick={() => {
                  setNotice("");
                  setEditing({
                    id: crypto.randomUUID(),
                    providerId: provider.id,
                    name: provider.name,
                    enabled: true,
                    configVersion: provider.configVersion,
                    config: Object.fromEntries(
                      provider.fields.map((field) => [
                        field.key,
                        field.defaultValue,
                      ]),
                    ),
                  });
                }}
              >
                <Plus size={15} />
                Add integration
              </button>
            </article>
          ))}
        </section>
      )}
    </>
  );
}

function IntegrationForm({
  initial,
  manifest,
  busy,
  onSave,
  onCancel,
}: {
  initial: Integration;
  manifest: IntegrationManifest;
  busy: boolean;
  onSave: (item: Integration) => Promise<void>;
  onCancel: () => void;
}) {
  const [item, setItem] = useState(initial);
  const [error, setError] = useState("");
  const [choosing, setChoosing] = useState(false);
  const dialog = useAppDialog();
  const dirty = JSON.stringify(initial) !== JSON.stringify(item);
  useEffect(() => {
    const listener = (event: Event) => {
      if (!dirty) return;
      (
        event as CustomEvent<{ promises: Promise<unknown>[] }>
      ).detail.promises.push(
        dialog
          .confirm({
            title: "Discard integration changes?",
            message: "Leave without saving this integration?",
            confirmLabel: "Discard changes",
          })
          .then((confirmed) => {
            if (!confirmed)
              throw new Error("Integration changes have not been saved.");
          }),
      );
    };
    window.addEventListener("foldory:before-navigate", listener);
    return () =>
      window.removeEventListener("foldory:before-navigate", listener);
  }, [dirty, dialog]);
  return (
    <form
      className="settings-card card integration-form"
      onSubmit={(event) => {
        event.preventDefault();
        void onSave(item);
      }}
    >
      <h3>Configure {manifest.name}</h3>
      <label>
        Workspace name
        <input
          required
          maxLength={160}
          value={item.name}
          disabled={busy}
          onChange={(e) => setItem({ ...item, name: e.target.value })}
        />
      </label>
      {manifest.fields.map((field) => (
        <div className="integration-field" key={field.key}>
          <label htmlFor={`integration-field-${field.key}`}>
            {field.label}
          </label>
          <div className="integration-file-field">
            <input
              id={`integration-field-${field.key}`}
              aria-describedby={`integration-help-${field.key}`}
              required
              value={item.config[field.key] ?? ""}
              disabled={busy || choosing}
              onChange={(e) =>
                setItem({
                  ...item,
                  config: { ...item.config, [field.key]: e.target.value },
                })
              }
            />
            {field.kind === "file" && (
              <button
                type="button"
                className="button"
                disabled={busy || choosing}
                aria-label={`Browse ${field.label}`}
                onClick={() =>
                  void (async () => {
                    setChoosing(true);
                    setError("");
                    try {
                      const path = await integrationsApi.chooseFile(
                        manifest.id,
                        field.key,
                      );
                      if (path)
                        setItem((previous) => ({
                          ...previous,
                          config: { ...previous.config, [field.key]: path },
                        }));
                    } catch (e) {
                      setError(messageOf(e));
                    } finally {
                      setChoosing(false);
                    }
                  })()
                }
              >
                <FolderOpen size={16} />
                Browse
              </button>
            )}
          </div>
          <small id={`integration-help-${field.key}`}>{field.help}</small>
        </div>
      ))}
      <div className="integration-permissions">
        <strong>This integration can</strong>
        <ul>
          {manifest.permissions.map((permission) => (
            <li key={permission}>{permission}</li>
          ))}
        </ul>
      </div>
      {error && (
        <div role="alert" className="inline-error">
          {error}
        </div>
      )}
      <div className="integration-actions">
        <button className="button primary" disabled={busy || choosing}>
          {busy ? "Saving…" : "Save integration"}
        </button>
        <button
          type="button"
          className="button"
          disabled={busy || choosing}
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
