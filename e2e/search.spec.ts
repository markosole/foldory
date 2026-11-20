import { expect, test, type Page } from "@playwright/test";
import type {
  Bootstrap,
  IndexSettings,
  ProjectIndexStats,
  SearchResult,
  Settings,
} from "../src/types";

// All native calls are intercepted. These tests never open a real project source.
async function searchFixture(page: Page, projectCount = 2) {
  await page.addInitScript(
    ({ projectCount }) => {
      const base = {
        sourceId: "source",
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
      const projects = [
        {
          ...base,
          id: "atlas",
          name: "Project Atlas",
          path: "D:\\Fixtures\\Atlas",
        },
        {
          ...base,
          id: "borealis",
          name: "Project Borealis",
          path: "D:\\Fixtures\\Borealis",
        },
      ];
      for (let i = 2; i < projectCount; i++)
        projects.push({
          ...base,
          id: `project-${i}`,
          name: `Project ${String(i + 1).padStart(3, "0")} · ${["Flutter", "PHP", "Rust", "TypeScript", "Python"][i % 5]}`,
          path: `D:\\Fixtures\\Project-${i}`,
        });
      const defaults: IndexSettings = {
        followGitignore: true,
        folderPatterns: [],
        filePatterns: [],
        profiles: [
          {
            id: "vcs",
            name: "Version control",
            description: "Repository metadata and internal files",
            enabled: true,
            folderPatterns: [".git", ".svn", ".hg"],
            filePatterns: [],
          },
          {
            id: "js",
            name: "JavaScript & TypeScript",
            description: "Node dependencies and framework caches",
            enabled: true,
            folderPatterns: ["node_modules", ".next", ".nuxt"],
            filePatterns: ["*.tsbuildinfo"],
          },
          ...[
            "Python",
            "Rust",
            "Go",
            "Java & Kotlin",
            ".NET",
            "PHP",
            "Ruby",
            "Dart & Flutter",
            "C & C++",
            "Swift",
            "Unity & Unreal",
            "Build output",
          ].map((name, i) => ({
            id: `preset-${i}`,
            name,
            description: "Optional generated files and dependencies",
            enabled: false,
            folderPatterns: ["build"],
            filePatterns: ["*.tmp"],
          })),
        ],
      };
      const data: Bootstrap = {
        sources: [
          {
            id: "source",
            name: "Fixtures",
            path: "D:\\Fixtures",
            available: true,
            connected: true,
          },
        ],
        projects,
        templates: [],
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
          files: 128410,
          projects: 2,
          lastIndexed: 1760000000000,
          message: "Indexed 128,410 files and 12,804 folders in 2 projects.",
        },
      };
      const archive: SearchResult = {
        projectId: "atlas",
        projectName: projects[0].name,
        name: "backup_package-10.5.0.zip",
        path: "Other/backup_package-10.5.0.zip",
        excerpt: "",
        directory: false,
        depth: 2,
        matchKind: "substring",
      };
      const folder: SearchResult = {
        projectId: "borealis",
        projectName: projects[1].name,
        path: "Desktop App/BorealisOrders/BorealisOrders",
        name: "BorealisOrders",
        excerpt: "",
        directory: true,
        depth: 3,
        matchKind: "substring",
      };
      const stats: ProjectIndexStats[] = projects.map((project, i) => ({
        projectId: project.id,
        projectName: project.name,
        files: i ? 28410 : 100000,
        folders: i ? 2804 : 10000,
        contentFiles: 2400,
        excludedEntries: 54,
        skippedFiles: 3,
        truncatedFiles: 2,
        lastIndexed: data.indexStatus.lastIndexed,
        durationMs: 1450,
        status: "indexed",
        message: "",
      }));
      if (projectCount > 2) {
        stats.forEach((row, i) => {
          if (i > 1)
            Object.assign(row, {
              files: (i * 8317) % 305000,
              folders: (i * 157) % 12000,
              contentFiles: (i * 393) % 64000,
              excludedEntries: i * 7,
              skippedFiles: i * 3,
              truncatedFiles: i % 4,
              durationMs: 1000 + i * 414,
              lastIndexed: data.indexStatus.lastIndexed - i * 60000,
              status:
                i % 37 === 0 ? "error" : i % 19 === 0 ? "cleared" : "indexed",
              message:
                i % 37 === 0
                  ? "Drive unavailable; previous index retained."
                  : "",
            });
        });
        data.indexStatus.projects = projectCount;
        data.indexStatus.files = stats.reduce((sum, row) => sum + row.files, 0);
        data.indexStatus.message = `Indexed ${data.indexStatus.files.toLocaleString()} files across ${projectCount} projects.`;
      }
      const calls: { command: string; args: Record<string, unknown> }[] = [];
      let callback = 0;
      const entry = (path: string, directory = false) => ({
        path,
        name: path.split("/").pop(),
        directory,
        size: directory ? 0 : 3321892,
        modifiedAt: 0,
      });
      Object.assign(window, {
        fixtureCalls: calls,
        isTauri: true,
        __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
        __TAURI_INTERNALS__: {
          metadata: { currentWindow: { label: "main" } },
          transformCallback: () => ++callback,
          invoke: async (
            command: string,
            args: Record<string, unknown> = {},
          ) => {
            calls.push({ command, args });
            if (command.startsWith("plugin:")) return ++callback;
            if (command === "bootstrap") return structuredClone(data);
            if (
              command === "list_integrations" ||
              command === "integration_catalog"
            )
              return [];
            if (command === "list_chats") return [];
            if (command === "search_files") {
              const query = String(args.query).toLowerCase();
              if (args.mode === "content")
                return [
                  {
                    ...archive,
                    name: "notes.md",
                    path: "notes.md",
                    excerpt: "The searchable documentation",
                  },
                ];
              if (query.includes("backup_package") && args.mode !== "folder")
                return [archive];
              if (query.includes("borea")) return [folder];
              return [];
            }
            if (command === "search_folders")
              return String(args.query).includes("borea")
                ? [
                    folder,
                    {
                      ...folder,
                      path: "Desktop App/BorealisOrders",
                      depth: 2,
                    },
                    { ...folder, path: "", name: projects[1].name, depth: 0 },
                  ]
                : [];
            if (command === "index_defaults") return structuredClone(defaults);
            if (command === "index_statistics") return structuredClone(stats);
            if (command === "save_settings") {
              data.settings = structuredClone(args.settings as Settings);
              data.indexStatus.lastIndexed++;
              return structuredClone(data.settings);
            }
            if (
              command === "clear_project_index" ||
              command === "reindex_project"
            ) {
              const row = stats.find(
                (item) => item.projectId === args.projectId,
              )!;
              row.status =
                command === "clear_project_index" ? "cleared" : "indexed";
              row.files = command === "clear_project_index" ? 0 : 100000;
              data.indexStatus.lastIndexed++;
              return structuredClone(data.indexStatus);
            }
            if (command === "rebuild_index")
              return structuredClone(data.indexStatus);
            if (command === "touch_project")
              return projects.find((project) => project.id === args.id);
            if (command === "list_directory") {
              if (args.path === "Other") return [entry(archive.path)];
              if (args.path === folder.path)
                return [entry(`${folder.path}/orders.cs`)];
              return [entry("Other", true), entry("Desktop App", true)];
            }
            if (command === "read_file")
              throw new Error("This navigation should not open the editor");
            throw new Error(`Unexpected fixture command: ${command}`);
          },
        },
      });
    },
    { projectCount },
  );
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Settings", exact: true }),
  ).toBeVisible();
}

