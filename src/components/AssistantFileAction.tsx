import { useRef, useState } from "react";
import { Check, FilePenLine, LoaderCircle, ShieldCheck, X } from "lucide-react";
import type { AssistantFileAction as FileAction } from "../types";
import AssistantErrorCard from "./AssistantErrorCard";

export default function AssistantFileAction({
  action,
  disabled,
  onDecision,
}: {
  action: FileAction;
  disabled: boolean;
  onDecision: (approve: boolean) => Promise<boolean>;
}) {
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const processing = useRef(false);
  async function decide(approve: boolean) {
    if (processing.current || disabled || action.status !== "pending") return;
    processing.current = true;
    setWorking(true);
    setError(null);
    try {
      await onDecision(approve);
    } catch (cause) {
      setError(cause);
    } finally {
      processing.current = false;
      setWorking(false);
    }
  }
  return (
    <section
      className="assistant-file-action"
      aria-label={`File change ${action.path}`}
      data-action-status={action.status}
    >
      <header>
        <FilePenLine size={16} aria-hidden="true" />
        <div>
          <strong>{action.path}</strong>
          <span>
            {action.beforeContent === null ? "Create file" : "Replace file"}
          </span>
        </div>
        <span className={`file-action-status ${action.status}`}>
          {action.status === "applied" ? (
            <>
              <Check size={13} /> Saved
            </>
          ) : action.status === "declined" ? (
            <>
              <X size={13} /> Declined
            </>
          ) : action.status === "failed" ? (
            "Not saved"
          ) : (
            <>
              <ShieldCheck size={13} /> Approval required
            </>
          )}
        </span>
      </header>
      {action.reason && <p>{action.reason}</p>}
      <details className="file-action-review">
        <summary>Review file content</summary>
        {action.beforeContent !== null && (
          <div>
            <h4>Current content when proposed</h4>
            <pre>{action.beforeContent || "(Empty file)"}</pre>
          </div>
        )}
        <div>
          <h4>Proposed content</h4>
          <pre>{action.content || "(Empty file)"}</pre>
        </div>
      </details>
      {action.status === "pending" && (
        <>
          <p className="file-action-approval-hint">
            Approve once saves this exact change. Your project access setting
            stays the same.
          </p>
          <div className="file-action-buttons">
            <button
              type="button"
              className="button primary"
              disabled={disabled || working}
              onClick={() => void decide(true)}
            >
              {working ? (
                <LoaderCircle size={14} className="spin" />
              ) : (
                <ShieldCheck size={14} />
              )}
              Approve once
            </button>
            <button
              type="button"
              className="button"
              disabled={disabled || working}
              onClick={() => void decide(false)}
            >
              Decline
            </button>
          </div>
        </>
      )}
      {action.status === "failed" && (
        <AssistantErrorCard
          error={action.error || "The file change could not be saved."}
          context="actions"
        />
      )}
      {Boolean(error) && <AssistantErrorCard error={error} context="actions" />}
    </section>
  );
}
