import { useEffect, useRef, useState, type CSSProperties } from "react";
import {
  Copy,
  FileText,
  LoaderCircle,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import { api } from "../api";
import type { FileExamination, Settings } from "../types";
import { messageOf } from "../utils";
import { Markdown } from "./Editor";
import VisualWordParser from "./VisualWordParser";
import { useStoredScroll } from "../useStoredScroll";
import { fileSettings } from "../fileSettings";
import { useFileZoom } from "../useFileZoom";
import FileZoomControls from "./FileZoomControls";

export default function DocumentPreview({
  projectId,
  path,
  onInclude,
  onError,
  refreshVersion = 0,
  settings,
  onSaved,
}: {
  projectId: string;
  path: string;
  onInclude: (wordResultId?: string) => void;
  onError: (message: string) => void;
  refreshVersion?: number;
  settings?: Settings;
  onSaved?: (path: string) => void;
}) {
  const config = fileSettings(settings?.files);
  const root = useRef<HTMLElement | null>(null);
  const zoom = useFileZoom(projectId, path, config, root, "preview");
  const previewScroll = useStoredScroll(
    `foldory:workspace:${projectId}:file:${path}:document-preview`,
    config.rememberSession && config.rememberPositions,
  );
  const [extraction, setDocument] = useState<FileExamination | null>(null);
  const [visualEnabled, setVisualEnabled] = useState(false);
  const [visualDocument, setVisualDocument] = useState<FileExamination | null>(
    null,
  );
  const [wordResultId, setWordResultId] = useState<string>();
  const [parserBusy, setParserBusy] = useState(false);
  const [formatting, setFormatting] = useState(false);
  const document =
    visualEnabled && visualDocument ? visualDocument : extraction;
  const visualIncomplete = visualEnabled && (!visualDocument || parserBusy);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [source, setSource] = useState(false);
  const csvRows =
    document?.format === "csv"
      ? document.content.split("\n").flatMap((line) => {
          const match = /^Row (\d+): (\[.*\])$/.exec(line);
          if (!match) return [];
          try {
            const cells: unknown = JSON.parse(match[2]);
            return Array.isArray(cells) &&
              cells.every((cell) => typeof cell === "string")
              ? [{ row: match[1], cells: cells as string[] }]
              : [];
          } catch {
            return [];
          }
        })
      : [];
  useEffect(() => {
    let active = true;
    setDocument(null);
    setVisualDocument(null);
    setWordResultId(undefined);
    setParserBusy(false);
    setError("");
    api
      .examineFile(projectId, path)
      .then((result) => {
        if (active) setDocument(result);
      })
      .catch((cause) => {
        if (active) setError(messageOf(cause));
      });
    return () => {
      active = false;
    };
  }, [projectId, path, attempt, refreshVersion]);

  return (
    <section
      ref={root}
      style={
        {
          "--preview-font-size": `${zoom.preview}px`,
          "--preview-width": `${config.previewWidth}px`,
          "--preview-padding": `${config.fullWidthPadding}px`,
        } as CSSProperties
      }
      className="document-editor document-examination"
      aria-label="Document preview"
    >
      <div className="editor-toolbar document-preview-toolbar">
        <span className="editor-filename">
          <FileText size={14} /> {path}
        </span>
        <FileZoomControls {...zoom} />
        {document && (
          <>
            {document.format !== "xlsx" && (
              <button
                className="button small"
                onClick={() => setSource(!source)}
              >
                {source ? "Preview" : "Extracted text"}
              </button>
            )}
            {extraction?.formatting && (
              <button
                className="button small"
                aria-pressed={formatting}
                onClick={() => setFormatting(!formatting)}
              >
                Formatting details
              </button>
            )}
            <button
              className="icon-button small"
              title="Copy extracted content"
              aria-label="Copy extracted content"
              disabled={visualIncomplete}
              onClick={() =>
                void navigator.clipboard
                  .writeText(document.content)
                  .catch((cause) => onError(messageOf(cause)))
              }
            >
              <Copy size={14} />
            </button>
            <button
              className="button small"
              disabled={visualIncomplete}
              onClick={() =>
                onInclude(visualEnabled ? wordResultId : undefined)
              }
            >
              <Sparkles size={14} /> Include in Assistant
            </button>
          </>
        )}
      </div>
      {extraction?.format === "docx" && settings && (
        <VisualWordParser
          projectId={projectId}
          path={path}
          settings={settings}
          enabled={visualEnabled}
          result={visualDocument}
          onEnabled={setVisualEnabled}
          onResult={(result, id) => {
            setVisualDocument(result);
            setWordResultId(id);
          }}
          onBusy={setParserBusy}
          onSaved={onSaved}
        />
      )}
      {formatting && extraction?.formatting && (
        <details className="word-formatting-details" open>
          <summary>
            Original Word formatting · fonts, point sizes, styles and sections
          </summary>
          <pre>{JSON.stringify(extraction.formatting, null, 2)}</pre>
        </details>
      )}
      {error ? (
        <div className="editor-notice error" role="alert">
          <span>{error}</span>
          <button
            className="button small"
            onClick={() => setAttempt(attempt + 1)}
          >
            <RefreshCw size={14} /> Retry
          </button>
        </div>
      ) : !document ? (
        <div className="workspace-loading" role="status">
          <LoaderCircle className="spin" size={18} /> Reading document…
        </div>
      ) : (
        <>
          {!!document.warnings.length && (
            <div className="document-preview-warnings" role="status">
              {document.warnings.map((warning, i) => (
                <p key={i}>{warning}</p>
              ))}
            </div>
          )}
          <div
            ref={previewScroll}
            className={`preview-pane document-preview-content file-preview preview-${config.previewLayout}`}
            tabIndex={0}
            aria-label="Extracted document content"
          >
            {source || document.format === "xlsx" ? (
              <pre>{document.content}</pre>
            ) : csvRows.length ? (
              <table className="document-data-table">
                <caption>All CSV records in original order</caption>
                <thead>
                  <tr>
                    <th scope="col">Row</th>
                    {csvRows[0].cells.map((_, i) => (
                      <th scope="col" key={i}>
                        Column {i + 1}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {csvRows.map((row) => (
                    <tr key={row.row}>
                      <th scope="row">{row.row}</th>
                      {row.cells.map((cell, i) => (
                        <td key={i}>{cell}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <Markdown
                content={document.content}
                allowImages={false}
                allowLinks={false}
              />
            )}
          </div>
          <footer className="editor-footer">
            <span>
              {document.format.toUpperCase()} ·{" "}
              {visualEnabled && visualDocument
                ? "Visual Markdown"
                : "Local extraction"}{" "}
              · Read-only preview
            </span>
            <span>
              Include in Assistant to share this content with your chosen model.
            </span>
          </footer>
        </>
      )}
    </section>
  );
}
