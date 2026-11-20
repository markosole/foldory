import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import type {
  ChatMessage,
  ChatSummary,
  ChatThread,
  FileEntry,
  FileOperationRequest,
  Settings,
} from "../src/types";

// Real UI/layout, isolated data and intercepted IPC: no user projects or AI services are accessed.
async function openFixture(page: Page) {
  await page.addInitScript(() => {
    const project = {
      id: "p0",
      sourceId: "source",
      path: "D:\\Projects\\Fixture Project",
      name: "Fixture Project",
      alias: "",
      client: "Test client",
      tags: [],
      color: "#83a9ff",
      pinned: false,
      hidden: false,
      lastOpened: 0,
      modifiedAt: 0,
      available: true,
    };
    const data = {
      sources: [
        {
          id: "source",
          name: "Projects",
          path: "D:\\Projects",
          available: true,
          connected: true,
        },
      ],
      projects: [
        project,
        ...Array.from({ length: 100 }, (_, i) => ({
          ...project,
          id: `p${i + 1}`,
          name: `Project ${i + 1}`,
          path: `D:\\Projects\\Project ${i + 1}`,
        })),
      ],
      templates: [
        { id: "default", name: "Standard", directories: [], files: [] },
      ],
      settings: JSON.parse(
        sessionStorage.getItem("fixture-settings") ?? "null",
      ) ?? {
        tools: [],
        aiBaseUrl: "http://127.0.0.1:1234/v1",
        aiModel: "fixture",
        aiHasKey: false,
        scanIntervalSeconds: 60,
        inspector: {
          outputTokens: 4096,
          timeoutMinutes: 5,
          defaultProfileId: "overview",
          profiles: [
            {
              id: "overview",
              name: "Overview",
              prompt: "Summarise.",
              templates: [],
            },
            {
              id: "handover",
              name: "Handover",
              prompt: "Write a handover.",
              templates: [],
            },
          ],
        },
      },
      indexStatus: {
        running: false,
        files: 10,
        projects: 101,
        lastIndexed: 0,
        message: "",
      },
    };
    const calls: { command: string; args: Record<string, unknown> }[] = [];
    const preferences = JSON.parse(
      sessionStorage.getItem("fixture-ai") ?? "null",
    ) ?? {
      preferredLocalModels: [],
      selections: {},
    };
    const threads = new Map<string, ChatThread>(
      JSON.parse(sessionStorage.getItem("fixture-chats") ?? "[]"),
    );
    const accessModes = new Map<string, "readOnly" | "write" | "full">();
    const writtenFiles = new Map<string, string>(
      JSON.parse(sessionStorage.getItem("fixture-files") ?? "[]"),
    );
    let fixtureClipboard = "";
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          fixtureClipboard = text;
        },
        readText: async () => fixtureClipboard,
      },
    });
    const active = new Map<string | null, string>(
      JSON.parse(sessionStorage.getItem("fixture-active-chats") ?? "[]"),
    );
    const callbacks = new Map<number, (event: unknown) => void>();
    const listeners = new Map<number, { event: string; handler: number }>();
    const approvals = new Map<
      string,
      { paths: string[]; kind: "excluded" | "credentials" }
    >();
    let nextId = Number(sessionStorage.getItem("fixture-chat-sequence") ?? "0");
    function selectFallback(projectId: string | null) {
      const next = Array.from(threads.values())
        .filter(({ chat }) => chat.projectId === projectId && !chat.archived)
        .sort((a, b) => b.chat.updatedAt - a.chat.updatedAt)[0];
      if (next) active.set(projectId, next.chat.id);
      else active.delete(projectId);
    }
    function persistChats() {
      for (const { chat } of threads.values())
        chat.active = active.get(chat.projectId) === chat.id;
      sessionStorage.setItem(
        "fixture-chats",
        JSON.stringify(Array.from(threads.entries())),
      );
      sessionStorage.setItem(
        "fixture-active-chats",
        JSON.stringify(Array.from(active.entries())),
      );
      sessionStorage.setItem("fixture-chat-sequence", String(nextId));
    }
    function emitChatChanged(thread: ChatThread) {
      persistChats();
      const event = "assistant-changed";
      const { id: chatId, projectId } = thread.chat;
      for (const [id, listener] of listeners) {
        if (listener.event === event)
          callbacks.get(listener.handler)?.({
            event,
            id,
            payload: { chatId, projectId },
          });
      }
    }
    Object.assign(window, {
      isTauri: true,
      fixtureCalls: calls,
      fixtureRefreshChat: (chatId: string) => {
        const thread = threads.get(chatId);
        if (thread) emitChatChanged(thread);
      },
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
      __TAURI_INTERNALS__: {
        metadata: { currentWindow: { label: "main" } },
        transformCallback: (callback: (event: unknown) => void) => {
          callbacks.set(++nextId, callback);
          return nextId;
        },
        invoke: async (command: string, args: Record<string, unknown> = {}) => {
          calls.push({ command, args });
          if (command === "plugin:event|listen") {
            listeners.set(++nextId, {
              event: String(args.event),
              handler: Number(args.handler),
            });
            return nextId;
          }
          if (command === "plugin:event|unlisten") {
            const id = Number(args.eventId);
            const listener = listeners.get(id);
            if (listener) callbacks.delete(listener.handler);
            listeners.delete(id);
            return null;
          }
          if (command.startsWith("plugin:")) return 1;
          if (command === "bootstrap") return structuredClone(data);
          if (command === "get_assistant_access")
            return {
              mode: accessModes.get(String(args.projectId)) ?? "readOnly",
            };
          if (command === "set_assistant_access") {
            accessModes.set(
              String(args.projectId),
              args.mode as "readOnly" | "write" | "full",
            );
            return { mode: args.mode };
          }
          if (command === "detect_supported_tools")
            return {
              cursor: { desktop: true, cli: false },
              claude: { desktop: false, cli: true },
              codex: { desktop: true, cli: true },
            };
          if (command === "save_settings") {
            data.settings = structuredClone(args.settings as Settings);
            sessionStorage.setItem(
              "fixture-settings",
              JSON.stringify(data.settings),
            );
            return structuredClone(data.settings);
          }
          if (command === "save_ai_key") {
            if (args.key === "fixture-rejected-key")
              throw new Error("Fixture credential storage unavailable");
            const endpoint = data.settings.aiProviders?.find(
              (entry) => entry.provider === args.provider,
            );
            if (endpoint) endpoint.hasKey = !!args.key;
            if (args.provider === "local") data.settings.aiHasKey = !!args.key;
            sessionStorage.setItem(
              "fixture-settings",
              JSON.stringify(data.settings),
            );
            return null;
          }
          if (command === "test_ai_provider")
            return "Cursor replied successfully using Auto. No project content was sent.";
          if (command === "ai_preferences") return structuredClone(preferences);
          if (command === "set_ai_selection") {
            preferences.selections[String(args.mode)] = args.choice;
            sessionStorage.setItem("fixture-ai", JSON.stringify(preferences));
            return structuredClone(preferences);
          }
          if (command === "save_preferred_local_models") {
            preferences.preferredModels ??= {};
            preferences.preferredModels[String(args.provider)] = args.models;
            if (args.provider === "local")
              preferences.preferredLocalModels = args.models;
            sessionStorage.setItem("fixture-ai", JSON.stringify(preferences));
            return structuredClone(preferences);
          }
          if (command === "ai_provider_catalog") {
            const models = {
              local: [{ id: "local-alternate", label: "local-alternate" }],
              codex: [{ id: "codex-fixture", label: "Codex fixture model" }],
              cursor: [
                { id: "cursor-fixture", label: "Cursor fixture model" },
                ...Array.from({ length: 240 }, (_, index) => ({
                  id: `cursor-${index}`,
                  label: `Cursor model ${index}`,
                })),
              ],
              claude: [],
            };
            return {
              connection: "ready",
              models: models[args.provider as keyof typeof models] ?? [
                {
                  id: `${args.provider}-fixture`,
                  label: `${args.provider} fixture model`,
                },
              ],
              detail: null,
            };
          }
          if (command === "get_inspector_write_access") return false;
          if (command === "prepare_inspector_context") {
            return {
              id: "fixture-context",
              destination: "Local fixture",
              inputBytes: 128,
              budgetBytes: 32768,
              outputTokens: 4096,
              systemPrompt: "Draft a project overview.",
              prompt: "Exact fixture payload",
              tree: ["docs/README.md"],
              documents: [
                {
                  path: "docs/README.md",
                  content: "# Local evidence",
                  truncated: false,
                  approved: false,
                },
              ],
              coverage: {
                visited: 4,
                excluded: 2,
                withheldDocuments: 0,
                redactedDocuments: 0,
                omittedDocuments: 0,
                omittedPaths: 0,
                traversalLimited: false,
              },
            };
          }
          if (command === "discard_inspector_context") return null;
          if (command === "draft_project_overview") {
            return {
              content:
                "# Reviewed project\n\n[Sample link](https://example.invalid/)\n\n![Image](https://example.invalid/image.png)",
              revision: null,
              writeBlocked: null,
            };
          }
          if (command === "list_directory") {
            const entry = (
              path: string,
              directory = false,
              aiExcluded = false,
            ) => ({
              path,
              name: path.split("/").pop(),
              directory,
              aiExcluded,
              aiExclusionReason: aiExcluded
                ? "Private workspace folders"
                : undefined,
              size: 40,
              modifiedAt: 0,
            });
            const folders: Record<string, ReturnType<typeof entry>[]> = {
              "": [
                entry("Docs", true),
                entry("Notes", true),
                entry("Secure", true, true),
                entry("amounts.csv"),
                entry("example.docx"),
              ],
              Docs: [entry("Docs/first.md"), entry("Docs/second.md")],
              Secure: [entry("Secure/private.md", false, true)],
            };
            const entries = [...(folders[String(args.path)] ?? [])];
            for (const path of writtenFiles.keys()) {
              if (
                path.split("/").slice(0, -1).join("/") === args.path &&
                !entries.some((item) => item.path === path)
              )
                entries.push(entry(path));
            }
            return entries;
          }
          if (command === "prepare_assistant_sources") {
            if (
              (args.paths as string[]).some((path) =>
                path.startsWith("Secure"),
              ) &&
              accessModes.get(String(args.projectId)) !== "full"
            ) {
              const id = `approval-${++nextId}`;
              approvals.set(id, {
                paths: args.paths as string[],
                kind: "excluded",
              });
              return {
                status: "approvalRequired",
                approval: {
                  id,
                  kind: "excluded",
                  paths: ["Secure", "Secure/private.md"],
                  totalPaths: 2,
                },
              };
            }
            return {
              status: "ready",
              sources: (args.paths as string[]).map((path, i) => ({
                id: `source-${i}-${path}`,
                path,
                directory: path === "Docs",
                fileCount: path === "Docs" ? 2 : 1,
                files:
                  path === "Docs"
                    ? ["Docs/first.md", "Docs/second.md"]
                    : [path],
                warnings: [],
              })),
            };
          }
          if (command === "approve_assistant_sources") {
            const pending = approvals.get(String(args.approvalId));
            if (!pending) throw new Error("Source approval expired.");
            approvals.delete(String(args.approvalId));
            if (!args.allow) return { status: "cancelled" };
            if (pending.kind === "excluded") {
              const id = `approval-${++nextId}`;
              approvals.set(id, { ...pending, kind: "credentials" });
              return {
                status: "approvalRequired",
                approval: {
                  id,
                  kind: "credentials",
                  paths: ["Secure/private.md"],
                  totalPaths: 1,
                },
              };
            }
            return {
              status: "ready",
              sources: pending.paths.map((path, i) => ({
                id: `source-${i}-${path}`,
                path,
                directory: true,
                fileCount: 1,
                files: ["Secure/private.md"],
                warnings: [],
              })),
            };
          }
          if (command === "discard_assistant_sources") return null;
          if (command === "examine_file")
            return {
              path: args.path,
              format: String(args.path).endsWith("docx") ? "docx" : "csv",
              content: String(args.path).endsWith("docx")
                ? "# Example document\n\nDocument content."
                : 'CSV records, in original order.\nRow 1: ["Status","Billed"]\nRow 2: ["Paid","120"]\nRow 3: ["Pending","80"]\n',
              warnings: [],
            };
          if (command === "read_file")
            return {
              path: args.path,
              content:
                writtenFiles.get(String(args.path)) ??
                "# Source document\n\nMarkdown file content.",
              revision: "fixture-revision",
            };
          if (command === "read_image") {
            const dataUrl = writtenFiles.get(String(args.path));
            if (!dataUrl?.startsWith("data:image/"))
              throw new Error("Fixture image is unavailable");
            return dataUrl;
          }
          if (command === "write_file") {
            writtenFiles.set(String(args.path), String(args.content));
            sessionStorage.setItem(
              "fixture-files",
              JSON.stringify([...writtenFiles]),
            );
            return {
              path: args.path,
              content: args.content,
              revision: "fixture-revision",
            };
          }
          if (command === "touch_project") {
            const p = data.projects.find((p) => p.id === args.id)!;
            p.lastOpened = Date.now();
            return { ...p };
          }
          if (command === "update_project") {
            const p = data.projects.find((p) => p.id === args.id)!;
            Object.assign(p, args.patch);
            return { ...p };
          }
          if (command === "launch_tool") return null;
          const projectId = (args.projectId ?? null) as string | null;
          const chatId = String(args.chatId);
          if (
            command === "list_integrations" ||
            command === "integration_catalog"
          )
            return [];
          if (command === "list_chats") {
            persistChats();
            return structuredClone(
              Array.from(threads.values(), ({ chat }) => chat)
                .filter((chat) => chat.projectId === projectId)
                .sort((a, b) => b.updatedAt - a.updatedAt),
            );
          }
          if (command === "create_chat") {
            const id = `chat-${++nextId}`;
            const thread: ChatThread = {
              chat: {
                id,
                projectId,
                title: "New conversation",
                updatedAt: Date.now(),
                pending: false,
                archived: false,
                active: true,
              },
              messages: [],
            };
            threads.set(id, thread);
            active.set(projectId, id);
            emitChatChanged(thread);
            return structuredClone(thread.chat);
          }
          const thread = threads.get(chatId);
          if (thread && thread.chat.projectId === projectId) {
            if (command === "get_chat") {
              persistChats();
              return structuredClone(thread);
            }
            if (command === "open_chat") {
              active.set(projectId, chatId);
              emitChatChanged(thread);
              return structuredClone(thread);
            }
            if (command === "send_chat_message") {
              if (thread.chat.archived)
                throw new Error(
                  "Restore this archived chat before sending a message.",
                );
              const fixtureWindow = window as unknown as {
                fixtureNextSendError?: unknown;
              };
              if (fixtureWindow.fixtureNextSendError) {
                const failure = fixtureWindow.fixtureNextSendError;
                delete fixtureWindow.fixtureNextSendError;
                throw failure;
              }
              const prompt = String(args.prompt);
              const createdAt = Date.now();
              if (thread.chat.pending) throw new Error("Chat already pending");
              if (thread.messages.length === 0) thread.chat.title = prompt;
              thread.chat.updatedAt = createdAt;
              thread.chat.pending = true;
              active.set(projectId, chatId);
              const reply: ChatMessage = {
                id: `message-${++nextId}`,
                role: "assistant",
                content: "",
                status: "pending",
                createdAt,
              };
              thread.messages.push(
                {
                  id: `message-${++nextId}`,
                  role: "user",
                  content: prompt,
                  status: "complete",
                  createdAt,
                },
                reply,
              );
              emitChatChanged(thread);
              if (prompt !== "Hold this request") {
                setTimeout(() => {
                  if (reply.status !== "pending") return;
                  reply.status = "complete";
                  reply.content =
                    prompt === "Long answer please"
                      ? Array.from(
                          { length: 150 },
                          (_, i) =>
                            `## Result ${i + 1}\n\nA paragraph for testing scroll containment.`,
                        ).join("\n\n")
                      : `Response to ${prompt}`;
                  if (prompt === "Model unavailable fixture") {
                    reply.status = "failed";
                    reply.content =
                      "AI endpoint returned an error (HTTP 400 Bad Request). No model loaded. Call POST /inference/load first. Or enable Model auto-switch (Settings > API) to load a requested model automatically.";
                  }
                  if (prompt === "Code sample fixture")
                    reply.content =
                      "Snippet content.\n\n```markdown\n# Prijedlog\n\nČitav sadržaj.\n```\n\n```javascript\nconst billed = 200;\n```\n\n" +
                      Array.from(
                        { length: 45 },
                        (_, i) =>
                          `Paragraph ${i + 1}: scroll through the response.`,
                      ).join("\n\n");
                  if (prompt.startsWith("Save proposal")) {
                    const mode = accessModes.get(projectId || "") ?? "readOnly";
                    const path = prompt.includes("Secure")
                      ? "Secure/Proposal.md"
                      : "Notes/Prijedlog.md";
                    const content =
                      "# Prijedlog\n\nSadržaj spremljen iz razgovora.\n";
                    const applied =
                      mode === "full" ||
                      (mode === "write" && !path.startsWith("Secure"));
                    reply.content = "Here is the proposed project file change.";
                    reply.actions = [
                      {
                        id: `action-${++nextId}`,
                        projectId: projectId!,
                        chatId,
                        messageId: reply.id,
                        path,
                        status: applied ? "applied" : "pending",
                        content,
                        beforeContent: writtenFiles.get(path) ?? null,
                        expectedRevision: writtenFiles.has(path)
                          ? "fixture-revision"
                          : null,
                        reason: applied
                          ? "Automatically approved by project access."
                          : "This file change needs approval.",
                        error: null,
                        createdAt,
                      },
                    ];
                    if (applied) writtenFiles.set(path, content);
                  }
                  thread.chat.pending = false;
                  emitChatChanged(thread);
                }, 300);
              }
              return structuredClone(thread);
            }
            if (command === "stop_chat") {
              const pending = thread.messages.find(
                (message) => message.status === "pending",
              );
              if (pending) pending.status = "stopped";
              thread.chat.pending = false;
              emitChatChanged(thread);
              return structuredClone(thread);
            }
            if (command === "decide_assistant_action") {
              if (thread.chat.archived)
                throw new Error(
                  "Restore this archived chat before deciding a file action.",
                );
              const action = thread.messages
                .flatMap((message) => message.actions ?? [])
                .find((action) => action.id === args.actionId);
              if (!action || action.status !== "pending")
                throw new Error("File action was already decided.");
              action.status = args.approve ? "applied" : "declined";
              if (args.approve) writtenFiles.set(action.path, action.content);
              emitChatChanged(thread);
              return structuredClone(action);
            }
            if (command === "delete_chat_message") {
              thread.messages = thread.messages.filter(
                (message) => message.id !== args.messageId,
              );
              emitChatChanged(thread);
              return null;
            }
            if (command === "delete_chat") {
              threads.delete(chatId);
              if (active.get(projectId) === chatId) selectFallback(projectId);
              emitChatChanged(thread);
              return null;
            }
            if (command === "set_chat_archived") {
              if (thread.chat.pending)
                throw new Error(
                  "Stop the pending request before changing this chat's archive state.",
                );
              thread.chat.archived = Boolean(args.archived);
              if (thread.chat.archived && active.get(projectId) === chatId)
                selectFallback(projectId);
              emitChatChanged(thread);
              return structuredClone(thread.chat);
            }
          }
          throw new Error(`Unexpected test command: ${command}`);
        },
      },
    });
  });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Your projects." }),
  ).toBeVisible();
}
const sidebarProject = (page: Page) =>
  page
    .getByRole("complementary", { name: "Project library" })
    .getByRole("button", { name: "Fixture Project", exact: true })
    .last();

