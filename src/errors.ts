export type AppErrorCode =
  | "database_busy"
  | "ai_model_unavailable"
  | "ai_connection"
  | "ai_auth"
  | "ai_rate_limit"
  | "ai_context_limit"
  | "ai_request"
  | "permission"
  | "source_limit"
  | "source_expired"
  | "file_access"
  | "file_conflict"
  | "file_action_invalid"
  | "request_timeout"
  | "unknown";

export type ErrorContext =
  "send" | "sources" | "history" | "response" | "actions" | "access";
export type ErrorCategory =
  "Workspace" | "AI service" | "Sources" | "Files" | "Assistant";

export interface AppErrorDescriptor {
  code: AppErrorCode;
  category: ErrorCategory;
  title: string;
  message: string;
  action: string;
  technicalDetails: string;
  retryable: boolean;
}

const descriptions: Record<
  AppErrorCode,
  Omit<AppErrorDescriptor, "code" | "technicalDetails">
> = {
  database_busy: {
    category: "Workspace",
    title: "Workspace database busy",
    message:
      "The app could not finish this operation because another workspace operation is using the database.",
    action:
      "Wait a few seconds, then try again. If this keeps happening, close other running copies of Foldory and reopen the app.",
    retryable: true,
  },
  ai_model_unavailable: {
    category: "AI service",
    title: "No AI model loaded",
    message:
      "The selected AI model is not loaded or is no longer available at the connected provider.",
    action:
      "For LM Studio or Unsloth, load a model and start its server. Then refresh the model list and choose a loaded model in the Assistant.",
    retryable: false,
  },
  ai_connection: {
    category: "AI service",
    title: "AI service unavailable",
    message:
      "The app could not connect to the AI provider, or its server is temporarily unavailable.",
    action:
      "Check that the provider is running and that its server address is correct in Settings → AI connection, then try again.",
    retryable: true,
  },
  ai_auth: {
    category: "AI service",
    title: "AI sign-in or API key required",
    message: "The AI provider refused access to this request.",
    action:
      "Check the provider's API key in Settings → AI connection. For a subscription CLI, sign in again and check that your account can use the selected model.",
    retryable: false,
  },
  ai_rate_limit: {
    category: "AI service",
    title: "AI request limit reached",
    message:
      "The provider or app is accepting too many requests, or your account has reached its usage limit.",
    action:
      "Wait for current requests to finish and check your provider's usage allowance before trying again.",
    retryable: true,
  },
  ai_context_limit: {
    category: "AI service",
    title: "Too much content for this model",
    message:
      "This conversation and its attached sources exceed the selected model's context limit.",
    action:
      "Start a new chat with fewer or smaller sources, or choose a model with a larger context window.",
    retryable: false,
  },
  ai_request: {
    category: "AI service",
    title: "AI provider rejected the request",
    message:
      "The provider could not accept this request with the current model or settings.",
    action:
      "Check the selected model and provider settings. Technical details below may identify an unsupported setting or a server error.",
    retryable: false,
  },
  permission: {
    category: "Sources",
    title: "Source access needs permission",
    message:
      "The source was not included because access was declined or an exclusion rule requires permission.",
    action:
      "Include the source again and approve the permission dialog if you intend to share it, or choose a different source.",
    retryable: false,
  },
  source_limit: {
    category: "Sources",
    title: "Source selection is too large",
    message:
      "The selected files or folders exceed the app's source size, count, or extraction limits.",
    action:
      "Choose fewer files or a smaller subfolder. If this chat already has many sources, start a new chat or delete an earlier message containing sources.",
    retryable: false,
  },
  source_expired: {
    category: "Sources",
    title: "Source attachment expired",
    message: "A prepared source is no longer available for this request.",
    action:
      "Remove the expired attachment and include the file or folder again. Sources must belong to the current project.",
    retryable: false,
  },
  file_access: {
    category: "Files",
    title: "Source file could not be read",
    message:
      "The file may have moved, become unavailable, or use a format the app cannot read safely.",
    action:
      "Check that the file exists inside this project and is accessible. Open it in Files to review it, then include it again.",
    retryable: false,
  },
  file_conflict: {
    category: "Files",
    title: "File changed since this proposal",
    message:
      "This file changed on disk after the assistant prepared its change. The newer file was preserved.",
    action:
      "Review the current file in Files and ask the assistant for a fresh proposal. Save or resolve any open editor changes before approving again.",
    retryable: false,
  },
  file_action_invalid: {
    category: "Files",
    title: "File proposal could not be used",
    message:
      "The assistant returned an invalid, unsupported or incomplete file change. It was not applied.",
    action:
      "Ask for a complete UTF-8 text file such as Markdown or CSV, a valid project-relative filename, and a smaller change if necessary. Review the technical details for the exact reason.",
    retryable: false,
  },
  request_timeout: {
    category: "AI service",
    title: "AI request timed out",
    message: "The AI provider did not finish before the request time limit.",
    action:
      "Check that the provider and model are ready. Try a shorter question or fewer sources, then try again.",
    retryable: true,
  },
  unknown: {
    category: "Assistant",
    title: "Assistant operation could not finish",
    message: "The app could not complete this operation.",
    action:
      "Review the technical details below. If the problem persists, reopen the app and try again.",
    retryable: false,
  },
};