async function noSourceWrites(page: Page) {
  const writes = await page.evaluate(() =>
    (
      window as unknown as { fixtureCalls: { command: string }[] }
    ).fixtureCalls.filter((call) =>
      ["write_file", "create_entry", "create_project", "read_file"].includes(
        call.command,
      ),
    ),
  );
  expect(writes).toEqual([]);
}

test("Ctrl K finds partial and full ZIP names and reveals its containing folder without opening a binary editor", async ({
  page,
}) => {
  await searchFixture(page);
  await page.keyboard.press("Control+k");
  const query = page.getByRole("textbox", { name: "Search files" });
  await query.fill("backup_package");
  await expect(
    page.getByText("backup_package-10.5.0.zip", { exact: true }),
  ).toBeVisible();
  await query.fill("backup_package-10.5.0.zip");
  await expect(page.locator(".search-result")).toHaveCount(1);
  await page.screenshot({ path: "test-results/search-archive.png" });
  await page
    .getByRole("button", {
      name: "Open containing folder for backup_package-10.5.0.zip",
    })
    .click();
  await expect(
    page.getByRole("button", {
      name: "backup_package-10.5.0.zip",
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
  expect(calls).toEqual(
    expect.arrayContaining([
      {
        command: "list_directory",
        args: { projectId: "atlas", path: "Other" },
      },
    ]),
  );
  await noSourceWrites(page);
});

test("sidebar displays ancestor context and level three matches, which open the target directory", async ({
  page,
}) => {
  await searchFixture(page);
  await page.getByRole("textbox", { name: "Filter projects" }).fill("borea");
  await expect(page.getByLabel("Depth 3", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Depth 2", { exact: true })).toBeVisible();
  const matches = page.getByRole("list", {
    name: "Matching projects and folders",
  });
  await expect(matches.getByText("Desktop App", { exact: true })).toBeVisible();
  await expect(
    matches.getByLabel("Project root", { exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: "test-results/search-sidebar-tree.png" });
  await matches.getByRole("button", { name: "BorealisOrders Depth 3" }).click();
  await expect(
    page.getByRole("button", { name: "orders.cs", exact: true }),
  ).toBeVisible();
  await noSourceWrites(page);
});

test("index settings remain contained at 960px and save editable presets with scoped clear/reindex actions", async ({
  page,
}) => {
  await page.setViewportSize({ width: 960, height: 640 });
  await searchFixture(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("button", { name: "Search & indexing" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Search & indexing" }),
  ).toBeVisible();
  await page.screenshot({ path: "test-results/search-settings-960.png" });
  const dimensions = await page.evaluate(() => ({
    body: document.documentElement.scrollWidth,
    viewport: innerWidth,
    panel: document.querySelector(".settings-content")!.scrollWidth,
    panelWidth: document.querySelector(".settings-content")!.clientWidth,
  }));
  expect(dimensions.body).toBeLessThanOrEqual(dimensions.viewport);
  expect(dimensions.panel).toBeLessThanOrEqual(dimensions.panelWidth + 1);
  const scrollRegion = page.getByRole("region", {
    name: "Scrollable project index statistics",
  });
  await expect(
    page.getByRole("table", { name: "Project index statistics" }),
  ).toBeVisible();
  const narrowTable = await scrollRegion.evaluate((element) => ({
    visible: element.clientWidth,
    total: element.scrollWidth,
  }));
  expect(narrowTable.total).toBeGreaterThan(narrowTable.visible);
  await page
    .getByRole("heading", { name: "Index by project" })
    .evaluate((element) => {
      const panel = element.closest(".settings-content");
      if (panel)
        panel.scrollTop +=
          element.getBoundingClientRect().top -
          panel.getBoundingClientRect().top -
          16;
    });
  expect(
    await page
      .locator(".app-shell")
      .evaluate((element) => element.getBoundingClientRect().top),
  ).toBe(0);
  await page.screenshot({ path: "test-results/search-index-table-960.png" });

  await page
    .locator("summary")
    .filter({ hasText: "JavaScript & TypeScript" })
    .click();
  await page
    .getByRole("textbox", { name: "JavaScript & TypeScript folder patterns" })
    .fill("node_modules\n.next\n.turbo");
  await page.setViewportSize({ width: 1440, height: 940 });
  await page
    .getByRole("heading", { name: "Language & tool presets" })
    .evaluate((element) => {
      const panel = element.closest(".settings-content");
      if (panel)
        panel.scrollTop +=
          element.getBoundingClientRect().top -
          panel.getBoundingClientRect().top -
          16;
    });
  await page.screenshot({ path: "test-results/search-exclusion-presets.png" });
  await page
    .getByRole("checkbox", { name: /Follow .gitignore files/ })
    .uncheck();
  await page.getByRole("button", { name: "Save exclusions" }).click();
  await expect(
    page.getByText("Settings saved.", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Clear index for Project Atlas" })
    .click();
  await expect(
    page
      .getByRole("table", { name: "Project index statistics" })
      .getByText("Cleared", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Reindex Project Atlas", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "Index by project" })
    .evaluate((element) => {
      const panel = element.closest(".settings-content");
      if (panel)
        panel.scrollTop +=
          element.getBoundingClientRect().top -
          panel.getBoundingClientRect().top -
          16;
    });
  await page.screenshot({ path: "test-results/search-project-statistics.png" });
  const calls = await page.evaluate(
    () =>
      (
        window as unknown as {
          fixtureCalls: { command: string; args: Record<string, unknown> }[];
        }
      ).fixtureCalls,
  );
  expect(calls).toEqual(
    expect.arrayContaining([
      { command: "clear_project_index", args: { projectId: "atlas" } },
      { command: "reindex_project", args: { projectId: "atlas" } },
    ]),
  );
  const save = calls.find((call) => call.command === "save_settings");
  expect((save!.args.settings as Settings).indexing).toMatchObject({
    followGitignore: false,
    profiles: expect.arrayContaining([
      expect.objectContaining({
        id: "js",
        folderPatterns: ["node_modules", ".next", ".turbo"],
      }),
    ]),
  });
  await noSourceWrites(page);
});

test("wide Settings and a 224-project index table use available space with sortable sticky columns", async ({
  page,
}) => {
  await page.setViewportSize({ width: 2560, height: 1440 });
  await searchFixture(page, 224);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settingsNav = page.getByRole("navigation", {
    name: "Settings sections",
  });
  // The shared Settings layout also expands sources, templates and preferences.
  for (const section of ["Project sources", "Project templates", "General"]) {
    await settingsNav
      .getByRole("button", { name: section, exact: true })
      .click();
    const widths = await page.locator(".settings-content").evaluate((panel) => {
      const card = panel.querySelector(".settings-card")!;
      const style = getComputedStyle(panel);
      return {
        available:
          panel.clientWidth -
          parseFloat(style.paddingLeft) -
          parseFloat(style.paddingRight),
        card: card.getBoundingClientRect().width,
      };
    });
    expect(widths.card).toBeGreaterThan(1500);
    expect(Math.abs(widths.available - widths.card)).toBeLessThan(2);
  }
  await settingsNav.getByRole("button", { name: "Search & indexing" }).click();
  const table = page.getByRole("table", { name: "Project index statistics" });
  await expect(table.getByRole("row")).toHaveCount(225);
  const region = page.getByRole("region", {
    name: "Scrollable project index statistics",
  });
  await region.scrollIntoViewIfNeeded();
  const layout = await region.evaluate((element) => {
    const table = element.querySelector("table")!;
    const panel = document.querySelector(".settings-content")!;
    return {
      scroll: element.scrollWidth,
      width: element.clientWidth,
      table: table.getBoundingClientRect().width,
      panel: panel.clientWidth,
      panelScroll: panel.scrollWidth,
      body: document.documentElement.scrollWidth,
      viewport: innerWidth,
    };
  });
  expect(layout.width).toBeGreaterThan(1500);
  expect(layout.scroll).toBeLessThanOrEqual(layout.width + 1);
  expect(layout.panelScroll).toBeLessThanOrEqual(layout.panel + 1);
  expect(layout.body).toBeLessThanOrEqual(layout.viewport);
  await page.getByRole("button", { name: "Sort by files" }).click();
  await expect(
    table
      .getByRole("columnheader")
      .filter({ has: page.getByRole("button", { name: "Sort by files" }) }),
  ).toHaveAttribute("aria-sort", "descending");
  const fileCounts = await table
    .locator("tbody tr")
    .evaluateAll((rows) =>
      rows.map((row) =>
        Number(row.children[2].textContent!.replaceAll(",", "")),
      ),
    );
  expect(fileCounts).toEqual([...fileCounts].sort((a, b) => b - a));
  await page
    .getByRole("heading", { name: "Index by project" })
    .evaluate((element) => {
      const panel = element.closest(".settings-content");
      if (panel)
        panel.scrollTop +=
          element.getBoundingClientRect().top -
          panel.getBoundingClientRect().top -
          16;
    });
  await page.screenshot({ path: "test-results/search-index-table-2560.png" });
  await region.evaluate((element) => {
    element.scrollTop = 500;
  });
  const sticky = await region.evaluate((element) => ({
    top: element.getBoundingClientRect().top,
    header: element.querySelector("thead th")!.getBoundingClientRect().top,
    scrollTop: element.scrollTop,
  }));
  expect(sticky.scrollTop).toBeGreaterThan(0);
  expect(Math.abs(sticky.header - sticky.top)).toBeLessThanOrEqual(2);
  await page.getByRole("combobox", { name: "Filter index status" }).click();
  await expect(page.locator("select")).toHaveCount(0);
  await page.screenshot({ path: "test-results/custom-index-status.png" });
  await page.getByRole("option", { name: "Error", exact: true }).click();
  await expect(table.locator("tbody tr")).toHaveCount(6);
  await page
    .getByRole("textbox", { name: "Filter projects", exact: true })
    .last()
    .fill("Project 038");
  await expect(table.locator("tbody tr")).toHaveCount(1);
  await expect(
    table.getByText("Drive unavailable; previous index retained."),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Clear filters", exact: true })
    .click();
  await expect(table.getByRole("row")).toHaveCount(225);
  await page
    .locator("summary")
    .filter({ hasText: "JavaScript & TypeScript" })
    .click();
  await page
    .getByRole("heading", { name: "Language & tool presets" })
    .evaluate((element) => {
      const panel = element.closest(".settings-content");
      if (panel)
        panel.scrollTop +=
          element.getBoundingClientRect().top -
          panel.getBoundingClientRect().top -
          16;
    });
  await page.screenshot({ path: "test-results/search-exclusions-2560.png" });
  await noSourceWrites(page);
});
