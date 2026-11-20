import { invoke } from "@tauri-apps/api/core";
import { beforeEach, expect, it, vi } from "vitest";
import { call } from "./api";
import { AppError } from "./errors";

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => true,
  invoke: vi.fn(),
}));
beforeEach(() => vi.clearAllMocks());

it("preserves structured database errors for Assistant error cards", async () => {
  vi.mocked(invoke).mockRejectedValue({
    code: "SQLITE_BUSY",
    message: "database is locked",
  });
  await expect(call("send_chat_message")).rejects.toMatchObject({
    code: "database_busy",
    title: "Workspace database busy",
    technicalDetails: expect.stringContaining("database is locked"),
  });
});

it("classifies provider errors without losing their technical detail", async () => {
  vi.mocked(invoke).mockRejectedValue(
    "AI endpoint returned an error (HTTP 400). No model loaded.",
  );
  await expect(call("ai_provider_catalog")).rejects.toMatchObject({
    code: "ai_model_unavailable",
    title: "No AI model loaded",
  });
});

it("keeps precise validation messages in other views such as file save conflicts", async () => {
  const message =
    "This file changed on disk. Reload it before saving, or review the conflict.";
  vi.mocked(invoke).mockRejectedValue(message);
  let failure: unknown;
  try {
    await call("write_file");
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
  expect(failure).not.toBeInstanceOf(AppError);
  expect((failure as Error).message).toBe(message);
});
