import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import type {
  Bootstrap,
  IndexSettings,
  ProjectIndexStats,
  SearchResult,
} from "../types";
import FileSearch from "./FileSearch";
import SidebarFolderSearch, { folderMatchTree } from "./SidebarFolderSearch";
import Settings from "./Settings";

vi.mock("../api", () => ({
  api: {
    searchFiles: vi.fn(),
    searchFolders: vi.fn(),
    indexDefaults: vi.fn(),
    indexStatistics: vi.fn(),
    clearProjectIndex: vi.fn(),
    reindexProject: vi.fn(),
    rebuildIndex: vi.fn(),
    saveSettings: vi.fn(),
  },
}));
const defaults: IndexSettings = {
  followGitignore: true,
  folderPatterns: [],
  filePatterns: [],
  profiles: [
    {
      id: "vcs",
      name: "Version control",
      description: "Repository internals",
      enabled: true,
      folderPatterns: [".git"],
      filePatterns: [],
    },
    {
      id: "js",
      name: "JavaScript",
      description: "Dependencies",
      enabled: false,
      folderPatterns: ["node_modules"],
      filePatterns: [],
    },
  ],
};
const data: Bootstrap = {
  sources: [],
  templates: [],
  projects: [
    {
      id: "atlas",
      sourceId: "source",
      path: "D:/Projects/Atlas",
      name: "Atlas",
      alias: "",
      client: "",
      tags: [],
      color: "",
      pinned: false,
      hidden: false,
      lastOpened: 0,
      modifiedAt: 0,
      available: true,
    },
  ],
  settings: {
    tools: [],
    aiBaseUrl: "",
    aiModel: "",
    aiHasKey: false,
    scanIntervalSeconds: 60,
    indexing: structuredClone(defaults),
  },
  indexStatus: {
    running: false,
    files: 100001,
    projects: 1,
    lastIndexed: 1000,
    message: "Indexed",
  },
};
const archive: SearchResult = {
  projectId: "atlas",
  projectName: "Atlas",
  name: "backup_package-10.5.0.zip",
  path: "Other/backup_package-10.5.0.zip",
  excerpt: "",
  directory: false,
  depth: 2,
  matchKind: "substring",
};
const stats: ProjectIndexStats = {
  projectId: "atlas",
  projectName: "Atlas",
  files: 100001,
  folders: 20,
  contentFiles: 200,
  excludedEntries: 3,
  skippedFiles: 5,
  truncatedFiles: 1,
  lastIndexed: 1000,
  durationMs: 1200,
  status: "indexed",
  message: "",
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.indexDefaults).mockResolvedValue(structuredClone(defaults));
  vi.mocked(api.indexStatistics).mockResolvedValue([stats]);
  vi.mocked(api.saveSettings).mockImplementation(async (settings) => settings);
  vi.mocked(api.clearProjectIndex).mockResolvedValue(data.indexStatus);
  vi.mocked(api.reindexProject).mockResolvedValue(data.indexStatus);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("search result correctness", () => {
  it("offers the current project only once and applies the selected project scope", async () => {
    vi.useFakeTimers();
    vi.mocked(api.searchFiles).mockResolvedValue([archive]);
    render(
      <FileSearch
        data={data}
        selectedId="atlas"
        onOpen={vi.fn()}
        onRefresh={vi.fn()}
        onError={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("combobox", { name: "Search scope" }));
    expect(
      screen.getAllByRole("option", { name: "Current project · Atlas" }),
    ).toHaveLength(1);
    expect(screen.getAllByRole("option")).toHaveLength(2);
    fireEvent.click(
      screen.getByRole("option", { name: "Current project · Atlas" }),
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Search files" }), {
      target: { value: "backup_package" },
    });
    await act(() => vi.advanceTimersByTimeAsync(230));
    expect(api.searchFiles).toHaveBeenLastCalledWith(
      "backup_package",
      "atlas",
      "filename",
    );
    fireEvent.click(screen.getByRole("combobox", { name: "Search scope" }));
    fireEvent.click(screen.getByRole("option", { name: "All projects" }));
    await act(() => vi.advanceTimersByTimeAsync(230));
    expect(api.searchFiles).toHaveBeenLastCalledWith(
      "backup_package",
      null,
      "filename",
    );
  });

  it("ignores a late response from an older query and safely reveals a ZIP's containing folder", async () => {
    vi.useFakeTimers();
    let resolveOld!: (results: SearchResult[]) => void;
    vi.mocked(api.searchFiles)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOld = resolve;
          }),
      )
      .mockResolvedValueOnce([archive]);
    const onOpen = vi.fn();
    render(
      <FileSearch
        data={data}
        selectedId={null}
        onOpen={onOpen}
        onRefresh={vi.fn()}
        onError={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Search files" }), {
      target: { value: "old" },
    });
    await act(() => vi.advanceTimersByTimeAsync(230));
    fireEvent.change(screen.getByRole("textbox", { name: "Search files" }), {
      target: { value: "backup_package-10.5.0.zip" },
    });
    await act(() => vi.advanceTimersByTimeAsync(230));
    await act(async () =>
      resolveOld([{ ...archive, name: "stale.zip", path: "stale.zip" }]),
    );
    expect(screen.queryByText("stale.zip")).not.toBeInTheDocument();
    expect(api.searchFiles).toHaveBeenLastCalledWith(
      archive.name,
      null,
      "filename",
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: `Open containing folder for ${archive.name}`,
      }),
    );
    expect(onOpen).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "atlas",
        path: "Other",
        directory: true,
      }),
    );
  });
  it("clears previous results when a new search fails", async () => {
    vi.useFakeTimers();
    vi.mocked(api.searchFiles)
      .mockResolvedValueOnce([archive])
      .mockRejectedValueOnce(new Error("Database unavailable"));
    render(
      <FileSearch
        data={data}
        selectedId="atlas"
        onOpen={vi.fn()}
        onRefresh={vi.fn()}
        onError={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Search files" }), {
      target: { value: "pkg" },
    });
    await act(() => vi.advanceTimersByTimeAsync(230));
    expect(screen.getByText(archive.name)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Folders" }));
    await act(() => vi.advanceTimersByTimeAsync(230));
    expect(api.searchFiles).toHaveBeenLastCalledWith("pkg", null, "folder");
    expect(screen.queryByText(archive.name)).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Database unavailable");
  });
});

