import AppSelect from "./AppSelect";
import { useEffect, useRef, useState } from "react";
import {
  FileCheck2,
  Eye,
  LoaderCircle,
  ScanSearch,
  ShieldCheck,
} from "lucide-react";
import {
  inspectorApi,
  type ContextReview,
  type ScanOptions,
  type OverviewDraft,
  type ProviderResponse,
} from "../inspectorApi";
import { messageOf } from "../utils";
import type { Settings } from "../types";
import { useModelChoice } from "../ai";
import AiModelPicker from "./AiModelPicker";
import { Markdown } from "./Editor";
import Modal from "./Modal";
import "./project-inspector.css";

const initialScan: ScanOptions = {
  level: "standard",
  inputKib: 32,
  focus: "",
  additionalFile: "",
  excludePatterns: [],
};

function ContextDetails({
  review,
  sent,
}: {
  review: ContextReview;
  sent: boolean;
}) {
  const { coverage } = review;
  return (
    <section
      className="inspector-context"
      aria-label={sent ? "Sent context" : "Context review"}
    >
      <h3>{sent ? "Context sent" : "Review before sending"}</h3>
      <p className="inspector-description">{review.destination}</p>
      <p>
        {(review.inputBytes / 1024).toFixed(1)} of {review.budgetBytes / 1024}{" "}
        KiB input · {review.tree.length} paths · {review.documents.length}{" "}
        excerpts
      </p>
      <p className="inspector-description">
        {coverage.visited} entries visited · {coverage.excluded} excluded ·{" "}
        {coverage.withheldDocuments} documents withheld ·{" "}
        {coverage.redactedDocuments} documents with redactions
      </p>
      {(coverage.traversalLimited ||
        coverage.omittedDocuments > 0 ||
        coverage.omittedPaths > 0) && (
        <p className="inspector-description">
          {coverage.omittedPaths} eligible paths and {coverage.omittedDocuments}{" "}
          candidate documents omitted by limits.
          {coverage.traversalLimited &&
            " Part of the tree was beyond the scan limits or could not be read."}{" "}
          Focus on a folder for a more targeted scan.
        </p>
      )}
      <p className="inspector-description">
        {review.outputTokens === null
          ? "The provider sets the output limit."
          : `Up to ${review.outputTokens.toLocaleString()} output tokens requested.`}{" "}
        The input budget measures UTF-8 bytes. Your model’s context window also
        needs room for the response.
      </p>
      <details className="inspector-evidence">
        <summary>Drafting instructions and templates</summary>
        <pre>{review.systemPrompt}</pre>
      </details>
      {review.tree.length > 0 && (
        <details className="inspector-evidence">
          <summary>Project structure</summary>
          <pre>{review.tree.join("\n")}</pre>
        </details>
      )}
      {review.documents.length > 0 && (
        <details className="inspector-evidence">
          <summary>Review included file excerpts</summary>
          <ul aria-label="Source documents">
            {review.documents.map(({ path, content, truncated, approved }) => (
              <li key={path}>
                <details>
                  <summary>
                    {path}
                    {truncated && " (compacted)"}
                    {approved && " (one-time approval)"}
                  </summary>
                  <pre>{content}</pre>
                </details>
              </li>
            ))}
          </ul>
        </details>
      )}
      <details className="inspector-evidence">
        <summary>Show exact prepared input</summary>
        <pre aria-label="Prepared AI input">{review.prompt}</pre>
      </details>
    </section>
  );
}

