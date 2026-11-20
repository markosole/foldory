import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "./api";
import { toAppError } from "./errors";
import { useChatScope } from "./useChatScope";
import type { ChatSummary, ChatThread } from "./types";

let emitChange: (event: {
  payload: { projectId: string; chatId: string };
}) => void;
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (_name, callback) => {
    emitChange = callback;
    return vi.fn();
  }),
}));
vi.mock("./api", () => ({
  desktop: true,
  api: {
    listChats: vi.fn(),
    getChat: vi.fn(),
    openChat: vi.fn(),
    setChatArchived: vi.fn(),
    sendChatMessage: vi.fn(),
    createChat: vi.fn(),
    decideAssistantAction: vi.fn(),
  },
}));
const chat: ChatSummary = {
  id: "chat",
  projectId: "project",
  title: "Conversation",
  updatedAt: 1,
  pending: false,
  archived: false,
  active: true,
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.listChats).mockResolvedValue([chat]);
  vi.mocked(api.getChat).mockResolvedValue({ chat, messages: [] });
});
afterEach(cleanup);

it("sends a file decision to its project and refreshes the saved action without changing access", async () => {
  vi.mocked(api.decideAssistantAction).mockResolvedValue({
    id: "action",
    projectId: "project",
    chatId: "chat",
    messageId: "response",
    path: "summary.md",
    status: "applied",
    content: "Saved",
    beforeContent: null,
    expectedRevision: null,
    reason: "Approved once",
    error: null,
    createdAt: 1,
  });
  const { result } = renderHook(() => useChatScope("project"));
  await waitFor(() => expect(result.current.thread?.chat.id).toBe("chat"));
  let accepted: boolean | undefined;
  await act(async () => {
    accepted = await result.current.decideAction("chat", "action", true);
  });
  expect(accepted).toBe(true);
  expect(api.decideAssistantAction).toHaveBeenCalledWith(
    "project",
    "chat",
    "action",
    true,
  );
  expect(api.listChats).toHaveBeenCalledTimes(2);
  expect(api.getChat).toHaveBeenCalledTimes(2);
});

it("keeps a typed send failure until explicit retry, without automatic duplicate sending", async () => {
  vi.mocked(api.sendChatMessage)
    .mockRejectedValueOnce(
      toAppError(
        { code: "SQLITE_BUSY", message: "database is locked" },
        "send_chat_message",
      ),
    )
    .mockResolvedValue({ chat, messages: [] });
  const { result } = renderHook(() => useChatScope("project"));
  await waitFor(() => expect(result.current.thread?.chat.id).toBe("chat"));
  let accepted: boolean | undefined;
  await act(async () => {
    accepted = await result.current.send("Keep my draft", false, ["source-id"]);
  });
  expect(accepted).toBe(false);
  expect(result.current.errorInfo?.code).toBe("database_busy");
  await act(async () => {
    emitChange({ payload: { projectId: "project", chatId: "chat" } });
  });
  await waitFor(() => expect(api.listChats).toHaveBeenCalledTimes(2));
  expect(result.current.errorInfo?.code).toBe("database_busy");
  expect(api.sendChatMessage).toHaveBeenCalledTimes(1);
  await act(async () => {
    accepted = await result.current.send("Keep my draft", false, ["source-id"]);
  });
  expect(accepted).toBe(true);
  expect(result.current.errorInfo).toBeUndefined();
  expect(result.current.error).toBe("");
  expect(api.sendChatMessage).toHaveBeenCalledTimes(2);
});

it("clears a temporary history error once history can load again", async () => {
  vi.mocked(api.listChats).mockRejectedValueOnce(
    new Error("database is locked"),
  );
  const { result } = renderHook(() => useChatScope("project"));
  await waitFor(() =>
    expect(result.current.errorInfo?.code).toBe("database_busy"),
  );
  await act(async () => {
    emitChange({ payload: { projectId: "project", chatId: "chat" } });
  });
  await waitFor(() => expect(result.current.thread?.chat.id).toBe("chat"));
  expect(result.current.error).toBe("");
  expect(result.current.errorInfo).toBeUndefined();
});

