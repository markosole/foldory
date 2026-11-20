import { useEffect, useState, type RefObject } from "react";
import type { FileSettings } from "./types";
import { stepFontSize } from "./fileSettings";

type Target = "editor" | "preview";
type Zoom = Partial<Record<Target, number>>;
// Zoom belongs to an open tab, survives view/project navigation, and never
// changes another file or the application's configured font defaults.
const openFileZoom = new Map<string, Zoom>();
export const clearFileZoom = (projectId: string, path: string) =>
  openFileZoom.delete(`${projectId}:${path}`);

export function useFileZoom(
  projectId: string,
  path: string,
  config: FileSettings,
  root: RefObject<HTMLElement | null>,
  defaultTarget: Target,
) {
  const key = `${projectId}:${path}`;
  const [overrides, setOverrides] = useState<Zoom>(
    () => openFileZoom.get(key) ?? {},
  );
  const [target, setTarget] = useState<Target>(defaultTarget);
  useEffect(() => setTarget(defaultTarget), [defaultTarget]);
  const editor = overrides.editor ?? config.editorFontSize;
  const preview = overrides.preview ?? config.previewFontSize;
  const size = target === "editor" ? editor : preview;
  function resize(direction: number) {
    setOverrides((current) => {
      const value = { ...current, [target]: stepFontSize(size, direction) };
      openFileZoom.set(key, value);
      return value;
    });
  }
  function reset() {
    openFileZoom.delete(key);
    setOverrides({});
  }
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (
        !(event.ctrlKey || event.metaKey) ||
        event.altKey ||
        !root.current?.isConnected
      )
        return;
      const focused = document.activeElement;
      if (
        focused instanceof HTMLElement &&
        !root.current.contains(focused) &&
        focused !== document.body &&
        !focused.closest("#project-files, .file-tabs, .workspace-tabs")
      )
        return;
      const increase =
        event.key === "+" || event.key === "=" || event.code === "NumpadAdd";
      const decrease =
        event.key === "-" ||
        event.key === "_" ||
        event.code === "NumpadSubtract";
      if (!increase && !decrease && event.key !== "0") return;
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "0") reset();
      else resize(increase ? 1 : -1);
    };
    window.addEventListener("keydown", listener, true);
    return () => window.removeEventListener("keydown", listener, true);
  }, [key, target, size, root]);
  return {
    editor,
    preview,
    target,
    size,
    setTarget,
    resize,
    reset,
    changed:
      editor !== config.editorFontSize || preview !== config.previewFontSize,
  };
}
