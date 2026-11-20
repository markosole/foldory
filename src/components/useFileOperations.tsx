import { useEffect, useRef, useState, type DragEvent } from "react";
import { api } from "../api";
import { ASSISTANT_FILES_MIME } from "../assistantSources";
import { containsFilePath, droppedFilePaths } from "../fileOperations";
import { beforeNavigate } from "../navigation";
import type {
  FileEntry,
  FileOperationPlan,
  FileOperationRequest,
  FileOperationResult,
} from "../types";
import Modal from "./Modal";

type Clipboard = { kind: "copy" | "move"; paths: string[] };

export default function useFileOperations({
  projectId,
  onChanged,
  onError,
}: {
  projectId: string;
  onChanged: (
    request: FileOperationRequest,
    result: FileOperationResult,
  ) => void;
  onError: (message: string) => void;
}) {
  const [clipboard, setClipboard] = useState<Clipboard | null>(null);
  const [pending, setPending] = useState<{
    request: FileOperationRequest;
    plan: FileOperationPlan;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const active = useRef(projectId);
  const locked = useRef(false);
  useEffect(() => {
    active.current = projectId;
    setClipboard(null);
    setPending(null);
    setStatus("");
  }, [projectId]);
  useEffect(
    () => () => {
      active.current = "";
    },
    [],
  );

  function remember(kind: "copy" | "move", entries: FileEntry[]) {
    if (locked.current || pending || !entries.length) return;
    setClipboard({ kind, paths: entries.map((entry) => entry.path) });
    setStatus(
      `${entries.length} item(s) ${kind === "move" ? "cut" : "copied"}. Open a destination folder and paste.`,
    );
  }

  async function execute(
    request: FileOperationRequest,
    plan: FileOperationPlan,
  ) {
    // Flush pending editor saves before changing or removing an open path.
    // Execution rejects a stale plan if anything changed while the dialog was open.
    await beforeNavigate();
    const result = await api.executeFileOperation(
      projectId,
      request,
      plan.confirmationToken,
    );
    if (active.current !== projectId) return;
    setPending(null);
    if (request.kind === "move" && result.completed.length)
      setClipboard((current) => {
        if (!current) return current;
        const paths = current.paths.flatMap((path) => {
          const item = result.completed.find((item) =>
            containsFilePath(item.source, path),
          );
          if (!item) return [path];
          if (current.kind === "move") return [];
          return item.destination
            ? [`${item.destination}${path.slice(item.source.length)}`]
            : [];
        });
        return paths.length ? { ...current, paths } : null;
      });
    if (request.kind === "delete")
      setClipboard((current) => {
        if (!current) return current;
        const paths = current.paths.filter(
          (path) =>
            !result.completed.some((item) =>
              containsFilePath(item.source, path),
            ),
        );
        return paths.length ? { ...current, paths } : null;
      });
    onChanged(request, result);
    const verb =
      request.kind === "move"
        ? "Moved"
        : request.kind === "copy"
          ? "Copied"
          : "Deleted";
    setStatus(`${verb} ${result.completed.length} item(s).`);
    if (result.error) onError(result.error);
  }

  async function perform(request: FileOperationRequest) {
    if (locked.current || pending) return;
    locked.current = true;
    setBusy(true);
    try {
      await beforeNavigate();
      const plan = await api.previewFileOperation(projectId, request);
      if (active.current !== projectId) return;
      if (request.kind === "delete" || plan.protectionChanges.length)
        setPending({ request, plan });
      else await execute(request, plan);
    } catch (error) {
      if (active.current === projectId) onError(String(error));
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }

  async function confirm() {
    if (!pending || locked.current) return;
    locked.current = true;
    setBusy(true);
    try {
      await execute(pending.request, pending.plan);
    } catch (error) {
      setPending(null);
      onError(String(error));
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }

  function drop(event: DragEvent<HTMLElement>, destination: string) {
    if (!event.dataTransfer.types.includes(ASSISTANT_FILES_MIME)) return;
    event.preventDefault();
    event.stopPropagation();
    try {
      const paths = droppedFilePaths(
        event.dataTransfer.getData(ASSISTANT_FILES_MIME),
        projectId,
      );
      void perform({
        kind: event.ctrlKey || event.metaKey ? "copy" : "move",
        paths,
        destination,
      });
    } catch (error) {
      onError(String(error));
    }
  }

  const deleting = pending?.request.kind === "delete";
  const verb = pending?.request.kind === "copy" ? "Copy" : "Move";
  return {
    clipboard,
    busy: busy || !!pending,
    status,
    cut: (entries: FileEntry[]) => remember("move", entries),
    copy: (entries: FileEntry[]) => remember("copy", entries),
    paste: (destination: string) =>
      clipboard && perform({ ...clipboard, destination }),
    remove: (entries: FileEntry[]) =>
      perform({ kind: "delete", paths: entries.map((entry) => entry.path) }),
    clear: () => {
      if (!locked.current && !pending) {
        setClipboard(null);
        setStatus("");
      }
    },
    drop,
    dialog: pending && (
      <Modal
        title={
          deleting
            ? "Permanently delete selected items?"
            : `${verb} outside protected locations?`
        }
        className="file-operation-dialog"
        onClose={() => {
          if (!busy) setPending(null);
        }}
      >
        <p>
          {deleting
            ? "These files and folders, including all folder contents, will be permanently deleted. This cannot be undone and does not use the Recycle Bin."
            : `Some items will no longer be excluded from AI at the destination. They may become available to search, indexing and the Assistant. Review these paths before you ${verb.toLowerCase()} them.`}
        </p>
        {deleting && pending.plan.protectedCount > 0 && (
          <p className="file-operation-warning">
            This selection includes {pending.plan.protectedCount} protected or
            excluded entries.
          </p>
        )}
        <ul className="file-operation-paths">
          {pending.plan.items.map((item) => (
            <li key={item.source}>
              <strong>{item.source}</strong>
              {item.destination && <span> → {item.destination}</span>}
            </li>
          ))}
        </ul>
        {!deleting && (
          <>
            <p className="file-operation-warning">
              {pending.plan.protectionChanges.length} entries will lose
              exclusion protection:
            </p>
            <ul className="file-operation-paths">
              {pending.plan.protectionChanges.map((change) => (
                <li key={change.source}>
                  <strong>{change.source}</strong>
                  <span> → {change.destination}</span>
                  <small>{change.reason}</small>
                </li>
              ))}
            </ul>
          </>
        )}
        <div className="modal-actions">
          <button
            className="button"
            disabled={busy}
            onClick={() => setPending(null)}
          >
            Cancel
          </button>
          <button
            className={`button ${deleting ? "danger" : "primary"}`}
            disabled={busy}
            onClick={() => void confirm()}
          >
            {busy
              ? "Working…"
              : deleting
                ? "Delete permanently"
                : `${verb} anyway`}
          </button>
        </div>
      </Modal>
    ),
  };
}
