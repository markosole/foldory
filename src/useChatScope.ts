import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, desktop } from "./api";
import type { ChatSummary, ChatThread } from "./types";
import { toAppError, type AppError } from "./errors";

export function useChatScope(projectId: string | null) {
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [thread, setThread] = useState<ChatThread | null>(null);
  const [loading, setLoading] = useState(desktop);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [errorInfo, setErrorInfo] = useState<AppError | null>(null);
  const errorOrigin = useRef<"history" | "operation" | null>(null);
  const request = useRef(0);
  const operationInProgress = useRef(false);
  const mounted = useRef(false);

  const refresh = useCallback(async () => {
    const id = ++request.current;
    try {
      const latest = await api.listChats(projectId);
      if (id !== request.current) return;
      setChats(latest);
      // Activity order and the selected conversation are independent. Background
      // updates must not move the reader into the most recently updated chat.
      const selected =
        latest.find((chat) => chat.active) ??
        latest.find((chat) => !chat.archived);
      const next = selected ? await api.getChat(selected.id, projectId) : null;
      if (id === request.current) {
        setThread(next);
        if (errorOrigin.current === "history") {
          setError("");
          setErrorInfo(null);
          errorOrigin.current = null;
        }
      }
    } catch (cause) {
      if (id === request.current && errorOrigin.current !== "operation") {
        const detail = toAppError(cause, "list_chats");
        setError(detail.message);
        setErrorInfo(detail);
        errorOrigin.current = "history";
      }
    } finally {
      if (id === request.current) setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    if (!desktop) return;
    mounted.current = true;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<{ projectId: string | null; chatId: string }>(
      "assistant-changed",
      ({ payload }) => {
        if (!disposed && payload.projectId === projectId) void refresh();
      },
    )
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch((cause) => {
        if (!disposed) {
          const detail = toAppError(cause, "list_chats");
          setError(detail.message);
          setErrorInfo(detail);
          errorOrigin.current = "history";
        }
      })
      .finally(() => {
        if (!disposed) void refresh();
      });
    return () => {
      disposed = true;
      mounted.current = false;
      ++request.current;
      unlisten?.();
    };
  }, [projectId, refresh]);

  async function run(operation: () => Promise<unknown>, command = "assistant") {
    if (operationInProgress.current) return false;
    operationInProgress.current = true;
    setBusy(true);
    setError("");
    setErrorInfo(null);
    errorOrigin.current = null;
    try {
      await operation();
      if (mounted.current) await refresh();
      return true;
    } catch (cause) {
      if (mounted.current) {
        const detail = toAppError(cause, command);
        setError(detail.message);
        setErrorInfo(detail);
        errorOrigin.current = "operation";
      }
      return false;
    } finally {
      operationInProgress.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  return {
    chats,
    thread,
    loading,
    busy,
    error,
    ...(errorInfo ? { errorInfo } : {}),
    create: () => run(() => api.createChat(projectId), "create_chat"),
    open: (chatId: string) =>
      run(() => api.openChat(chatId, projectId), "open_chat"),
    setArchived: (chatId: string, archived: boolean) =>
      run(
        () => api.setChatArchived(chatId, projectId, archived),
        "set_chat_archived",
      ),
    send: (
      prompt: string,
      includeOverview: boolean,
      sourceIds: string[] = [],
      scopeProjectIds: string[] = [],
    ) =>
      run(async () => {
        const chat = thread?.chat ?? (await api.createChat(projectId));
        await api.sendChatMessage(
          chat.id,
          projectId,
          prompt,
          includeOverview,
          sourceIds,
          scopeProjectIds,
        );
      }, "send_chat_message"),
    stop: (chatId: string) =>
      run(() => api.stopChat(chatId, projectId), "stop_chat"),
    remove: (chatId: string) =>
      run(() => api.deleteChat(chatId, projectId), "delete_chat"),
    removeMessage: (chatId: string, messageId: string) =>
      run(
        () => api.deleteChatMessage(chatId, projectId, messageId),
        "delete_chat_message",
      ),
    decideAction: (chatId: string, actionId: string, approve: boolean) =>
      run(async () => {
        if (!projectId)
          throw new Error("Open the project to approve its file changes.");
        await api.decideAssistantAction(projectId, chatId, actionId, approve);
      }, "decide_assistant_action"),
  };
}

export type ChatScope = ReturnType<typeof useChatScope>;
