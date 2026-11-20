import { invoke, isTauri } from "@tauri-apps/api/core";
import { toAppError } from "./errors";
import type {
  SourcePreparation,
  AssistantAccess,
  AssistantAccessMode,
  AssistantFileAction,
  Bootstrap,
  ChatSummary,
  ChatThread,
  FileDocument,
  FileEntry,
  FileExamination,
  GitInfo,
  IndexStatus,
  IndexSettings,
  ProjectIndexStats,
  Project,
  ProjectPatch,
  SearchResult,
  Settings,
  SupportedToolDetection,
  EndpointProvider,
  Template,
} from "./types";
export const desktop = isTauri();
const assistantCommands = new Set([
  "list_chats",
  "create_chat",
  "open_chat",
  "get_chat",
  "send_chat_message",
  "stop_chat",
  "delete_chat",
  "delete_chat_message",
  "prepare_assistant_sources",
  "approve_assistant_sources",
  "discard_assistant_sources",
  "get_assistant_access",
  "set_assistant_access",
  "decide_assistant_action",
]);
export async function call<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  if (!desktop)
    throw new Error(
      "Open the desktop app to access local projects. Run npm run tauri dev from the app folder.",
    );
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    if (assistantCommands.has(command) || command.startsWith("ai_"))
      throw toAppError(error, command);
    // Other views still use their existing domain-specific validation messages
    // (for example, file-save conflicts and invalid project names).
    throw error instanceof Error ? error : new Error(String(error));
  }
}
export const api = {
  detectSupportedTools: () =>
    call<SupportedToolDetection>("detect_supported_tools"),
  bootstrap: () => call<Bootstrap>("bootstrap"),
  addSource: (path: string) => call<Bootstrap>("add_source", { path }),
  setSourceConnected: (id: string, connected: boolean) =>
    call<Bootstrap>("set_source_connected", { id, connected }),
  removeSource: (id: string) => call<Bootstrap>("remove_source", { id }),
  scanSources: () => call<Bootstrap>("scan_sources"),
  updateProject: (id: string, patch: ProjectPatch) =>
    call<Project>("update_project", { id, patch }),
  touchProject: (id: string) => call<Project>("touch_project", { id }),
  createProject: (
    sourceId: string,
    name: string,
    templateId: string,
    client: string,
  ) => call<Project>("create_project", { sourceId, name, templateId, client }),
  saveTemplate: (template: Template) =>
    call<Template>("save_template", { template }),
  deleteTemplate: (id: string) => call<void>("delete_template", { id }),
  listDirectory: (projectId: string, path: string) =>
    call<FileEntry[]>("list_directory", { projectId, path }),
  previewFileOperation: (
    projectId: string,
    request: import("./types").FileOperationRequest,
  ) =>
    call<import("./types").FileOperationPlan>("preview_file_operation", {
      projectId,
      request,
    }),
  executeFileOperation: (
    projectId: string,
    request: import("./types").FileOperationRequest,
    confirmationToken: string,
  ) =>
    call<import("./types").FileOperationResult>("execute_file_operation", {
      projectId,
      request,
      confirmationToken,
    }),
  readFile: (projectId: string, path: string) =>
    call<FileDocument>("read_file", { projectId, path }),
  readImage: (projectId: string, path: string) =>
    call<string>("read_image", { projectId, path }),
  examineFile: (projectId: string, path: string) =>
    call<FileExamination>("examine_file", { projectId, path }),
  prepareWordDocument: (
    projectId: string,
    path: string,
    instructions: string,
  ) =>
    call<import("./types").PreparedWord>("prepare_word_document", {
      projectId,
      path,
      instructions,
    }),
  parseWordPage: (
    projectId: string,
    id: string,
    page: number,
    totalPages: number,
    pageText: string,
    image: string,
  ) =>
    call<string>("parse_word_page", {
      projectId,
      id,
      page,
      totalPages,
      pageText,
      image,
    }),
  completeWordDocument: (projectId: string, id: string, totalPages: number) =>
    call<FileExamination>("complete_word_document", {
      projectId,
      id,
      totalPages,
    }),
  prepareWordSource: (projectId: string, id: string) =>
    call<SourcePreparation>("prepare_word_source", { projectId, id }),
  prepareAssistantSources: (projectId: string, paths: string[]) =>
    call<SourcePreparation>("prepare_assistant_sources", { projectId, paths }),
  approveAssistantSources: (
    projectId: string,
    approvalId: string,
    allow: boolean,
  ) =>
    call<SourcePreparation>("approve_assistant_sources", {
      projectId,
      approvalId,
      allow,
    }),
  getAssistantAccess: (projectId: string) =>
    call<AssistantAccess>("get_assistant_access", { projectId }),
  setAssistantAccess: (projectId: string, mode: AssistantAccessMode) =>
    call<AssistantAccess>("set_assistant_access", { projectId, mode }),
  decideAssistantAction: (
    projectId: string,
    chatId: string,
    actionId: string,
    approve: boolean,
  ) =>
    call<AssistantFileAction>("decide_assistant_action", {
      projectId,
      chatId,
      actionId,
      approve,
    }),
  discardAssistantSources: (projectId: string, sourceIds: string[]) =>
    call<void>("discard_assistant_sources", { projectId, sourceIds }),
  writeFile: (
    projectId: string,
    path: string,
    content: string,
    revision: string | null,
    force = false,
  ) =>
    call<FileDocument>("write_file", {
      projectId,
      path,
      content,
      revision,
      force,
    }),
  createEntry: (projectId: string, path: string, directory: boolean) =>
    call<void>("create_entry", { projectId, path, directory }),
  searchFiles: (query: string, projectId: string | null, mode: string) =>
    call<SearchResult[]>("search_files", { query, projectId, mode }),
  searchFolders: (query: string) =>
    call<SearchResult[]>("search_folders", { query }),
  indexDefaults: () => call<IndexSettings>("index_defaults"),
  indexStatistics: () => call<ProjectIndexStats[]>("index_statistics"),
  clearProjectIndex: (projectId: string) =>
    call<IndexStatus>("clear_project_index", { projectId }),
  reindexProject: (projectId: string) =>
    call<IndexStatus>("reindex_project", { projectId }),
  rebuildIndex: () => call<IndexStatus>("rebuild_index"),
  indexStatus: () => call<IndexStatus>("index_status"),
  saveSettings: (settings: Settings) =>
    call<Settings>("save_settings", { settings }),
  chooseDirectory: () => call<string | null>("choose_directory"),
  openExternalUrl: (url: string) => call<void>("open_external_url", { url }),
  launchTool: (projectId: string, toolId: string, path: string | null = null) =>
    call<void>("launch_tool", { projectId, toolId, path }),
  gitInfo: (projectId: string) => call<GitInfo>("git_info", { projectId }),
  saveAiKey: (provider: EndpointProvider, key: string) =>
    call<void>("save_ai_key", { provider, key }),
  listChats: (projectId: string | null) =>
    call<ChatSummary[]>("list_chats", { projectId }),
  createChat: (projectId: string | null) =>
    call<ChatSummary>("create_chat", { projectId }),
  openChat: (chatId: string, projectId: string | null) =>
    call<ChatThread>("open_chat", { chatId, projectId }),
  getChat: (chatId: string, projectId: string | null) =>
    call<ChatThread>("get_chat", { chatId, projectId }),
  setChatArchived: (
    chatId: string,
    projectId: string | null,
    archived: boolean,
  ) => call<ChatSummary>("set_chat_archived", { chatId, projectId, archived }),
  sendChatMessage: (
    chatId: string,
    projectId: string | null,
    prompt: string,
    includeOverview: boolean,
    sourceIds: string[] = [],
    scopeProjectIds: string[] = [],
  ) =>
    call<ChatThread>("send_chat_message", {
      chatId,
      projectId,
      prompt,
      includeOverview,
      sourceIds,
      scopeProjectIds,
    }),
  stopChat: (chatId: string, projectId: string | null) =>
    call<ChatThread>("stop_chat", { chatId, projectId }),
  deleteChat: (chatId: string, projectId: string | null) =>
    call<void>("delete_chat", { chatId, projectId }),
  deleteChatMessage: (
    chatId: string,
    projectId: string | null,
    messageId: string,
  ) => call<void>("delete_chat_message", { chatId, projectId, messageId }),
};
