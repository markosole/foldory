import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { FileText, Folder, ShieldAlert } from "lucide-react";
import type { SourceApproval } from "../types";
import Modal from "./Modal";

export default function SourceApprovalModal({
  approval,
  destination,
  onDecision,
}: {
  approval: SourceApproval;
  destination?: string;
  onDecision: (allow: boolean) => void;
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancel.current?.focus();
  }, [approval.id]);
  const credentials = approval.kind === "credentials";
  const groups = new Map<string, string[]>();
  for (const path of approval.paths) {
    const segments = path.replaceAll("\\", "/").split("/");
    const name = segments.pop() || "Project folder";
    const parent = segments.join("/") || "Project root";
    groups.set(parent, [...(groups.get(parent) || []), name]);
  }

  return createPortal(
    <Modal
      title={
        credentials
          ? "Share detected sensitive content?"
          : "Include excluded sources?"
      }
      className="source-approval-modal"
      onClose={() => onDecision(false)}
    >
      <div className="source-approval-intro">
        <ShieldAlert size={23} aria-hidden="true" />
        <p>
          {credentials
            ? "Possible credentials were detected in these files. Include them only if you intend to share their contents with the AI provider."
            : "These paths are normally excluded from AI by privacy or ignore rules. They may contain credentials or private information."}
        </p>
      </div>
      <div
        className="source-approval-list"
        role="region"
        aria-label="Sources requiring permission"
        tabIndex={0}
      >
        {Array.from(groups, ([parent, names]) => (
          <section key={parent}>
            <h3>
              <Folder size={14} aria-hidden="true" />
              <span>{parent}</span>
            </h3>
            <ul>
              {names.map((name, index) => (
                <li key={`${name}-${index}`}>
                  <FileText size={14} aria-hidden="true" />
                  <span>{name}</span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      <p className="source-approval-count">
        {approval.totalPaths}{" "}
        {credentials
          ? "files with detected sensitive content"
          : "excluded paths"}
        {approval.totalPaths > approval.paths.length
          ? ` · Showing ${approval.paths.length}; ${approval.totalPaths - approval.paths.length} more require the same permission`
          : ""}
        .
      </p>
      <div className="source-approval-retention">
        <p>
          Included content is stored as a snapshot in this conversation and may
          be sent again with follow-up messages, including after you change the
          AI provider or model.
        </p>
        <p>
          Delete the message that attached a source to stop using its snapshot
          in future requests, or start a new chat. Global exclusions stay in
          place.
        </p>
        {destination && (
          <p className="source-approval-destination">
            <span>Current destination</span>
            <strong>{destination}</strong>
          </p>
        )}
      </div>
      <p className="source-approval-note">
        Nothing is sent until you send a message.
      </p>
      <div className="modal-actions">
        <button
          ref={cancel}
          type="button"
          className="button"
          autoFocus
          onClick={() => onDecision(false)}
        >
          Cancel
        </button>
        <button
          type="button"
          className="button primary"
          onClick={() => onDecision(true)}
        >
          {credentials ? "Share detected content" : "Include sources"}
        </button>
      </div>
    </Modal>,
    document.body,
  );
}
