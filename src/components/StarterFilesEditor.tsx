import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import type { TemplateFile } from "../types";
import { Markdown } from "./Editor";
import SettingsPreview from "./SettingsPreview";

export function parseStarterFiles(value: string): TemplateFile[] {
  let files: unknown;
  try {
    files = JSON.parse(value);
  } catch {
    throw new Error("Correct the starter files JSON before continuing.");
  }
  if (
    !Array.isArray(files) ||
    !files.every(
      (file) =>
        file &&
        typeof file === "object" &&
        typeof file.path === "string" &&
        typeof file.content === "string",
    )
  ) {
    throw new Error(
      "Starter files need a JSON array of objects with a path and text content.",
    );
  }
  return files;
}

export default function StarterFilesEditor({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const [mode, setMode] = useState<"json" | "markdown">("json");
  const [error, setError] = useState("");
  const files = mode === "markdown" ? parseStarterFiles(value) : [];

  function openMarkdown() {
    try {
      parseStarterFiles(value);
      setError("");
      setMode("markdown");
    } catch (error) {
      setError((error as Error).message);
    }
  }

  function changeFiles(next: TemplateFile[]) {
    onChange(JSON.stringify(next, null, 2));
  }

  function changeFile(index: number, patch: Partial<TemplateFile>) {
    changeFiles(
      files.map((file, i) => (i === index ? { ...file, ...patch } : file)),
    );
  }

  return (
    <fieldset className="starter-files-editor">
      <legend>Starter files</legend>
      <div
        className="settings-form-actions"
        role="group"
        aria-label="Starter file format"
      >
        <button
          className="button"
          type="button"
          aria-pressed={mode === "json"}
          onClick={() => setMode("json")}
        >
          JSON
        </button>
        <button
          className="button"
          type="button"
          aria-pressed={mode === "markdown"}
          onClick={openMarkdown}
        >
          Markdown
        </button>
      </div>
      <p className="settings-help">
        Use {"{{name}}"} and {"{{client}}"} in file content. Edits in either
        format are saved as starter files.
      </p>
      {mode === "json" ? (
        <>
          <label className="field">
            Starter files JSON
            <textarea
              className="json-input"
              value={value}
              rows={12}
              spellCheck={false}
              required
              onChange={(event) => {
                setError("");
                onChange(event.target.value);
              }}
            />
          </label>
          {error && (
            <p className="inline-error" role="alert">
              {error}
            </p>
          )}
        </>
      ) : (
        <>
          {files.map(({ path, content }, index) => (
            <section className="settings-markdown-block" key={index}>
              <label className="field">
                File path {index + 1}
                <input
                  required
                  value={path}
                  onChange={(event) =>
                    changeFile(index, { path: event.target.value })
                  }
                  placeholder="Docs/README.md"
                />
              </label>
              <label className="field">
                File content {index + 1}
                <textarea
                  rows={7}
                  spellCheck={false}
                  value={content}
                  onChange={(event) =>
                    changeFile(index, { content: event.target.value })
                  }
                />
              </label>
              <SettingsPreview title={`Preview ${path || `file ${index + 1}`}`}>
                {() => {
                  const preview = content
                    .replaceAll("{{name}}", "Example project")
                    .replaceAll("{{client}}", "Example client");
                  return /\.(md|markdown|mdx)$/i.test(path) || !path ? (
                    <Markdown content={preview} allowImages={false} />
                  ) : (
                    <pre>{preview}</pre>
                  );
                }}
              </SettingsPreview>
              <button
                type="button"
                className="button"
                onClick={() => changeFiles(files.filter((_, i) => i !== index))}
              >
                <Trash2 size={14} /> Remove file {index + 1}
              </button>
            </section>
          ))}
          <button
            type="button"
            className="button"
            onClick={() => changeFiles([...files, { path: "", content: "" }])}
          >
            <Plus size={15} /> Add starter file
          </button>
        </>
      )}
    </fieldset>
  );
}
