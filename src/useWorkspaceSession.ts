import { useState, type SetStateAction } from "react";
import type { FileSettings } from "./types";
import { fileSettings } from "./fileSettings";

export interface WorkspaceSession {
  tab: "overview" | "files" | "git" | "assistant";
  directory: string;
  openFiles: string[];
  activeFile: string;
  expandedFolders: string[];
  explorerVisible: boolean;
}

export function readPreference<T>(key: string, fallback: T): T {
  try {
    const saved = localStorage.getItem(key);
    return saved === null ? fallback : JSON.parse(saved);
  } catch {
    return fallback;
  }
}

export function writePreference(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Workspace preferences must never prevent opening or saving a file.
  }
}

function paths(value: unknown): string[] {
  return Array.isArray(value)
    ? [
        ...new Set(
          value.filter(
            (path): path is string => typeof path === "string" && !!path,
          ),
        ),
      ]
    : [];
}

export function useWorkspaceSession(
  projectId: string,
  preferences?: FileSettings,
) {
  const config = fileSettings(preferences);
  const key = `foldory:workspace:${projectId}`;
  const [session, setSession] = useState<WorkspaceSession>(() => {
    const saved = config.rememberSession
      ? readPreference<Partial<WorkspaceSession> | null>(key, null)
      : null;
    const openFiles = config.restoreOpenFiles ? paths(saved?.openFiles) : [];
    return {
      tab: ["overview", "files", "git", "assistant"].includes(saved?.tab ?? "")
        ? saved!.tab!
        : "overview",
      directory: typeof saved?.directory === "string" ? saved.directory : "",
      openFiles,
      activeFile: openFiles.includes(saved?.activeFile ?? "")
        ? saved!.activeFile!
        : (openFiles[0] ?? ""),
      expandedFolders: paths(saved?.expandedFolders),
      explorerVisible: saved?.explorerVisible !== false,
    };
  });
  function update(next: SetStateAction<WorkspaceSession>) {
    setSession((current) => {
      const value = typeof next === "function" ? next(current) : next;
      writePreference(
        key,
        config.rememberSession
          ? {
              ...value,
              openFiles: config.restoreOpenFiles ? value.openFiles : [],
              activeFile: config.restoreOpenFiles ? value.activeFile : "",
            }
          : null,
      );
      return value;
    });
  }
  return [session, update] as const;
}
