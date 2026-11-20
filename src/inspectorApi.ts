import { call } from "./api";
import type { FileDocument } from "./types";

export interface OverviewDraft {
  content: string;
  revision: string | null;
  writeBlocked: string | null;
}

export type ScanLevel = "outline" | "standard" | "deep";

export interface ScanOptions {
  level: ScanLevel;
  inputKib: number;
  focus: string;
  additionalFile: string;
  excludePatterns: string[];
}

export interface ContextReview {
  id: string;
  destination: string;
  inputBytes: number;
  budgetBytes: number;
  outputTokens: number | null;
  prompt: string;
  systemPrompt: string;
  tree: string[];
  documents: {
    path: string;
    content: string;
    truncated: boolean;
    approved: boolean;
  }[];
  coverage: {
    visited: number;
    excluded: number;
    withheldDocuments: number;
    redactedDocuments: number;
    omittedDocuments: number;
    omittedPaths: number;
    traversalLimited: boolean;
  };
}

export interface ProviderResponse {
  status: number;
  finishReason: string | null;
  completionTokens: number | null;
  tokenLimit: number;
  bodyExcerpt: string;
  truncated: boolean;
}

type DraftResult =
  | OverviewDraft
  | { error: { message: string; response: ProviderResponse | null } };

export const inspectorApi = {
  writeAccess: (projectId: string) =>
    call<boolean>("get_inspector_write_access", { projectId }),
  setWriteAccess: (projectId: string, enabled: boolean) =>
    call<boolean>("set_inspector_write_access", { projectId, enabled }),
  prepareContext: (
    projectId: string,
    profileId: string | null,
    options: ScanOptions,
  ) =>
    call<ContextReview>("prepare_inspector_context", {
      projectId,
      profileId,
      options,
    }),
  discardContext: (contextId: string) =>
    call<void>("discard_inspector_context", { contextId }),
  draftOverview: (projectId: string, contextId: string) =>
    call<DraftResult>("draft_project_overview", { projectId, contextId }),
  applyOverview: (
    projectId: string,
    content: string,
    revision: string | null,
  ) =>
    call<FileDocument | null>("apply_project_overview", {
      projectId,
      content,
      revision,
    }),
};
