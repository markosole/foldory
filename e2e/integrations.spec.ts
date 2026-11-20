import { expect, test, type Page } from "@playwright/test";
import type { Integration } from "../src/integrations/types";

async function fixture(page: Page) {
  await page.addInitScript(() => {
    const manifest = {
      id: "cursor-dashboard",
      name: "Cursor dashboard",
      description:
        "Bring your Cursor project groups into a separate workspace, with their names, paths and colors.",
      configVersion: 1,
      capabilities: ["workspace"],
      permissions: [
        "Read dashboard.projectData from the selected settings file",
        "Check project folder availability",
        "Open a project folder when you select it",
      ],
      fields: [
        {
          key: "settingsPath",
          label: "Settings file",
          kind: "file",
          defaultValue:
            "C:\\ExampleProfile\\AppData\\Roaming\\Cursor\\User\\settings.json",
          help: "Only dashboard.projectData is used. Cursor settings are never modified.",
          extensions: ["json", "jsonc"],
        },
      ],
    };
    let connections: Integration[] = JSON.parse(
      sessionStorage.getItem("integration-fixture") ?? "[]",
    );
    const project = {
      id: "p",
      sourceId: "s",
      name: "Library project",
      path: "H:\\Projects\\Library",
      alias: "",
      client: "",
      tags: [],
      pinned: true,
      hidden: false,
      color: "#87cfb0",
      lastOpened: 1,
      modifiedAt: 0,
      available: true,
    };
    const data = {
      projects: [project],
      sources: [
        { id: "s", name: "Projects", path: "H:\\Projects", available: true },
      ],
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
        files: 0,
        projects: 1,
        lastIndexed: 0,
        message: "",
      },
    };
    const colors = [
      "#efb567",
      "#79deec",
      "#93dfb8",
      "#e292c0",
      "#e6db6c",
      "#89a5d8",
    ];
    const group = (name: string, id: string, count: number) => ({
      id,
      name,
      projects: Array.from({ length: count }, (_, i) => ({
        id: `${id}-${i}`,
        name: [
          "NodeJS Application",
          "NodePBXMonitor",
          "Simple NodeJS SocketIO Server",
          "AccessLogParser",
          "ResourceMonitor",
          "ShareAndStore",
        ][i % 6],
        path: `H:\\Projects\\${name}\\Project ${i}`,
        color: colors[i % 6],
        pathStatus: i === 3 ? "missing" : "available",
        pathMessage: i === 3 ? "Folder not found" : "Folder exists",
      })),
    });
    const workspace = {
      groups: [
        group("Node JS Projects", "g1", 6),
        group("Terminal Monitoring", "g2", 3),
        group("Coastline Projects", "g3", 2),
      ],
      checkedAt: Date.now(),
      warnings: [],
    };
    const calls: string[] = [];
    Object.assign(window, {
      isTauri: true,
      integrationCalls: calls,
      failIntegrationRefresh: false,
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
      __TAURI_INTERNALS__: {
        metadata: { currentWindow: { label: "main" } },
        transformCallback: () => 1,
        invoke: async (command: string, args: Record<string, unknown> = {}) => {
          calls.push(command);
          if (command.startsWith("plugin:")) return 1;
          if (command === "bootstrap") return structuredClone(data);
          if (command === "list_chats") return [];
          if (command === "integration_catalog") return [manifest];
          if (command === "list_integrations")
            return structuredClone(connections);
          if (command === "save_integration") {
            const item = args.integration as Integration;
            connections = [
              ...connections.filter((i) => i.id !== item.id),
              item,
            ];
            sessionStorage.setItem(
              "integration-fixture",
              JSON.stringify(connections),
            );
            return structuredClone(item);
          }
          if (command === "remove_integration") {
            connections = connections.filter((i) => i.id !== args.id);
            sessionStorage.setItem(
              "integration-fixture",
              JSON.stringify(connections),
            );
            return null;
          }
          if (command === "integration_workspace") {
            if (
              (window as unknown as { failIntegrationRefresh: boolean })
                .failIntegrationRefresh
            )
              throw new Error("Cannot read Cursor settings file");
            return structuredClone(workspace);
          }
          if (command === "open_integration_project") return null;
          if (command === "choose_integration_file")
            return "H:\\Profiles\\Cursor\\settings.json";
          if (command === "touch_project") return project;
          if (command === "read_file")
            return { content: "# Library", path: "PROJECT.md", revision: "1" };
          throw new Error(`Unexpected command: ${command}`);
        },
      },
    });
  });
  await page.goto("/");
}

async function openSettings(page: Page) {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Integrations", exact: true }).click();
}