const codes = new Set<string>(Object.keys(descriptions));

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function codeOf(value: unknown): AppErrorCode | undefined {
  if (typeof value !== "string") return;
  const normalized = value.trim().toLowerCase();
  if (codes.has(normalized)) return normalized as AppErrorCode;
  if (/^sqlite_(?:busy|locked)(?:_.*)?$/.test(normalized))
    return "database_busy";
  if (
    ["model_not_found", "no_models_loaded", "model_not_loaded"].includes(
      normalized,
    )
  )
    return "ai_model_unavailable";
}

function parsedObject(
  text: string,
): { prefix: string; value: Record<string, unknown> } | undefined {
  const start = text.indexOf("{");
  if (start < 0 || !text.trimEnd().endsWith("}")) return;
  try {
    const value = record(JSON.parse(text.slice(start)));
    if (value) return { prefix: text.slice(0, start).trim(), value };
  } catch {
    // Legacy native errors are often ordinary strings rather than JSON.
  }
}

/** Keep diagnostics useful without echoing request payloads or file contents. */
function diagnosticText(error: unknown, depth = 0): string {
  if (depth > 3) return "";
  if (typeof error === "string") {
    const parsed = parsedObject(error);
    if (parsed)
      return [parsed.prefix, diagnosticText(parsed.value, depth + 1)]
        .filter(Boolean)
        .join("\n");
    return error;
  }
  if (error instanceof Error) return diagnosticText(error.message, depth + 1);
  const object = record(error);
  if (!object)
    return typeof error === "number"
      ? String(error)
      : "No additional diagnostic information was provided.";
  const fields: string[] = [];
  for (const key of [
    "code",
    "status",
    "statusCode",
    "httpStatus",
    "type",
    "message",
  ]) {
    const value = object[key];
    if (typeof value === "string" || typeof value === "number")
      fields.push(`${key}: ${value}`);
  }
  if (object.error !== undefined)
    fields.push(diagnosticText(object.error, depth + 1));
  if (typeof object.details === "string")
    fields.push(diagnosticText(object.details, depth + 1));
  if (typeof object.technicalDetails === "string")
    fields.push(diagnosticText(object.technicalDetails, depth + 1));
  return (
    fields.filter(Boolean).join("\n") ||
    "No additional diagnostic information was provided."
  );
}

function envelope(error: unknown): Record<string, unknown> | undefined {
  if (typeof error === "string") return parsedObject(error)?.value;
  if (error instanceof Error) {
    const object = record(error);
    return codeOf(object?.code)
      ? object
      : (parsedObject(error.message)?.value ?? object);
  }
  return record(error);
}