function conversation(
  id: string,
  updatedAt: number,
  options: Partial<ChatSummary> = {},
): ChatSummary {
  return { ...chat, id, title: id, updatedAt, active: false, ...options };
}

function mockConversations(initial: ChatSummary[]) {
  let saved = initial;
  vi.mocked(api.listChats).mockImplementation(async () => saved);
  vi.mocked(api.getChat).mockImplementation(async (id) => ({
    chat: saved.find((item) => item.id === id)!,
    messages: [],
  }));
  vi.mocked(api.openChat).mockImplementation(async (id) => {
    saved = saved.map((item) => ({ ...item, active: item.id === id }));
    return { chat: saved.find((item) => item.id === id)!, messages: [] };
  });
  vi.mocked(api.setChatArchived).mockImplementation(
    async (id, _projectId, archived) => {
      const current = saved.find((item) => item.id === id)!;
      const nextActive =
        archived && current.active
          ? saved.find((item) => item.id !== id && !item.archived)?.id
          : saved.find((item) => item.active)?.id;
      saved = saved.map((item) => ({
        ...item,
        archived: item.id === id ? archived : item.archived,
        active: item.id === nextActive,
      }));
      return saved.find((item) => item.id === id)!;
    },
  );
  return {
    read: () => saved,
    update: (next: ChatSummary[]) => {
      saved = next;
    },
  };
}

it("opens the native active conversation even when it is not first in activity order", async () => {
  const latest = conversation("newest", 100);
  const selected = conversation("selected-older", 20, { active: true });
  const saved = mockConversations([latest, selected]);
  const { result } = renderHook(() => useChatScope("project"));
  await waitFor(() =>
    expect(result.current.thread?.chat.id).toBe("selected-older"),
  );
  expect(result.current.chats.map((item) => item.id)).toEqual([
    "newest",
    "selected-older",
  ]);
  expect(api.getChat).toHaveBeenCalledExactlyOnceWith(
    "selected-older",
    "project",
  );

  saved.update([{ ...latest, updatedAt: 120, pending: true }, selected]);
  await act(async () => {
    emitChange({ payload: { projectId: "project", chatId: "newest" } });
  });
  await waitFor(() => expect(api.getChat).toHaveBeenCalledTimes(2));
  expect(result.current.thread?.chat.id).toBe("selected-older");
});

it("opening an older chat changes selection without moving it ahead of newer activity", async () => {
  const latest = conversation("newest", 100, { active: true });
  const older = conversation("older", 10);
  mockConversations([latest, older]);
  const { result } = renderHook(() => useChatScope("project"));
  await waitFor(() => expect(result.current.thread?.chat.id).toBe("newest"));
  await act(async () => {
    expect(await result.current.open("older")).toBe(true);
  });
  expect(api.openChat).toHaveBeenCalledWith("older", "project");
  expect(result.current.thread?.chat.id).toBe("older");
  expect(result.current.chats.map((item) => [item.id, item.updatedAt])).toEqual(
    [
      ["newest", 100],
      ["older", 10],
    ],
  );
});

it("archiving the selected chat follows native fallback and clears the thread when no unarchived chat remains", async () => {
  const latest = conversation("newest", 100, { active: true });
  const older = conversation("older", 10);
  mockConversations([latest, older]);
  const { result } = renderHook(() => useChatScope("project"));
  await waitFor(() => expect(result.current.thread?.chat.id).toBe("newest"));
  await act(async () => {
    expect(await result.current.setArchived("newest", true)).toBe(true);
  });
  expect(api.setChatArchived).toHaveBeenLastCalledWith(
    "newest",
    "project",
    true,
  );
  expect(result.current.thread?.chat.id).toBe("older");
  expect(
    result.current.chats.find((item) => item.id === "newest")?.archived,
  ).toBe(true);
  expect(result.current.chats[0].updatedAt).toBe(100);
  await act(async () => {
    expect(await result.current.setArchived("older", true)).toBe(true);
  });
  expect(result.current.thread).toBeNull();
  expect(result.current.chats).toHaveLength(2);
  expect(
    result.current.chats.every((item) => item.archived && !item.active),
  ).toBe(true);
});