describe("sidebar folder hierarchy", () => {
  const nested: SearchResult = {
    ...archive,
    directory: true,
    path: "Desktop App/BorealisOrders/BorealisOrders",
    name: "BorealisOrders",
    depth: 3,
  };
  it("retains unmatched ancestors and merges duplicate paths", () => {
    const tree = folderMatchTree([
      nested,
      nested,
      { ...nested, path: "Desktop App/BorealisOrders", depth: 2 },
    ]);
    expect(tree).toHaveLength(1);
    expect(tree[0].matched).toBe(false);
    expect(tree[0].children[0].result.name).toBe("Desktop App");
    expect(tree[0].children[0].matched).toBe(false);
    expect(tree[0].children[0].children[0].matched).toBe(true);
    expect(tree[0].children[0].children[0].children).toHaveLength(1);
  });
  it("shows depth labels and opens folders through a directory result", async () => {
    vi.useFakeTimers();
    vi.mocked(api.searchFolders).mockResolvedValue([nested]);
    const onOpen = vi.fn();
    render(
      <SidebarFolderSearch
        query="borea"
        projects={data.projects}
        indexStatus={data.indexStatus}
        onOpen={onOpen}
      />,
    );
    await act(() => vi.advanceTimersByTimeAsync(190));
    expect(screen.getByText("Desktop App")).toBeInTheDocument();
    expect(screen.getByLabelText("Depth 3")).toHaveTextContent("L3");
    fireEvent.click(
      screen.getByRole("button", { name: "BorealisOrders Depth 3" }),
    );
    expect(onOpen).toHaveBeenCalledWith(nested);
  });
});

describe("search settings", () => {
  it("edits presets, adds a custom list and saves normalized exclusions", async () => {
    render(<Settings data={data} onRefresh={vi.fn()} onError={vi.fn()} />);
    fireEvent.click(
      within(
        screen.getByRole("navigation", { name: "Settings sections" }),
      ).getByRole("button", { name: "Search & indexing" }),
    );
    await screen.findByRole("button", { name: "Reset all defaults" });
    fireEvent.click(screen.getByText("JavaScript", { exact: true }));
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Enable JavaScript" }),
    );
    fireEvent.change(
      screen.getByRole("textbox", { name: "JavaScript folder patterns" }),
      { target: { value: "node_modules\n .next\n" } },
    );
    fireEvent.click(
      screen.getByRole("checkbox", { name: /Follow .gitignore files/ }),
    );
    fireEvent.change(
      screen.getByRole("textbox", { name: "Additional folder patterns" }),
      { target: { value: "library\n\nlibrary\n" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Add list" }));
    fireEvent.change(
      screen.getByRole("textbox", { name: "Name for Custom exclusions" }),
      { target: { value: "My build output" } },
    );
    fireEvent.change(
      screen.getByRole("textbox", { name: "My build output file patterns" }),
      { target: { value: "*.tmp" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Save exclusions" }));
    await waitFor(() => expect(api.saveSettings).toHaveBeenCalled());
    const saved = vi.mocked(api.saveSettings).mock.calls[0][0].indexing!;
    expect(saved.followGitignore).toBe(false);
    expect(saved.folderPatterns).toEqual(["library"]);
    expect(saved.profiles.find((profile) => profile.id === "js")).toMatchObject(
      { enabled: true, folderPatterns: ["node_modules", ".next"] },
    );
    expect(saved.profiles[2]).toMatchObject({
      name: "My build output",
      filePatterns: ["*.tmp"],
      enabled: true,
    });
  });
  it("resets individual lists and all defaults, and scopes clear/reindex to the selected project", async () => {
    render(<Settings data={data} onRefresh={vi.fn()} onError={vi.fn()} />);
    fireEvent.click(
      within(
        screen.getByRole("navigation", { name: "Settings sections" }),
      ).getByRole("button", { name: "Search & indexing" }),
    );
    await screen.findByRole("button", { name: "Reindex Atlas" });
    fireEvent.click(screen.getByText("JavaScript", { exact: true }));
    fireEvent.change(
      screen.getByRole("textbox", { name: "JavaScript folder patterns" }),
      { target: { value: "dist" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Reset JavaScript" }));
    expect(
      screen.getByRole("textbox", { name: "JavaScript folder patterns" }),
    ).toHaveValue("node_modules");
    fireEvent.click(screen.getByRole("button", { name: "Add list" }));
    fireEvent.click(screen.getByRole("button", { name: "Reset all defaults" }));
    expect(
      screen.queryByRole("textbox", { name: "Name for Custom exclusions" }),
    ).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Clear index for Atlas" }),
    );
    await waitFor(() =>
      expect(api.clearProjectIndex).toHaveBeenCalledWith("atlas"),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Reindex Atlas" }),
      ).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Reindex Atlas" }));
    await waitFor(() =>
      expect(api.reindexProject).toHaveBeenCalledWith("atlas"),
    );
    expect(api.rebuildIndex).not.toHaveBeenCalled();
    expect(
      within(
        screen.getByText("Index by project").closest("section")!,
      ).getByText("100,001"),
    ).toBeInTheDocument();
  });
});
