import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { api } from "../api";
import { ASSISTANT_FILES_MIME } from "../assistantSources";
import type {
  AssistantFileAction,
  AssistantSource,
  Project,
  Settings,
  SourcePreparation,
} from "../types";
import type { ChatScope } from "../useChatScope";
import Assistant from "./Assistant";

vi.mock("../api", () => ({
  desktop: true,
  api: {
    prepareAssistantSources: vi.fn(),
    approveAssistantSources: vi.fn(),
    discardAssistantSources: vi.fn(),
    listDirectory: vi.fn(),
    getAssistantAccess: vi.fn(),
    setAssistantAccess: vi.fn(),
  },
}));
vi.mock("../ai", () => ({
  useModelChoice: () => ({
    ready: true,
    prefs: { saving: false, loaded: true },
    destination: "http://local.invalid/v1",
  }),
}));
vi.mock("./AiModelPicker", () => ({ default: () => <div>Test model</div> }));
vi.mock("./Editor", () => ({
  Markdown: ({ content }: { content: string }) => <p>{content}</p>,
}));

const settings: Settings = {
  tools: [],
  aiBaseUrl: "http://local.invalid/v1",
  aiModel: "test",
  aiHasKey: false,
  scanIntervalSeconds: 0,
};
const source: AssistantSource = {
  id: "prepared",
  path: "Docs",
  directory: true,
  fileCount: 2,
  files: ["Docs/a.md", "Docs/b.md"],
  warnings: [],
};
const ready = (sources: AssistantSource[]): SourcePreparation => ({
  status: "ready",
  sources,
});
const excluded: SourcePreparation = {
  status: "approvalRequired",
  approval: {
    id: "approval-excluded",
    kind: "excluded",
    paths: ["Secure/Other/OfferDetails.md"],
    totalPaths: 1,
  },
};

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
});
function makeScope(): ChatScope {
  return {
    chats: [],
    thread: null,
    loading: false,
    busy: false,
    error: "",
    create: vi.fn(async () => true),
    open: vi.fn(async () => true),
    send: vi.fn(async () => true),
    stop: vi.fn(async () => true),
    remove: vi.fn(async () => true),
    removeMessage: vi.fn(async () => true),
    decideAction: vi.fn(async () => true),
    setArchived: vi.fn(async () => true),
  };
}

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  vi.mocked(api.getAssistantAccess).mockResolvedValue({ mode: "readOnly" });
  vi.mocked(api.setAssistantAccess).mockResolvedValue({ mode: "readOnly" });
  vi.mocked(api.prepareAssistantSources).mockResolvedValue(ready([source]));
  vi.mocked(api.approveAssistantSources).mockResolvedValue({
    status: "cancelled",
  });
  vi.mocked(api.discardAssistantSources).mockResolvedValue();
  vi.mocked(api.listDirectory).mockResolvedValue([
    { name: "Docs", path: "Docs", directory: true, size: 0, modifiedAt: 0 },
  ]);
});
afterEach(cleanup);

it("prepares explicit sources once, preserves draft while docking, and submits opaque source IDs", async () => {
  const user = userEvent.setup();
  const scope = makeScope();
  const request = { token: 1, paths: ["Docs"] };
  const view = render(
    <Assistant
      scope={scope}
      projectId="p"
      projectName="Project"
      sourceRequest={request}
      settings={settings}
      onError={vi.fn()}
    />,
  );
  await screen.findByRole("button", { name: "Remove source Docs" });
  await user.type(
    screen.getByRole("textbox", { name: "Your question" }),
    "Summarize the documents",
  );
  view.rerender(
    <Assistant
      scope={scope}
      projectId="p"
      projectName="Project"
      sourceRequest={request}
      docked
      pinned
      onTogglePin={vi.fn()}
      settings={settings}
      onError={vi.fn()}
    />,
  );
  expect(screen.getByRole("textbox")).toHaveValue("Summarize the documents");
  expect(
    screen.queryByRole("complementary", { name: "Chat history" }),
  ).not.toBeInTheDocument();
  expect(api.prepareAssistantSources).toHaveBeenCalledTimes(1);
  await user.click(screen.getByRole("button", { name: "Send question" }));
  await waitFor(() =>
    expect(scope.send).toHaveBeenCalledWith("Summarize the documents", false, [
      "prepared",
    ]),
  );
  expect(
    screen.queryByRole("button", { name: "Remove source Docs" }),
  ).not.toBeInTheDocument();
});

