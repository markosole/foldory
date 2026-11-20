import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import Settings from "./Settings";
import { AppDialogProvider } from "./AppDialog";
import { api } from "../api";
import type { Bootstrap } from "../types";

vi.mock("../api", () => ({
  api: {
    saveSettings: vi.fn(),
    saveTemplate: vi.fn(),
    setSourceConnected: vi.fn(),
    removeSource: vi.fn(),
    chooseDirectory: vi.fn(),
    detectSupportedTools: vi.fn().mockResolvedValue({
      cursor: { desktop: true, cli: false },
      claude: { desktop: false, cli: true },
      codex: { desktop: true, cli: true },
    }),
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
const data: Bootstrap = {
  sources: [],
  projects: [],
  templates: [
    { id: "base", name: "Standard", directories: ["Docs"], files: [] },
  ],
  settings: {
    tools: [],
    aiBaseUrl: "http://localhost:1234/v1",
    aiModel: "local",
    aiHasKey: false,
    scanIntervalSeconds: 60,
    inspector: {
      outputTokens: 50000,
      timeoutMinutes: 45,
      defaultProfileId: "standard",
      profiles: [
        {
          id: "standard",
          name: "Standard overview",
          prompt: "Summarise the project.",
          templates: [],
        },
      ],
    },
  },
  indexStatus: {
    running: false,
    files: 0,
    projects: 0,
    lastIndexed: 0,
    message: "",
  },
};
afterEach(cleanup);
describe("settings edits", () => {
  it("refreshes templates changed by onboarding while preserving an unsaved template draft", () => {
    const props = { onRefresh: vi.fn(), onError: vi.fn() };
    const { rerender } = render(<Settings data={data} {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Project templates" }));
    const updated = {
      ...data,
      templates: [
        { ...data.templates[0], directories: ["Secure/Docs", "App"] },
      ],
    };
    rerender(<Settings data={updated} {...props} />);
    expect(screen.getByLabelText(/Folders/)).toHaveValue("Secure/Docs\nApp");
    fireEvent.change(screen.getByLabelText(/Folders/), {
      target: { value: "Docs\nMy unsaved folder" },
    });
    rerender(
      <Settings
        data={{
          ...updated,
          templates: [{ ...updated.templates[0], directories: ["Other"] }],
        }}
        {...props}
      />,
    );
    expect(screen.getByLabelText(/Folders/)).toHaveValue(
      "Docs\nMy unsaved folder",
    );
  });
  it("keeps disconnect separate from permanently removing a saved source", async () => {
    vi.mocked(api.setSourceConnected).mockResolvedValue({
      ...data,
      sources: [],
    });
    vi.mocked(api.removeSource).mockResolvedValue({ ...data, sources: [] });
    const withSource: Bootstrap = {
      ...data,
      sources: [
        {
          id: "source-one",
          name: "Projects",
          path: "D:\\Projects",
          available: true,
          connected: true,
        },
      ],
    };
    const onRefresh = vi.fn().mockResolvedValue(undefined);
    render(
      <AppDialogProvider>
        <Settings data={withSource} onRefresh={onRefresh} onError={vi.fn()} />
      </AppDialogProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    const disconnectDialog = await screen.findByRole("dialog", {
      name: "Disconnect “Projects”?",
    });
    expect(disconnectDialog).toBeVisible();
    fireEvent.click(
      within(disconnectDialog).getByRole("button", { name: "Disconnect" }),
    );

    await waitFor(() =>
      expect(api.setSourceConnected).toHaveBeenCalledWith("source-one", false),
    );
    expect(api.removeSource).not.toHaveBeenCalled();
    expect(onRefresh).toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole("button", { name: "Remove Projects source" }),
    );
    const removeDialog = await screen.findByRole("dialog", {
      name: "Remove “Projects”?",
    });
    fireEvent.click(
      within(removeDialog).getByRole("button", { name: "Remove source" }),
    );
    await waitFor(() =>
      expect(api.removeSource).toHaveBeenCalledWith("source-one"),
    );
  });

  it("reconnects a saved source without adding it again", async () => {
    vi.mocked(api.setSourceConnected).mockResolvedValue({
      ...data,
      sources: [],
    });
    render(
      <AppDialogProvider>
        <Settings
          data={{
            ...data,
            sources: [
              {
                id: "source-one",
                name: "Projects",
                path: "D:\\Projects",
                available: false,
                connected: false,
              },
            ],
          }}
          onRefresh={vi.fn()}
          onError={vi.fn()}
        />
      </AppDialogProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    await waitFor(() =>
      expect(api.setSourceConnected).toHaveBeenCalledWith("source-one", true),
    );
  });

  it("detects installed launch modes and persists separate desktop and CLI choices", async () => {
    vi.mocked(api.saveSettings).mockImplementation(async (value) => value);
    render(<Settings data={data} onRefresh={vi.fn()} onError={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Tools & launchers" }));
    const claude = screen.getByRole("switch", {
      name: "Enable Claude launcher",
    });
    await waitFor(() => expect(claude).toBeEnabled());
    fireEvent.click(claude);
    await waitFor(() => expect(claude).toBeChecked());
    expect(api.saveSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({
        supportedTools: expect.objectContaining({
          claude: { enabled: true, desktop: false, cli: true },
        }),
      }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Claude launch options" }),
    );
    expect(
      screen.getByRole("switch", { name: "Enable Claude Desktop" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("switch", { name: "Enable Claude CLI" }),
    ).toBeChecked();
    fireEvent.click(
      screen.getByRole("button", { name: "Codex launch options" }),
    );
    fireEvent.click(
      screen.getByRole("switch", { name: "Enable Codex Desktop" }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("switch", { name: "Enable Codex Desktop" }),
      ).toBeChecked(),
    );
    fireEvent.click(screen.getByRole("switch", { name: "Enable Codex CLI" }));
    await waitFor(() =>
      expect(
        screen.getByRole("switch", { name: "Enable Codex CLI" }),
      ).toBeChecked(),
    );
    fireEvent.click(
      screen.getByRole("switch", { name: "Enable Codex launcher" }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("switch", { name: "Enable Codex launcher" }),
      ).not.toBeChecked(),
    );
    expect(api.saveSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({
        supportedTools: expect.objectContaining({
          codex: { enabled: false, desktop: true, cli: true },
        }),
      }),
    );
  });

  it("keeps the previous launcher preference if saving fails", async () => {
    vi.mocked(api.saveSettings).mockRejectedValueOnce(
      new Error("Could not save"),
    );
    const onError = vi.fn();
    render(<Settings data={data} onRefresh={vi.fn()} onError={onError} />);
    fireEvent.click(screen.getByRole("button", { name: "Tools & launchers" }));
    const cursor = screen.getByRole("switch", {
      name: "Enable Cursor launcher",
    });
    await waitFor(() => expect(cursor).toBeEnabled());
    fireEvent.click(cursor);
    await waitFor(() => expect(onError).toHaveBeenCalledWith("Could not save"));
    expect(cursor).toBeChecked();
  });

  it("preserves unsaved connection input when polling returns equal saved settings", () => {
    const props = { data, onRefresh: vi.fn(), onError: vi.fn() };
    const { rerender } = render(<Settings {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "AI connection" }));
    fireEvent.change(screen.getByLabelText("Model"), {
      target: { value: "unsaved model" },
    });
    rerender(<Settings {...props} data={structuredClone(data)} />);
    expect(screen.getByLabelText("Model")).toHaveValue("unsaved model");
  });

  it("configures and enables Unsloth independently from LM Studio", async () => {
    vi.mocked(api.saveSettings).mockImplementation(async (value) => value);
    render(<Settings data={data} onRefresh={vi.fn()} onError={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "AI connection" }));
    fireEvent.click(screen.getByRole("button", { name: /Unsloth/ }));
    const toggle = screen.getByLabelText("Enable Unsloth");
    expect(toggle).not.toBeChecked();
    fireEvent.click(toggle);
    expect(toggle).toBeChecked();
    fireEvent.change(screen.getByLabelText("Model"), {
      target: { value: "unsloth-model" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save provider" }));
    await waitFor(() =>
      expect(api.saveSettings).toHaveBeenLastCalledWith(
        expect.objectContaining({
          aiProviders: expect.arrayContaining([
            expect.objectContaining({
              provider: "unsloth",
              enabled: true,
              baseUrl: "http://127.0.0.1:8888/v1",
              model: "unsloth-model",
            }),
          ]),
        }),
      ),
    );
  });
  it("keeps a new template draft when the library is refreshed", () => {
    const props = { data, onRefresh: vi.fn(), onError: vi.fn() };
    const { rerender } = render(<Settings {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Project templates" }));
    fireEvent.click(screen.getByRole("combobox", { name: "Template" }));
    fireEvent.click(screen.getByRole("option", { name: "New template" }));
    fireEvent.change(screen.getByLabelText("Template name"), {
      target: { value: "My new template" },
    });
    rerender(<Settings {...props} data={structuredClone(data)} />);
    expect(screen.getByLabelText("Template name")).toHaveValue(
      "My new template",
    );
  });

  it("previews Markdown and converts multiple starter files back into JSON", async () => {
    render(<Settings data={data} onRefresh={vi.fn()} onError={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Project templates" }));
    const json =
      '[{"path":"PROJECT.md", "content":"# {{name}}\\n"}, {"path":"config.txt", "content":"unchanged\\n"}]';
    fireEvent.change(screen.getByLabelText("Starter files JSON"), {
      target: { value: json },
    });
    fireEvent.click(screen.getByRole("button", { name: "Markdown" }));
    fireEvent.click(screen.getByText("Preview PROJECT.md"));
    expect(
      await screen.findByRole("heading", { name: "Example project" }),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "JSON" }));
    expect(screen.getByLabelText("Starter files JSON")).toHaveValue(json);
    fireEvent.click(screen.getByRole("button", { name: "Markdown" }));
    fireEvent.change(screen.getByLabelText("File content 1"), {
      target: { value: "# Updated\n\n## Overview\n" },
    });
    fireEvent.click(screen.getByRole("button", { name: "JSON" }));
    const expected = [
      { path: "PROJECT.md", content: "# Updated\n\n## Overview\n" },
      { path: "config.txt", content: "unchanged\n" },
    ];
    expect(
      JSON.parse(
        (screen.getByLabelText("Starter files JSON") as HTMLTextAreaElement)
          .value,
      ),
    ).toEqual(expected);
    vi.mocked(api.saveTemplate).mockResolvedValue({
      ...data.templates[0],
      files: expected,
    });
    fireEvent.click(screen.getByRole("button", { name: "Save template" }));
    await waitFor(() =>
      expect(api.saveTemplate).toHaveBeenCalledWith({
        ...data.templates[0],
        files: expected,
      }),
    );
    const invalidJson = '[{"path":"PROJECT.md"}';
    fireEvent.change(screen.getByLabelText("Starter files JSON"), {
      target: { value: invalidJson },
    });
    fireEvent.click(screen.getByRole("button", { name: "Markdown" }));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Correct the starter files JSON",
    );
    expect(screen.getByLabelText("Starter files JSON")).toHaveValue(
      invalidJson,
    );
  });

  it("saves generation limits and a default profile with a previewed Markdown attachment", async () => {
    vi.mocked(api.saveSettings).mockImplementation(async (value) => value);
    render(<Settings data={data} onRefresh={vi.fn()} onError={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Project inspector" }));
    fireEvent.change(screen.getByLabelText("Maximum output tokens"), {
      target: { value: "60000" },
    });
    fireEvent.change(screen.getByLabelText("Maximum time in minutes"), {
      target: { value: "70" },
    });
    fireEvent.click(screen.getByRole("button", { name: "New profile" }));
    fireEvent.change(screen.getByLabelText("Profile name"), {
      target: { value: "Handover" },
    });
    fireEvent.change(screen.getByLabelText("Scan prompt"), {
      target: { value: "Draft a handover." },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Add Markdown attachment" }),
    );
    fireEvent.change(screen.getByLabelText("Markdown template 1"), {
      target: { value: "## Runbook\n\n- Steps" },
    });
    fireEvent.click(screen.getByText("Preview template 1"));
    expect(
      await screen.findByRole("heading", { name: "Runbook" }),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Make default" }));
    const id = (screen.getByLabelText("Prompt profile") as HTMLButtonElement)
      .value;
    fireEvent.click(
      screen.getByRole("button", { name: "Save inspector settings" }),
    );
    await waitFor(() =>
      expect(api.saveSettings).toHaveBeenCalledWith({
        ...data.settings,
        inspector: {
          outputTokens: 60000,
          timeoutMinutes: 70,
          defaultProfileId: id,
          profiles: [
            ...data.settings.inspector!.profiles,
            {
              id,
              name: "Handover",
              prompt: "Draft a handover.",
              templates: ["## Runbook\n\n- Steps"],
            },
          ],
        },
      }),
    );
  });
});