function classify(error: unknown, text: string): AppErrorCode {
  const object = envelope(error);
  const nested = record(object?.error);
  const explicit = codeOf(object?.code) ?? codeOf(nested?.code);
  if (explicit && explicit !== "unknown") return explicit;
  const rawStatus =
    object?.status ??
    object?.statusCode ??
    object?.httpStatus ??
    nested?.status;
  const status =
    Number(rawStatus) ||
    Number(text.match(/\b(?:HTTP|status(?:Code)?)[^\d]{0,8}(\d{3})\b/i)?.[1]);
  if (status === 401 || status === 403) return "ai_auth";
  if (
    /project-actions|write_project_file|assistant (?:file paths|proposed|writes (?:currently |only )?)|proposed (?:file|contents)|no file changes were applied/i.test(
      text,
    )
  )
    return "file_action_invalid";
  if (
    /\bCONFLICT\b|file (?:has )?changed (?:on disk|since)|file was (?:created|removed) on disk/i.test(
      text,
    )
  )
    return "file_conflict";
  if (
    /database (?:is )?(?:locked|busy)|database lock failed|sqlite_(?:busy|locked)|database table is locked/i.test(
      text,
    )
  )
    return "database_busy";
  if (
    /context[_ ](?:length|window|limit)|maximum context|too many tokens|prompt (?:is )?too long|token limit.*exceed|exceed.*token limit/i.test(
      text,
    ) ||
    status === 413
  )
    return "ai_context_limit";
  if (
    /no models?(?: (?:are|is))?(?: currently)? (?:loaded|selected|available)|no (?:available|loaded) models?|model[^\n]{0,160}(?:not (?:loaded|found|available)|unloaded|does not exist|no longer available)|(?:load|select|choose) (?:an? )?(?:ai )?model|model_not_found|no_models_loaded|model_not_loaded|failed to load[^\n]{0,100}model|configure an ai endpoint and model|selected Cursor model is unavailable/i.test(
      text,
    )
  )
    return "ai_model_unavailable";
  if (
    status === 401 ||
    status === 403 ||
    /unauthorized|invalid (?:api[ _-]?)?key|incorrect (?:api[ _-]?)?key|authentication (?:failed|required)|not authenticated|sign in (?:again|first)/i.test(
      text,
    )
  )
    return "ai_auth";
  if (
    status === 429 ||
    /rate[_ -]?limit|quota (?:exceeded|exhausted)|insufficient_quota|too many requests|usage allowance was reached/i.test(
      text,
    )
  )
    return "ai_rate_limit";
  if (
    /source[^\n]{0,100}(?:expired|already sent|another project)|source has expired/i.test(
      text,
    )
  )
    return "source_expired";
  if (
    /permission (?:was )?(?:declined|denied|required)|permission is required|access (?:was )?declined|excluded sources were not included|exclusion rules changed|sources were not attached because possible credentials/i.test(
      text,
    )
  )
    return "permission";
  if (
    /source[^\n]{0,100}(?:limit|too many)|too many prepared sources|(?:selection|attachments?|conversation)[^\n]{0,100}(?:exceed|too (?:large|many))|(?:500 (?:readable )?files|512\s*ki?b|64 source selections|10,000 entries|32\s*mib|8\s*mib|100,000 populated cells)|select (?:smaller|fewer)|no (?:content|rows|cells|paragraphs) (?:was|were) truncated/i.test(
      text,
    )
  )
    return "source_limit";
  if (
    status === 408 ||
    status === 504 ||
    /timed? out|timeout|deadline exceeded/i.test(text)
  )
    return "request_timeout";
  if (
    status === 502 ||
    status === 503 ||
    /econnrefused|econnreset|connection (?:refused|reset|closed|failed)|failed to fetch|fetch failed|network (?:error|request failed)|error sending request|could not connect|tcp connect error|no connection could be made|dns error|os error 10061|endpoint[^\n]{0,50}(?:unreachable|offline)/i.test(
      text,
    )
  )
    return "ai_connection";
  if (
    /outside (?:the )?project|path traversal|symbolic links?|junctions?|linked (?:project |files|path)|cannot (?:access|read|open)|could not (?:read|open)|file[^\n]{0,100}(?:not found|unavailable|not utf-8|binary|unsupported)|(?:project|source) is unavailable|access (?:is )?denied|sharing violation|unsupported (?:file|layout)|file type cannot|csv must be utf-8|word[^\n]{0,80}(?:malformed|no word\/document)|os error (?:2|3|5|32)\b/i.test(
      text,
    )
  )
    return "file_access";
  if (
    status >= 400 ||
    /ai endpoint returned an error|provider[^\n]{0,80}(?:rejected|error)|invalid_request_error|Cursor CLI (?:rejected|cannot)|headless requests are disabled/i.test(
      text,
    )
  )
    return "ai_request";
  return "unknown";
}

