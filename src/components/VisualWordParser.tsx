import { useEffect, useRef, useState } from "react";
import { Eye, LoaderCircle, Play, Square, Save } from "lucide-react";
import { api } from "../api";
import { endpointSettings, useModelChoice } from "../ai";
import type { EndpointProvider, FileExamination, Settings } from "../types";
import { messageOf } from "../utils";
import { parseVisualWord, type WordProgress } from "../wordParser";
import AiModelPicker from "./AiModelPicker";
import { isEndpointProvider } from "../aiProviders";

export default function VisualWordParser({
  projectId,
  path,
  settings,
  enabled,
  result,
  onEnabled,
  onResult,
  onBusy,
  onSaved,
}: {
  projectId: string;
  path: string;
  settings: Settings;
  enabled: boolean;
  result: FileExamination | null;
  onEnabled: (enabled: boolean) => void;
  onResult: (document: FileExamination | null, id?: string) => void;
  onBusy: (busy: boolean) => void;
  onSaved?: (path: string) => void;
}) {
  const model = useModelChoice("wordParser", settings);
  const resolvedModel =
    model.choice.model ??
    (isEndpointProvider(model.choice.provider)
      ? endpointSettings(settings, model.choice.provider as EndpointProvider)
          .model
      : "");
  const modelKey = JSON.stringify([
    model.choice,
    model.destination,
    resolvedModel,
  ]);
  const [instructions, setInstructions] = useState("");
  const [progress, setProgress] = useState<WordProgress | null>(null);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const run = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const previousModel = useRef(modelKey);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      run.current?.abort();
    };
  }, []);

  useEffect(() => {
    const next = modelKey;
    if (previousModel.current !== next) {
      previousModel.current = next;
      run.current?.abort();
      onResult(null);
      setProgress(null);
      setNotice("");
    }
  }, [modelKey, onResult]);

  async function start() {
    if (run.current) return;
    const controller = new AbortController();
    run.current = controller;
    setBusy(true);
    onBusy(true);
    setError("");
    setNotice("");
    onResult(null);
    try {
      const parsed = await parseVisualWord({
        projectId,
        path,
        instructions,
        signal: controller.signal,
        onProgress: (value) => {
          if (mounted.current) setProgress(value);
        },
      });
      if (mounted.current) {
        onResult(parsed.document, parsed.id);
        setNotice(
          "All pages parsed. Review the Markdown, then save it or include it in Assistant.",
        );
      }
    } catch (cause) {
      if (mounted.current) setError(messageOf(cause));
    } finally {
      run.current = null;
      if (mounted.current) {
        setBusy(false);
        onBusy(false);
      }
    }
  }
  async function save() {
    if (!result) return;
    const destination = path.replace(/\.docx$/i, ".md");
    setSaving(true);
    setError("");
    try {
      await api.writeFile(projectId, destination, result.content, null);
      if (mounted.current) {
        setNotice(`Saved ${destination}`);
        onSaved?.(destination);
      }
    } catch (cause) {
      if (mounted.current) setError(messageOf(cause));
    } finally {
      if (mounted.current) setSaving(false);
    }
  }
  return (
    <div className="word-parser">
      <label className="word-parser-toggle">
        <input
          type="checkbox"
          checked={enabled}
          disabled={busy}
          onChange={(event) => onEnabled(event.target.checked)}
        />
        <Eye size={15} /> Visual Word parsing
      </label>
      {enabled && (
        <>
          <details className="word-parser-options" open={!result}>
            <summary>Model and formatting options</summary>
            <p className="muted">
              Render every page and send its image, text and formatting to a
              vision model. Pages are processed individually; completed pages
              are cached for one hour in this app session. Larger documents take
              more requests.
            </p>
            <div className="word-parser-controls">
              <AiModelPicker
                model={model}
                settings={settings}
                disabled={busy}
                endpointsOnly
              />
              <span className="muted word-parser-destination">
                Sends to {model.destination}
              </span>
            </div>
            <label className="word-parser-instructions">
              Formatting instructions
              <textarea
                aria-label="Word formatting instructions"
                rows={2}
                maxLength={4000}
                placeholder="For example: preserve the original headings and lists; use GitHub Markdown tables."
                value={instructions}
                disabled={busy}
                onChange={(event) => {
                  setInstructions(event.target.value);
                  onResult(null);
                  setProgress(null);
                  setNotice("");
                }}
              />
            </label>
          </details>
          <div className="word-parser-controls">
            <button
              className="button small"
              disabled={busy || !model.ready}
              onClick={() => void start()}
            >
              <Play size={13} />{" "}
              {progress && !result ? "Resume parsing" : "Parse all pages"}
            </button>
            {busy && (
              <button
                className="button small"
                disabled={run.current?.signal.aborted}
                onClick={() => {
                  run.current?.abort();
                  setNotice(
                    "Stopping after the current page; its result will be cached.",
                  );
                }}
              >
                <Square size={13} /> Stop after page
              </button>
            )}
            {result && (
              <button
                className="button small"
                disabled={saving}
                onClick={() => void save()}
              >
                <Save size={13} /> {saving ? "Saving…" : "Save Markdown"}
              </button>
            )}
          </div>
          {busy && (
            <div className="word-parser-progress" role="status">
              <LoaderCircle size={14} className="spin" />
              {progress
                ? `${progress.completed} / ${progress.total} pages complete${progress.page ? ` · Analysing page ${progress.page}` : ""}`
                : "Rendering Word document…"}
            </div>
          )}
          {progress && (
            <progress
              aria-label="Word parsing progress"
              value={progress.completed}
              max={progress.total}
            />
          )}
          {progress?.image && busy && (
            <details className="word-page-image">
              <summary>Current page image · {progress.renderer}</summary>
              <img
                src={progress.image}
                alt={`Rendered Word page ${progress.page}`}
              />
            </details>
          )}
          {notice && <p role="status">{notice}</p>}
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
        </>
      )}
    </div>
  );
}
