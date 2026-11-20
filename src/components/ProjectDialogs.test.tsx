import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CreateProject, EditProject } from "./ProjectDialogs";
import { api } from "../api";
import type { Bootstrap, Project } from "../types";
vi.mock("../api", () => ({
  api: { createProject: vi.fn(), updateProject: vi.fn() },
}));
const project: Project = {
  id: "p",
  sourceId: "s",
  path: "D:\\Projects\\New project",
  name: "New project",
  alias: "",
  client: "",
  tags: [],
  color: "#83a9ff",
  pinned: false,
  hidden: false,
  lastOpened: 0,
  modifiedAt: 0,
  available: true,
};
const data: Bootstrap = {
  sources: [
    {
      id: "s",
      path: "D:\\Projects",
      name: "Projects",
      available: true,
      connected: true,
    },
  ],
  projects: [],
  templates: [
    {
      id: "t",
      name: "Standard project",
      directories: ["Docs", "App"],
      files: [{ path: "PROJECT.md", content: "# {{name}}" }],
    },
  ],
  settings: {
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
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
});
beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
});
describe("project dialogs", () => {
  it("creates a project with selected destination and template", async () => {
    const user = userEvent.setup();
    const onCreated = vi.fn();
    vi.mocked(api.createProject).mockResolvedValue(project);
    render(
      <CreateProject
        data={{
          ...data,
          sources: [
            ...data.sources,
            {
              id: "second",
              path: "E:\\Work",
              name: "Work",
              connected: true,
              available: true,
            },
            {
              id: "offline",
              path: "F:\\Archive",
              name: "Archive",
              connected: true,
              available: false,
            },
          ],
          templates: [
            ...data.templates,
            {
              id: "custom",
              name: "Custom project",
              directories: ["src"],
              files: [],
            },
          ],
        }}
        onClose={vi.fn()}
        onCreated={onCreated}
        onSettings={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("combobox", { name: "Destination" }));
    expect(
      screen.getByRole("option", { name: /Archive.*offline/ }),
    ).toHaveAttribute("aria-disabled", "true");
    await user.click(screen.getByRole("option", { name: /Archive.*offline/ }));
    expect(screen.getByRole("combobox", { name: "Destination" })).toHaveValue(
      "s",
    );
    await user.click(screen.getByRole("option", { name: "E:\\Work" }));
    await user.click(
      screen.getByRole("combobox", { name: "Project template" }),
    );
    await user.click(screen.getByRole("option", { name: "Custom project" }));
    await user.type(screen.getByLabelText("Project name"), "New project");
    await user.type(screen.getByLabelText(/Client/), "Acme");
    await user.click(screen.getByRole("button", { name: "Create project" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(project));
    expect(api.createProject).toHaveBeenCalledWith(
      "second",
      "New project",
      "custom",
      "Acme",
    );
  });
  it("keeps unavailable destinations unselectable and requires a usable source", async () => {
    const user = userEvent.setup();
    render(
      <CreateProject
        data={{
          ...data,
          sources: data.sources.map((source) => ({
            ...source,
            available: false,
          })),
        }}
        onClose={vi.fn()}
        onCreated={vi.fn()}
        onSettings={vi.fn()}
      />,
    );
    expect(screen.getByRole("combobox", { name: "Destination" })).toHaveValue(
      "",
    );
    await user.click(screen.getByRole("combobox", { name: "Destination" }));
    expect(screen.getByRole("option", { name: /offline/ })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await user.click(screen.getByRole("option", { name: /offline/ }));
    expect(screen.getByRole("combobox", { name: "Destination" })).toHaveValue(
      "",
    );
    await user.keyboard("{Escape}");
    expect(
      screen.getByRole("button", { name: "Create project" }),
    ).toBeDisabled();
    expect(api.createProject).not.toHaveBeenCalled();
  });
  it("does not submit a traversal path and shows a useful error", async () => {
    const user = userEvent.setup();
    render(
      <CreateProject
        data={data}
        onClose={vi.fn()}
        onCreated={vi.fn()}
        onSettings={vi.fn()}
      />,
    );
    await user.type(screen.getByLabelText("Project name"), "../outside");
    await user.click(screen.getByRole("button", { name: "Create project" }));
    expect(screen.getByRole("alert")).toHaveTextContent("valid Windows");
    expect(api.createProject).not.toHaveBeenCalled();
  });
  it("stores display metadata without changing the folder name", async () => {
    const user = userEvent.setup();
    vi.mocked(api.updateProject).mockResolvedValue({
      ...project,
      alias: "Website",
    });
    render(
      <EditProject project={project} onClose={vi.fn()} onSaved={vi.fn()} />,
    );
    await user.type(screen.getByLabelText(/Display name/), "Website");
    await user.type(screen.getByLabelText(/Tags/), "web, active, web");
    await user.click(screen.getByRole("button", { name: "Save details" }));
    await waitFor(() =>
      expect(api.updateProject).toHaveBeenCalledWith(
        "p",
        expect.objectContaining({ alias: "Website", tags: ["web", "active"] }),
      ),
    );
    expect(
      screen.getByText(/Your folder keeps its original name/),
    ).toHaveTextContent("New project");
  });
});