function operationContext(operation?: string): ErrorContext | undefined {
  if (!operation) return;
  if (
    ["access", "get_assistant_access", "set_assistant_access"].includes(
      operation,
    )
  )
    return "access";
  if (["actions", "decide_assistant_action"].includes(operation))
    return "actions";
  if (
    [
      "sources",
      "prepare_assistant_sources",
      "approve_assistant_sources",
      "discard_assistant_sources",
    ].includes(operation)
  )
    return "sources";
  if (
    [
      "history",
      "list_chats",
      "open_chat",
      "get_chat",
      "create_chat",
      "set_chat_archived",
    ].includes(operation)
  )
    return "history";
  if (["send", "send_chat_message"].includes(operation)) return "send";
  if (operation === "response") return "response";
}

export class AppError extends Error implements AppErrorDescriptor {
  readonly code: AppErrorCode;
  readonly category: ErrorCategory;
  readonly title: string;
  readonly action: string;
  readonly technicalDetails: string;
  readonly retryable: boolean;
  readonly operation?: string;

  constructor(code: AppErrorCode, technicalDetails = "", operation?: string) {
    const descriptor = { ...descriptions[code] };
    if (
      /^(?:Cursor(?:'s| CLI| sign-in)|The selected Cursor model)/.test(
        technicalDetails,
      )
    ) {
      descriptor.message = technicalDetails.split("\n")[0];
      descriptor.action =
        "Open Settings → AI connection → Cursor and use Test connection. Sign in again if requested. In the Inspector or Assistant, select Cursor first, then Auto (recommended) or another available model.";
    }
    if (code === "unknown") {
      const context = operationContext(operation);
      if (context === "actions") {
        descriptor.category = "Files";
        descriptor.title = "File change could not be completed";
        descriptor.message =
          "The app could not apply this proposed file change.";
        descriptor.action =
          "Check the target file and proposed content, then request a fresh change if needed. Only a Saved status confirms that a write completed.";
      } else if (context === "access") {
        descriptor.category = "Workspace";
        descriptor.title = "Assistant access could not be updated";
        descriptor.message =
          "The app could not load or save this project's Assistant access setting.";
        descriptor.action =
          "Try choosing the access mode again. Read only access remains the default until a setting is saved.";
      } else if (context === "sources") {
        descriptor.category = "Sources";
        descriptor.title = "Source could not be included";
        descriptor.message =
          "The app could not prepare this source for the Assistant.";
        descriptor.action =
          "Check the file or folder in Files, then include it again. Review the technical details if the problem continues.";
      } else if (context === "history") {
        descriptor.category = "Workspace";
        if (operation === "set_chat_archived") {
          descriptor.title = "Chat archive could not be updated";
          descriptor.message =
            "The chat's archive status could not be changed.";
          descriptor.action =
            "Wait for any response or file change to finish, then try again. Your saved messages are preserved.";
        } else {
          descriptor.title = "Conversations could not be opened";
          descriptor.message =
            "The app could not load or update the saved conversations.";
        }
      } else if (context === "send" || context === "response") {
        descriptor.title = "Assistant request failed";
        descriptor.message = "The Assistant could not complete this request.";
      }
    }
    super(descriptor.message);
    this.name = "AppError";
    this.code = code;
    this.category = descriptor.category;
    this.title = descriptor.title;
    this.action = descriptor.action;
    this.technicalDetails = technicalDetails
      .replace(/\u0000/g, "")
      .slice(0, 2400);
    this.retryable = descriptor.retryable;
    this.operation = operation;
  }
}

/** Accepts native typed envelopes as well as older persisted error strings. */
export function toAppError(error: unknown, operation?: string): AppError {
  if (error instanceof AppError) {
    if (error.code === "unknown" && operation && !error.operation)
      return new AppError(error.code, error.technicalDetails, operation);
    return error;
  }
  const details = diagnosticText(error);
  return new AppError(classify(error, details), details, operation);
}
