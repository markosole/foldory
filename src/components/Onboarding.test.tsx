import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import Onboarding, { normalizeOnboardingEndpoint } from "./Onboarding";
import { secureTemplatePath, templateTree } from "./TemplateBuilder";
import { api } from "../api";
import type { Bootstrap, Template } from "../types";

vi.mock("../api", () => ({
  api: { bootstrap: vi.fn(), saveSettings: vi.fn() },
  call: vi.fn(),
  desktop: false,
}));
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const data: Bootstrap = {
  sources: [],
  projects: [],
  templates: [],
  settings: {
    onboardingCompleted: false,
    tools: [],
    aiBaseUrl: "",
    aiModel: "",
    aiHasKey: false,
    scanIntervalSeconds: 60,
  },
  indexStatus: {
    running: false,
    files: 0,
    projects: 0,
    lastIndexed: 0,
    message: "",
  },
};

describe("onboarding completion", () => {
  it("keeps the wizard open when persistence fails, then retries with the latest settings", async () => {
    const latest = {
      ...data,
      settings: { ...data.settings, scanIntervalSeconds: 180 },
    };
    vi.mocked(api.bootstrap).mockResolvedValue(latest);
    vi.mocked(api.saveSettings)
      .mockRejectedValueOnce(new Error("Disk is unavailable"))
      .mockResolvedValue(latest.settings);
    const onClose = vi.fn();
    const onRefresh = vi.fn().mockResolvedValue(undefined);
    render(<Onboarding data={data} onClose={onClose} onRefresh={onRefresh} />);
    fireEvent.click(screen.getByRole("button", { name: "Skip setup" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Disk is unavailable",
    );
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Skip setup" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(api.saveSettings).toHaveBeenLastCalledWith({
      ...latest.settings,
      onboardingCompleted: true,
    });
    expect(onRefresh).toHaveBeenCalledOnce();
  });
});

describe("endpoint input", () => {
  it("accepts bare loopback IP:port, explicit API prefixes and HTTPS hosts", () => {
    expect(normalizeOnboardingEndpoint("127.0.0.1:1234")).toBe(
      "http://127.0.0.1:1234/v1",
    );
    expect(normalizeOnboardingEndpoint(" http://localhost:4321/api/v2/ ")).toBe(
      "http://localhost:4321/api/v2",
    );
    expect(normalizeOnboardingEndpoint("https://192.168.1.10:9000")).toBe(
      "https://192.168.1.10:9000/v1",
    );
    expect(normalizeOnboardingEndpoint("http://[::1]:1234")).toBe(
      "http://[::1]:1234/v1",
    );
  });
  it("rejects credentials in URLs, query secrets, non-loopback HTTP and malformed URLs", () => {
    for (const value of [
      "https://user:password@example.com/v1",
      "https://example.com/v1?key=abc",
      "https://example.com/#key",
      "http://192.168.1.10:9000",
      "",
      "not a host",
    ])
      expect(() => normalizeOnboardingEndpoint(value)).toThrow();
  });
});

describe("template protection", () => {
  const template: Template = {
    id: "t",
    name: "Client work",
    directories: ["Docs", "Docs/Notes", "App", "Secure"],
    files: [
      { path: "Docs/Notes/client.md", content: "Keep this content" },
      { path: "PROJECT.md", content: "# {{name}}" },
    ],
  };
  it("moves a folder and all its descendants under Secure and can move them back without changing contents", () => {
    const secured = secureTemplatePath(template, "Docs");
    expect(secured.directories).toContain("Secure/Docs/Notes");
    expect(secured.files[0]).toEqual({
      path: "Secure/Docs/Notes/client.md",
      content: "Keep this content",
    });
    expect(secureTemplatePath(secured, "Secure/Docs")).toEqual(template);
    expect(template.files[0].path).toBe("Docs/Notes/client.md");
    const tree = templateTree(secured);
    expect(tree.find(({ name }) => name === "Secure")?.children[0].name).toBe(
      "Docs",
    );
  });
  it("protects individual files and refuses a conflicting destination instead of merging it", () => {
    expect(secureTemplatePath(template, "PROJECT.md").files[1].path).toBe(
      "Secure/PROJECT.md",
    );
    expect(() =>
      secureTemplatePath(
        { ...template, directories: [...template.directories, "Secure/Docs"] },
        "Docs",
      ),
    ).toThrow("already exists");
    expect(secureTemplatePath(template, "Secure")).toBe(template);
  });
  it("handles nested Secure folders and case-insensitive Windows parent paths", () => {
    const nested = {
      ...template,
      directories: ["Docs/Secure", "Docs"],
      files: [
        { path: "Docs/Secure/note.md", content: "Keep it" },
        { path: "docs/readme.md", content: "Read me" },
      ],
    };
    expect(
      secureTemplatePath(nested, "Docs/Secure/note.md").files[0].path,
    ).toBe("Docs/note.md");
    expect(
      templateTree(nested).filter(({ name }) => name.toLowerCase() === "docs"),
    ).toHaveLength(1);
    expect(secureTemplatePath(nested, "Docs").files[1].path).toBe(
      "Secure/Docs/readme.md",
    );
  });
});
