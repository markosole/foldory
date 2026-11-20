import { expect, test, type Page } from "@playwright/test";
import type { Bootstrap, Project, Source } from "../src/types";

// Native calls use an isolated in-memory library; no real sources are accessed.
async function fixture(page: Page) {
  await page.addInitScript(() => {
    const sources: Source[] = [
      {
        id: "local",
        name: "Projects",
        path: "H:\\Projects",
        available: true,
        connected: true,
      },
      {
        id: "network",
        name: "Projects",
        path: "\\\\server\\Team\\Projects",
        available: true,
        connected: true,
      },
      {
        id: "archive",
        name: "Archive",
        path: "F:\\Archive",
        available: false,
        connected: true,
      },
      {
        id: "empty",
        name: "Empty source",
        path: "D:\\Empty",
        available: true,
        connected: true,
      },
      {
        id: "disabled",
        name: "Disconnected source",
        path: "E:\\Disabled",
        available: true,
        connected: false,
      },
    ];
    const project = (
      id: string,
      sourceId: string,
      name: string,
      patch: Partial<Project> = {},
    ): Project => ({
      id,
      sourceId,
      name,
      path: `${sources.find((source) => source.id === sourceId)!.path}\\${name}`,
      alias: "",
      client: "",
      tags: [],
      color: "#87cfb0",
      pinned: false,
      hidden: false,
      lastOpened: 0,
      modifiedAt: 0,
      available: true,
      ...patch,
    });
    const projects = [
      project("local-shared", "local", "Shared project", {
        pinned: true,
        lastOpened: 1,
      }),
      project("local-alpha", "local", "Zulu folder", {
        alias: "Alpha project",
      }),
      project("network-shared", "network", "Shared project"),
      project("network-only", "network", "Remote only"),
      project("archived", "archive", "Archived project", { available: false }),
      project("hidden", "local", "Hidden project", { hidden: true }),
      project("disabled-project", "disabled", "Disabled project"),
    ];
    const bootstrap = (): Bootstrap => ({
      sources: structuredClone(sources),
      projects: structuredClone(
        projects.filter(
          (p) => sources.find((s) => s.id === p.sourceId)?.connected,
        ),
      ),
      templates: [],
      settings: {
        tools: [],
        aiBaseUrl: "",
        aiModel: "",
        aiHasKey: false,
        scanIntervalSeconds: 60,
      },
      indexStatus: {
        running: false,
        files: 50,
        projects: 6,
        lastIndexed: 0,
        message: "",
      },
    });
    const calls: { command: string; args: Record<string, unknown> }[] = [];
    Object.assign(window, {
      sourceViewCalls: calls,
      isTauri: true,
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
      __TAURI_INTERNALS__: {
        metadata: { currentWindow: { label: "main" } },
        transformCallback: () => 1,
        invoke: async (command: string, args: Record<string, unknown> = {}) => {
          calls.push({ command, args });
          if (command.startsWith("plugin:")) return 1;
          if (command === "bootstrap" || command === "scan_sources")
            return bootstrap();
          if (
            [
              "list_chats",
              "list_integrations",
              "integration_catalog",
              "list_directory",
              "search_folders",
            ].includes(command)
          )
            return [];
          if (command === "set_source_connected") {
            sources.find((s) => s.id === args.id)!.connected = Boolean(
              args.connected,
            );
            return bootstrap();
          }
          if (command === "touch_project" || command === "update_project") {
            const p = projects.find((item) => item.id === args.id)!;
            Object.assign(
              p,
              command === "touch_project"
                ? { lastOpened: Date.now() }
                : args.patch,
            );
            return structuredClone(p);
          }
          throw new Error(`Unexpected native command: ${command}`);
        },
      },
    });
  });
  await page.goto("/");
}

const sourceGroup = (page: Page, path: string) =>
  page
    .locator(".sidebar-source-group")
    .filter({ has: page.locator(".sidebar-source-path", { hasText: path }) });