it("uses autocomplete for paths with spaces and cancels app permission without an error", async () => {
  const user = userEvent.setup();
  const scope = makeScope();
  vi.mocked(api.listDirectory).mockResolvedValue([
    {
      name: "Project info",
      path: "Project info",
      directory: true,
      size: 0,
      modifiedAt: 0,
      aiExcluded: true,
      aiExclusionReason: "Global rule",
    },
  ]);
  vi.mocked(api.prepareAssistantSources).mockResolvedValue(excluded);
  render(
    <Assistant
      scope={scope}
      projectId="p"
      projectName="Project"
      settings={settings}
      onError={vi.fn()}
    />,
  );
  await user.type(screen.getByRole("textbox"), "Summarize @Proj");
  const option = await screen.findByRole("option", { name: /Project info/ });
  expect(option).toHaveClass("ai-excluded");
  await user.click(option);
  const dialog = await screen.findByRole("dialog", {
    name: "Include excluded sources?",
  });
  expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
  expect(dialog).toHaveTextContent("follow-up messages");
  fireEvent(dialog, new Event("cancel", { cancelable: true }));
  await waitFor(() =>
    expect(api.approveAssistantSources).toHaveBeenCalledWith(
      "p",
      "approval-excluded",
      false,
    ),
  );
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(api.prepareAssistantSources).toHaveBeenCalledWith("p", [
    "Project info",
  ]);
  expect(scope.send).not.toHaveBeenCalled();
  expect(screen.queryByLabelText("Included sources")).not.toBeInTheDocument();
  expect(screen.getByRole("textbox")).toHaveValue("Summarize @Proj");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it("rejects cross-project drops without preparing content", async () => {
  render(
    <Assistant
      scope={makeScope()}
      projectId="p"
      projectName="Project"
      settings={settings}
      onError={vi.fn()}
    />,
  );
  fireEvent.drop(screen.getByRole("textbox").closest("form")!, {
    dataTransfer: {
      types: [ASSISTANT_FILES_MIME],
      getData: () => JSON.stringify({ projectId: "other", paths: ["Secure"] }),
    },
  });
  expect(await screen.findByRole("alert")).toHaveTextContent("current project");
  expect(api.prepareAssistantSources).not.toHaveBeenCalled();
});

it("requires separate app approval for exclusions and detected credentials before attaching", async () => {
  const user = userEvent.setup();
  const scope = makeScope();
  vi.mocked(api.prepareAssistantSources).mockResolvedValue(excluded);
  vi.mocked(api.approveAssistantSources)
    .mockResolvedValueOnce({
      status: "approvalRequired",
      approval: {
        id: "approval-credentials",
        kind: "credentials",
        paths: ["Secure/Other/OfferDetails.md"],
        totalPaths: 1,
      },
    })
    .mockResolvedValueOnce(ready([{ ...source, path: "Secure" }]));
  render(
    <Assistant
      scope={scope}
      projectId="p"
      projectName="Project"
      sourceRequest={{ token: 1, paths: ["Secure"] }}
      settings={settings}
      onError={vi.fn()}
    />,
  );
  await screen.findByRole("dialog", { name: "Include excluded sources?" });
  expect(screen.queryByLabelText("Included sources")).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Include sources" }));
  await screen.findByRole("dialog", {
    name: "Share detected sensitive content?",
  });
  expect(api.approveAssistantSources).toHaveBeenCalledWith(
    "p",
    "approval-excluded",
    true,
  );
  expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
  await user.click(
    screen.getByRole("button", { name: "Share detected content" }),
  );
  await screen.findByRole("button", { name: "Remove source Secure" });
  expect(api.approveAssistantSources).toHaveBeenCalledWith(
    "p",
    "approval-credentials",
    true,
  );
  expect(scope.send).not.toHaveBeenCalled();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it("cancels pending approval when the assistant is unmounted", async () => {
  vi.mocked(api.prepareAssistantSources).mockResolvedValue(excluded);
  const view = render(
    <Assistant
      scope={makeScope()}
      projectId="p"
      projectName="Project"
      sourceRequest={{ token: 1, paths: ["Secure"] }}
      settings={settings}
      onError={vi.fn()}
    />,
  );
  await screen.findByRole("dialog", { name: "Include excluded sources?" });
  view.unmount();
  await waitFor(() =>
    expect(api.approveAssistantSources).toHaveBeenCalledWith(
      "p",
      "approval-excluded",
      false,
    ),
  );
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it("denies a late approval response instead of opening it in another conversation", async () => {
  const user = userEvent.setup();
  let finish!: (result: SourcePreparation) => void;
  vi.mocked(api.prepareAssistantSources).mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const scope = makeScope();
  scope.chats = [
    {
      id: "other",
      projectId: "p",
      title: "Other chat",
      updatedAt: 0,
      pending: false,
      archived: false,
      active: false,
    },
  ];
  render(
    <Assistant
      scope={scope}
      projectId="p"
      projectName="Project"
      sourceRequest={{ token: 1, paths: ["Secure"] }}
      settings={settings}
      onError={vi.fn()}
    />,
  );
  await waitFor(() => expect(api.prepareAssistantSources).toHaveBeenCalled());
  await user.click(screen.getByRole("button", { name: "Other chat" }));
  finish(excluded);
  await waitFor(() =>
    expect(api.approveAssistantSources).toHaveBeenCalledWith(
      "p",
      "approval-excluded",
      false,
    ),
  );
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it("blocks source reads and sending when unsaved edits cannot be flushed", async () => {
  const user = userEvent.setup();
  const scope = makeScope();
  const beforePrepareSources = vi.fn(async () => {
    throw new Error("Save conflict: finish saving this file.");
  });
  render(
    <Assistant
      scope={scope}
      projectId="p"
      projectName="Project"
      beforePrepareSources={beforePrepareSources}
      settings={settings}
      onError={vi.fn()}
    />,
  );
  await user.type(screen.getByRole("textbox"), 'Summarize @"Docs" please');
  await user.click(screen.getByRole("button", { name: "Send question" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Save conflict");
  expect(beforePrepareSources).toHaveBeenCalledTimes(1);
  expect(api.prepareAssistantSources).not.toHaveBeenCalled();
  expect(scope.send).not.toHaveBeenCalled();
});

it("resolves quoted references on send and retains sources when sending fails", async () => {
  const user = userEvent.setup();
  const scope = makeScope();
  vi.mocked(scope.send).mockResolvedValue(false);
  vi.mocked(api.prepareAssistantSources).mockResolvedValue(
    ready([{ ...source, path: "Project info" }]),
  );
  render(
    <Assistant
      scope={scope}
      projectId="p"
      projectName="Project"
      settings={settings}
      onError={vi.fn()}
    />,
  );
  await user.type(
    screen.getByRole("textbox"),
    'Summarize @"Project info" please',
  );
  await user.click(screen.getByRole("button", { name: "Send question" }));
  await waitFor(() =>
    expect(scope.send).toHaveBeenCalledWith(
      'Summarize @"Project info" please',
      false,
      ["prepared"],
    ),
  );
  expect(api.prepareAssistantSources).toHaveBeenCalledWith("p", [
    "Project info",
  ]);
  expect(
    screen.getByRole("button", { name: "Remove source Project info" }),
  ).toBeInTheDocument();
  expect(screen.getByRole("textbox")).toHaveValue(
    'Summarize @"Project info" please',
  );
});

it("keeps text typed while a selected source is being prepared", async () => {
  const user = userEvent.setup();
  let finish!: (result: SourcePreparation) => void;
  vi.mocked(api.prepareAssistantSources).mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  render(
    <Assistant
      scope={makeScope()}
      projectId="p"
      projectName="Project"
      settings={settings}
      onError={vi.fn()}
    />,
  );
  await user.type(screen.getByRole("textbox"), "Summarize @Doc");
  await user.click(await screen.findByRole("option", { name: "Docs" }));
  await user.type(screen.getByRole("textbox"), " and explain it");
  finish(ready([source]));
  await screen.findByRole("button", { name: "Remove source Docs" });
  expect(screen.getByRole("textbox")).toHaveValue(
    "Summarize @Doc and explain it",
  );
});

it("discards a late prepared snapshot after changing conversations", async () => {
  const user = userEvent.setup();
  let finish!: (result: SourcePreparation) => void;
  vi.mocked(api.prepareAssistantSources).mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const scope = makeScope();
  scope.chats = [
    {
      id: "other-chat",
      projectId: "p",
      title: "Other chat",
      updatedAt: 0,
      pending: false,
      archived: false,
      active: false,
    },
  ];
  render(
    <Assistant
      scope={scope}
      projectId="p"
      projectName="Project"
      sourceRequest={{ token: 1, paths: ["Docs"] }}
      settings={settings}
      onError={vi.fn()}
    />,
  );
  await waitFor(() => expect(api.prepareAssistantSources).toHaveBeenCalled());
  await user.click(screen.getByRole("button", { name: "Other chat" }));
  finish(ready([source]));
  await waitFor(() =>
    expect(api.discardAssistantSources).toHaveBeenCalledWith("p", ["prepared"]),
  );
  expect(
    screen.queryByRole("button", { name: "Remove source Docs" }),
  ).not.toBeInTheDocument();
});

it("verifies access modes from native storage and blocks requests if access cannot be loaded", async () => {
  const user = userEvent.setup();
  vi.mocked(api.getAssistantAccess).mockRejectedValueOnce(
    new Error("database is locked"),
  );
  render(
    <Assistant
      scope={makeScope()}
      projectId="p"
      projectName="Project"
      settings={settings}
      onError={vi.fn()}
    />,
  );
  await screen.findByRole("heading", { name: "Workspace database busy" });
  const picker = screen.getByRole("combobox", { name: "Assistant access" });
  expect(picker).toHaveTextContent("Read only access");
  expect(picker).toBeDisabled();
  await user.type(screen.getByRole("textbox"), "Summarize this project");
  expect(screen.getByRole("button", { name: "Send question" })).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(picker).toBeEnabled());
  await user.click(picker);
  const full = screen.getByRole("option", { name: "Full access" });
  expect(full).toHaveAccessibleDescription(
    /No shell commands or access outside the project/,
  );
  vi.mocked(api.getAssistantAccess).mockResolvedValue({ mode: "full" });
  await user.click(full);
  await waitFor(() => expect(picker).toHaveTextContent("Full access"));
  expect(api.setAssistantAccess).toHaveBeenCalledWith("p", "full");
  expect(picker.querySelector(".access-full")).toBeInTheDocument();
});

it("hides project privileges in the global assistant and flushes before a message without attachments", async () => {
  const user = userEvent.setup();
  const scope = makeScope();
  const flush = vi.fn(async () => {});
  render(
    <Assistant
      scope={scope}
      settings={settings}
      beforePrepareSources={flush}
      onError={vi.fn()}
    />,
  );
  expect(
    screen.queryByRole("combobox", { name: "Assistant access" }),
  ).not.toBeInTheDocument();
  expect(api.getAssistantAccess).not.toHaveBeenCalled();
  await user.type(screen.getByRole("textbox"), "A plain question");
  await user.click(screen.getByRole("button", { name: "Send question" }));
  expect(flush).toHaveBeenCalledTimes(1);
  expect(scope.send).toHaveBeenCalledWith("A plain question", false, []);
});

it("browses a project and includes its files from global @ autocomplete", async () => {
  const user = userEvent.setup();
  const scope = makeScope();
  const projects: Project[] = [
    {
      id: "atlas",
      sourceId: "source",
      path: "C:/Projects/Atlas Notes",
      name: "Atlas Notes",
      alias: "",
      client: "North",
      tags: [],
      color: "#76c7ad",
      pinned: false,
      hidden: false,
      lastOpened: 0,
      modifiedAt: 0,
      available: true,
    },
  ];
  vi.mocked(api.prepareAssistantSources).mockResolvedValue(
    ready([{ ...source, id: "atlas-docs", path: "Docs" }]),
  );
  render(
    <Assistant
      scope={scope}
      projects={projects}
      settings={settings}
      onError={vi.fn()}
    />,
  );

  const input = screen.getByRole("textbox", { name: "Your question" });
  expect(input).toHaveAttribute(
    "placeholder",
    "Ask anything · @ or / to include project files",
  );
  await user.type(input, "Compare @Atl");
  await user.click(
    await screen.findByRole("option", { name: /Atlas Notes.*Project/ }),
  );
  expect(input).toHaveValue('Compare @"Atlas Notes/');
  expect(api.listDirectory).toHaveBeenCalledWith("atlas", "");
  await user.click(
    await screen.findByRole("option", { name: /Docs.*Atlas Notes/ }),
  );

  await screen.findByRole("button", { name: "Remove source Docs" });
  expect(input).toHaveValue("Compare ");
  expect(api.prepareAssistantSources).toHaveBeenCalledWith("atlas", ["Docs"]);
  await user.type(input, "the documentation");
  await user.click(screen.getByRole("button", { name: "Send question" }));
  await waitFor(() =>
    expect(scope.send).toHaveBeenCalledWith(
      "Compare the documentation",
      false,
      ["atlas-docs"],
      ["atlas"],
    ),
  );
});

it("chooses multiple projects from the global plus picker and sends their scope", async () => {
  const user = userEvent.setup();
  const scope = makeScope();
  vi.mocked(api.prepareAssistantSources)
    .mockResolvedValueOnce(
      ready([{ ...source, id: "atlas-source", path: "Docs" }]),
    )
    .mockResolvedValueOnce(
      ready([{ ...source, id: "borealis-source", path: "Docs" }]),
    );
  const projects: Project[] = [
    {
      id: "atlas",
      sourceId: "source",
      path: "C:/Projects/Atlas",
      name: "Atlas",
      alias: "",
      client: "North",
      tags: [],
      color: "#76c7ad",
      pinned: false,
      hidden: false,
      lastOpened: 0,
      modifiedAt: 0,
      available: true,
    },
    {
      id: "borealis",
      sourceId: "source",
      path: "C:/Projects/Borealis",
      name: "Borealis",
      alias: "",
      client: "South",
      tags: [],
      color: "#9b8bd1",
      pinned: false,
      hidden: false,
      lastOpened: 0,
      modifiedAt: 0,
      available: true,
    },
  ];
  render(
    <Assistant
      scope={scope}
      projects={projects}
      settings={settings}
      onError={vi.fn()}
    />,
  );

  expect(
    screen.queryByRole("button", { name: "Include docs" }),
  ).not.toBeInTheDocument();
  await user.click(
    screen.getByRole("button", { name: "Choose project context" }),
  );
  const picker = screen.getByRole("dialog", {
    name: "Include project context",
  });
  expect(picker).toHaveTextContent("choose its overview, docs, or exact files");
  await user.click(within(picker).getByRole("button", { name: /Atlas/ }));
  await user.click(
    await within(picker).findByRole("checkbox", {
      name: "Include Atlas Docs",
    }),
  );
  await user.click(within(picker).getByRole("button", { name: /Borealis/ }));
  await user.click(
    await within(picker).findByRole("checkbox", {
      name: "Include Borealis Docs",
    }),
  );
  expect(screen.getByLabelText("Included project context")).toHaveTextContent(
    "Atlas",
  );
  await user.type(
    screen.getByRole("textbox", { name: "Your question" }),
    "Compare them",
  );
  await user.click(screen.getByRole("button", { name: "Send question" }));
  expect(scope.send).toHaveBeenCalledWith(
    "Compare them",
    false,
    ["atlas-source", "borealis-source"],
    ["atlas", "borealis"],
  );
  expect(api.prepareAssistantSources).toHaveBeenNthCalledWith(1, "atlas", [
    "Docs",
  ]);
  expect(api.prepareAssistantSources).toHaveBeenNthCalledWith(2, "borealis", [
    "Docs",
  ]);
});

const proposedAction: AssistantFileAction = {
  id: "action",
  projectId: "p",
  chatId: "chat",
  messageId: "response",
  path: "Notes/summary.md",
  status: "pending",
  content: "# New summary",
  beforeContent: "# Old summary",
  expectedRevision: "revision",
  reason: "Read only access requires approval.",
  error: null,
  createdAt: 1,
};
function actionScope(action = proposedAction) {
  const scope = makeScope();
  scope.thread = {
    chat: {
      id: "chat",
      projectId: "p",
      title: "Conversation",
      updatedAt: 1,
      pending: false,
      archived: false,
      active: false,
    },
    messages: [
      {
        id: "response",
        role: "assistant",
        content: "Here is the proposed summary.",
        status: "complete",
        createdAt: 1,
        actions: [action],
      },
    ],
  };
  return scope;
}

it("reviews an exact file proposal, flushes first, and approves only once while a decision is pending", async () => {
  const user = userEvent.setup();
  const scope = actionScope();
  const order: string[] = [];
  let finish!: (accepted: boolean) => void;
  const flush = vi.fn(async () => {
    order.push("flush");
  });
  vi.mocked(scope.decideAction).mockImplementation(async () => {
    order.push("decide");
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  render(
    <Assistant
      scope={scope}
      projectId="p"
      projectName="Project"
      settings={settings}
      beforePrepareSources={flush}
      onError={vi.fn()}
    />,
  );
  await user.click(screen.getByText("Review file content"));
  expect(screen.getByText("# Old summary")).toBeVisible();
  expect(screen.getByText("# New summary")).toBeVisible();
  const approve = screen.getByRole("button", { name: "Approve once" });
  await user.dblClick(approve);
  expect(scope.decideAction).toHaveBeenCalledTimes(1);
  expect(scope.decideAction).toHaveBeenCalledWith("chat", "action", true);
  expect(order).toEqual(["flush", "decide"]);
  expect(approve).toBeDisabled();
  finish(true);
  await waitFor(() => expect(approve).toBeEnabled());
});

it("declines without writing and reports an observed applied file only once", async () => {
  const user = userEvent.setup();
  const scope = actionScope();
  const flush = vi.fn(async () => {});
  const onFilesChanged = vi.fn();
  const props = {
    projectId: "p",
    projectName: "Project",
    settings,
    beforePrepareSources: flush,
    onFilesChanged,
    onError: vi.fn(),
  };
  const view = render(<Assistant scope={scope} {...props} />);
  await user.click(screen.getByRole("button", { name: "Decline" }));
  expect(scope.decideAction).toHaveBeenCalledWith("chat", "action", false);
  expect(flush).not.toHaveBeenCalled();
  const applied = actionScope({ ...proposedAction, status: "applied" });
  view.rerender(<Assistant scope={applied} {...props} />);
  await waitFor(() =>
    expect(onFilesChanged).toHaveBeenCalledWith(["Notes/summary.md"]),
  );
  view.rerender(
    <Assistant
      scope={actionScope({ ...proposedAction, status: "applied" })}
      {...props}
    />,
  );
  expect(onFilesChanged).toHaveBeenCalledTimes(1);
  expect(screen.getByText("Saved")).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "Approve once" }),
  ).not.toBeInTheDocument();
});

it("keeps the draft while expanding chat width and collapsing history to its minimum", async () => {
  const user = userEvent.setup();
  const scope = makeScope();
  scope.chats = [
    {
      id: "chat",
      projectId: "p",
      title: "An accessible conversation",
      updatedAt: 1,
      pending: false,
      archived: false,
      active: false,
    },
  ];
  const view = render(
    <Assistant
      scope={scope}
      projectId="p"
      projectName="Project"
      settings={settings}
      onError={vi.fn()}
    />,
  );
  await user.type(screen.getByRole("textbox"), "Keep this draft");
  await user.click(screen.getByRole("button", { name: "Use full width" }));
  expect(view.container.querySelector(".chat-shell")).toHaveClass(
    "chat-full-width",
  );
  const separator = screen.getByRole("separator", {
    name: "Resize chat history",
  });
  separator.focus();
  await user.keyboard("{Home}");
  expect(separator).toHaveAttribute("aria-valuenow", "50");
  expect(view.container.querySelector(".chat-shell")).toHaveClass(
    "chat-history-compact",
  );
  expect(
    screen.getByRole("button", { name: "An accessible conversation" }),
  ).toBeInTheDocument();
  expect(screen.getByRole("textbox")).toHaveValue("Keep this draft");
  expect(localStorage.getItem("foldory.assistant-full-width")).toBe("true");
  expect(localStorage.getItem("foldory.chat-history-width")).toBe("50");
  await user.keyboard("{End}");
  expect(separator).toHaveAttribute("aria-valuenow", "370");
  expect(localStorage.getItem("foldory.chat-history-width")).toBe("370");
});

it("filters archived rows without disturbing chronology or the selected archived conversation", async () => {
  const user = userEvent.setup();
  const scope = actionScope();
  const newest = {
    ...scope.thread!.chat,
    id: "new",
    title: "Newest conversation",
    updatedAt: 30,
    active: false,
  };
  const older = {
    ...scope.thread!.chat,
    id: "old",
    title: "Older archived conversation",
    updatedAt: 20,
    archived: true,
    active: true,
  };
  scope.chats = [newest, older];
  scope.thread = { chat: older, messages: [] };
  render(
    <Assistant
      scope={scope}
      projectId="p"
      projectName="Project"
      settings={settings}
      onError={vi.fn()}
    />,
  );
  const history = screen.getByRole("complementary", { name: "Chat history" });
  expect(
    within(history).queryByRole("button", { name: older.title }),
  ).not.toBeInTheDocument();
  expect(
    screen.getByText(
      "Archived chat. Restore it to send messages or apply file changes.",
    ),
  ).toBeVisible();
  expect(screen.getByRole("textbox")).toBeDisabled();
  expect(screen.getByRole("button", { name: "Send question" })).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "Show archived chats" }));
  expect(
    Array.from(history.querySelectorAll(".chat-history-item"), (item) =>
      item.getAttribute("aria-label"),
    ),
  ).toEqual([newest.title, older.title]);
  expect(
    within(history).getByRole("button", { name: older.title }),
  ).toHaveAttribute("aria-current", "true");
  await user.click(screen.getByRole("button", { name: "Hide archived chats" }));
  expect(screen.getByRole("textbox")).toBeDisabled();
  expect(screen.getByRole("button", { name: "Restore chat" })).toBeEnabled();
  await user.click(screen.getByRole("button", { name: "Restore chat" }));
  expect(scope.setArchived).toHaveBeenCalledWith("old", false);
  expect(scope.send).not.toHaveBeenCalled();
});

it("archives with a scoped operation and prevents archive changes while a response is pending", async () => {
  const user = userEvent.setup();
  const scope = actionScope();
  const props = {
    projectId: "p",
    projectName: "Project",
    settings,
    onError: vi.fn(),
  };
  const view = render(<Assistant scope={scope} {...props} />);
  await user.click(screen.getByRole("button", { name: "Archive chat" }));
  expect(scope.setArchived).toHaveBeenCalledWith("chat", true);
  const pending = actionScope();
  pending.thread!.chat.pending = true;
  view.rerender(<Assistant scope={pending} {...props} />);
  expect(screen.getByRole("button", { name: "Archive chat" })).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "Archive chat" }));
  expect(pending.setArchived).not.toHaveBeenCalled();
});