export default function ProjectInspector({
  projectId,
  projectName,
  available,
  aiSettings,
  onClose,
  onSaved,
}: {
  projectId: string;
  projectName: string;
  available: boolean;
  aiSettings: Settings;
  onClose: () => void;
  onSaved: () => void;
}) {
  const model = useModelChoice("inspector", aiSettings);
  const settings = aiSettings.inspector;
  const [access, setAccess] = useState<boolean | null>(null);
  const [draft, setDraft] = useState<OverviewDraft | null>(null);
  const [options, setOptions] = useState(initialScan);
  const [review, setReview] = useState<ContextReview | null>(null);
  const [approved, setApproved] = useState(false);
  const [sent, setSent] = useState<ContextReview | null>(null);
  const [preview, setPreview] = useState(false);
  const activeReview = useRef<string | null>(null);
  const mounted = useRef(false);
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState<"scan" | "draft" | "access" | "save" | null>(
    null,
  );
  const [error, setError] = useState("");
  const [selectedProfile, setSelectedProfile] = useState("");
  const profileId = settings?.profiles.some(({ id }) => id === selectedProfile)
    ? selectedProfile
    : settings?.defaultProfileId;
  const [providerResponse, setProviderResponse] =
    useState<ProviderResponse | null>(null);

  useEffect(() => {
    mounted.current = true;
    let current = true;
    void inspectorApi
      .writeAccess(projectId)
      .then((enabled) => {
        if (current) setAccess(enabled);
      })
      .catch((error) => {
        if (current) setError(messageOf(error));
      });
    return () => {
      current = false;
      mounted.current = false;
      if (activeReview.current) {
        void inspectorApi.discardContext(activeReview.current).catch(() => {});
        activeReview.current = null;
      }
    };
  }, [projectId]);

  function clearReview() {
    if (activeReview.current) {
      void inspectorApi.discardContext(activeReview.current).catch(() => {});
      activeReview.current = null;
    }
    setReview(null);
    setApproved(false);
    setError("");
  }

  async function scan() {
    setBusy("scan");
    setError("");
    setProviderResponse(null);
    try {
      const next = await inspectorApi.prepareContext(
        projectId,
        profileId ?? null,
        {
          ...options,
          focus: options.focus.trim(),
          additionalFile: options.additionalFile.trim(),
        },
      );
      if (!mounted.current) {
        await inspectorApi.discardContext(next.id);
        return;
      }
      activeReview.current = next.id;
      setReview(next);
    } catch (error) {
      if (mounted.current) setError(messageOf(error));
    } finally {
      if (mounted.current) setBusy(null);
    }
  }

  async function generate() {
    if (!review || !approved) return;
    setBusy("draft");
    setError("");
    setProviderResponse(null);
    try {
      const next = await inspectorApi.draftOverview(projectId, review.id);
      activeReview.current = null;
      setReview(null);
      setApproved(false);
      if ("error" in next) {
        setError(next.error.message);
        setProviderResponse(next.error.response);
        return;
      }
      setSent(review);
      setDraft(next);
      setContent(next.content);
    } catch (error) {
      clearReview();
      setError(messageOf(error));
    } finally {
      setBusy(null);
    }
  }

  async function changeAccess() {
    setBusy("access");
    setError("");
    try {
      setAccess(await inspectorApi.setWriteAccess(projectId, !access));
    } catch (error) {
      setError(messageOf(error));
    } finally {
      setBusy(null);
    }
  }

  async function save() {
    if (!access || !draft || draft.writeBlocked || !content.trim()) return;
    setBusy("save");
    setError("");
    try {
      const saved = await inspectorApi.applyOverview(
        projectId,
        content,
        draft.revision,
      );
      if (saved) onSaved();
    } catch (error) {
      setError(messageOf(error));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Modal title="Project inspector" wide onClose={onClose}>
      <div className="project-inspector">
        <p className="inspector-description">
          Scan {projectName} locally. Review the prepared paths, excerpts and
          prompt before sending them to the selected provider to draft
          PROJECT.md.
        </p>
        <div className="inspector-model">
          <AiModelPicker
            model={model}
            settings={aiSettings}
            disabled={busy !== null || !!review}
          />
          {model.ready && <small>Sends to {model.destination}</small>}
        </div>
        {settings && (
          <label className="field inspector-profile">
            Prompt profile
            <AppSelect
              aria-label="Prompt profile"
              disabled={busy !== null || !!review}
              value={profileId ?? ""}
              onChange={setSelectedProfile}
              searchable
              options={settings.profiles.map(({ id, name }) => ({
                value: id,
                label: name,
              }))}
            />
            <span className="field-help">
              {model.choice.provider === "local" &&
                `${settings.outputTokens.toLocaleString()} output tokens · `}
              {settings.timeoutMinutes} minutes
            </span>
          </label>
        )}
        <fieldset
          className="inspector-scan"
          disabled={busy !== null || !!review}
        >
          <div className="inspector-scan-grid">
            <label className="field">
              Scan level
              <AppSelect
                aria-label="Scan level"
                disabled={busy !== null || !!review}
                value={options.level}
                onChange={(level) =>
                  setOptions({
                    ...options,
                    level: level as ScanOptions["level"],
                  })
                }
                searchable={false}
                options={[
                  { value: "outline", label: "Outline · 2 levels, paths only" },
                  {
                    value: "standard",
                    label: "Standard · 5 levels, docs and manifests",
                  },
                  {
                    value: "deep",
                    label: "Deep · 8 levels, plus source signatures",
                  },
                ]}
              />
            </label>
            <label className="field">
              Input budget (KiB)
              <input
                type="number"
                min={4}
                max={96}
                value={options.inputKib || ""}
                onChange={(event) =>
                  setOptions({
                    ...options,
                    inputKib: Number(event.target.value),
                  })
                }
              />
            </label>
          </div>
          <details className="inspector-evidence">
            <summary>Focus, exclusions and one-time file access</summary>
            <label className="field">
              Focus folder
              <input
                value={options.focus}
                placeholder="For example, src/modules"
                onChange={(event) =>
                  setOptions({ ...options, focus: event.target.value })
                }
              />
              <span className="field-help">
                Scan this subtree with depth measured from the selected folder.
              </span>
            </label>
            <label className="field">
              Exclude for this scan
              <textarea
                rows={2}
                value={options.excludePatterns.join("\n")}
                placeholder={"samples/\n**/customer-notes*.md"}
                onChange={(event) =>
                  setOptions({
                    ...options,
                    excludePatterns: event.target.value.split("\n"),
                  })
                }
              />
              <span className="field-help">
                One Git-style pattern per line, added to the saved and project
                rules.
              </span>
            </label>
            <label className="field">
              Additional file for one-time review
              <input
                value={options.additionalFile}
                placeholder="For example, private/handover.md"
                onChange={(event) =>
                  setOptions({ ...options, additionalFile: event.target.value })
                }
              />
              <span className="field-help">
                Approve the exact path in a Windows dialog. Credential and
                ignore rules still apply.
              </span>
            </label>
          </details>
        </fieldset>
        <div className="inspector-access">
          <ShieldCheck size={20} aria-hidden="true" />
          <div>
            <strong>
              {access === null
                ? "Checking write access…"
                : access
                  ? "Full access enabled for this project"
                  : "Read-only access"}
            </strong>
            <p>
              Inspector writes are limited to PROJECT.md. Each save requires
              confirmation.
            </p>
          </div>
          <button
            className="button"
            type="button"
            disabled={
              access === null || busy !== null || (!available && !access)
            }
            onClick={() => void changeAccess()}
          >
            {access ? "Revoke full access" : "Enable full access"}
          </button>
        </div>
        {model.prefs.loaded && !model.ready && (
          <p className="inspector-description">
            Choose a connected provider and model to draft an overview.
          </p>
        )}
        {!available && (
          <p className="inspector-description">
            Reconnect the project folder to scan it or save a draft.
          </p>
        )}
        {review && (
          <>
            <ContextDetails review={review} sent={false} />
            <label className="inspector-approval">
              <input
                type="checkbox"
                checked={approved}
                disabled={busy !== null}
                onChange={(event) => setApproved(event.target.checked)}
              />
              I reviewed the prepared context and approve sending it to{" "}
              {review.destination}.
            </label>
          </>
        )}
        {!review && sent && <ContextDetails review={sent} sent />}
        {draft && (
          <>
            <div className="inspector-actions">
              <button
                className="button"
                type="button"
                onClick={() => setPreview(true)}
                disabled={!content.trim()}
              >
                <Eye size={16} /> Preview rendered Markdown
              </button>
            </div>
            <label className="field inspector-draft">
              PROJECT.md draft
              <textarea
                rows={10}
                spellCheck={false}
                value={content}
                readOnly={busy !== null}
                onChange={(event) => setContent(event.target.value)}
              />
            </label>
            {draft.writeBlocked && (
              <p className="inline-error" role="status">
                {draft.writeBlocked}
              </p>
            )}
          </>
        )}
        {error && (
          <p className="inline-error" role="alert">
            {error}
          </p>
        )}
        {providerResponse && (
          <details className="inspector-evidence">
            <summary>Provider response</summary>
            <p className="muted">
              HTTP {providerResponse.status}
              {providerResponse.finishReason &&
                ` · Finish reason ${providerResponse.finishReason}`}
              {providerResponse.completionTokens !== null &&
                ` · ${providerResponse.completionTokens} output tokens`}
              {` · Requested limit ${providerResponse.tokenLimit} tokens`}
            </p>
            {providerResponse.truncated && (
              <p className="muted">Showing the first 16 KiB of the response.</p>
            )}
            <pre aria-label="Provider response body">
              {providerResponse.bodyExcerpt || "The response body was empty."}
            </pre>
          </details>
        )}
        <div className="inspector-actions">
          {review && (
            <button
              className="button"
              type="button"
              disabled={busy !== null}
              onClick={clearReview}
            >
              Change scan
            </button>
          )}
          <button
            className={`button ${draft && !review ? "" : "primary"}`}
            type="button"
            disabled={
              !available ||
              busy !== null ||
              (!!review && !approved) ||
              (!review &&
                (!model.ready ||
                  model.prefs.saving ||
                  !Number.isInteger(options.inputKib) ||
                  options.inputKib < 4 ||
                  options.inputKib > 96))
            }
            onClick={() => void (review ? generate() : scan())}
          >
            {busy === "draft" ? (
              <>
                <LoaderCircle size={16} className="spin" /> Drafting…
              </>
            ) : busy === "scan" ? (
              <>
                <LoaderCircle size={16} className="spin" /> Scanning locally…
              </>
            ) : (
              <>
                <ScanSearch size={16} />{" "}
                {review ? "Send approved context" : "Scan and review context"}
              </>
            )}
          </button>
          {draft && (
            <button
              className="button primary"
              type="button"
              disabled={
                !available ||
                !access ||
                !!draft.writeBlocked ||
                !content.trim() ||
                busy !== null
              }
              onClick={() => void save()}
            >
              <FileCheck2 size={16} />
              {draft.revision ? "Review replacement" : "Review and save"}
            </button>
          )}
        </div>
      </div>
      {preview && (
        <Modal
          title="PROJECT.md preview"
          className="inspector-preview"
          onClose={() => setPreview(false)}
        >
          <article className="inspector-rendered">
            <Markdown
              content={content}
              allowImages={false}
              allowLinks={false}
            />
          </article>
        </Modal>
      )}
    </Modal>
  );
}
