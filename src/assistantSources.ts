import type { AssistantSource } from "./types";

export const ASSISTANT_FILES_MIME = "application/x-foldory-files";

export function sourcePathKey(path: string) {
  return path
    .replaceAll("\\", "/")
    .replace(/^\.\//, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}

export function isCoveredPath(
  path: string,
  sources: Pick<AssistantSource, "path" | "directory">[],
) {
  const key = sourcePathKey(path);
  return sources.some((source) => {
    const parent = sourcePathKey(source.path);
    return (
      key === parent ||
      (source.directory && (!parent || key.startsWith(`${parent}/`)))
    );
  });
}

export interface PathReference {
  start: number;
  end: number;
  path: string;
}

/** References only start at a word boundary, so email addresses/URLs stay prose. */
export function pathReferences(prompt: string): PathReference[] {
  const pattern = /(?:^|\s)[@/](?:"([^"\r\n]+)"|([^\s"<>]+))/g;
  return Array.from(prompt.matchAll(pattern), (match) => ({
    start:
      match.index! +
      (match[0].startsWith("@") || match[0].startsWith("/") ? 0 : 1),
    end: match.index! + match[0].length,
    path: match[1] ?? match[2].replace(/[.,;!?)\]}]+$/, ""),
  }));
}

export function activePathReference(
  prompt: string,
  caret: number,
): PathReference | null {
  const prefix = prompt.slice(0, caret);
  const match = /(?:^|\s)[@/](?:"([^"\r\n]*)|([^\s"<>]*))$/.exec(prefix);
  if (!match) return null;
  return {
    start: match.index + (/^\s/.test(match[0]) ? 1 : 0),
    end: caret,
    path: match[1] ?? match[2] ?? "",
  };
}

export function draggedSourcePaths(
  serialized: string,
  projectId: string,
): string[] {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new Error("These items are not project files.");
  }
  if (
    !value ||
    typeof value !== "object" ||
    !("projectId" in value) ||
    !("paths" in value)
  )
    throw new Error("These items are not project files.");
  if (value.projectId !== projectId)
    throw new Error(
      "Include files from the current project. Open the other project’s Assistant to use its files.",
    );
  if (
    !Array.isArray(value.paths) ||
    !value.paths.length ||
    value.paths.some((path) => typeof path !== "string")
  )
    throw new Error("No valid project paths were dropped.");
  return [...new Set(value.paths as string[])];
}
