export interface Source {
  id: string;
  path: string;
  name: string;
  available: boolean;
  connected: boolean;
}
export interface Project {
  id: string;
  sourceId: string;
  path: string;
  name: string;
  alias: string;
  client: string;
  tags: string[];
  color: string;
  pinned: boolean;
  hidden: boolean;
  lastOpened: number;
  modifiedAt: number;
  available: boolean;
}
export type ProjectPatch = Partial<
  Pick<Project, "alias" | "client" | "tags" | "color" | "pinned" | "hidden">
>;
export interface TemplateFile {
  path: string;
  content: string;
}
export interface Template {
  id: string;
  name: string;
  directories: string[];
  files: TemplateFile[];
}
export interface Tool {
  id: string;
  name: string;
  executable: string;
  args: string[];
}
export interface InspectorProfile {
  id: string;
  name: string;
  prompt: string;
  templates: string[];
}
export interface InspectorSettings {
  excludePatterns?: string[];
  outputTokens: number;
  timeoutMinutes: number;
  defaultProfileId: string;
  profiles: InspectorProfile[];
}
export type EndpointProvider =
  | "local"
  | "unsloth"
  | "ollama"
  | "openai"
  | "gemini"
  | "openrouter"
  | "deepseek"
  | "groq"
  | "mistral"
  | "custom";
export interface AiEndpointSettings {
  provider: EndpointProvider;
  enabled: boolean;
  baseUrl: string;
  model: string;
  hasKey: boolean;
}
export type SupportedToolId = "cursor" | "claude" | "codex";
export interface SupportedToolSettings {
  enabled: boolean;
  desktop: boolean;
  cli: boolean;
}
export type SupportedToolDetection = Record<
  SupportedToolId,
  { desktop: boolean; cli: boolean }
>;
export interface ExclusionProfile {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  folderPatterns: string[];
  filePatterns: string[];
}
export interface IndexSettings {
  followGitignore: boolean;
  profiles: ExclusionProfile[];
  folderPatterns: string[];
  filePatterns: string[];
}
export interface ProjectIndexStats {
  projectId: string;
  projectName: string;
  files: number;
  folders: number;
  contentFiles: number;
  excludedEntries: number;
  skippedFiles: number;
  truncatedFiles: number;
  lastIndexed: number;
  durationMs: number;
  status: string;
  message: string;
}
export interface FileSettings {
  rememberSession: boolean;
  restoreOpenFiles: boolean;
  rememberPositions: boolean;
  defaultMode: "preview" | "edit" | "split";
  wrapLines: boolean;
  lineNumbers: boolean;
  previewLayout: "boxed" | "full";
  previewWidth: number;
  fullWidthPadding: number;
  editorFontSize: number;
  previewFontSize: number;
}
export interface Settings {
  onboardingCompleted?: boolean;
  defaultTemplateId?: string;
  files?: FileSettings;
  indexing?: IndexSettings;
  tools: Tool[];
  supportedTools?: Partial<Record<SupportedToolId, SupportedToolSettings>>;
  aiBaseUrl: string;
  aiModel: string;
  aiHasKey: boolean;
  aiProviders?: AiEndpointSettings[];
  aiProvider?: EndpointProvider;
  scanIntervalSeconds: number;
  inspector?: InspectorSettings;
}
export interface IndexStatus {
  running: boolean;
  files: number;
  projects: number;
  lastIndexed: number;
  message: string;
}
export interface Bootstrap {
  sources: Source[];
  projects: Project[];
  templates: Template[];
  settings: Settings;
  indexStatus: IndexStatus;
}
export interface FileEntry {
  name: string;
  path: string;
  directory: boolean;
  size: number;
  modifiedAt: number;
  aiExcluded?: boolean;
  aiExclusionReason?: string;
}
export interface FileOperationRequest {
  kind: "copy" | "move" | "delete";
  paths: string[];
  destination?: string;
}
export interface FileOperationItem {
  source: string;
  destination?: string | null;
}
export interface FileOperationPlan {
  items: FileOperationItem[];
  protectionChanges: { source: string; destination: string; reason: string }[];
  protectedCount: number;
  confirmationToken: string;
}
export interface FileOperationResult {
  completed: FileOperationItem[];
  error?: string | null;
}
export interface AssistantSource {
  id: string;
  path: string;
  directory: boolean;
  fileCount: number;
  files: string[];
  warnings: string[];
}
export interface SourceApproval {
  id: string;
  kind: "excluded" | "credentials";
  paths: string[];
  totalPaths: number;
}
export type SourcePreparation =
  | { status: "ready"; sources: AssistantSource[] }
  | { status: "approvalRequired"; approval: SourceApproval }
  | { status: "cancelled" };
export type AssistantAccessMode = "readOnly" | "write" | "full";
export interface AssistantAccess {
  mode: AssistantAccessMode;
}
export interface AssistantFileAction {
  id: string;
  projectId: string;
  chatId: string;
  messageId: string;
  path: string;
  status: "pending" | "applied" | "declined" | "failed";
  content: string;
  beforeContent: string | null;
  expectedRevision: string | null;
  reason: string;
  error: string | null;
  createdAt: number;
}
export interface FileExamination {
  path: string;
  format: "csv" | "xlsx" | "docx";
  content: string;
  warnings: string[];
  formatting?: {
    paragraphs: Record<string, unknown>[];
    sections: Record<string, unknown>[];
  };
}
export interface PreparedWord {
  id: string;
  pdf: string;
  renderer: string;
  completedPages: Record<string, string>;
}
export interface FileDocument {
  path: string;
  content: string;
  revision: string;
}
export interface SearchResult {
  projectId: string;
  projectName: string;
  path: string;
  name: string;
  excerpt: string;
  directory: boolean;
  depth: number;
  matchKind: string;
}
export interface GitCommit {
  hash: string;
  author: string;
  date: string;
  subject: string;
}
export interface GitInfo {
  available: boolean;
  isRepo: boolean;
  branch: string;
  changes: string[];
  commits: GitCommit[];
  message: string;
}
export interface ChatSummary {
  id: string;
  projectId: string | null;
  title: string;
  updatedAt: number;
  pending: boolean;
  archived: boolean;
  active: boolean;
}
export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  status: "complete" | "pending" | "stopped" | "failed";
  createdAt: number;
  actions?: AssistantFileAction[];
  sources?: {
    path: string;
    directory: boolean;
    fileCount: number;
    warnings?: string[];
  }[];
}
export interface ChatThread {
  chat: ChatSummary;
  messages: ChatMessage[];
}
export interface WorkspaceProps {
  project: Project;
  settings: Settings;
  openFile?: { path: string; token: number; directory?: boolean };
  onError: (message: string) => void;
  onProjectChange: (project: Project) => void;
  onProjectContextMenu?: (
    event: import("react").MouseEvent<HTMLElement>,
  ) => void;
}
export interface SettingsProps {
  onRunOnboarding?: () => void;
  onIntegrationsChanged?: () => Promise<void>;
  onOpenIntegration?: (id: string) => void;
  data: Bootstrap;
  onRefresh: () => Promise<void>;
  onError: (message: string) => void;
}
