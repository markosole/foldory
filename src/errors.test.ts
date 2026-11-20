import { describe, expect, it } from "vitest";
import { AppError, toAppError } from "./errors";

describe("assistant error classification", () => {
  it("keeps Cursor's actionable cause visible and points to its subscription controls", () => {
    const result = toAppError(
      "Cursor CLI cannot use its OS sandbox on this platform. Update Foldory; Windows requests must use Cursor's allowlist mode.\nCursor CLI detail: Sandbox requires macOS or Linux.",
      "response",
    );
    expect(result.code).toBe("ai_request");
    expect(result.message).toContain("sandbox");
    expect(result.action).toContain("AI connection → Cursor");
    expect(result.action).toContain("Test connection");
    expect(
      toAppError(
        "Cursor's usage allowance was reached. Check your Cursor account Usage and try Auto or an available model.",
        "response",
      ).code,
    ).toBe("ai_rate_limit");
  });
  it("explains invalid file proposals and preserves newer disk content on conflicts", () => {
    expect(
      toAppError(
        "The AI returned malformed project-actions JSON. No file changes were applied.",
        "response",
      ).code,
    ).toBe("file_action_invalid");
    expect(
      toAppError(
        "CONFLICT: This file changed on disk. Reload it or explicitly overwrite it.",
        "decide_assistant_action",
      ).code,
    ).toBe("file_conflict");
    expect(
      toAppError(
        "Assistant writes only support UTF-8 text files, not DOCX containers.",
        "response",
      ).action,
    ).toContain("Markdown or CSV");
  });
  it.each([
    "database is locked",
    "Database lock failed. Restart the app.",
    { code: "SQLITE_BUSY", message: "SQLite could not acquire the write lock" },
    { code: "database_busy", message: "Native retry deadline reached" },
  ])("describes workspace database contention: %j", (error) => {
    const result = toAppError(error, "list_chats");
    expect(result).toBeInstanceOf(Error);
    expect(result.code).toBe("database_busy");
    expect(result.title).toBe("Workspace database busy");
    expect(result.message).not.toContain("database is locked");
    expect(result.retryable).toBe(true);
    expect(result.action).toMatch(/wait a few seconds/i);
  });

  it.each([
    'AI endpoint returned an error (HTTP 400 Bad Request). {"error":"No models loaded. Please load a model in the developer page or use the lms load CLI."}',
    {
      status: 400,
      error: { code: "model_not_found", message: "The model is not available" },
    },
    new Error("The selected model is not loaded"),
    "No models are currently loaded.",
    "No loaded models found.",
  ])(
    "recognizes unloaded-model errors without confusing all HTTP 400 responses: %j",
    (error) => {
      const result = toAppError(error, "response");
      expect(result.code).toBe("ai_model_unavailable");
      expect(result.title).toBe("No AI model loaded");
      expect(result.action).toContain("LM Studio");
      expect(result.action).toContain("load a model");
    },
  );

  it("keeps generic bad requests distinct from unloaded-model errors", () => {
    const result = toAppError(
      'AI endpoint returned an error (HTTP 400 Bad Request). {"error":{"message":"Unsupported parameter: max_tokens"}}',
      "response",
    );
    expect(result.code).toBe("ai_request");
    expect(result.title).toBe("AI provider rejected the request");
    expect(result.technicalDetails).toContain("Unsupported parameter");
    expect(result.message).not.toContain("max_tokens");
  });

  it.each([
    ["HTTP 401 Unauthorized", "ai_auth"],
    [{ status: 403, message: "Forbidden" }, "ai_auth"],
    [new TypeError("Failed to fetch"), "ai_connection"],
    [
      "error sending request for url (http://127.0.0.1:1234/v1/chat/completions)",
      "ai_connection",
    ],
    [
      "error trying to connect: tcp connect error: connection refused",
      "ai_connection",
    ],
    ["The request timed out", "request_timeout"],
    [{ statusCode: 429, message: "Too Many Requests" }, "ai_rate_limit"],
    ["Maximum context length exceeded for this model", "ai_context_limit"],
    [
      "Excluded sources were not included. Permission was declined; no selected content was read.",
      "permission",
    ],
    [
      "This source permission request expired or was already answered. Include the sources again.",
      "source_expired",
    ],
    [
      "A source belongs to another project or has expired. Attach it again.",
      "source_expired",
    ],
    [
      "The selection exceeds 512 KiB of extracted context. Select smaller subfolders.",
      "source_limit",
    ],
    ["Cannot access project source file: os error 2", "file_access"],
  ] as const)("maps %j to %s", (error, code) => {
    expect(toAppError(error).code).toBe(code);
  });

  it("preserves explicit structured native codes and avoids object stringification", () => {
    const native = {
      code: "ai_context_limit",
      message: "Provider returned invalid request",
      status: 400,
    };
    const result = toAppError(native, "send_chat_message");
    expect(result.code).toBe("ai_context_limit");
    expect(result.technicalDetails).toContain(
      "Provider returned invalid request",
    );
    expect(result.technicalDetails).not.toContain("[object Object]");
    const serialized = toAppError(JSON.stringify(native));
    expect(serialized.code).toBe("ai_context_limit");
  });

  it("uses context-specific fallback without exposing provider or source text as the main message", () => {
    const native = {
      message: "Unexpected native condition",
      sources: [
        {
          path: "Secure/account.md",
          content: "SOURCE-CONTENT-MUST-NOT-BE-ECHOED",
        },
      ],
      prompt: "USER-PROMPT-MUST-NOT-BE-ECHOED",
      body: { messages: [{ content: "REQUEST-PAYLOAD-MUST-NOT-BE-ECHOED" }] },
    };
    const result = toAppError(native, "prepare_assistant_sources");
    expect(result.code).toBe("unknown");
    expect(result.title).toBe("Source could not be included");
    expect(result.message).not.toContain("Unexpected native condition");
    expect(result.technicalDetails).toContain("Unexpected native condition");
    expect(JSON.stringify(result)).not.toContain("MUST-NOT-BE-ECHOED");
    expect(toAppError("Unexpected native condition", "list_chats").title).toBe(
      "Conversations could not be opened",
    );
    expect(toAppError("Unexpected native condition", "response").title).toBe(
      "Assistant request failed",
    );
    const archive = toAppError(
      "Unexpected native condition",
      "set_chat_archived",
    );
    expect(archive.title).toBe("Chat archive could not be updated");
    expect(archive.category).toBe("Workspace");
    expect(archive.action).toContain("saved messages are preserved");
  });

  it("filters embedded JSON request payloads from technical diagnostics too", () => {
    const result = toAppError(
      'AI endpoint returned an error (HTTP 400). {"error":{"message":"Invalid parameter","request":{"content":"PRIVATE-SOURCE-CONTENT"}},"prompt":"PRIVATE-PROMPT"}',
    );
    expect(result.technicalDetails).toContain("Invalid parameter");
    expect(result.technicalDetails).not.toContain("PRIVATE-");
  });

  it("preserves typed errors across multiple API and UI boundaries", () => {
    const first = toAppError("database is locked", "get_chat");
    expect(toAppError(first, "history")).toBe(first);
    const generic = new AppError("unknown", "An unfamiliar error");
    expect(toAppError(generic, "sources").title).toBe(
      "Source could not be included",
    );
  });

  it("bounds diagnostic output and supports errors without useful fields", () => {
    expect(toAppError("x".repeat(5000)).technicalDetails).toHaveLength(2400);
    expect(toAppError({ prompt: "sensitive" }).technicalDetails).not.toContain(
      "sensitive",
    );
    expect(toAppError(null).code).toBe("unknown");
  });
});