test("integration lifecycle, grouped workspace, availability, filtering, refresh and persistence", async ({
  page,
}) => {
  await fixture(page);
  const all = page.getByRole("button", { name: /^All projects/ });
  await all.click();
  await expect(all).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("#all-projects-list")).toBeHidden();
  await page.getByRole("button", { name: /^Pinned/ }).click();
  await expect(
    page
      .locator(".sidebar-section")
      .filter({ hasText: "Pinned" })
      .getByRole("button", { name: "Library project" }),
  ).toBeVisible();
  await openSettings(page);
  await page
    .getByRole("button", { name: "Add integration", exact: true })
    .click();
  await expect(page.getByLabel("Settings file", { exact: true })).toHaveValue(
    /Cursor\\User\\settings.json$/,
  );
  await page.getByRole("button", { name: "Browse Settings file" }).click();
  await expect(page.getByLabel("Settings file", { exact: true })).toHaveValue(
    "H:\\Profiles\\Cursor\\settings.json",
  );
  await page.getByLabel("Workspace name").fill("Cursor projects");
  await page.getByRole("button", { name: "Save integration" }).click();
  await expect(page.getByRole("status")).toContainText("Integration saved");
  await page.screenshot({ path: "test-results/integration-settings.png" });
  await page
    .getByRole("button", { name: "Open workspace", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Cursor projects" }),
  ).toBeVisible();
  await expect(page.locator(".integration-project-card")).toHaveCount(11);
  await expect(
    page.getByRole("button", { name: "AccessLogParser — Folder not found" }),
  ).toBeDisabled();
  await page.screenshot({ path: "test-results/integration-workspace.png" });
  await page.setViewportSize({ width: 960, height: 640 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    960,
  );
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(
    640,
  );
  await page.screenshot({ path: "test-results/integration-workspace-960.png" });
  await page.setViewportSize({ width: 1440, height: 940 });
  const group = page.getByRole("button", { name: "Node JS Projects 6" });
  await group.click();
  await expect(group).toHaveAttribute("aria-expanded", "false");
  await page
    .getByRole("textbox", { name: "Filter integration projects" })
    .fill("AccessLogParser");
  await expect(page.locator(".integration-project-card")).toHaveCount(1);
  await expect(
    page.getByRole("button", { name: "Node JS Projects 1" }),
  ).toHaveAttribute("aria-expanded", "true");
  await page.getByRole("button", { name: "Clear integration filter" }).click();
  await expect(group).toHaveAttribute("aria-expanded", "false");
  await group.click();
  await page
    .getByRole("button", {
      name: "NodeJS Application — Folder exists — Open folder",
    })
    .first()
    .click();
  expect(
    await page.evaluate(
      () =>
        (
          window as unknown as { integrationCalls: string[] }
        ).integrationCalls.filter((c) => c === "open_integration_project")
          .length,
    ),
  ).toBe(1);
  await page.evaluate(() => {
    (
      window as unknown as { failIntegrationRefresh: boolean }
    ).failIntegrationRefresh = true;
  });
  await page.getByRole("button", { name: "Refresh workspace" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Showing the previous snapshot",
  );
  await expect(
    page.locator(".integration-project-card").first(),
  ).toBeDisabled();
  await page.evaluate(() => {
    (
      window as unknown as { failIntegrationRefresh: boolean }
    ).failIntegrationRefresh = false;
  });
  await page.getByRole("button", { name: "Refresh workspace" }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.locator(".integration-project-card").first()).toBeEnabled();
  await page.reload();
  await expect(
    page.getByRole("button", { name: /^All projects/ }),
  ).toHaveAttribute("aria-expanded", "false");
  await expect(
    page.getByRole("button", { name: "Cursor projects", exact: true }),
  ).toBeVisible();
  const workspaces = page.getByRole("button", { name: /^Workspaces/ });
  await expect(workspaces).toHaveAttribute("aria-expanded", "true");
  await workspaces.click();
  await expect(
    page.getByRole("button", { name: "Cursor projects", exact: true }),
  ).toBeHidden();
  await workspaces.click();
  await openSettings(page);
  await page.getByRole("button", { name: "Disable Cursor projects" }).click();
  await expect(
    page.getByRole("button", { name: "Cursor projects", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Enable Cursor projects" }).click();
  await expect(
    page.getByRole("button", { name: "Cursor projects", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Configure Cursor projects" }).click();
  await page.getByLabel("Workspace name").fill("Cursor profile");
  await page.getByRole("button", { name: "Save integration" }).click();
  await expect(
    page.getByRole("button", { name: "Cursor profile", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Remove Cursor profile" }).click();
  await page
    .getByRole("button", { name: "Remove integration", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Cursor profile", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText("No integrations yet.", { exact: false }),
  ).toBeVisible();
  await expect(page.getByRole("status")).toContainText(
    "External files were kept",
  );
});

test("integration form guards unsaved changes when leaving its settings section", async ({
  page,
}) => {
  await fixture(page);
  await openSettings(page);
  await page
    .getByRole("button", { name: "Add integration", exact: true })
    .click();
  await page.getByLabel("Workspace name").fill("Unsaved profile");
  await page.getByRole("button", { name: "General", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText(
    "Discard integration changes?",
  );
  await page
    .getByRole("button", { name: "Cancel", exact: true })
    .last()
    .click();
  await expect(page.getByLabel("Workspace name")).toHaveValue(
    "Unsaved profile",
  );
});