test("file preferences save preview layout, fonts, editor defaults and session choices", async ({
  page,
}) => {
  await openFixture(page);
  await sidebarProject(page).click();
  await page.getByRole("button", { name: "Files", exact: true }).click();
  await page.getByRole("button", { name: "Expand Docs", exact: true }).click();
  await page.getByRole("button", { name: "first.md", exact: true }).click();
  async function preferences() {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page
      .getByRole("button", { name: "Files & editor", exact: true })
      .click();
  }
  async function choose(name: string, option: string) {
    await page.getByRole("combobox", { name, exact: true }).click();
    await page.getByRole("option", { name: option, exact: true }).click();
  }
  await preferences();
  await page
    .getByRole("checkbox", { name: /^Remember file positions and views/ })
    .uncheck();
  await choose("Default Markdown view", "Split");
  await choose("Editor font size", "16 px");
  await choose("Preview font size", "18 px");
  await choose("Preview layout", "Full width");
  await page
    .getByRole("checkbox", { name: "Wrap long lines by default", exact: true })
    .uncheck();
  await page
    .getByRole("checkbox", { name: "Show line numbers", exact: true })
    .uncheck();
  await page
    .getByRole("spinbutton", { name: "Boxed preview width (px)", exact: true })
    .fill("600");
  await page
    .getByRole("spinbutton", {
      name: "Full width side padding (px)",
      exact: true,
    })
    .fill("10");
  await page
    .getByRole("button", { name: "Save file preferences", exact: true })
    .click();
  await expect(
    page.getByText("Settings saved.", { exact: true }),
  ).toBeVisible();
  expect(
    (await calls(page, "save_settings")).at(-1)?.args.settings,
  ).toMatchObject({
    files: {
      previewLayout: "full",
      editorFontSize: 16,
      previewFontSize: 18,
      restoreOpenFiles: true,
      rememberPositions: false,
      previewWidth: 600,
      fullWidthPadding: 10,
    },
  });
  await page.screenshot({ path: "test-results/file-preferences.png" });
  await sidebarProject(page).click();
  await expect(
    page.getByRole("button", { name: "Split", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".cm-editor")).toHaveCSS("font-size", "16px");
  await expect(page.locator(".file-preview .markdown")).toHaveCSS(
    "font-size",
    "18px",
  );
  await expect(page.locator(".file-preview")).toHaveCSS("padding-left", "10px");
  await expect(page.locator(".cm-lineNumbers")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Text wrap", exact: true }),
  ).toHaveAttribute("aria-pressed", "false");
  await preferences();
  await choose("Default Markdown view", "Preview");
  await choose("Preview layout", "Boxed");
  await page
    .getByRole("button", { name: "Save file preferences", exact: true })
    .click();
  await expect(
    page.getByText("Settings saved.", { exact: true }),
  ).toBeVisible();
  await sidebarProject(page).click();
  await expect(page.locator(".file-preview")).toHaveClass(/preview-boxed/);
  await expect
    .poll(async () =>
      Math.round(
        (await page.locator(".file-preview > .markdown").boundingBox())!.width,
      ),
    )
    .toBe(600);
  await preferences();
  await page
    .getByRole("checkbox", { name: /^Restore open file tabs/ })
    .uncheck();
  await page
    .getByRole("button", { name: "Save file preferences", exact: true })
    .click();
  await expect(
    page.getByText("Settings saved.", { exact: true }),
  ).toBeVisible();
  await sidebarProject(page).click();
  await expect(page.getByRole("tab")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Collapse Docs", exact: true }),
  ).toBeVisible();
  await preferences();
  await page
    .getByRole("checkbox", { name: /^Remember project sessions/ })
    .uncheck();
  await expect(
    page.getByRole("checkbox", { name: /^Restore open file tabs/ }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "Save file preferences", exact: true })
    .click();
  await expect(
    page.getByText("Settings saved.", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await sidebarProject(page).click();
  await expect(
    page.getByRole("button", { name: "Overview", exact: true }),
  ).toHaveClass(/active/);
  await page.getByRole("button", { name: "Files", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Expand Docs", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("tab")).toHaveCount(0);
});

test("font zoom follows one open file, targets split panes and resets after closing", async ({
  page,
}) => {
  await openFixture(page);
  await sidebarProject(page).click();
  await page.getByRole("button", { name: "Files", exact: true }).click();
  await page.getByRole("button", { name: "Expand Docs", exact: true }).click();
  await page.getByRole("button", { name: "first.md", exact: true }).click();
  const markdown = page.locator(".file-preview .markdown");
  await expect(markdown).toHaveCSS("font-size", "13px");
  await page.keyboard.press("Control+=");
  await expect(markdown).toHaveCSS("font-size", "14px");
  await expect(
    page.getByRole("button", { name: "Reset zoom", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "second.md", exact: true }).click();
  await expect(markdown).toHaveCSS("font-size", "13px");
  await expect(
    page.getByRole("button", { name: "Reset zoom", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("tab", { name: "first.md", exact: true }).click();
  await expect(markdown).toHaveCSS("font-size", "14px");
  await page.getByRole("button", { name: "Assistant", exact: true }).click();
  await page.getByRole("button", { name: "Files", exact: true }).click();
  await expect(markdown).toHaveCSS("font-size", "14px");
  await page
    .getByRole("complementary", { name: "Project library" })
    .getByRole("button", { name: "Project 1", exact: true })
    .last()
    .click();
  await sidebarProject(page).click();
  await expect(markdown).toHaveCSS("font-size", "14px");
  await page
    .getByRole("button", { name: "Close Docs/first.md", exact: true })
    .click();
  await page.getByRole("button", { name: "first.md", exact: true }).click();
  await expect(markdown).toHaveCSS("font-size", "13px");
  await expect(
    page.getByRole("button", { name: "Reset zoom", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Split", exact: true }).click();
  const code = page.locator(".cm-editor");
  await expect(code).toHaveCSS("font-size", "12px");
  await page.getByLabel("File preview", { exact: true }).focus();
  await page.keyboard.press("Control+=");
  await expect(markdown).toHaveCSS("font-size", "14px");
  await expect(code).toHaveCSS("font-size", "12px");
  await page.locator(".cm-content").focus();
  await page.keyboard.press("Control+=");
  await expect(code).toHaveCSS("font-size", "13px");
  await page.keyboard.press("Control+0");
  await expect(code).toHaveCSS("font-size", "12px");
  await expect(markdown).toHaveCSS("font-size", "13px");
  for (let i = 0; i < 25; i++) await page.keyboard.press("Control+=");
  await expect(code).toHaveCSS("font-size", "46px");
  await expect(
    page.getByRole("button", {
      name: "Increase editor font size",
      exact: true,
    }),
  ).toBeDisabled();
  for (let i = 0; i < 25; i++) await page.keyboard.press("Control+-");
  await expect(code).toHaveCSS("font-size", "9px");
  await page.keyboard.press("Control+0");
  await expect(code).toHaveCSS("font-size", "12px");
  await page.screenshot({ path: "test-results/file-preview-zoom.png" });
});

test("PNG and JPEG previews browse sibling images with buttons and arrow keys", async ({
  page,
}) => {
  await openFixture(page);
  await page.evaluate(async () => {
    const ipc = (
      window as unknown as {
        __TAURI_INTERNALS__: {
          invoke: (
            command: string,
            args: Record<string, unknown>,
          ) => Promise<unknown>;
        };
      }
    ).__TAURI_INTERNALS__;
    const canvas = document.createElement("canvas");
    canvas.width = 1200;
    canvas.height = 800;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#384c67";
    context.fillRect(0, 0, 1200, 800);
    context.fillStyle = "#a1c9bc";
    context.fillRect(80, 100, 1040, 300);
    for (const path of [
      "Docs/landscape.png",
      "Docs/photo.JPG",
      "Docs/broken.png",
    ])
      await ipc.invoke("write_file", {
        projectId: "p0",
        path,
        content: path.includes("broken")
          ? "broken"
          : canvas.toDataURL(path.endsWith("JPG") ? "image/jpeg" : "image/png"),
      });
  });
  await sidebarProject(page).click();
  await page.getByRole("button", { name: "Files", exact: true }).click();
  await page.getByRole("button", { name: "Expand Docs", exact: true }).click();
  await page
    .getByRole("button", { name: "landscape.png", exact: true })
    .click();
  await expect(
    page.getByRole("img", { name: "landscape.png", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("1200 × 800 px", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Next image", exact: true }).click();
  await expect(
    page.getByRole("img", { name: "photo.JPG", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("tab")).toHaveCount(1);
  await page.keyboard.press("ArrowLeft");
  await expect(
    page.getByRole("img", { name: "landscape.png", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("ArrowRight");
  await expect(
    page.getByRole("img", { name: "photo.JPG", exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: "test-results/image-preview.png" });
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("alert")).toContainText(
    "Fixture image is unavailable",
  );
  await page
    .getByRole("button", { name: "Previous image", exact: true })
    .click();
  await expect(
    page.getByRole("img", { name: "photo.JPG", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "first.md", exact: true }).click();
  await expect(page.getByRole("tab")).toHaveCount(2);
  await page.getByRole("tab", { name: "photo.JPG", exact: true }).click();
  await expect(
    page.getByRole("img", { name: "photo.JPG", exact: true }),
  ).toBeVisible();
  expect(
    (await calls(page, "read_file")).some((call) =>
      /\.(png|jpe?g)$/i.test(String(call.args.path)),
    ),
  ).toBe(false);
});

test("file tabs restore folders, active file and positions across views, projects and reload", async ({
  page,
}) => {
  await openFixture(page);
  await page.evaluate(async () => {
    const ipc = (
      window as unknown as {
        __TAURI_INTERNALS__: {
          invoke: (
            command: string,
            args: Record<string, unknown>,
          ) => Promise<unknown>;
        };
      }
    ).__TAURI_INTERNALS__;
    await ipc.invoke("write_file", {
      projectId: "p0",
      path: "Docs/first.md",
      content: Array.from(
        { length: 60 },
        (_, i) =>
          `## Section ${i}\n\nParagraph ${i} with enough text to scroll.\n`,
      ).join("\n"),
    });
  });
  await sidebarProject(page).click();
  await page.getByRole("button", { name: "Files", exact: true }).click();
  await page.getByRole("button", { name: "Expand Docs", exact: true }).click();
  await page.getByRole("button", { name: "first.md", exact: true }).click();
  const preview = page.locator(".file-panel .preview-pane");
  await expect(preview).toContainText("Section 59");
  await preview.evaluate((node) => {
    node.scrollTop = 700;
  });
  await expect.poll(() => preview.evaluate((node) => node.scrollTop)).toBe(700);
  await page.getByRole("button", { name: "second.md", exact: true }).click();
  await expect(page.getByRole("tab")).toHaveCount(2);
  await page.getByRole("tab", { name: "first.md", exact: true }).click();
  await expect.poll(() => preview.evaluate((node) => node.scrollTop)).toBe(700);
  await page.getByRole("button", { name: "Assistant", exact: true }).click();
  await page.getByRole("button", { name: "Files", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Collapse Docs", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("tab", { name: "first.md", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect.poll(() => preview.evaluate((node) => node.scrollTop)).toBe(700);

  // Folder navigation must preserve the expansion state of the root tree.
  await page.getByRole("button", { name: "Notes", exact: true }).click();
  await page.getByRole("button", { name: "Project root", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Collapse Docs", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "amounts.csv", exact: true }).click();
  await expect(page.getByRole("tab")).toHaveCount(3);
  await page.getByRole("tab", { name: "first.md", exact: true }).click();
  await page.getByRole("button", { name: "Split", exact: true }).click();
  const code = page.locator(".cm-content");
  await expect(code).toBeVisible();
  // Place a cursor and scroll the source independently of the preview.
  await code.click();
  await code.press("Control+Home");
  await code.press("ArrowRight");
  await code.press("ArrowRight");
  // Let CodeMirror finish scrolling the caret into view before scrolling away.
  await code.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await page.locator(".cm-scroller").evaluate((node) => {
    node.scrollTop = 450;
  });
  await preview.evaluate((node) => {
    node.scrollTop = 900;
  });
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          JSON.parse(
            localStorage.getItem(
              "foldory:workspace:p0:file:Docs/first.md:selection",
            ) ?? "null",
          )?.head,
      ),
    )
    .toBe(2);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          JSON.parse(
            localStorage.getItem(
              "foldory:workspace:p0:file:Docs/first.md:code-scroll",
            ) ?? "null",
          )?.top,
      ),
    )
    .toBe(450);
  await page
    .getByRole("complementary", { name: "Project library" })
    .getByRole("button", { name: "Project 1", exact: true })
    .last()
    .click();
  await page.getByRole("button", { name: "Files", exact: true }).click();
  await expect(page.getByRole("tab")).toHaveCount(0);
  await sidebarProject(page).click();
  await expect(page.getByRole("tab")).toHaveCount(3);
  await expect(
    page.getByRole("button", { name: "Split", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => preview.evaluate((node) => node.scrollTop)).toBe(900);
  await expect
    .poll(() => page.locator(".cm-scroller").evaluate((node) => node.scrollTop))
    .toBe(450);
  await expect(
    page.getByRole("button", { name: "Collapse Docs", exact: true }),
  ).toBeVisible();

  await page.reload();
  await sidebarProject(page).click();
  await expect(page.getByRole("tab")).toHaveCount(3);
  await expect.poll(() => preview.evaluate((node) => node.scrollTop)).toBe(900);
  await expect
    .poll(() => page.locator(".cm-scroller").evaluate((node) => node.scrollTop))
    .toBe(450);
  await expect(
    page.getByRole("tab", { name: "first.md", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByRole("button", { name: "Split", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByRole("button", { name: "Collapse Docs", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Close Docs/second.md", exact: true })
    .click();
  await expect(
    page.getByRole("tab", { name: "first.md", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await page
    .getByRole("button", { name: "Close Docs/first.md", exact: true })
    .click();
  await expect(
    page.getByRole("tab", { name: "amounts.csv", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await page
    .getByRole("button", { name: "Close amounts.csv", exact: true })
    .click();
  await expect(
    page.getByText("Your project, within reach", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await sidebarProject(page).click();
  await expect(page.getByRole("tab")).toHaveCount(0);
});

test("many file tabs scroll and the assistant divider reaches both 150px limits", async ({
  page,
}) => {
  await openFixture(page);
  await page.evaluate(async () => {
    const ipc = (
      window as unknown as {
        __TAURI_INTERNALS__: {
          invoke: (
            command: string,
            args: Record<string, unknown>,
          ) => Promise<unknown>;
        };
      }
    ).__TAURI_INTERNALS__;
    for (let i = 0; i < 14; i++)
      await ipc.invoke("write_file", {
        projectId: "p0",
        path: `Docs/document-${i}.md`,
        content: `# Document ${i}`,
      });
  });
  await sidebarProject(page).click();
  await page.getByRole("button", { name: "Files", exact: true }).click();
  await page.getByRole("button", { name: "Expand Docs", exact: true }).click();
  for (let i = 0; i < 14; i++)
    await page
      .getByRole("button", { name: `document-${i}.md`, exact: true })
      .click();
  const tabs = page.getByRole("tablist", { name: "Open files" });
  await expect(page.getByRole("tab")).toHaveCount(14);
  await expect
    .poll(() => tabs.evaluate((node) => node.scrollLeft))
    .toBeGreaterThan(0);
  expect(
    await tabs.evaluate((node) => node.scrollWidth > node.clientWidth),
  ).toBe(true);
  await tabs.hover();
  await page.mouse.wheel(0, -3000);
  await expect.poll(() => tabs.evaluate((node) => node.scrollLeft)).toBe(0);
  await page.getByRole("tab", { name: "document-0.md", exact: true }).click();
  await expect(
    page.getByRole("tab", { name: "document-0.md", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await page
    .getByRole("tab", { name: "document-0.md", exact: true })
    .press("ArrowRight");
  await expect(
    page.getByRole("tab", { name: "document-1.md", exact: true }),
  ).toBeFocused();
  await expect(
    page.getByRole("tab", { name: "document-1.md", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  const explorer = page.locator(".file-entry-list");
  const explorerTop = await explorer.evaluate((node) => {
    node.scrollTop = node.scrollHeight;
    return node.scrollTop;
  });
  expect(explorerTop).toBeGreaterThan(0);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          JSON.parse(
            localStorage.getItem("foldory:workspace:p0:explorer:") ?? "null",
          )?.top,
      ),
    )
    .toBe(explorerTop);
  await page.getByRole("button", { name: "Assistant", exact: true }).click();
  await page
    .getByRole("button", { name: "Pin assistant to side", exact: true })
    .click();
  const assistant = page.locator(".workspace-assistant.docked");
  await expect
    .poll(() => explorer.evaluate((node) => node.scrollTop))
    .toBe(explorerTop);
  const divider = page.getByRole("separator", {
    name: "Resize assistant",
    exact: true,
  });
  await expect
    .poll(async () => (await assistant.boundingBox())!.width)
    .toBe(420);
  await page.screenshot({
    path: "test-results/file-tabs-and-resizable-assistant.png",
  });
  let bounds = (await divider.boundingBox())!;
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 100);
  await page.mouse.down();
  await page.mouse.move(bounds.x - 2000, bounds.y + 100, { steps: 12 });
  await page.mouse.up();
  const bodyWidth = (await page.locator(".workspace-body").boundingBox())!
    .width;
  await expect
    .poll(async () => Math.round((await assistant.boundingBox())!.width))
    .toBe(Math.round(bodyWidth - 150));
  expect(
    Math.round((await page.locator(".workspace-primary").boundingBox())!.width),
  ).toBe(150);
  bounds = (await divider.boundingBox())!;
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 100);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 2000, bounds.y + 100, { steps: 12 });
  await page.mouse.up();
  await expect
    .poll(async () => (await assistant.boundingBox())!.width)
    .toBe(150);
  await divider.focus();
  await divider.press("ArrowLeft");
  await expect
    .poll(async () => (await assistant.boundingBox())!.width)
    .toBe(160);
  await page.setViewportSize({ width: 1100, height: 800 });
  await divider.press("End");
  await expect
    .poll(async () =>
      Math.round(
        (await page.locator(".workspace-primary").boundingBox())!.width,
      ),
    )
    .toBe(150);
  await divider.press("Home");
  await divider.press("ArrowLeft");
  await page.reload();
  await sidebarProject(page).click();
  await expect
    .poll(async () => (await assistant.boundingBox())!.width)
    .toBe(160);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("closing a dirty file saves it and a failed save keeps its tab open", async ({
  page,
}) => {
  await openFixture(page);
  await sidebarProject(page).click();
  await page.getByRole("button", { name: "Files", exact: true }).click();
  await page.getByRole("button", { name: "Expand Docs", exact: true }).click();
  await page.getByRole("button", { name: "first.md", exact: true }).click();
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  const code = page.locator(".cm-content");
  await code.fill("Saved when closing");
  await page
    .getByRole("button", { name: "Close Docs/first.md", exact: true })
    .click();
  await expect(page.getByRole("tab")).toHaveCount(0);
  expect((await calls(page, "write_file")).at(-1)?.args.content).toBe(
    "Saved when closing",
  );
  await page.getByRole("button", { name: "first.md", exact: true }).click();
  await expect(code).toContainText("Saved when closing");
  await page.evaluate(() => {
    const ipc = (
      window as unknown as {
        __TAURI_INTERNALS__: {
          invoke: (
            command: string,
            args: Record<string, unknown>,
          ) => Promise<unknown>;
        };
      }
    ).__TAURI_INTERNALS__;
    const original = ipc.invoke;
    ipc.invoke = async (command, args) => {
      if (command === "write_file") throw new Error("Fixture save failed");
      return original(command, args);
    };
  });
  await code.fill("Keep my unsaved edits");
  await page
    .getByRole("button", { name: "Close Docs/first.md", exact: true })
    .click();
  await expect(
    page.getByRole("tab", { name: "first.md", exact: true }),
  ).toBeVisible();
  await expect(code).toContainText("Keep my unsaved edits");
  await expect(
    page.getByText(/Finish saving the current file before navigating/),
  ).toBeVisible();
});

function visualWordPdf() {
  const content = (text: string) => `BT /F1 24 Tf 60 740 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${content("First page").length} >>\nstream\n${content("First page")}\nendstream`,
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>",
    `<< /Length ${content("Second page").length} >>\nstream\n${content("Second page")}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join(
      "",
    )}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf).toString("base64");
}

for (const width of [1440, 960]) {
  test(`visual Word parsing renders, resumes, saves and includes Markdown at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: width === 960 ? 640 : 940 });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (
        message.type() === "error" &&
        /Content Security Policy|Refused to|wasm/i.test(message.text())
      )
        errors.push(message.text());
    });
    if (testInfo.project.name === "release") {
      const config = JSON.parse(
        readFileSync(
          new URL("../src-tauri/tauri.conf.json", import.meta.url),
          "utf8",
        ),
      );
      await page.route("**/", async (route) => {
        const response = await route.fetch();
        const html = (await response.text()).replace(
          /<style\b/gi,
          '<style nonce="release-test"',
        );
        const policy = config.app.security.csp.replace(
          /style-src([^;]*)/,
          "$& 'nonce-release-test'",
        );
        await route.fulfill({
          response,
          body: html,
          headers: { ...response.headers(), "content-security-policy": policy },
        });
      });
    }
    await openFixture(page);
    await page.evaluate((pdf) => {
      const fixture = window as unknown as {
        __TAURI_INTERNALS__: {
          invoke: (
            command: string,
            args?: Record<string, unknown>,
          ) => Promise<unknown>;
        };
        fixtureCalls: { command: string; args: Record<string, unknown> }[];
      };
      const invoke = fixture.__TAURI_INTERNALS__.invoke;
      const pages: Record<string, string> = {};
      let failed = false;
      fixture.__TAURI_INTERNALS__.invoke = async (command, args = {}) => {
        if (
          ![
            "prepare_word_document",
            "parse_word_page",
            "complete_word_document",
            "prepare_word_source",
          ].includes(command)
        )
          return invoke(command, args);
        fixture.fixtureCalls.push({ command, args });
        if (command === "prepare_word_document")
          return {
            id: "visual-job",
            pdf,
            renderer: "Word fixture",
            completedPages: { ...pages },
          };
        if (command === "parse_word_page") {
          if (!String(args.image).startsWith("data:image/jpeg;base64,"))
            throw new Error("Missing page image");
          if (args.page === 2 && !failed) {
            failed = true;
            throw new Error("Simulated page failure; retry this page.");
          }
          const text =
            args.page === 1
              ? "# First page\n\n**Original emphasis**"
              : "## Second page\n\n- Original bullet";
          pages[String(args.page)] = text;
          return text;
        }
        if (command === "complete_word_document") {
          if (!pages["1"] || !pages["2"])
            throw new Error("Incomplete document");
          return {
            path: "example.docx",
            format: "docx",
            content: `${pages["1"]}\n\n${pages["2"]}`,
            warnings: ["All 2 pages visually parsed."],
          };
        }
        return {
          status: "ready",
          sources: [
            {
              id: "visual-source",
              path: "example.docx",
              directory: false,
              fileCount: 1,
              files: ["example.docx"],
              warnings: ["Visual Markdown"],
            },
          ],
        };
      };
    }, visualWordPdf());
    await sidebarProject(page).click();
    await page.getByRole("button", { name: "Files", exact: true }).click();
    await page
      .getByRole("button", { name: "example.docx", exact: true })
      .click();
    const preview = page.getByRole("region", { name: "Document preview" });
    await preview
      .getByRole("checkbox", { name: "Visual Word parsing" })
      .check();
    await preview
      .getByRole("textbox", { name: "Word formatting instructions" })
      .fill("Preserve original headings and lists.");
    await expect(
      preview.getByRole("button", { name: "Include in Assistant" }),
    ).toBeDisabled();
    await preview.getByRole("button", { name: "Parse all pages" }).click();
    await expect(preview.getByRole("alert")).toContainText(
      "Simulated page failure",
    );
    await preview.getByRole("button", { name: "Resume parsing" }).click();
    await expect(
      preview.getByRole("heading", { name: "Second page" }),
    ).toBeVisible();
    await expect(preview.getByRole("progressbar")).toHaveAttribute(
      "value",
      "2",
    );
    await preview.getByRole("button", { name: "Save Markdown" }).click();
    await expect(
      preview.getByText("Saved example.md", { exact: true }),
    ).toBeVisible();
    await page.screenshot({ path: `test-results/word-parser-${width}.png` });
    await preview.getByRole("button", { name: "Include in Assistant" }).click();
    await expect(
      page.getByRole("button", {
        name: "Remove source example.docx",
        exact: true,
      }),
    ).toBeVisible();
    const calls = await page.evaluate(
      () =>
        (
          window as unknown as {
            fixtureCalls: { command: string; args: Record<string, unknown> }[];
          }
        ).fixtureCalls,
    );
    expect(
      calls
        .filter((call) => call.command === "parse_word_page")
        .map((call) => call.args.page),
    ).toEqual([1, 2, 2]);
    expect(
      calls.filter((call) => call.command === "parse_word_page")[0].args
        .pageText,
    ).toContain('"sizePt":24');
    expect(
      calls.find((call) => call.command === "write_file")?.args.content,
    ).toContain("## Second page");
    expect(
      calls.find((call) => call.command === "prepare_word_source")?.args.id,
    ).toBe("visual-job");
    expect(errors).toEqual([]);
  });
}

test("code editor keeps its gutters aligned with the document", async ({
  page,
}, testInfo) => {
  const violations: string[] = [];
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      /style|Content Security Policy/i.test(message.text())
    )
      violations.push(message.text());
  });
  if (testInfo.project.name === "release") {
    const config = JSON.parse(
      readFileSync(
        new URL("../src-tauri/tauri.conf.json", import.meta.url),
        "utf8",
      ),
    );
    await page.route("**/", async (route) => {
      const response = await route.fetch();
      let html = await response.text();
      let policy = config.app.security.csp as string;
      // Tauri nonces every static style tag and adds that nonce to style-src.
      // This must use the built HTML, since Vite dev does not enforce this policy.
      if (/<style\b/i.test(html)) {
        html = html.replace(/<style\b/gi, '<style nonce="release-test"');
        policy = policy.replace(/style-src([^;]*)/, "$& 'nonce-release-test'");
      }
      await route.fulfill({
        response,
        body: html,
        headers: {
          ...response.headers(),
          "content-security-policy": policy,
        },
      });
    });
  }
  await openFixture(page);
  await sidebarProject(page).click();
  await page.getByRole("button", { name: "Files", exact: true }).click();
  await page.getByRole("button", { name: "Docs", exact: true }).click();
  await page.getByRole("button", { name: "first.md", exact: true }).click();
  await expect(page.locator(".file-entry.selected")).toHaveCSS(
    "box-shadow",
    "none",
  );
  await page.getByRole("button", { name: "Edit", exact: true }).click();

  const editor = page.getByLabel("Edit Docs/first.md");
  await expect(editor).toBeVisible();
  const heading = editor.locator(".cm-line").first();
  await expect(heading).toHaveText("# Source document");
  const wrapToggle = page.getByRole("button", {
    name: "Text wrap",
    exact: true,
  });
  await expect(wrapToggle).toHaveAttribute("aria-pressed", "true");
  // One Dark colors the heading text coral and its Markdown marker green.
  await expect
    .poll(() =>
      heading
        .locator("span")
        .last()
        .evaluate((span) => getComputedStyle(span).color),
    )
    .toBe("rgb(224, 108, 117)");
  const layout = await editor.evaluate((root) => {
    const scroller = root.querySelector<HTMLElement>(".cm-scroller");
    const content = root.querySelector<HTMLElement>(".cm-content");
    const gutters = scroller?.querySelector<HTMLElement>(".cm-gutters");
    const firstLine = content.querySelector<HTMLElement>(".cm-line");
    const firstNumber = Array.from(
      gutters?.querySelectorAll<HTMLElement>(
        ".cm-lineNumbers .cm-gutterElement",
      ) ?? [],
    ).find((number) => number.style.visibility !== "hidden");
    return {
      scrollerDisplay: scroller ? getComputedStyle(scroller).display : "",
      guttersDisplay: gutters ? getComputedStyle(gutters).display : "",
      lineTop: firstLine?.getBoundingClientRect().top ?? -1,
      numberTop: firstNumber?.getBoundingClientRect().top ?? -1,
    };
  });

  expect(layout.scrollerDisplay).toBe("flex");
  expect(layout.guttersDisplay).toBe("flex");
  expect(Math.abs(layout.lineTop - layout.numberTop)).toBeLessThan(2);
  await expect
    .poll(() =>
      editor.evaluate((root) => {
        const lines = Array.from(
          root.querySelectorAll<HTMLElement>(".cm-line"),
        );
        const numbers = Array.from(
          root.querySelectorAll<HTMLElement>(
            ".cm-lineNumbers .cm-gutterElement",
          ),
        ).filter((number) => getComputedStyle(number).visibility !== "hidden");
        return (
          lines.length === numbers.length &&
          lines.every(
            (line, index) =>
              numbers[index].textContent === String(index + 1) &&
              Math.abs(
                line.getBoundingClientRect().top -
                  numbers[index].getBoundingClientRect().top,
              ) < 2,
          )
        );
      }),
    )
    .toBe(true);
  await page.screenshot({
    path: `test-results/editor-${testInfo.project.name || "dev"}.png`,
  });
  const longText =
    "# Source document\n\n" +
    "A long line of text for visual wrapping. ".repeat(80) +
    "x".repeat(400);
  const content = editor.locator(".cm-content");
  await content.fill(longText);
  const scroller = editor.locator(".cm-scroller");
  await expect
    .poll(() =>
      scroller.evaluate((element) => element.scrollWidth - element.clientWidth),
    )
    .toBeLessThanOrEqual(1);
  const wrappedHeight = await editor
    .locator(".cm-line")
    .last()
    .evaluate((line) => line.getBoundingClientRect().height);
  await wrapToggle.click();
  await expect(wrapToggle).toHaveAttribute("aria-pressed", "false");
  await expect
    .poll(() =>
      scroller.evaluate((element) => element.scrollWidth - element.clientWidth),
    )
    .toBeGreaterThan(100);
  expect(
    await editor
      .locator(".cm-line")
      .last()
      .evaluate((line) => line.getBoundingClientRect().height),
  ).toBeLessThan(wrappedHeight);
  await expect(editor.locator(".cm-line").last()).toHaveText(
    longText.split("\n")[2],
  );
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await expect(wrapToggle).toHaveCount(0);
  await page.getByRole("button", { name: "Split", exact: true }).click();
  await expect(wrapToggle).toHaveAttribute("aria-pressed", "false");
  await wrapToggle.click();
  await expect
    .poll(() =>
      editor
        .locator(".cm-scroller")
        .evaluate((element) => element.scrollWidth - element.clientWidth),
    )
    .toBeLessThanOrEqual(1);
  await expect(editor.locator(".cm-line").last()).toHaveText(
    longText.split("\n")[2],
  );
  await expect
    .poll(async () => (await calls(page, "write_file")).at(-1)?.args.content)
    .toBe(longText);
  expect(violations).toEqual([]);
});

test("custom dropdowns search large lists, preserve keyboard focus and stay usable inside dialogs", async ({
  page,
}) => {
  await page.setViewportSize({ width: 960, height: 640 });
  await openFixture(page);
  await expect(page.locator("select")).toHaveCount(0);
  const sort = page.getByRole("combobox", { name: "Sort projects" });
  await sort.focus();
  await page.keyboard.press("ArrowDown");
  await expect(
    page.getByRole("listbox", { name: "Sort projects" }),
  ).toBeVisible();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await expect(sort).toHaveText("Last updated");
  await expect(sort).toBeFocused();
  await sort.click();
  const popup = page.locator(".app-select-popup");
  let bounds = (await popup.boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(8);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(952);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(632);
  await page.keyboard.press("Escape");

  await page.keyboard.press("Control+k");
  const scope = page.getByRole("combobox", { name: "Search scope" });
  await scope.click();
  await expect(page.getByRole("option")).toHaveCount(102);
  const fullMenuHeight = (await popup.boundingBox())!.height;
  const search = page.getByRole("searchbox", {
    name: "Search Search scope options",
  });
  await expect(search).toBeFocused();
  await search.fill("Project 100");
  await expect(page.getByRole("option")).toHaveCount(1);
  await expect(scope).toHaveText("All projects");
  await search.clear();
  await expect(page.getByRole("option")).toHaveCount(102);
  await expect
    .poll(async () => (await popup.boundingBox())!.height)
    .toBeGreaterThanOrEqual(fullMenuHeight - 2);
  await search.fill("Project 100");
  await page.screenshot({ path: "test-results/custom-project-search.png" });
  await page.keyboard.press("Enter");
  await expect(scope).toHaveText("Project 100");
  await expect(scope).toBeFocused();
  await scope.click();
  const selectedOption = page.getByRole("option", {
    name: "Project 100",
    exact: true,
  });
  await expect
    .poll(async () => {
      const [row, menu] = await Promise.all([
        selectedOption.boundingBox(),
        page.getByRole("listbox", { name: "Search scope" }).boundingBox(),
      ]);
      return (
        !!row &&
        !!menu &&
        row.y >= menu.y - 1 &&
        row.y + row.height <= menu.y + menu.height + 1
      );
    })
    .toBe(true);
  await search.fill("no such project");
  await expect(
    page.getByText("No matching options", { exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(scope).toHaveText("Project 100");
  await expect(page.locator("select")).toHaveCount(0);

  await page.getByRole("button", { name: "Projects dashboard" }).click();
  await page
    .locator(".dashboard")
    .getByRole("button", { name: "New project", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Create project" });
  const template = dialog.getByRole("combobox", { name: "Project template" });
  await template.click();
  await expect(
    dialog.getByRole("listbox", { name: "Project template" }),
  ).toBeVisible();
  bounds = (await popup.boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(8);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(952);
  expect(bounds.y).toBeGreaterThanOrEqual(8);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(632);
  await page.screenshot({ path: "test-results/custom-dialog-select.png" });
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await expect(template).toBeFocused();
  await template.click();
  await page.keyboard.press("Tab");
  await expect(popup).toHaveCount(0);
  await expect(
    dialog.getByRole("button", { name: "Cancel", exact: true }),
  ).toBeFocused();
  await expect(page.locator("select")).toHaveCount(0);
  expect(await calls(page, "create_project")).toHaveLength(0);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("button", { name: "Project templates", exact: true })
    .click();
  const settingsTemplate = page.getByRole("combobox", {
    name: "Template",
    exact: true,
  });
  await settingsTemplate.click();
  await page.getByRole("searchbox").fill("Standard");
  await page.getByRole("option", { name: "Standard", exact: true }).click();
  await expect(settingsTemplate).toHaveText("Standard");
  await page
    .getByRole("button", { name: "Project inspector", exact: true })
    .click();
  const profile = page.getByRole("combobox", { name: "Prompt profile" });
  await profile.click();
  await expect(
    page.getByRole("listbox", { name: "Prompt profile" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(profile).toBeFocused();
  await expect(page.locator("select")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    960,
  );
});

for (const viewport of [
  { width: 2560, height: 1440 },
  { width: 960, height: 640 },
]) {
  test(`project dashboard fills its pane and keeps headings visible while the list scrolls at ${viewport.width}x${viewport.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await openFixture(page);
    const dashboard = page.locator(".dashboard");
    const panel = page.locator(".main-panel");
    const list = page.getByRole("region", {
      name: "Project list",
      exact: true,
    });
    await expect(list.locator(".project-table-row")).toHaveCount(101);

    // Both expanded and collapsed sidebars leave the entire remaining pane available.
    for (const collapse of [false, true]) {
      if (collapse)
        await page.getByRole("button", { name: "Collapse sidebar" }).click();
      const [dashboardBox, panelBox] = await Promise.all([
        dashboard.boundingBox(),
        panel.boundingBox(),
      ]);
      expect(dashboardBox!.x).toBeCloseTo(panelBox!.x, 0);
      expect(dashboardBox!.width).toBeCloseTo(panelBox!.width, 0);
      const listBox = (await list.boundingBox())!;
      expect(listBox.width).toBeGreaterThan(panelBox!.width - 110);
      expect(listBox.height).toBeGreaterThan(200);
    }
    if (viewport.width === 960)
      await page.getByRole("button", { name: "Expand sidebar" }).click();

    const fixed = page.locator(
      ".topbar, .dashboard .workspace-page-heading, .workspace-stats, .library-toolbar, .project-table-heading",
    );
    const header = page.locator(".dashboard .workspace-page-heading");
    const title = header.getByRole("heading", { name: "Your projects." });
    const subtitle = header.getByText(
      "Everything you’re working on, within reach.",
    );
    const [headerBox, titleBox, topbarBox, currentPanelBox] = await Promise.all(
      [
        header.boundingBox(),
        title.boundingBox(),
        page.locator(".topbar").boundingBox(),
        panel.boundingBox(),
      ],
    );
    expect(titleBox!.x - currentPanelBox!.x).toBe(
      viewport.width <= 1050 ? 20 : 32,
    );
    expect(headerBox!.y).toBeCloseTo(topbarBox!.y + topbarBox!.height, 0);
    await expect(title).toHaveCSS("font-size", "27px");
    await expect(title).toHaveCSS("font-weight", "600");
    await expect(subtitle).toHaveCSS("font-size", "13px");
    const positions = () =>
      fixed.evaluateAll((elements) =>
        elements.map((element) => element.getBoundingClientRect().top),
      );
    const before = await positions();
    const firstRow = list.locator(".project-table-row").first();
    const firstTop = (await firstRow.boundingBox())!.y;
    await list.hover();
    await page.mouse.wheel(0, 1700);
    await expect
      .poll(() => list.evaluate((e) => e.scrollTop))
      .toBeGreaterThan(500);
    expect((await firstRow.boundingBox())!.y).toBeLessThan(firstTop - 500);
    expect(await positions()).toEqual(before);
    await expect(
      page.getByRole("combobox", { name: "Sort projects" }),
    ).toBeVisible();
    await expect(
      page.getByRole("combobox", { name: "Filter by source" }),
    ).toBeVisible();
    await page.screenshot({
      path: `test-results/projects-dashboard-${viewport.width}.png`,
    });

    // The scroll region is reachable by keyboard, including the final project.
    await list.focus();
    await page.keyboard.press("End");
    await expect
      .poll(() =>
        list.evaluate((e) =>
          Math.abs(e.scrollHeight - e.clientHeight - e.scrollTop),
        ),
      )
      .toBeLessThan(2);
    await expect(list.locator(".project-table-row").last()).toBeInViewport();
    expect(await positions()).toEqual(before);
    await page.keyboard.press("Home");
    await expect.poll(() => list.evaluate((e) => e.scrollTop)).toBe(0);
    await expect(firstRow).toBeInViewport();

    const overflow = await page.evaluate(() => ({
      pageScroll: window.scrollY,
      documentHeight: document.documentElement.scrollHeight,
      documentWidth: document.documentElement.scrollWidth,
      dashboardScroll: document.querySelector(".dashboard")!.scrollTop,
      sidebarScroll: document.querySelector(".sidebar-scroll")!.scrollTop,
      listWidth: document.querySelector(".project-table")!.scrollWidth,
      listClientWidth: document.querySelector(".project-table")!.clientWidth,
    }));
    expect(overflow.pageScroll).toBe(0);
    expect(overflow.dashboardScroll).toBe(0);
    expect(overflow.sidebarScroll).toBe(0);
    expect(overflow.documentHeight).toBe(viewport.height);
    expect(overflow.documentWidth).toBe(viewport.width);
    expect(overflow.listWidth).toBe(overflow.listClientWidth);
  });
}

async function calls(page: Page, command: string) {
  return page.evaluate(
    (cmd) =>
      (
        window as unknown as {
          fixtureCalls: { command: string; args: Record<string, unknown> }[];
        }
      ).fixtureCalls.filter((c) => c.command === cmd),
    command,
  );
}

// Exercise the real explorer/editor UI against an isolated, mutable filesystem.
// Native filesystem safety and policy decisions are tested in Rust.
async function openFileOperationFixture(page: Page) {
  await openFixture(page);
  await page.evaluate(() => {
    const fixture = window as unknown as {
      fixtureCalls: { command: string; args: Record<string, unknown> }[];
      __TAURI_INTERNALS__: {
        invoke: (
          command: string,
          args?: Record<string, unknown>,
        ) => Promise<unknown>;
      };
    };
    const original = fixture.__TAURI_INTERNALS__.invoke;
    const files = new Map<string, boolean>([
      ["PROJECT.md", false],
      ["note.txt", false],
      ["Target", true],
      ["Public", true],
      ["Source", true],
      ["Source/Nested", true],
      ["Source/Nested/child.txt", false],
      ["Secure", true],
      ["Secure/Bundle", true],
      ["Secure/Bundle/private-note.txt", false],
    ]);
    fixture.__TAURI_INTERNALS__.invoke = async (command, args = {}) => {
      if (command === "list_directory") {
        const parent = String(args.path || "");
        return [...files]
          .filter(([path]) => path.split("/").slice(0, -1).join("/") === parent)
          .map(([path, directory]): FileEntry => ({
            path,
            name: path.split("/").pop()!,
            directory,
            size: 10,
            modifiedAt: 0,
            aiExcluded: path.startsWith("Secure"),
          }));
      }
      if (
        command !== "preview_file_operation" &&
        command !== "execute_file_operation"
      )
        return original(command, args);
      fixture.fixtureCalls.push({ command, args });
      const request = args.request as FileOperationRequest;
      const items = request.paths.map((source) => ({
        source,
        destination:
          request.kind === "delete"
            ? undefined
            : [request.destination, source.split("/").pop()]
                .filter(Boolean)
                .join("/"),
      }));
      if (items.some((item) => item.destination && files.has(item.destination)))
        throw new Error("The destination already exists. Nothing was changed.");
      if (command === "preview_file_operation") {
        const protectionChanges = items.flatMap((item) =>
          [...files.keys()]
            .filter(
              (path) =>
                (path === item.source || path.startsWith(`${item.source}/`)) &&
                path.startsWith("Secure/") &&
                !item.destination?.startsWith("Secure/"),
            )
            .map((path) => ({
              source: path,
              destination: `${item.destination}${path.slice(item.source.length)}`,
              reason: "Inherited private folder",
            })),
        );
        return {
          items,
          protectionChanges,
          protectedCount: protectionChanges.length,
          confirmationToken: "fixture-confirmed",
        };
      }
      if (args.confirmationToken !== "fixture-confirmed")
        throw new Error("Confirmation is required");
      for (const item of items) {
        const nested = [...files].filter(
          ([path]) =>
            path === item.source || path.startsWith(`${item.source}/`),
        );
        for (const [path, directory] of nested) {
          if (item.destination)
            files.set(
              `${item.destination}${path.slice(item.source.length)}`,
              directory,
            );
          if (request.kind !== "copy") files.delete(path);
        }
      }
      return { completed: items, error: null };
    };
  });
  await sidebarProject(page).click();
  await page.getByRole("button", { name: "Files", exact: true }).click();
}

test("file operations cut/paste and keyboard copy preserve the editor and support confirmed deletion", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await openFileOperationFixture(page);
  const note = page.getByRole("button", { name: "note.txt", exact: true });
  await note.click();
  await expect(
    page.getByRole("region", { name: "Editor for note.txt", exact: true }),
  ).toBeVisible();
  await note.click({ button: "right" });
  await page.getByRole("menuitem", { name: /^Cut / }).click();
  await expect(note.locator("..")).toHaveClass(/cut/);
  await page
    .getByRole("button", { name: "Target", exact: true })
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: /^Paste into folder/ }).click();
  await expect(
    page.getByRole("region", {
      name: "Editor for Target/note.txt",
      exact: true,
    }),
  ).toBeVisible();
  await expect(note).toHaveCount(0);
  await page
    .getByRole("button", { name: "Expand Target", exact: true })
    .click();
  await note.click();
  await note.press("Control+c");
  await page.getByRole("button", { name: "Public", exact: true }).click();
  const explorer = page.getByRole("complementary", {
    name: "Project files",
    exact: true,
  });
  await explorer.focus();
  await explorer.press("Control+v");
  await expect(note).toBeVisible();
  expect(
    (await calls(page, "execute_file_operation")).at(-1)?.args.request,
  ).toEqual({
    kind: "copy",
    paths: ["Target/note.txt"],
    destination: "Public",
  });
  await note.click();
  await note.press("Delete");
  const dialog = page.getByRole("dialog", {
    name: "Permanently delete selected items?",
  });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(note).toBeVisible();
  await note.focus();
  await note.press("Delete");
  await dialog
    .getByRole("button", { name: "Delete permanently", exact: true })
    .click();
  await expect(note).toHaveCount(0);
  await expect(
    page.getByRole("region", {
      name: "Editor for Public/note.txt",
      exact: true,
    }),
  ).toHaveCount(0);
});

test("file operations drag folders through the tree and warn before protected contents are exposed", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1024, height: 760 });
  await openFileOperationFixture(page);
  await page
    .getByRole("button", { name: "Source", exact: true })
    .dragTo(page.getByRole("button", { name: "Target", exact: true }));
  await expect(
    page.getByRole("button", { name: "Source", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Expand Target", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Source", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Expand Source", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Nested", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Expand Secure", exact: true })
    .click();
  const bundle = page.getByRole("button", { name: "Bundle", exact: true });
  const target = page.getByRole("button", { name: "Target", exact: true });
  await bundle.dragTo(target);
  const dialog = page.getByRole("dialog", {
    name: "Move outside protected locations?",
  });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByText("Secure/Bundle/private-note.txt", { exact: true }),
  ).toBeVisible();
  expect(await calls(page, "execute_file_operation")).toHaveLength(1);
  await page.screenshot({ path: "test-results/file-operation-protection.png" });
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(bundle).toBeVisible();
  await bundle.dragTo(target);
  await dialog
    .getByRole("button", { name: "Move anyway", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "private-note.txt", exact: true }),
  ).toHaveCount(0);
  expect(await calls(page, "execute_file_operation")).toHaveLength(2);
  await expect(
    page.getByRole("status").filter({ hasText: "Moved 1" }),
  ).toBeVisible();
  await page.screenshot({ path: "test-results/file-operation-tree.png" });
});

test("the new-template button aligns with the template selector", async ({
  page,
}) => {
  await openFixture(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("button", { name: "Project templates", exact: true })
    .click();
  const select = page.getByRole("combobox", { name: "Template", exact: true });
  const button = page.getByRole("button", {
    name: "New template",
    exact: true,
  });
  const [selectBox, buttonBox] = await Promise.all([
    select.boundingBox(),
    button.boundingBox(),
  ]);
  expect(selectBox).not.toBeNull();
  expect(buttonBox).not.toBeNull();
  expect(Math.abs(selectBox!.y - buttonBox!.y)).toBeLessThan(1);
});

test("right-click actions change only project metadata and launch in the clicked project", async ({
  page,
}) => {
  await openFixture(page);
  await sidebarProject(page).click({ button: "right" });
  const menu = page.getByRole("menu", { name: "Actions for Fixture Project" });
  await expect(menu).toBeVisible();
  await menu
    .getByRole("menuitem", { name: "Folder colour", exact: true })
    .click();
  await menu.getByRole("menuitemradio", { name: "Colour #e5ba75" }).click();
  await expect
    .poll(() => calls(page, "update_project"))
    .toEqual([
      {
        command: "update_project",
        args: { id: "p0", patch: { color: "#e5ba75" } },
      },
    ]);
  await sidebarProject(page).click({ button: "right" });
  await menu.getByRole("menuitem", { name: "Rename display label…" }).click();
  await page
    .getByRole("textbox", { name: /Display name/ })
    .fill("My visual label");
  await page.getByRole("button", { name: "Save label" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const updated = await calls(page, "update_project");
  expect(updated[1].args).toEqual({
    id: "p0",
    patch: { alias: "My visual label" },
  });
  await expect(
    page.getByRole("button", { name: /My visual label D:/ }),
  ).toHaveCount(1);
  for (const [label, toolId] of [
    ["Open in Explorer", "explorer"],
    ["Start CMD here", "cmd"],
    ["Start Cursor Desktop here", "cursor-desktop"],
  ]) {
    await page
      .getByRole("complementary", { name: "Project library" })
      .getByRole("button", { name: "My visual label", exact: true })
      .click({ button: "right" });
    await page.getByRole("menuitem", { name: label, exact: true }).click();
    expect((await calls(page, "launch_tool")).at(-1)?.args).toEqual({
      projectId: "p0",
      toolId,
      path: null,
    });
  }
  await page
    .getByRole("button", { name: "Actions for My visual label", exact: true })
    .click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(
    page.getByRole("button", {
      name: "Actions for My visual label",
      exact: true,
    }),
  ).toBeFocused();
  await page.setViewportSize({ width: 960, height: 640 });
  await page
    .getByRole("button", { name: "Actions for Project 99", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Folder colour", exact: true })
    .click();
  const bounds = await page.getByRole("menu").boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.y).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(960);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(640);
  await page.screenshot({ path: "test-results/project-context-menu.png" });
});

test("supported launchers detect variants, persist switches, and precede custom tools", async ({
  page,
}) => {
  await openFixture(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Tools & launchers" }).click();
  const builtin = page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: "Built-in launchers" }) });
  await expect(builtin).not.toContainText("Cursor");
  await page.getByRole("button", { name: "Codex launch options" }).click();
  await page
    .getByRole("switch", { name: "Enable Codex Desktop", exact: true })
    .check();
  await page
    .getByRole("switch", { name: "Enable Codex CLI", exact: true })
    .check();
  await page.getByRole("switch", { name: "Enable Cursor launcher" }).uncheck();
  await page.getByRole("button", { name: "Claude launch options" }).click();
  await expect(
    page.getByRole("switch", { name: "Enable Claude Desktop" }),
  ).toBeDisabled();
  await page
    .getByRole("switch", { name: "Enable Claude CLI", exact: true })
    .check();
  await expect
    .poll(async () => (await calls(page, "save_settings")).length)
    .toBe(4);
  await page.screenshot({
    path: "test-results/supported-launchers-settings.png",
    fullPage: true,
  });
  // Include a configured custom launcher and verify that a full reload keeps preferences.
  await page.evaluate(() => {
    const settings = JSON.parse(sessionStorage.getItem("fixture-settings")!);
    settings.tools = [
      {
        id: "editor-test",
        name: "Custom editor",
        executable: "editor.exe",
        args: ["{{project}}"],
      },
    ];
    sessionStorage.setItem("fixture-settings", JSON.stringify(settings));
  });
  await page.reload();
  await sidebarProject(page).click({ button: "right" });
  const menu = page.getByRole("menu", { name: "Actions for Fixture Project" });
  await expect(menu.getByRole("menuitem")).toHaveText([
    "Rename display label…",
    "Folder colour",
    "Open in Explorer",
    "Start CMD here",
    "Open PowerShell",
    "Start Claude CLI here",
    "Start Codex Desktop here",
    "Start Codex CLI here",
    "Custom editor",
    "Edit details…",
    "Pin project",
    "Hide project",
  ]);
  await expect(menu.locator(".launcher-menu-label")).toHaveText([
    "Supported tools",
    "Custom tools",
  ]);
  await page.screenshot({
    path: "test-results/supported-launchers-menu.png",
    fullPage: true,
  });
  await menu
    .getByRole("menuitem", { name: "Start Codex Desktop here" })
    .click();
  expect((await calls(page, "launch_tool")).at(-1)?.args).toEqual({
    projectId: "p0",
    toolId: "codex-desktop",
    path: null,
  });
  await sidebarProject(page).click();
  await page.getByRole("button", { name: "More project tools" }).click();
  const toolbar = page.locator(".tools-menu");
  await expect(toolbar.getByRole("button")).toHaveText([
    "Command Prompt",
    "PowerShell",
    "Claude CLI",
    "Codex Desktop",
    "Codex CLI",
    "Custom editor",
  ]);
  await toolbar.getByRole("button", { name: "Codex CLI", exact: true }).click();
  expect((await calls(page, "launch_tool")).at(-1)?.args.toolId).toBe(
    "codex-cli",
  );
});

test("Enter sends once; Shift+Enter inserts a newline and IME Enter does not send", async ({
  page,
}) => {
  await openFixture(page);
  await sidebarProject(page).click();
  await page.getByRole("button", { name: "Assistant", exact: true }).click();
  const prompt = page.getByRole("textbox", { name: "Your question" });
  await prompt.press("Enter");
  expect(await calls(page, "send_chat_message")).toHaveLength(0);
  await prompt.fill("First line");
  await prompt.press("Shift+Enter");
  await prompt.pressSequentially("Second line");
  await expect(prompt).toHaveValue("First line\nSecond line");
  expect(await calls(page, "send_chat_message")).toHaveLength(0);
  await prompt.dispatchEvent("keydown", { key: "Enter", isComposing: true });
  expect(await calls(page, "send_chat_message")).toHaveLength(0);
  await prompt.press("Enter");
  await prompt.press("Enter");
  await expect
    .poll(() => calls(page, "send_chat_message"))
    .toEqual([
      {
        command: "send_chat_message",
        args: {
          chatId: expect.any(String),
          projectId: "p0",
          prompt: "First line\nSecond line",
          includeOverview: false,
          scopeProjectIds: [],
          sourceIds: [],
        },
      },
    ]);
  await expect(
    page.getByRole("button", { name: "Copy response" }),
  ).toBeVisible();
});

for (const viewport of [
  { width: 1440, height: 940 },
  { width: 960, height: 720 },
]) {
  test(`pinned assistant keeps drafts and attaches explorer selections at ${viewport.width}px`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await openFixture(page);
    await sidebarProject(page).click();
    await page.getByRole("button", { name: "Assistant", exact: true }).click();
    const prompt = page.getByRole("textbox", { name: "Your question" });
    await prompt.fill("Summarize these documents");
    await page.getByRole("button", { name: "Pin assistant to side" }).click();
    const divider = page.getByRole("separator", { name: "Resize assistant" });
    await divider.focus();
    await divider.press("Home");
    await expect(divider).toHaveAttribute("aria-valuenow", "150");
    await divider.press("ArrowLeft");
    await expect(divider).toHaveAttribute("aria-valuenow", "160");
    await divider.press("ArrowRight");
    await expect(divider).toHaveAttribute("aria-valuenow", "150");
    for (let i = 0; i < 17; i++) await divider.press("ArrowLeft");
    await expect(prompt).toHaveValue("Summarize these documents");
    await expect(
      page.getByRole("complementary", { name: "Project files", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Expand Docs", exact: true })
      .click();
    await page
      .getByRole("button", { name: "first.md", exact: true })
      .click({ modifiers: ["Control"] });
    await page
      .getByRole("button", { name: "second.md", exact: true })
      .click({ modifiers: ["Control"] });
    await page
      .getByRole("button", { name: "first.md", exact: true })
      .click({ button: "right" });
    await page
      .getByRole("menuitem", { name: "Include in Assistant", exact: true })
      .click();
    await expect(
      page.getByRole("button", {
        name: "Remove source Docs/first.md",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", {
        name: "Remove source Docs/second.md",
        exact: true,
      }),
    ).toBeVisible();
    expect(
      (await calls(page, "prepare_assistant_sources")).at(-1)?.args.paths,
    ).toEqual(["Docs/first.md", "Docs/second.md"]);
    await page
      .getByRole("button", { name: "amounts.csv", exact: true })
      .click();
    await expect(
      page.getByRole("region", { name: "Document preview", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("cell", { name: "120", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Overview", exact: true }).click();
    await expect(prompt).toHaveValue("Summarize these documents");
    await page.getByRole("button", { name: "Files", exact: true }).click();
    await expect(prompt).toHaveValue("Summarize these documents");
    await page.screenshot({
      path: `test-results/assistant-pinned-${viewport.width}.png`,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await prompt.press("Enter");
    await expect
      .poll(async () => (await calls(page, "send_chat_message")).length)
      .toBe(1);
    expect(
      (await calls(page, "send_chat_message"))[0].args.sourceIds,
    ).toHaveLength(2);
    await expect(
      page.getByRole("button", {
        name: "Remove source Docs/first.md",
        exact: true,
      }),
    ).toHaveCount(0);
    await expect(
      page.getByText("Response to Summarize these documents"),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Unpin assistant", exact: true })
      .click();
    await expect(page.locator(".workspace-assistant")).not.toHaveClass(
      /docked/,
    );
    await expect(
      page.getByText("Response to Summarize these documents"),
    ).toBeVisible();
  });
}

test("folder drops, path references, and cancelled excluded attachments use the same source flow", async ({
  page,
}) => {
  await openFixture(page);
  await sidebarProject(page).click();
  await page.getByRole("button", { name: "Assistant", exact: true }).click();
  await page.getByRole("button", { name: "Pin assistant to side" }).click();
  const prompt = page.getByRole("textbox", { name: "Your question" });
  await page.getByRole("button", { name: "Docs", exact: true }).dragTo(prompt);
  await expect(
    page.getByRole("button", { name: "Remove source Docs", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".chat-sources")).toContainText("2 files");
  await page
    .getByRole("button", { name: "Remove source Docs", exact: true })
    .click();
  await prompt.fill("@Doc");
  await expect(page.getByRole("option", { name: /Docs/ })).toBeVisible();
  await prompt.press("ArrowDown");
  await prompt.press("ArrowUp");
  await prompt.press("Enter");
  await expect(
    page.getByRole("button", { name: "Remove source Docs", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Remove source Docs", exact: true })
    .click();
  await prompt.fill("/Doc");
  await expect(page.getByRole("option", { name: /Docs/ })).toBeVisible();
  await prompt.press("Enter");
  await expect(
    page.getByRole("button", { name: "Remove source Docs", exact: true }),
  ).toBeVisible();
  const secure = page.getByRole("button", { name: "Secure", exact: true });
  await expect(secure.locator(".file-icon")).toHaveCSS(
    "color",
    "rgb(240, 120, 120)",
  );
  await secure.click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "Include in Assistant", exact: true })
    .click();
  const permission = page.getByRole("dialog", {
    name: "Include excluded sources?",
  });
  await expect(permission).toBeVisible();
  await permission.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(permission).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Remove source Secure", exact: true }),
  ).toHaveCount(0);
  expect(await calls(page, "send_chat_message")).toHaveLength(0);
  await page.getByRole("button", { name: "example.docx", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Example document", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Extracted text", exact: true })
    .click();
  await expect(page.locator(".document-preview-content pre")).toContainText(
    "# Example document",
  );
});

for (const viewport of [
  { width: 1440, height: 940 },
  { width: 960, height: 720 },
]) {
  test(`in-app source permission and typed errors preserve the draft at ${viewport.width}px`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await openFixture(page);
    await sidebarProject(page).click();
    await page.getByRole("button", { name: "Assistant", exact: true }).click();
    await page.getByRole("button", { name: "Pin assistant to side" }).click();
    const prompt = page.getByRole("textbox", { name: "Your question" });
    await prompt.fill("Summarize the included files");
    const secure = page.getByRole("button", { name: "Secure", exact: true });
    await secure.click({ button: "right" });
    await page
      .getByRole("menuitem", { name: "Include in Assistant", exact: true })
      .click();
    const permission = page.getByRole("dialog", {
      name: "Include excluded sources?",
      exact: true,
    });
    await expect(permission).toBeVisible();
    await expect(
      permission.getByRole("button", { name: "Cancel", exact: true }),
    ).toBeFocused();
    await expect(
      page.getByRole("button", { name: "Remove source Secure", exact: true }),
    ).toHaveCount(0);
    await page.screenshot({
      path: `test-results/assistant-source-permission-${viewport.width}.png`,
    });
    await page.keyboard.press("Escape");
    await expect(permission).toHaveCount(0);
    await expect(page.getByRole("alert")).toHaveCount(0);
    expect(
      (await calls(page, "approve_assistant_sources")).at(-1)?.args.allow,
    ).toBe(false);
    await secure.click({ button: "right" });
    await page
      .getByRole("menuitem", { name: "Include in Assistant", exact: true })
      .click();
    await permission
      .getByRole("button", { name: "Include sources", exact: true })
      .click();
    const sensitive = page.getByRole("dialog", {
      name: "Share detected sensitive content?",
      exact: true,
    });
    await expect(sensitive).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Remove source Secure", exact: true }),
    ).toHaveCount(0);
    await sensitive
      .getByRole("button", { name: "Share detected content", exact: true })
      .click();
    await expect(sensitive).toHaveCount(0);
    const source = page.getByRole("button", {
      name: "Remove source Secure",
      exact: true,
    });
    await expect(source).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Send question", exact: true }),
    ).toBeEnabled();
    await page.evaluate(() => {
      (
        window as unknown as { fixtureNextSendError: unknown }
      ).fixtureNextSendError = {
        code: "SQLITE_BUSY",
        message: "database is locked",
      };
    });
    await prompt.press("Enter");
    const busy = page.locator(
      '.assistant-error-card[data-error-code="database_busy"]',
    );
    await expect(
      busy.getByRole("heading", { name: "Workspace database busy" }),
    ).toBeVisible();
    await expect(prompt).toHaveValue("Summarize the included files");
    await expect(source).toBeVisible();
    await expect(busy.locator("details")).not.toHaveAttribute("open");
    await page.screenshot({
      path: `test-results/assistant-database-error-${viewport.width}.png`,
    });
    await prompt.fill("Model unavailable fixture");
    await prompt.press("Enter");
    const modelError = page.locator(
      '.chat-message.assistant .assistant-error-card[data-error-code="ai_model_unavailable"]',
    );
    await expect(
      modelError.getByRole("heading", { name: "No AI model loaded" }),
    ).toBeVisible();
    await expect(busy).toHaveCount(0);
    await expect(source).toHaveCount(0);
    await page.screenshot({
      path: `test-results/assistant-model-error-${viewport.width}.png`,
    });
    await modelError.getByText("Technical details", { exact: true }).click();
    await expect(modelError.locator("pre")).toContainText("HTTP 400");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
}

test("project access modes gate real file-action cards, refresh Files, and bypass prompts only in Full access", async ({
  page,
}) => {
  await openFixture(page);
  await sidebarProject(page).click();
  await page.getByRole("button", { name: "Assistant", exact: true }).click();
  const access = page.getByRole("combobox", {
    name: "Assistant access",
    exact: true,
  });
  await expect(access).toHaveText("Read only access");
  const prompt = page.getByRole("textbox", { name: "Your question" });
  await prompt.fill("Save proposal");
  await expect(
    page.getByRole("button", { name: "Send question" }),
  ).toBeEnabled();
  await prompt.press("Enter");
  let action = page.getByRole("region", {
    name: "File change Notes/Prijedlog.md",
    exact: true,
  });
  await expect(
    action.getByRole("button", { name: "Approve once", exact: true }),
  ).toBeVisible();
  await action.getByText("Review file content", { exact: true }).click();
  await expect(action.locator("pre")).toContainText("# Prijedlog");
  await page.screenshot({ path: "test-results/assistant-write-approval.png" });
  expect(await calls(page, "decide_assistant_action")).toHaveLength(0);
  await action
    .getByRole("button", { name: "Approve once", exact: true })
    .click();
  await expect(action).toHaveAttribute("data-action-status", "applied");
  await expect(access).toHaveText("Read only access");
  await page.getByRole("button", { name: "Files", exact: true }).click();
  await page.getByRole("button", { name: "Expand Notes", exact: true }).click();
  await page.getByRole("button", { name: "Prijedlog.md", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Prijedlog", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Assistant", exact: true }).click();
  await page.getByRole("button", { name: "New chat", exact: true }).click();
  await access.click();
  await page
    .getByRole("option", { name: "Allow write access", exact: true })
    .click();
  await expect(access).toHaveText("Allow write access");
  await prompt.fill("Save proposal");
  await expect(
    page.getByRole("button", { name: "Send question" }),
  ).toBeEnabled();
  await prompt.press("Enter");
  action = page.getByRole("region", {
    name: "File change Notes/Prijedlog.md",
    exact: true,
  });
  await expect(action).toHaveAttribute("data-action-status", "applied");
  await expect(
    action.getByRole("button", { name: "Approve once" }),
  ).toHaveCount(0);
  await prompt.fill("Save proposal Secure");
  await prompt.press("Enter");
  const protectedAction = page.getByRole("region", {
    name: "File change Secure/Proposal.md",
    exact: true,
  });
  await expect(protectedAction).toHaveAttribute(
    "data-action-status",
    "pending",
  );
  await protectedAction
    .getByRole("button", { name: "Decline", exact: true })
    .click();
  await expect(protectedAction).toHaveAttribute(
    "data-action-status",
    "declined",
  );
  await access.click();
  const full = page.getByRole("option", { name: "Full access", exact: true });
  await expect(full).toHaveAccessibleDescription(/this project/);
  await page.screenshot({ path: "test-results/assistant-access-options.png" });
  await full.click();
  await expect(access).toHaveText("Full access");
  await page.getByRole("button", { name: "New chat", exact: true }).click();
  await prompt.fill("Save proposal Secure");
  await expect(
    page.getByRole("button", { name: "Send question" }),
  ).toBeEnabled();
  await prompt.press("Enter");
  await expect(
    page.getByRole("region", {
      name: "File change Secure/Proposal.md",
      exact: true,
    }),
  ).toHaveAttribute("data-action-status", "applied");
  await page
    .getByRole("button", { name: "Pin assistant to side", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Secure", exact: true })
    .click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "Include in Assistant", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Remove source Secure", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(await calls(page, "approve_assistant_sources")).toHaveLength(0);
});

for (const viewport of [
  { width: 1440, height: 940 },
  { width: 960, height: 720 },
]) {
  test(`full-width chat, copied snippets, floating composer and history divider work at ${viewport.width}px`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await openFixture(page);
    await sidebarProject(page).click();
    await page.getByRole("button", { name: "Assistant", exact: true }).click();
    const prompt = page.getByRole("textbox", { name: "Your question" });
    await prompt.fill("Code sample fixture");
    await expect(
      page.getByRole("button", { name: "Send question" }),
    ).toBeEnabled();
    await prompt.press("Enter");
    await expect(
      page.getByRole("button", { name: "Copy Markdown", exact: true }),
    ).toBeAttached();
    const normalComposer = (await page
      .locator(".chat-composer")
      .boundingBox())!;
    const normalTranscript = (await page
      .locator(".chat-transcript")
      .boundingBox())!;
    await page
      .getByRole("button", { name: "Use full width", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Use contained width", exact: true }),
    ).toBeVisible();
    expect(
      await page
        .locator(".chat-transcript")
        .evaluate((element) => getComputedStyle(element).maxWidth),
    ).toBe("none");
    const wideComposer = (await page.locator(".chat-composer").boundingBox())!;
    expect(Math.abs(wideComposer.width - normalComposer.width)).toBeLessThan(2);
    if (viewport.width === 1440) {
      const wideTranscript = (await page
        .locator(".chat-transcript")
        .boundingBox())!;
      expect(wideTranscript.width).toBeGreaterThan(normalTranscript.width + 50);
    }
    const divider = page.getByRole("separator", {
      name: "Resize chat history",
      exact: true,
    });
    await divider.focus();
    await divider.press("Home");
    await expect(divider).toHaveAttribute("aria-valuenow", "50");
    await expect(page.locator(".chat-history")).toHaveCSS("width", "50px");
    await expect(
      page
        .getByRole("complementary", { name: "Chat history" })
        .getByRole("button", { name: "Code sample fixture", exact: true }),
    ).toBeVisible();
    await divider.press("End");
    await expect(divider).toHaveAttribute("aria-valuenow", "370");
    const box = (await divider.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + 90);
    await page.mouse.down();
    await page.mouse.move(box.x - 70, box.y + 90);
    await page.mouse.up();
    await expect
      .poll(async () => Number(await divider.getAttribute("aria-valuenow")))
      .toBeLessThan(370);
    await expect
      .poll(async () => Number(await divider.getAttribute("aria-valuenow")))
      .toBeGreaterThanOrEqual(50);
    await page.locator(".assistant-view").evaluate((element) => {
      element.scrollTop = 0;
    });
    await page
      .getByRole("button", { name: "Copy Markdown", exact: true })
      .click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      "# Prijedlog\n\nČitav sadržaj.\n",
    );
    await page
      .getByRole("button", { name: "Copy javascript", exact: true })
      .click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      "const billed = 200;\n",
    );
    await prompt.fill("Draft survives layout changes");
    const overlay = page.locator(".chat-composer-overlay");
    const before = await overlay.boundingBox();
    await page.locator(".assistant-view").evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    const after = await overlay.boundingBox();
    expect(Math.abs(after!.y - before!.y)).toBeLessThan(2);
    await expect(prompt).toBeInViewport();
    const glass = await overlay.evaluate((element) => {
      const shell = getComputedStyle(element);
      const surface = getComputedStyle(element, "::before");
      return {
        shellBlur: shell.backdropFilter,
        shellBackground: shell.backgroundImage,
        blur: surface.backdropFilter,
        background: surface.backgroundImage,
        mask: surface.maskImage,
        composite: surface.maskComposite,
        radius: surface.borderTopLeftRadius,
        inset: surface.left,
      };
    });
    expect(glass.shellBlur).toBe("none");
    expect(glass.shellBackground).toBe("none");
    expect(glass.blur).toBe("blur(18px)");
    expect(glass.background).toContain("23, 24, 25");
    expect(glass.background).toContain("76px");
    expect(glass.background).toContain("rgb(23, 24, 25) 140px");
    expect(glass.mask).toContain("linear-gradient");
    expect(
      glass.composite.split(",").every((mode) => mode.trim() === "intersect"),
    ).toBe(true);
    expect(Number.parseFloat(glass.radius)).toBeGreaterThanOrEqual(28);
    expect(Number.parseFloat(glass.inset)).toBeGreaterThan(0);
    const clear = await page
      .locator(".assistant-view")
      .evaluate((element) =>
        Number.parseFloat(getComputedStyle(element).paddingBottom),
      );
    expect(clear).toBeGreaterThanOrEqual(after!.height);
    await page.screenshot({
      path: `test-results/assistant-full-width-${viewport.width}.png`,
    });
    await page
      .getByRole("button", { name: "Use contained width", exact: true })
      .click();
    await expect(prompt).toHaveValue("Draft survives layout changes");
    const contained = await overlay.boundingBox();
    expect(Math.abs(contained!.width - after!.width)).toBeLessThan(2);
    expect(contained!.width).toBeLessThanOrEqual(858);
    const composer = await page.locator(".chat-composer").boundingBox();
    expect(Math.abs(contained!.width - composer!.width)).toBeLessThan(2);
    await page.locator(".assistant-view").evaluate((element) => {
      element.scrollTop = element.scrollHeight * 0.55;
    });
    await page.screenshot({
      path: `test-results/assistant-faded-glass-${viewport.width}.png`,
    });
    await page.screenshot({
      path: `test-results/assistant-faded-glass-18px-${viewport.width}.png`,
    });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-transparency", value: "reduce" }],
    });
    expect(
      await overlay.evaluate(
        (element) => getComputedStyle(element, "::before").backdropFilter,
      ),
    ).toBe("none");
    expect(
      await page
        .locator(".chat-composer-box")
        .evaluate((element) => getComputedStyle(element).boxShadow),
    ).not.toBe("none");
    await cdp.send("Emulation.setEmulatedMedia", { features: [] });
    await cdp.detach();
    await page
      .getByRole("button", { name: "Use full width", exact: true })
      .click();
    await page.reload();
    await sidebarProject(page).click();
    await page.getByRole("button", { name: "Assistant", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Use contained width", exact: true }),
    ).toBeVisible();
    expect(
      Number(
        await page
          .getByRole("separator", { name: "Resize chat history", exact: true })
          .getAttribute("aria-valuenow"),
      ),
    ).toBeGreaterThanOrEqual(50);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
}

test("composer grows to 350px, shrinks and reflows while docs use an opt-in toggle", async ({
  page,
}) => {
  await openFixture(page);
  await sidebarProject(page).click();
  await page.getByRole("button", { name: "Assistant", exact: true }).click();
  const prompt = page.getByRole("textbox", { name: "Your question" });
  const docs = page.getByRole("button", { name: "Include docs", exact: true });
  await expect(docs).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator(".chat-composer input[type=checkbox]")).toHaveCount(
    0,
  );
  const inactiveColor = await docs.evaluate(
    (element) => getComputedStyle(element).color,
  );
  await docs.click();
  await expect(docs).toHaveAttribute("aria-pressed", "true");
  await expect(docs).toHaveCSS("color", "rgb(158, 211, 187)");
  await expect(docs.locator("svg")).toBeVisible();
  await docs.press("Space");
  await expect(docs).toHaveAttribute("aria-pressed", "false");
  await expect(docs).toHaveCSS("color", inactiveColor);

  const initialHeight = (await prompt.boundingBox())!.height;
  const lines = Array.from(
    { length: 10 },
    (_, index) => `Line ${index + 1}`,
  ).join("\n");
  await prompt.fill(lines);
  const expanded = (await prompt.boundingBox())!.height;
  expect(expanded).toBeGreaterThan(initialHeight + 100);
  expect(expanded).toBeLessThan(350);
  await expect(prompt).toHaveCSS("overflow-y", "hidden");
  await prompt.press("End");
  await prompt.press("Shift+Enter");
  await expect(prompt).toHaveValue(lines + "\n");
  expect(await calls(page, "send_chat_message")).toHaveLength(0);

  await prompt.fill(
    Array.from(
      { length: 45 },
      (_, index) => `Long draft line ${index + 1}`,
    ).join("\n"),
  );
  await expect(prompt).toHaveCSS("height", "350px");
  await expect(prompt).toHaveCSS("overflow-y", "auto");
  expect(
    await prompt.evaluate(
      (element) => element.scrollHeight > element.clientHeight,
    ),
  ).toBe(true);
  const clearance = await page
    .locator(".assistant-view")
    .evaluate((element) =>
      Number.parseFloat(getComputedStyle(element).paddingBottom),
    );
  expect(clearance).toBeGreaterThanOrEqual(
    (await page.locator(".chat-composer-overlay").boundingBox())!.height,
  );
  await page.screenshot({ path: "test-results/assistant-multiline-350.png" });

  await prompt.fill("A short draft");
  await expect(prompt).toHaveCSS("overflow-y", "hidden");
  expect(
    Math.abs((await prompt.boundingBox())!.height - initialHeight),
  ).toBeLessThan(2);
  await prompt.fill("Wrapped content ".repeat(60));
  const wideHeight = (await prompt.boundingBox())!.height;
  await page.setViewportSize({ width: 960, height: 940 });
  await expect
    .poll(async () => (await prompt.boundingBox())!.height)
    .toBeGreaterThan(wideHeight);
  await expect(prompt).toHaveCSS("max-height", "350px");
  await expect(docs.locator("svg")).toBeVisible();
  await prompt.fill("Summarize the overview");
  await docs.click();
  await prompt.press("Enter");
  await expect
    .poll(async () => (await calls(page, "send_chat_message")).length)
    .toBe(1);
  expect((await calls(page, "send_chat_message"))[0].args).toMatchObject({
    projectId: "p0",
    prompt: "Summarize the overview",
    includeOverview: true,
  });
  await expect(prompt).toHaveValue("");
  expect(
    Math.abs((await prompt.boundingBox())!.height - initialHeight),
  ).toBeLessThan(2);
});

test("restores provider and model independently in the three AI modes", async ({
  page,
}) => {
  await openFixture(page);
  const globalAssistant = page.getByRole("button", {
    name: "Global Assistant",
    exact: true,
  });
  const projectAssistant = page.getByRole("button", {
    name: "Assistant",
    exact: true,
  });
  const picker = page.getByRole("combobox", { name: "AI model" });

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("button", { name: "AI connection", exact: true })
    .click();
  await page.getByRole("button", { name: "Show Model options" }).click();
  await expect(
    page.getByRole("option", { name: "local-alternate" }),
  ).toBeVisible();
  await page
    .getByPlaceholder("Add a model to quick pickers")
    .fill("local-alternate");
  await page
    .getByRole("button", { name: "Add preferred model", exact: true })
    .click();
  await expect(
    page.getByRole("button", {
      name: "Remove preferred model local-alternate",
    }),
  ).toBeVisible();

  await globalAssistant.click();
  await picker.click();
  await expect(
    page.getByRole("group", { name: "Preferred · LM Studio" }),
  ).toBeVisible();
  await page
    .getByRole("option", { name: "local-alternate", exact: true })
    .click();
  await expect(picker).toHaveAttribute(
    "value",
    JSON.stringify(["local", "local-alternate"]),
  );

  await sidebarProject(page).click();
  await projectAssistant.click();
  await page
    .getByRole("combobox", { name: "AI provider", exact: true })
    .click();
  await page.getByRole("option", { name: /ChatGPT Codex/ }).click();
  await picker.click();
  await page
    .getByRole("searchbox", { name: "Search AI model options" })
    .fill("codex-fixture");
  await page
    .getByRole("option", { name: "Codex fixture model", exact: true })
    .click();
  await expect(page.getByText("Sends to ChatGPT Codex")).toBeVisible();

  await page.getByRole("button", { name: "Inspect", exact: true }).click();
  await page
    .getByRole("combobox", { name: "AI provider", exact: true })
    .click();
  await page.getByRole("option", { name: /Cursor/ }).click();
  await picker.click();
  await page
    .getByRole("option", { name: "Cursor fixture model", exact: true })
    .click();
  await expect(page.getByText("Sends to Cursor")).toBeVisible();
  await page.getByRole("button", { name: "Close", exact: true }).click();

  await page.reload();
  await globalAssistant.click();
  await expect(picker).toHaveAttribute(
    "value",
    JSON.stringify(["local", "local-alternate"]),
  );
  await sidebarProject(page).click();
  await projectAssistant.click();
  await expect(picker).toHaveAttribute(
    "value",
    JSON.stringify(["codex", "codex-fixture"]),
  );
  await page.getByRole("button", { name: "Inspect", exact: true }).click();
  await expect(picker).toHaveAttribute(
    "value",
    JSON.stringify(["cursor", "cursor-fixture"]),
  );
});

test("reviews focused context before sending and renders an isolated large Markdown preview", async ({
  page,
}) => {
  await openFixture(page);
  await sidebarProject(page).click();
  await page.getByRole("button", { name: "Assistant", exact: true }).click();
  await page.getByRole("button", { name: "Inspect", exact: true }).click();
  const inspector = page.getByRole("dialog", { name: "Project inspector" });
  await inspector.getByRole("combobox", { name: "Scan level" }).click();
  await page
    .getByRole("option", { name: "Deep · 8 levels, plus source signatures" })
    .click();
  await inspector
    .getByText("Focus, exclusions and one-time file access")
    .click();
  await inspector.getByRole("textbox", { name: /Focus folder/ }).fill("docs");
  await inspector
    .getByRole("button", { name: "Scan and review context" })
    .click();
  const send = inspector.getByRole("button", { name: "Send approved context" });
  await expect(send).toBeDisabled();
  expect(await calls(page, "draft_project_overview")).toHaveLength(0);
  expect(
    (await calls(page, "prepare_inspector_context"))[0].args,
  ).toMatchObject({
    options: { level: "deep", focus: "docs", inputKib: 32 },
  });
  await inspector.getByText("Show exact prepared input").click();
  await expect(inspector.getByLabel("Prepared AI input")).toHaveText(
    "Exact fixture payload",
  );
  await inspector.getByRole("checkbox", { name: /approve sending/ }).check();
  await send.click();
  expect((await calls(page, "draft_project_overview"))[0].args).toMatchObject({
    contextId: "fixture-context",
  });
  await inspector
    .getByRole("button", { name: "Preview rendered Markdown" })
    .click();
  const preview = page.getByRole("dialog", { name: "PROJECT.md preview" });
  await expect(
    preview.getByRole("heading", { name: "Reviewed project" }),
  ).toBeVisible();
  expect((await preview.boundingBox())?.width).toBeGreaterThan(620);
  await expect(preview.getByRole("article").locator("a, img")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(preview).toHaveCount(0);
  await expect(
    inspector.getByRole("textbox", { name: "PROJECT.md draft" }),
  ).toHaveValue(/# Reviewed project/);
});

async function fixtureChatSummaries(page: Page, projectId: string | null) {
  return page.evaluate(async (projectId) => {
    const fixture = window as unknown as {
      __TAURI_INTERNALS__: {
        invoke: (
          command: string,
          args: Record<string, unknown>,
        ) => Promise<ChatSummary[]>;
      };
    };
    return fixture.__TAURI_INTERNALS__.invoke("list_chats", { projectId });
  }, projectId);
}

test("history stays chronological when opening an older chat and preserves selection across updates and reload", async ({
  page,
}) => {
  await openFixture(page);
  await sidebarProject(page).click();
  await page.getByRole("button", { name: "Assistant", exact: true }).click();
  const prompt = page.getByRole("textbox", { name: "Your question" });
  const history = page.getByRole("complementary", { name: "Chat history" });
  const titles = () =>
    history
      .locator(".chat-history-item")
      .evaluateAll((rows) => rows.map((row) => row.getAttribute("aria-label")));
  async function send(text: string) {
    await prompt.fill(text);
    await expect(
      page.getByRole("button", { name: "Send question", exact: true }),
    ).toBeEnabled();
    await prompt.press("Enter");
    await expect(
      page.getByText(`Response to ${text}`, { exact: true }),
    ).toBeVisible();
  }
  await send("Older conversation");
  await page.getByRole("button", { name: "New chat", exact: true }).click();
  await send("Newer conversation");
  const before = await fixtureChatSummaries(page, "p0");
  expect(before.map((chat) => chat.title)).toEqual([
    "Newer conversation",
    "Older conversation",
  ]);
  await history
    .getByRole("button", { name: "Older conversation", exact: true })
    .click();
  await expect(
    page.getByText("Response to Older conversation", { exact: true }),
  ).toBeVisible();
  expect(await titles()).toEqual(["Newer conversation", "Older conversation"]);
  expect(
    (await fixtureChatSummaries(page, "p0")).map(({ id, updatedAt }) => ({
      id,
      updatedAt,
    })),
  ).toEqual(before.map(({ id, updatedAt }) => ({ id, updatedAt })));
  await page.evaluate(
    (chatId) =>
      (
        window as unknown as { fixtureRefreshChat: (id: string) => void }
      ).fixtureRefreshChat(chatId),
    before[0].id,
  );
  await expect(
    history.getByRole("button", { name: "Older conversation", exact: true }),
  ).toHaveAttribute("aria-current", "true");
  await expect(
    page.getByText("Response to Older conversation", { exact: true }),
  ).toBeVisible();
  await send("Follow up in the older chat");
  expect(await titles()).toEqual(["Older conversation", "Newer conversation"]);
  const after = await fixtureChatSummaries(page, "p0");
  expect(after[0].updatedAt).toBeGreaterThan(before[1].updatedAt);
  expect(after[0].active).toBe(true);
  await page.reload();
  await sidebarProject(page).click();
  await page.getByRole("button", { name: "Assistant", exact: true }).click();
  await expect(
    page.getByText("Response to Follow up in the older chat", { exact: true }),
  ).toBeVisible();
  expect(await titles()).toEqual(["Older conversation", "Newer conversation"]);
  await expect(
    history.getByRole("button", { name: "Older conversation", exact: true }),
  ).toHaveAttribute("aria-current", "true");
});

for (const viewport of [
  { width: 1440, height: 940 },
  { width: 960, height: 720 },
]) {
  test(`archived chats can be hidden, reopened read-only, restored and isolated from global history at ${viewport.width}px`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await openFixture(page);
    await sidebarProject(page).click();
    await page.getByRole("button", { name: "Assistant", exact: true }).click();
    const history = page.getByRole("complementary", { name: "Chat history" });
    const prompt = page.getByRole("textbox", { name: "Your question" });
    const heading = page.locator(".chat-heading");
    async function send(text: string) {
      await prompt.fill(text);
      await expect(
        page.getByRole("button", { name: "Send question", exact: true }),
      ).toBeEnabled();
      await prompt.press("Enter");
      await expect(
        page.getByText(`Response to ${text}`, { exact: true }),
      ).toBeVisible();
    }
    await send("Keep this project chat");
    await page.getByRole("button", { name: "New chat", exact: true }).click();
    await send("Archive this project chat");
    const before = await fixtureChatSummaries(page, "p0");
    await heading
      .getByRole("button", { name: "Archive chat", exact: true })
      .click();
    await expect(
      history.getByRole("button", {
        name: "Archive this project chat",
        exact: true,
      }),
    ).toHaveCount(0);
    await expect(
      page.getByText("Response to Keep this project chat", { exact: true }),
    ).toBeVisible();
    expect(
      (await fixtureChatSummaries(page, "p0")).find(
        (chat) => chat.title === "Archive this project chat",
      )?.updatedAt,
    ).toBe(before[0].updatedAt);
    await history
      .getByRole("button", { name: "Show archived chats", exact: true })
      .click();
    const archived = history.getByRole("button", {
      name: "Archive this project chat",
      exact: true,
    });
    await expect(archived).toContainText("Archived");
    await archived.click();
    await expect(
      page.getByText("Response to Archive this project chat", { exact: true }),
    ).toBeVisible();
    await expect(prompt).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Send question", exact: true }),
    ).toBeDisabled();
    const sends = (await calls(page, "send_chat_message")).length;
    await page
      .locator(".chat-composer")
      .evaluate((form: HTMLFormElement) => form.requestSubmit());
    expect((await calls(page, "send_chat_message")).length).toBe(sends);
    await history
      .getByRole("button", { name: "Hide archived chats", exact: true })
      .click();
    await expect(archived).toHaveCount(0);
    await expect(prompt).toBeDisabled();
    await expect(
      heading.getByRole("button", { name: "Restore chat", exact: true }),
    ).toBeEnabled();
    await page.screenshot({
      path: `test-results/assistant-archived-${viewport.width}.png`,
    });
    await heading
      .getByRole("button", { name: "Restore chat", exact: true })
      .click();
    await expect(prompt).toBeEnabled();
    await expect(archived).toBeVisible();
    expect(
      (await fixtureChatSummaries(page, "p0")).find(
        (chat) => chat.title === "Archive this project chat",
      )?.updatedAt,
    ).toBe(before[0].updatedAt);
    await heading
      .getByRole("button", { name: "Archive chat", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Global Assistant", exact: true })
      .click();
    await send("A separate global chat");
    await expect(
      history.getByRole("button", {
        name: "Archive this project chat",
        exact: true,
      }),
    ).toHaveCount(0);
    await heading
      .getByRole("button", { name: "Archive chat", exact: true })
      .click();
    const show = history.getByRole("button", {
      name: "Show archived chats",
      exact: true,
    });
    if (await show.count()) await show.click();
    await history
      .getByRole("button", { name: "A separate global chat", exact: true })
      .click();
    await expect(prompt).toBeDisabled();
    await heading
      .getByRole("button", { name: "Restore chat", exact: true })
      .click();
    expect((await fixtureChatSummaries(page, null))[0].archived).toBe(false);
    expect(
      (await fixtureChatSummaries(page, "p0")).find(
        (chat) => chat.title === "Archive this project chat",
      )?.archived,
    ).toBe(true);
    await page.reload();
    await sidebarProject(page).click();
    await page.getByRole("button", { name: "Assistant", exact: true }).click();
    const showProject = history.getByRole("button", {
      name: "Show archived chats",
      exact: true,
    });
    if (await showProject.count()) await showProject.click();
    await history
      .getByRole("button", { name: "Archive this project chat", exact: true })
      .click();
    await expect(prompt).toBeDisabled();
    await expect(
      heading.getByRole("button", { name: "Restore chat", exact: true }),
    ).toBeVisible();
    await history
      .getByRole("button", { name: "New chat", exact: true })
      .click();
    await prompt.fill("Hold this request");
    await expect(
      page.getByRole("button", { name: "Send question", exact: true }),
    ).toBeEnabled();
    await prompt.press("Enter");
    await expect(
      page.getByRole("button", { name: "Stop request", exact: true }),
    ).toBeEnabled();
    await expect(
      heading.getByRole("button", { name: "Archive chat", exact: true }),
    ).toBeDisabled();
  });
}

test("global and project history stay separate and a pending project request can be restored and stopped", async ({
  page,
}) => {
  await openFixture(page);
  const projectAssistant = page.getByRole("button", {
    name: "Assistant",
    exact: true,
  });
  const globalAssistant = page.getByRole("button", {
    name: "Global Assistant",
    exact: true,
  });
  const prompt = page.getByRole("textbox", { name: "Your question" });
  const history = page.getByRole("complementary", { name: "Chat history" });

  await sidebarProject(page).click();
  await projectAssistant.click();
  await prompt.fill("Hold this request");
  await prompt.press("Enter");
  await expect(
    page.getByRole("button", { name: "Stop request" }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Overview", exact: true }).click();
  await expect(
    projectAssistant.locator(".chat-pending-indicator"),
  ).toBeVisible();

  await globalAssistant.click();
  await expect(
    history.getByRole("button", { name: /Hold this request/ }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Include docs", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Choose project context", exact: true })
    .click();
  const scopePicker = page.getByRole("dialog", {
    name: "Include project context",
  });
  await scopePicker.getByRole("button", { name: /Fixture Project/ }).click();
  await scopePicker
    .getByRole("checkbox", { name: "Include Fixture Project Docs" })
    .check();
  await expect(page.getByLabel("Included project context")).toContainText(
    "Fixture Project › Docs",
  );
  await page.screenshot({ path: ".qa/global-scope-picker.png" });
  await scopePicker
    .getByRole("button", { name: "Close project context picker" })
    .click();
  await prompt.fill("Across projects");
  await prompt.press("Enter");
  await expect(page.getByText("Response to Across projects")).toBeVisible();
  expect((await calls(page, "send_chat_message")).at(-1)?.args).toMatchObject({
    projectId: null,
    includeOverview: false,
    scopeProjectIds: ["p0"],
    sourceIds: ["source-0-Docs"],
  });

  await sidebarProject(page).click();
  await projectAssistant.click();
  await expect(
    history.getByRole("button", { name: /Across projects/ }),
  ).toHaveCount(0);
  await expect(
    page.getByText("Hold this request", { exact: true }).last(),
  ).toBeVisible();
  await page.getByRole("button", { name: "Stop request" }).click();
  await expect(page.getByText("Request stopped.")).toBeVisible();
  await expect(projectAssistant.locator(".chat-pending-indicator")).toHaveCount(
    0,
  );

  await page.getByRole("button", { name: "New chat" }).click();
  await prompt.fill("A separate conversation");
  await prompt.press("Enter");
  await expect(
    page.getByText("Response to A separate conversation"),
  ).toBeVisible();
  await history.getByRole("button", { name: /Hold this request/ }).click();
  await expect(page.getByText("Request stopped.")).toBeVisible();
  await globalAssistant.click();
  await sidebarProject(page).click();
  await projectAssistant.click();
  await expect(page.getByText("Request stopped.")).toBeVisible();

  await page
    .getByRole("article", { name: "Your message" })
    .getByRole("button", { name: "Delete message" })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Delete message" })
    .click();
  await expect(page.getByRole("article", { name: "Your message" })).toHaveCount(
    0,
  );
  await page.getByRole("button", { name: "Delete chat" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Delete chat" })
    .click();
  await expect(
    history.getByRole("button", { name: /Hold this request/ }),
  ).toHaveCount(0);
  await expect(
    page.getByText("Response to A separate conversation"),
  ).toBeVisible();
});

test("global assistant browses project files with @ autocomplete", async ({
  page,
}) => {
  await openFixture(page);
  await page
    .getByRole("button", { name: "Global Assistant", exact: true })
    .click();
  const prompt = page.getByRole("textbox", { name: "Your question" });
  await expect(prompt).toHaveAttribute(
    "placeholder",
    "Ask anything · @ or / to include project files",
  );
  await prompt.fill("@Fix");
  await page.getByRole("option", { name: /Fixture Project.*Project/ }).click();
  await expect(prompt).toHaveValue('@"Fixture Project/');
  await page.screenshot({ path: ".qa/global-at-autocomplete.png" });
  await page.getByRole("option", { name: /Docs.*Fixture Project/ }).click();
  await expect(
    page.getByRole("button", { name: "Remove source Docs" }),
  ).toBeVisible();
  await expect(prompt).toHaveValue("");
  await prompt.fill("Summarize these docs");
  await prompt.press("Enter");
  await expect(
    page.getByText("Response to Summarize these docs"),
  ).toBeVisible();
  expect((await calls(page, "send_chat_message")).at(-1)?.args).toMatchObject({
    projectId: null,
    scopeProjectIds: ["p0"],
    sourceIds: ["source-0-Docs"],
  });
});

for (const viewport of [
  { width: 1440, height: 940 },
  { width: 960, height: 640 },
]) {
  test(`long answers and project lists scroll within panes at ${viewport.width}x${viewport.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await openFixture(page);
    await sidebarProject(page).click();
    await page.getByRole("button", { name: "Assistant", exact: true }).click();
    await page
      .getByRole("textbox", { name: "Your question" })
      .fill("Long answer please");
    await page.getByRole("button", { name: "Send question" }).click();
    await expect(
      page.getByRole("heading", { name: "Result 150", exact: true }),
    ).toBeAttached();
    const topbar = await page.locator(".topbar").boundingBox();
    const composer = page.locator(".chat-composer");
    const composerTop = (await composer.boundingBox())!.y;
    const panel = page.locator(".assistant-view");
    await panel.hover();
    await page.mouse.wheel(0, 1500);
    await expect
      .poll(() => panel.evaluate((e) => e.scrollTop))
      .toBeGreaterThan(0);
    const heights = await page.evaluate(() => ({
      viewport: window.innerHeight,
      body: document.body.scrollHeight,
      root: document.getElementById("root")!.scrollHeight,
      document: document.documentElement.scrollHeight,
      scrollY: window.scrollY,
      sidebar: document
        .querySelector(".project-sidebar")!
        .getBoundingClientRect().height,
    }));
    expect(heights.body).toBe(heights.viewport);
    expect(heights.root).toBe(heights.viewport);
    expect(heights.document).toBe(heights.viewport);
    expect(heights.scrollY).toBe(0);
    expect(heights.sidebar).toBe(heights.viewport);
    expect((await page.locator(".topbar").boundingBox())!.y).toBe(topbar!.y);
    await expect(
      composer.getByRole("textbox", { name: "Your question" }),
    ).toBeInViewport();
    expect((await composer.boundingBox())!.y).toBe(composerTop);
    await panel.evaluate((e) => (e.scrollTop = e.scrollHeight));
    await page.mouse.wheel(0, 1000);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    const sidebar = page.locator(".sidebar-scroll");
    await sidebar.hover();
    await page.mouse.wheel(0, 1000);
    await expect
      .poll(() => sidebar.evaluate((e) => e.scrollTop))
      .toBeGreaterThan(0);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    await page.screenshot({
      path: `test-results/scroll-${viewport.width}.png`,
    });
  });
}

test("fixed shortcut previews open full panels and reveal All projects rows", async ({
  page,
}) => {
  await page.setViewportSize({ width: 960, height: 940 });
  await openFixture(page);
  const shortcuts = page.locator(".sidebar-shortcuts");
  const allProjectsScroll = page.locator(".sidebar-projects-scroll");
  const allProjectsFrame = page.locator(".sidebar-projects-frame");
  for (const name of ["Pinned", "Recently opened"]) {
    const section = page.getByRole("button", { name: new RegExp(`^${name}`) });
    if ((await section.getAttribute("aria-expanded")) === "false")
      await section.click();
  }
  expect(
    await page
      .locator("#pinned-projects-list")
      .evaluate((element) => element.closest(".sidebar-shortcuts") !== null),
  ).toBe(true);
  expect(
    await page
      .locator("#recent-projects-list")
      .evaluate((element) => element.closest(".sidebar-shortcuts") !== null),
  ).toBe(true);
  for (let id = 74; id <= 80; id += 1) {
    const project = page.locator(
      `#all-projects-list .sidebar-project[data-project-id="p${id}"]`,
    );
    await project.scrollIntoViewIfNeeded();
    await project.click({ button: "right" });
    await page
      .getByRole("menu", { name: `Actions for Project ${id}` })
      .getByRole("menuitem", { name: "Pin project" })
      .click();
  }
  for (let id = 74; id <= 78; id += 1)
    await page
      .locator(`#all-projects-list .sidebar-project[data-project-id="p${id}"]`)
      .click();
  await expect(
    page.locator("#pinned-projects-list .sidebar-project"),
  ).toHaveCount(4);
  await expect(
    page.locator("#recent-projects-list .sidebar-project"),
  ).toHaveCount(4);
  expect(
    await shortcuts.evaluate(
      (element) => element.scrollHeight <= element.clientHeight,
    ),
  ).toBe(true);

  const libraryProject = page.locator(
    '#all-projects-list .sidebar-project[data-project-id="p80"]',
  );

  await allProjectsScroll.evaluate((element) => (element.scrollTop = 0));
  await expect(allProjectsFrame).toHaveClass(/can-scroll-down/);
  await expect(allProjectsFrame).not.toHaveClass(/can-scroll-up/);
  await page
    .getByRole("button", { name: "View all 7 pinned projects" })
    .click();
  const pinnedPanel = page.getByRole("dialog", {
    name: "All pinned projects",
  });
  await page.screenshot({ path: ".qa/sidebar-shortcut-panel.png" });
  const pinned = pinnedPanel.getByRole("button", { name: "Project 80" });
  await pinned.click();
  await expect(pinned).toBeFocused();
  await expect
    .poll(() => allProjectsScroll.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);
  await expect(allProjectsFrame).toHaveClass(/can-scroll-up/);
  await pinnedPanel
    .getByRole("button", { name: "Close project shortcuts" })
    .click();
  await expect(libraryProject).toBeInViewport();

  await allProjectsScroll.evaluate((element) => (element.scrollTop = 0));
  await page
    .getByRole("button", { name: "View all 5 recently opened projects" })
    .click();
  const recentPanel = page.getByRole("dialog", {
    name: "All recently opened projects",
  });
  const recent = recentPanel.getByRole("button", { name: "Project 80" });
  await recent.click();
  await expect(recent).toBeFocused();
  await expect
    .poll(() => allProjectsScroll.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);
  await recentPanel
    .getByRole("button", { name: "Close project shortcuts" })
    .click();
  await expect(libraryProject).toBeInViewport();
  await page.screenshot({ path: ".qa/sidebar-independent-scroll.png" });
});

test("AI connection presets stay compact and persist independent settings, credentials and preferred models", async ({
  page,
}) => {
  test.setTimeout(60000);
  await openFixture(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("button", { name: "AI connection", exact: true })
    .click();
  const subscriptions = page.getByRole("region", {
    name: "Subscription providers",
  });
  const custom = page.getByRole("region", { name: "Custom providers" });
  expect((await subscriptions.boundingBox())!.y).toBeLessThan(
    (await custom.boundingBox())!.y,
  );
  await expect(custom.getByRole("button", { pressed: true })).toHaveText(
    "LM Studio",
  );
  for (const [label, url] of [
    ["Ollama", "http://127.0.0.1:11434/v1"],
    ["OpenAI", "https://api.openai.com/v1"],
    [
      "Google Gemini",
      "https://generativelanguage.googleapis.com/v1beta/openai",
    ],
    ["OpenRouter", "https://openrouter.ai/api/v1"],
    ["DeepSeek", "https://api.deepseek.com"],
    ["Groq", "https://api.groq.com/openai/v1"],
    ["Mistral", "https://api.mistral.ai/v1"],
  ]) {
    await custom.getByRole("button", { name: label, exact: true }).click();
    await expect(custom.getByLabel("Base URL", { exact: true })).toHaveValue(
      url,
    );
    await expect(custom.getByLabel("Base URL", { exact: true })).toBeEditable();
  }
  await custom.getByRole("button", { name: "OpenAI", exact: true }).click();
  await custom.getByLabel("Enable OpenAI").check();
  await custom.getByLabel("Model", { exact: true }).fill("openai-default");
  await custom.getByRole("button", { name: "Save provider" }).click();
  await expect(
    page.getByText("Settings saved.", { exact: true }),
  ).toBeVisible();
  await custom
    .getByLabel("Base URL", { exact: true })
    .fill("https://gateway.example.test/openai/v1");
  await custom
    .getByLabel("API key", { exact: true })
    .fill("fixture-openai-key");
  await custom.getByRole("button", { name: "Save key", exact: true }).click();
  await expect(custom.getByLabel("API key", { exact: true })).toHaveValue("");
  await expect(custom.getByLabel("Base URL", { exact: true })).toHaveValue(
    "https://gateway.example.test/openai/v1",
  );
  await custom.getByRole("button", { name: "Save provider" }).click();
  await expect(
    custom.getByRole("button", { name: "Remove key", exact: true }),
  ).toBeVisible();
  await custom
    .getByLabel("Preferred models", { exact: true })
    .fill("my-favorite");
  await custom.getByRole("button", { name: "Add preferred model" }).click();
  await expect(
    custom.getByRole("button", { name: "Remove preferred model my-favorite" }),
  ).toBeVisible();
  await custom.getByRole("button", { name: "Groq", exact: true }).click();
  await custom.getByLabel("Enable Groq").check();
  await custom.getByLabel("Model", { exact: true }).fill("groq-default");
  await custom.getByRole("button", { name: "Save provider" }).click();
  await expect(
    custom.getByRole("button", { name: "Remove preferred model my-favorite" }),
  ).toHaveCount(0);
  await expect(
    custom.getByRole("button", { name: "Remove key", exact: true }),
  ).toHaveCount(0);
  await custom
    .getByLabel("API key", { exact: true })
    .fill("fixture-rejected-key");
  await custom.getByRole("button", { name: "Save key", exact: true }).click();
  await expect(custom.getByLabel("API key", { exact: true })).toHaveValue(
    "fixture-rejected-key",
  );
  await expect(
    page.getByText("Fixture credential storage unavailable", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Dismiss error" }).click();
  await custom.getByLabel("API key", { exact: true }).fill("");
  await custom.getByRole("button", { name: "OpenAI", exact: true }).click();
  await expect(custom.getByLabel("Model", { exact: true })).toHaveValue(
    "openai-default",
  );
  await expect(
    custom.getByRole("button", { name: "Remove preferred model my-favorite" }),
  ).toBeVisible();
  await page.locator(".settings-content").evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.screenshot({
    path: ".qa/ai-connections-desktop.png",
    fullPage: true,
  });
  expect(
    (await page.locator(".ai-endpoint-panel").boundingBox())!.height,
  ).toBeLessThan(300);
  await page.setViewportSize({ width: 2165, height: 1375 });
  expect(
    (await page.locator(".ai-connection-page").boundingBox())!.width,
  ).toBeLessThanOrEqual(1120);
  await page.screenshot({
    path: ".qa/ai-connections-wide.png",
    fullPage: true,
  });
  for (const width of [1000, 760]) {
    await page.setViewportSize({ width, height: 940 });
    await expect(custom.getByLabel("API key", { exact: true })).toBeVisible();
    const bounds = await page
      .locator(".settings-content")
      .evaluate((el) => ({ width: el.clientWidth, scroll: el.scrollWidth }));
    expect(bounds.scroll).toBeLessThanOrEqual(bounds.width + 1);
  }
  await custom.getByLabel("Base URL", { exact: true }).scrollIntoViewIfNeeded();
  await expect(custom.getByLabel("API key", { exact: true })).toBeInViewport();
  await page.screenshot({
    path: ".qa/ai-connections-narrow.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 940 });
  await page
    .getByRole("button", { name: "Global Assistant", exact: true })
    .click();
  const picker = page.getByRole("combobox", { name: "AI model" });
  await page
    .getByRole("combobox", { name: "AI provider", exact: true })
    .click();
  await page.getByRole("option", { name: /OpenAI/ }).click();
  await picker.click();
  await expect(
    page.getByRole("group", { name: "Preferred · OpenAI" }),
  ).toBeVisible();
  await page.getByRole("option", { name: "my-favorite", exact: true }).click();
  await expect(picker).toHaveAttribute(
    "value",
    JSON.stringify(["openai", "my-favorite"]),
  );
  await page.reload();
  await page
    .getByRole("button", { name: "Global Assistant", exact: true })
    .click();
  await expect(
    page.getByRole("combobox", { name: "AI model" }),
  ).toHaveAttribute("value", JSON.stringify(["openai", "my-favorite"]));
});

test("two-step AI picker isolates large provider catalogs and Cursor settings explain and test the connection", async ({
  page,
}) => {
  await openFixture(page);
  await page
    .getByRole("button", { name: "Global Assistant", exact: true })
    .click();
  const provider = page.getByRole("combobox", {
    name: "AI provider",
    exact: true,
  });
  const model = page.getByRole("combobox", { name: "AI model", exact: true });
  await provider.click();
  expect(await page.getByRole("option").count()).toBeLessThan(20);
  await expect(
    page.getByRole("option", { name: "Cursor fixture model", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("option", { name: /Cursor/ }).click();
  await expect(model).toHaveText(/Auto/);
  await model.click();
  await expect(
    page.getByRole("option", { name: "Codex fixture model", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("option", { name: "local-alternate", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("searchbox", { name: "Search AI model options" })
    .fill("cursor-239");
  await expect(page.getByRole("option")).toHaveCount(1);
  await page.screenshot({ path: ".qa/ai-picker-search.png" });
  await page
    .getByRole("option", { name: "Cursor model 239", exact: true })
    .click();
  await expect(model).toHaveAttribute(
    "value",
    JSON.stringify(["cursor", "cursor-239"]),
  );
  await page.reload();
  await page
    .getByRole("button", { name: "Global Assistant", exact: true })
    .click();
  await expect(model).toHaveAttribute(
    "value",
    JSON.stringify(["cursor", "cursor-239"]),
  );
  await sidebarProject(page).click();
  await page.getByRole("button", { name: "Assistant", exact: true }).click();
  await page.screenshot({ path: ".qa/ai-picker-toolbar.png" });
  await page.getByRole("button", { name: "Inspect", exact: true }).click();
  await provider.click();
  await page.getByRole("option", { name: /Cursor/ }).click();
  await model.click();
  await page
    .getByRole("searchbox", { name: "Search AI model options" })
    .fill("Cursor model 239");
  await page.screenshot({ path: ".qa/ai-picker-inspector.png" });
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("button", { name: "AI connection", exact: true })
    .click();
  await page
    .getByText("Connection setup & troubleshooting", { exact: true })
    .click();
  await expect(
    page.getByText(/No base URL or API key is needed here/),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Test Cursor connection", exact: true })
    .click();
  await expect(
    page.getByText(
      "Cursor replied successfully using Auto. No project content was sent.",
      { exact: true },
    ),
  ).toBeVisible();
  expect((await calls(page, "test_ai_provider"))[0].args).toEqual({
    provider: "cursor",
  });
  await page.screenshot({ path: ".qa/cursor-connection-help.png" });
});