it("allows explicit selection of an archived conversation and keeps it selected when restored", async () => {
  const latest = conversation("newest", 100, { active: true });
  const archived = conversation("archived", 10, { archived: true });
  mockConversations([latest, archived]);
  const { result } = renderHook(() => useChatScope("project"));
  await waitFor(() => expect(result.current.thread?.chat.id).toBe("newest"));
  await act(async () => {
    expect(await result.current.open("archived")).toBe(true);
  });
  expect(result.current.thread?.chat.id).toBe("archived");
  expect(result.current.thread?.chat.archived).toBe(true);
  await act(async () => {
    expect(await result.current.setArchived("archived", false)).toBe(true);
  });
  expect(api.setChatArchived).toHaveBeenLastCalledWith(
    "archived",
    "project",
    false,
  );
  expect(result.current.thread?.chat.id).toBe("archived");
  expect(result.current.thread?.chat.archived).toBe(false);
  expect(result.current.chats.map((item) => item.id)).toEqual([
    "newest",
    "archived",
  ]);
});

it("falls back only to an unarchived conversation when native selection is absent", async () => {
  mockConversations([
    conversation("archived-newest", 100, { archived: true }),
    conversation("unarchived", 10),
  ]);
  const { result } = renderHook(() => useChatScope("project"));
  await waitFor(() =>
    expect(result.current.thread?.chat.id).toBe("unarchived"),
  );
  expect(api.getChat).toHaveBeenCalledExactlyOnceWith("unarchived", "project");
});

it("does not open an archived conversation implicitly when no selection or unarchived chat exists", async () => {
  mockConversations([conversation("archived", 100, { archived: true })]);
  const { result } = renderHook(() => useChatScope("project"));
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.thread).toBeNull();
  expect(api.getChat).not.toHaveBeenCalled();
});

it("keeps typed archive failures visible across unrelated events without retrying automatically", async () => {
  mockConversations([chat]);
  vi.mocked(api.setChatArchived).mockRejectedValueOnce({
    code: "database_busy",
    message: "database is locked",
  });
  const { result } = renderHook(() => useChatScope("project"));
  await waitFor(() => expect(result.current.thread?.chat.id).toBe("chat"));
  await act(async () => {
    expect(await result.current.setArchived("chat", true)).toBe(false);
  });
  expect(result.current.errorInfo?.code).toBe("database_busy");
  expect(result.current.errorInfo?.operation).toBe("set_chat_archived");
  expect(result.current.thread?.chat.archived).toBe(false);
  await act(async () => {
    emitChange({ payload: { projectId: "project", chatId: "unrelated" } });
  });
  await waitFor(() => expect(api.listChats).toHaveBeenCalledTimes(2));
  expect(result.current.errorInfo?.code).toBe("database_busy");
  expect(api.setChatArchived).toHaveBeenCalledTimes(1);
});

it("ignores an older in-flight thread refresh after the user opens a different conversation", async () => {
  const latest = conversation("newest", 100, { active: true });
  const older = conversation("older", 10);
  mockConversations([latest, older]);
  const { result } = renderHook(() => useChatScope("project"));
  await waitFor(() => expect(result.current.thread?.chat.id).toBe("newest"));
  let finishStale: ((thread: ChatThread) => void) | undefined;
  vi.mocked(api.getChat).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishStale = resolve;
      }),
  );
  await act(async () => {
    emitChange({ payload: { projectId: "project", chatId: "newest" } });
  });
  await waitFor(() => expect(finishStale).toBeDefined());
  await act(async () => {
    expect(await result.current.open("older")).toBe(true);
  });
  expect(result.current.thread?.chat.id).toBe("older");
  await act(async () => {
    finishStale?.({ chat: latest, messages: [] });
  });
  expect(result.current.thread?.chat.id).toBe("older");
});
