import type { DragEvent } from "react";
import { ASSISTANT_FILES_MIME } from "./assistantSources";

export function containsFilePath(parent: string, path: string) {
  parent = parent.replaceAll("\\", "/").toLowerCase();
  path = path.replaceAll("\\", "/").toLowerCase();
  return path === parent || path.startsWith(`${parent}/`);
}

export function acceptFileDrag(event: DragEvent<HTMLElement>) {
  if (!event.dataTransfer.types.includes(ASSISTANT_FILES_MIME)) return false;
  event.preventDefault();
  event.stopPropagation();
  event.dataTransfer.dropEffect =
    event.ctrlKey || event.metaKey ? "copy" : "move";
  return true;
}

export function droppedFilePaths(
  serialized: string,
  projectId: string,
): string[] {
  let value;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new Error("These items are not project files.");
  }
  if (value?.projectId !== projectId)
    throw new Error(
      "Move or copy files within the current project. Open its Files section to choose a destination.",
    );
  if (
    !Array.isArray(value.paths) ||
    !value.paths.length ||
    value.paths.some((path: unknown) => typeof path !== "string" || !path)
  )
    throw new Error("No valid project paths were dropped.");
  return [...new Set<string>(value.paths)];
}
