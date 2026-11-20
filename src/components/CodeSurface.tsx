import { useEffect, useMemo, useRef, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { oneDark } from "@codemirror/theme-one-dark";
import { StreamLanguage } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  undo,
  redo,
  undoDepth,
  redoDepth,
  selectAll,
} from "@codemirror/commands";
import { useContextMenu } from "./ContextMenus";
import { readPreference, writePreference } from "../useWorkspaceSession";
import { useStoredScroll } from "../useStoredScroll";

interface Props {
  path: string;
  content: string;
  onChange: (value: string) => void;
  wrapLines: boolean;
  stateKey?: string;
  rememberPosition?: boolean;
  lineNumbers?: boolean;
}

async function languageFor(path: string): Promise<Extension[]> {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (["md", "mdx", "markdown"].includes(ext))
    return [(await import("@codemirror/lang-markdown")).markdown()];
  if (["js", "jsx", "mjs", "cjs", "ts", "tsx"].includes(ext))
    return [
      (await import("@codemirror/lang-javascript")).javascript({
        jsx: true,
        typescript: ext === "ts" || ext === "tsx",
      }),
    ];
  if (ext === "json") return [(await import("@codemirror/lang-json")).json()];
  if (["html", "htm"].includes(ext))
    return [(await import("@codemirror/lang-html")).html()];
  if (["css", "scss"].includes(ext))
    return [(await import("@codemirror/lang-css")).css()];
  if (ext === "rs") return [(await import("@codemirror/lang-rust")).rust()];
  if (ext === "py") return [(await import("@codemirror/lang-python")).python()];
  if (ext === "cs")
    return [
      StreamLanguage.define(
        (await import("@codemirror/legacy-modes/mode/clike")).csharp,
      ),
    ];
  if (["c", "h", "cpp", "hpp", "cc"].includes(ext))
    return [(await import("@codemirror/lang-cpp")).cpp()];
  return [];
}

export default function CodeSurface({
  path,
  content,
  onChange,
  wrapLines,
  stateKey = `foldory:editor:${path}`,
  rememberPosition = true,
  lineNumbers = true,
}: Props) {
  const viewRef = useRef<EditorView | null>(null);
  const showMenu = useContextMenu();
  const [extensions, setExtensions] = useState<Extension[]>([]);
  const scrollRef = useStoredScroll(
    `${stateKey}:code-scroll`,
    rememberPosition,
  );
  useEffect(() => () => scrollRef(null), [scrollRef]);
  const editorExtensions = useMemo(
    () => (wrapLines ? [...extensions, EditorView.lineWrapping] : extensions),
    [extensions, wrapLines],
  );
  useEffect(() => {
    let active = true;
    void languageFor(path)
      .then((value) => {
        if (active) setExtensions(value);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [path]);
  return (
    <CodeMirror
      onCreateEditor={(view) => {
        viewRef.current = view;
        const saved = readPreference<{ anchor?: number; head?: number } | null>(
          `${stateKey}:selection`,
          null,
        );
        if (
          rememberPosition &&
          saved &&
          Number.isFinite(saved.anchor) &&
          Number.isFinite(saved.head)
        ) {
          const clamp = (position: number) =>
            Math.max(0, Math.min(view.state.doc.length, position));
          view.dispatch({
            selection: {
              anchor: clamp(saved.anchor!),
              head: clamp(saved.head!),
            },
          });
        }
        // CodeMirror initially estimates line heights. Restore after its first
        // measurement so virtual rendering cannot shift the saved position.
        view.requestMeasure({
          read: () => null,
          write: () => scrollRef(view.scrollDOM),
        });
      }}
      onUpdate={(update) => {
        if (rememberPosition && update.selectionSet) {
          const { anchor, head } = update.state.selection.main;
          writePreference(`${stateKey}:selection`, { anchor, head });
        }
      }}
      onContextMenu={(event) => {
        const view = viewRef.current;
        if (!view) {
          event.preventDefault();
          return;
        }
        const selection = view.state.selection;
        const selected = selection.ranges
          .map((range) => view.state.sliceDoc(range.from, range.to))
          .join("\n");
        const replace = (text: string, userEvent: string) => {
          view.dispatch({ selection });
          view.dispatch(view.state.replaceSelection(text), {
            userEvent,
            scrollIntoView: true,
          });
          view.focus();
        };
        showMenu(event, "Editor actions", [
          {
            label: "Undo",
            shortcut: "Ctrl+Z",
            disabled: !undoDepth(view.state),
            run: () => {
              undo(view);
              view.focus();
            },
          },
          {
            label: "Redo",
            shortcut: "Ctrl+Y",
            disabled: !redoDepth(view.state),
            run: () => {
              redo(view);
              view.focus();
            },
          },
          {
            label: "Cut",
            shortcut: "Ctrl+X",
            disabled: !selected || view.state.readOnly,
            run: async () => {
              await navigator.clipboard.writeText(selected);
              replace("", "delete.cut");
            },
          },
          {
            label: "Copy",
            shortcut: "Ctrl+C",
            disabled: !selected,
            run: () => navigator.clipboard.writeText(selected),
          },
          {
            label: "Paste",
            shortcut: "Ctrl+V",
            disabled: view.state.readOnly,
            run: async () =>
              replace(await navigator.clipboard.readText(), "input.paste"),
          },
          {
            label: "Select all",
            shortcut: "Ctrl+A",
            run: () => {
              selectAll(view);
              view.focus();
            },
          },
        ]);
      }}
      value={content}
      onChange={onChange}
      theme={oneDark}
      extensions={editorExtensions}
      height="100%"
      basicSetup={{
        lineNumbers,
        foldGutter: true,
        highlightActiveLine: true,
        autocompletion: true,
      }}
      aria-label={`Edit ${path}`}
    />
  );
}