test("Source view is opt-in, groups by source identity and remembers toggles and folds", async ({
  page,
}) => {
  await fixture(page);
  const toggle = page.getByRole("button", { name: "Source view", exact: true });
  const all = page.getByRole("button", { name: /^All projects/ });
  const list = page.locator("#all-projects-list");
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(list.locator(".sidebar-project")).toHaveCount(5);
  await expect(list.locator(".sidebar-source-group")).toHaveCount(0);
  await all.click();
  await toggle.focus();
  await page.keyboard.press("Enter");
  await expect(all).toHaveAttribute("aria-expanded", "true");
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(list.locator(".sidebar-source-group")).toHaveCount(4);
  const local = sourceGroup(page, "H:\\Projects");
  const network = sourceGroup(page, "\\\\server\\Team\\Projects");
  await expect(local.locator(".sidebar-project")).toHaveText([
    "Alpha project",
    "Shared project",
  ]);
  await expect(network.locator(".sidebar-project")).toHaveText([
    "Remote only",
    "Shared project",
  ]);
  await expect(local.locator(".sidebar-source-count")).toHaveText("2");
  await expect(sourceGroup(page, "F:\\Archive")).toContainText("Offline");
  await expect(sourceGroup(page, "D:\\Empty")).toContainText(
    "No visible projects.",
  );
  await expect(list).not.toContainText("Hidden project");
  await expect(list).not.toContainText("Disconnected source");
  const localToggle = local.locator(".sidebar-source-toggle");
  await localToggle.focus();
  await page.keyboard.press("Space");
  await expect(localToggle).toHaveAttribute("aria-expanded", "false");
  await expect(
    network.getByRole("button", { name: "Remote only" }),
  ).toBeVisible();
  for (const heading of ["Pinned", "Recently opened"]) {
    const section = page.locator(".sidebar-section").filter({
      has: page.locator(".sidebar-section-title", { hasText: heading }),
    });
    const sectionToggle = section.getByRole("button", {
      name: new RegExp(`^${heading}`),
    });
    await expect(sectionToggle).toHaveAttribute("aria-expanded", "false");
    await expect(sectionToggle.locator(".sidebar-section-count")).toHaveText(
      "1",
    );
    await sectionToggle.click();
    await expect(
      section.getByRole("button", { name: "Shared project" }),
    ).toBeVisible();
  }
  await page.reload();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(localToggle).toHaveAttribute("aria-expanded", "false");
  await all.click();
  await page.reload();
  await expect(all).toHaveAttribute("aria-expanded", "false");
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await all.click();
  await toggle.click();
  await expect(list.locator(".sidebar-project")).toHaveCount(5);
  await expect(list.locator(".sidebar-source-group")).toHaveCount(0);
  await page.reload();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await toggle.click();
  await page.getByRole("textbox", { name: "Filter projects" }).fill("Remote");
  await expect(
    page.getByRole("list", { name: "Matching projects and folders" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Clear project filter" }).click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(localToggle).toHaveAttribute("aria-expanded", "false");
});

test("search keeps a matching pinned project in both pinned and project results", async ({
  page,
}) => {
  await fixture(page);
  await page
    .getByRole("textbox", { name: "Filter projects" })
    .fill("Shared project");
  const pinnedSection = page.locator(".sidebar-section").filter({
    has: page.getByRole("button", { name: /^Pinned/ }),
  });
  await expect(
    pinnedSection.getByRole("button", { name: "Shared project" }),
  ).toBeVisible();
  const results = page.getByRole("list", {
    name: "Matching projects and folders",
  });
  await expect(results).toBeVisible();
  await expect(results.locator(".folder-match-open")).toHaveCount(2);
  await expect(results.locator(".folder-match-open")).toContainText([
    "Shared project",
    "Shared project",
  ]);
});

test("opening a pinned project reveals its matching library row", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.assign(window, { revealedLibraryProjects: [] as string[] });
    HTMLElement.prototype.scrollIntoView = function () {
      const projectId = this.dataset.projectId;
      if (projectId)
        (
          window as unknown as { revealedLibraryProjects: string[] }
        ).revealedLibraryProjects.push(projectId);
    };
  });
  await fixture(page);
  const allProjects = page.getByRole("button", { name: /^All projects/ });
  await allProjects.click();
  await expect(allProjects).toHaveAttribute("aria-expanded", "false");
  await page.getByRole("button", { name: /^Pinned/ }).click();
  await page
    .locator("#pinned-projects-list")
    .getByRole("button", { name: "Shared project" })
    .click();
  await expect(allProjects).toHaveAttribute("aria-expanded", "true");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { revealedLibraryProjects: string[] })
            .revealedLibraryProjects,
      ),
    )
    .toContain("local-shared");
  await expect(
    page.locator(
      '#all-projects-list .sidebar-project[data-project-id="local-shared"]',
    ),
  ).toHaveClass(/active/);
});

test("grouped projects retain selection, context actions and source connection updates", async ({
  page,
}) => {
  await fixture(page);
  await page.getByRole("button", { name: "Source view", exact: true }).click();
  const network = sourceGroup(page, "\\\\server\\Team\\Projects");
  await network
    .getByRole("button", { name: "Shared project", exact: true })
    .click();
  await expect(
    network.getByRole("button", { name: "Shared project", exact: true }),
  ).toHaveClass(/active/);
  await expect
    .poll(() =>
      page.evaluate(() =>
        (
          window as unknown as {
            sourceViewCalls: { command: string; args: { id?: string } }[];
          }
        ).sourceViewCalls
          .filter((call) => call.command === "touch_project")
          .map((call) => call.args.id),
      ),
    )
    .toEqual(["network-shared"]);
  await network
    .getByRole("button", { name: "Remote only" })
    .click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "Hide project", exact: true })
    .click();
  await expect(network.locator(".sidebar-source-count")).toHaveText("1");
  await expect(
    network.getByRole("button", { name: "Remote only" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const row = page
    .locator(".source-row")
    .filter({ hasText: "\\\\server\\Team\\Projects" });
  await row.getByRole("button", { name: "Disconnect", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Disconnect", exact: true })
    .click();
  await expect(network).toHaveCount(0);
  await row.getByRole("button", { name: "Reconnect", exact: true }).click();
  await expect(network.locator(".sidebar-project")).toHaveCount(1);
  await expect(
    page.getByRole("button", { name: "Source view", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
});

test("Source view fits default, minimum and maximum sidebar widths", async ({
  page,
}, testInfo) => {
  await fixture(page);
  await page.getByRole("button", { name: "Source view", exact: true }).click();
  const sidebar = page.getByRole("complementary", { name: "Project library" });
  await sidebar.screenshot({ path: testInfo.outputPath("source-view.png") });
  const resize = page.getByRole("separator", {
    name: "Resize project library",
  });
  await page.setViewportSize({ width: 960, height: 640 });
  for (const key of ["Home", "End"]) {
    await resize.focus();
    await page.keyboard.press(key);
    await expect(sidebar).toHaveCSS(
      "width",
      key === "Home" ? "100px" : "420px",
    );
    await expect
      .poll(() =>
        page
          .locator(".sidebar-scroll")
          .evaluate((el) => el.scrollWidth - el.clientWidth),
      )
      .toBe(0);
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollWidth - window.innerWidth,
        ),
      )
      .toBe(0);
    const toggle = page.getByRole("button", {
      name: "Source view",
      exact: true,
    });
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await sidebar.screenshot({
      path: testInfo.outputPath(
        `source-view-${key === "Home" ? "100" : "420"}.png`,
      ),
    });
  }
});
