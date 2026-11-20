import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { inspectorApi, type ContextReview } from "../inspectorApi";
import ProjectInspector from "./ProjectInspector";

const localAi = {
  tools: [],
  aiBaseUrl: "http://localhost:1234/v1",
  aiModel: "test-model",
  aiHasKey: false,
  scanIntervalSeconds: 0,
};

vi.mock("../inspectorApi", () => ({
  inspectorApi: {
    writeAccess: vi.fn(),
    setWriteAccess: vi.fn(),
    prepareContext: vi.fn(),
    discardContext: vi.fn(),
    draftOverview: vi.fn(),
    applyOverview: vi.fn(),
  },
}));

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
});
afterEach(cleanup);

const reviewContext: ContextReview = {
  id: "prepared",
  destination: "Local test model",
  inputBytes: 100,
  budgetBytes: 32768,
  outputTokens: 4096,
  prompt: "Reviewed payload",
  systemPrompt: "Draft an overview.",
  tree: ["README.md"],
  documents: [
    {
      path: "README.md",
      content: "# Reviewable evidence",
      truncated: false,
      approved: false,
    },
  ],
  coverage: {
    visited: 2,
    excluded: 1,
    withheldDocuments: 0,
    redactedDocuments: 0,
    omittedDocuments: 0,
    omittedPaths: 0,
    traversalLimited: false,
  },
};

async function scanAndApprove(user: ReturnType<typeof userEvent.setup>) {
  await user.click(
    screen.getByRole("button", { name: "Scan and review context" }),
  );
  const send = await screen.findByRole("button", {
    name: "Send approved context",
  });
  expect(send).toBeDisabled();
  expect(screen.getByRole("combobox", { name: "Scan level" })).toBeDisabled();
  const profile = screen.queryByRole("combobox", { name: "Prompt profile" });
  if (profile) expect(profile).toBeDisabled();
  await user.click(screen.getByRole("checkbox", { name: /approve sending/ }));
  await user.click(send);
}

it("sends the selected profile and shows the provider's response when there is no draft", async () => {
  const user = userEvent.setup();
  vi.mocked(inspectorApi.writeAccess).mockResolvedValue(false);
  vi.mocked(inspectorApi.prepareContext).mockResolvedValue(reviewContext);
  vi.mocked(inspectorApi.draftOverview).mockResolvedValue({
    error: {
      message: "The provider reached the token limit during reasoning.",
      response: {
        status: 200,
        finishReason: "length",
        completionTokens: 50000,
        tokenLimit: 50000,
        bodyExcerpt: '{"choices":[{"message":{"content":null}}]}',
        truncated: false,
      },
    },
  });
  render(
    <ProjectInspector
      projectId="old-project"
      projectName="Old project"
      available
      aiSettings={{
        ...localAi,
        inspector: {
          outputTokens: 50000,
          timeoutMinutes: 45,
          defaultProfileId: "standard",
          profiles: [
            {
              id: "standard",
              name: "Standard overview",
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
      }}
      onClose={vi.fn()}
      onSaved={vi.fn()}
    />,
  );
  const profile = screen.getByRole("combobox", { name: /Prompt profile/ });
  expect(profile).toHaveValue("standard");
  await user.click(profile);
  await user.click(screen.getByRole("option", { name: "Handover" }));
  await user.click(screen.getByRole("combobox", { name: "Scan level" }));
  await user.click(
    screen.getByRole("option", {
      name: "Deep · 8 levels, plus source signatures",
    }),
  );
  await scanAndApprove(user);
  expect(inspectorApi.prepareContext).toHaveBeenLastCalledWith(
    "old-project",
    "handover",
    expect.objectContaining({ level: "deep", inputKib: 32 }),
  );
  expect(inspectorApi.draftOverview).toHaveBeenLastCalledWith(
    "old-project",
    "prepared",
  );
  expect(await screen.findByRole("alert")).toHaveTextContent("token limit");
  await user.click(screen.getByText("Provider response", { exact: true }));
  expect(screen.getByText(/HTTP 200.*Finish reason length/)).toBeVisible();
  expect(screen.getByLabelText("Provider response body")).toHaveTextContent(
    '"content":null',
  );
  expect(
    screen.queryByRole("textbox", { name: "PROJECT.md draft" }),
  ).toBeNull();
});

it("keeps drafts read-only on disk until access and the specific write are approved", async () => {
  const user = userEvent.setup();
  const saved = vi.fn();
  vi.mocked(inspectorApi.writeAccess).mockResolvedValue(false);
  vi.mocked(inspectorApi.prepareContext).mockResolvedValue(reviewContext);
  vi.mocked(inspectorApi.setWriteAccess).mockResolvedValue(true);
  vi.mocked(inspectorApi.draftOverview).mockResolvedValue({
    content: "# Found project\n",
    revision: "prior-revision",
    writeBlocked: null,
  });
  vi.mocked(inspectorApi.applyOverview)
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce({
      path: "PROJECT.md",
      content: "# Edited overview",
      revision: "new-revision",
    });

  render(
    <ProjectInspector
      projectId="old-project"
      projectName="Old project"
      available
      aiSettings={localAi}
      onClose={vi.fn()}
      onSaved={saved}
    />,
  );
  await scanAndApprove(user);
  const editor = await screen.findByRole("textbox", {
    name: "PROJECT.md draft",
  });
  const review = screen.getByRole("button", { name: "Review replacement" });
  expect(editor).toHaveValue("# Found project\n");
  expect(review).toBeDisabled();
  expect(inspectorApi.applyOverview).not.toHaveBeenCalled();

  await user.click(screen.getByRole("button", { name: "Enable full access" }));
  expect(inspectorApi.setWriteAccess).toHaveBeenCalledWith("old-project", true);
  await user.clear(editor);
  await user.type(editor, "# Edited overview");
  await user.click(
    screen.getByRole("button", { name: "Preview rendered Markdown" }),
  );
  const preview = screen.getByRole("dialog", { name: "PROJECT.md preview" });
  expect(
    within(preview).getByRole("heading", { name: "Edited overview" }),
  ).toBeVisible();
  await user.click(within(preview).getByRole("button", { name: "Close" }));
  expect(editor).toHaveValue("# Edited overview");
  await user.click(review);
  expect(inspectorApi.applyOverview).toHaveBeenLastCalledWith(
    "old-project",
    "# Edited overview",
    "prior-revision",
  );
  expect(saved).not.toHaveBeenCalled();
  await user.click(review);
  expect(saved).toHaveBeenCalledTimes(1);
});
