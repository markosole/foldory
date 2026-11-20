import { expect, test, type Page } from "@playwright/test";

// Every native command and clipboard operation is intercepted; no real source or tool is opened.
async function fixture(page: Page) {
  await page.addInitScript(() => {
    const project = {
      id: "cascade",
      sourceId: "source",
      path: "D:\\Fixtures\\Cascade",
      name: "Project Cascade",
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
    const calls: { command: string; args: Record<string, unknown> }[] = [];
    let clipboard = "";
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: async (value: string) => {
          clipboard = value;
        },
        readText: async () => clipboard,
      },
    });
    let token = 0;
    Object.assign(window, {
      fixtureCalls: calls,
      isTauri: true,
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
      __TAURI_INTERNALS__: {
        metadata: { currentWindow: { label: "main" } },
        transformCallback: () => ++token,
        invoke: async (command: string, args: Record<string, unknown> = {}) => {
          calls.push({ command, args });
          if (command.startsWith("plugin:")) return ++token;
          if (command === "bootstrap")
            return {
              projects: [{ ...project }],
              sources: [
                {
                  id: "source",
                  name: "Fixtures",
                  path: "D:\\Fixtures",
                  available: true,
                  connected: true,
                },
              ],
              templates: [],
              settings: {
                tools: [
                  {
                    id: "custom",
                    name: "Custom editor",
                    executable: "fixture.exe",
                    args: ["{project}"],
                  },
                ],
                supportedTools: {
                  cursor: { enabled: true, desktop: true, cli: true },
                  claude: { enabled: true, desktop: true, cli: true },
                  codex: { enabled: true, desktop: true, cli: true },
                },
                aiBaseUrl: "",
                aiModel: "",
                aiHasKey: false,
                scanIntervalSeconds: 60,
              },
              indexStatus: {
                running: false,
                files: 10,
                projects: 1,
                lastIndexed: 1000,
                message: "Indexed",
              },
            };
          if (
            command === "list_integrations" ||
            command === "integration_catalog"
          )
            return [];
          if (command === "list_chats") return [];
          if (command === "search_folders")
            return ["", "Desktop App/Cascade site"].map((path) => ({
              projectId: project.id,
              projectName: project.alias || project.name,
              path,
              name: path ? "Cascade site" : project.alias || project.name,
              directory: true,
              depth: path ? 2 : 0,
              excerpt: "",
              matchKind: "substring",
            }));
          if (command === "update_project") {
            Object.assign(project, args.patch);
            return { ...project };
          }
          if (command === "touch_project") return { ...project };
          if (command === "launch_tool") return null;
          if (command === "list_directory")
            return [
              {
                name: "assets",
                path: `${args.path ? `${args.path}/` : ""}assets`,
                directory: true,
                size: 0,
                modifiedAt: 0,
              },
            ];
          throw new Error(`Unexpected native command: ${command}`);
        },
      },
    });
  });
  await page.goto("/");
  await page.getByRole("textbox", { name: "Filter projects" }).fill("cascade");
  await expect(
    page.getByRole("list", { name: "Matching projects and folders" }),
  ).toBeVisible();
}

async function calls(page: Page) {
  return page.evaluate(
    () =>
      (
        window as unknown as {
          fixtureCalls: { command: string; args: Record<string, unknown> }[];
        }
      ).fixtureCalls,
  );
}

test("search roots expose the complete project menu and immediately reflect metadata actions", async ({
  page,
}) => {
  await fixture(page);
  const tree = page.getByRole("list", {
    name: "Matching projects and folders",
  });
  const root = tree
    .locator(".folder-match-open")
    .filter({ hasText: "Project Cascade" });
  await root.click({ button: "right" });
  const menu = page.getByRole("menu", {
    name: "Actions for Project Cascade",
  });
  await expect(
    menu.getByRole("menuitem", { name: "Rename display label…" }),
  ).toBeVisible();
  await expect(
    menu.getByRole("menuitem", { name: "Start CMD here" }),
  ).toBeVisible();
  await expect(
    menu.getByRole("menuitem", { name: "Start Codex CLI here" }),
  ).toBeVisible();
  await expect(
    menu.getByRole("menuitem", { name: "Custom editor" }),
  ).toBeVisible();
  await expect(
    page.getByRole("menu", { name: "Workspace actions" }),
  ).toHaveCount(0);
  await menu
    .getByRole("menuitem", { name: "Folder colour", exact: true })
    .click();
  const color = menu.getByRole("menuitemradio").nth(2);
  const picked = (await color.getAttribute("aria-label"))!.replace(
    "Colour ",
    "",
  );
  await color.click();
  await expect
    .poll(async () =>
      (await calls(page)).some(
        (call) =>
          call.command === "update_project" &&
          (call.args.patch as { color?: string }).color === picked,
      ),
    )
    .toBe(true);
  const expectedColor = await page.evaluate((value) => {
    const element = document.createElement("span");
    element.style.color = value;
    return element.style.color;
  }, picked);
  await expect(root.locator("svg")).toHaveCSS("color", expectedColor);
  await root.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Rename display label…" }).click();
  await page
    .getByRole("dialog")
    .getByRole("textbox")
    .fill("Cascade display name");
  await page.getByRole("button", { name: "Save label" }).click();
  const renamed = tree
    .locator(".folder-match-open")
    .filter({ hasText: "Cascade display name" });
  await expect(renamed).toBeVisible();
  await renamed.click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "Pin project", exact: true })
    .click();
  await renamed.click({ button: "right" });
  await expect(
    page.getByRole("menuitem", { name: "Unpin project" }),
  ).toBeVisible();
  await page.getByRole("menuitem", { name: "Hide project" }).click();
  await expect(tree).toHaveCount(0);
  expect(
    (await calls(page)).filter((call) =>
      ["write_file", "create_entry", "create_project"].includes(call.command),
    ),
  ).toEqual([]);
});

test("nested and ancestor search menus launch in the selected folder and support keyboard and safe navigation", async ({
  page,
}) => {
  await page.setViewportSize({ width: 960, height: 640 });
  await fixture(page);
  const tree = page.getByRole("list", {
    name: "Matching projects and folders",
  });
  const nested = tree
    .locator(".folder-match-open")
    .filter({ hasText: "Cascade site" });
  await nested.focus();
  await nested.press("Shift+F10");
  const menu = page.getByRole("menu", { name: "Actions for Cascade site" });
  await expect(menu).toBeVisible();
  await expect(page.getByRole("menu")).toHaveCount(1);
  await expect(
    menu.getByRole("menuitem", { name: "Rename project display label…" }),
  ).toBeVisible();
  const box = (await menu.boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(640);
  await menu.press("Escape");
  await expect(nested).toBeFocused();
  for (const [label, toolId] of [
    ["Open in Explorer", "explorer"],
    ["Start CMD here", "cmd"],
    ["Open PowerShell", "powershell"],
    ["Start Cursor Desktop here", "cursor-desktop"],
    ["Start Claude CLI here", "claude-cli"],
    ["Start Codex Desktop here", "codex-desktop"],
    ["Start Codex CLI here", "codex-cli"],
    ["Custom editor", "custom"],
  ]) {
    await nested.click({ button: "right" });
    await menu.getByRole("menuitem", { name: label, exact: true }).click();
    await expect
      .poll(
        async () =>
          (await calls(page))
            .filter((call) => call.command === "launch_tool")
            .at(-1)?.args,
      )
      .toEqual({
        projectId: "cascade",
        toolId,
        path: "Desktop App/Cascade site",
      });
  }
  await nested.click({ button: "right" });
  await menu.getByRole("menuitem", { name: "Copy full path" }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    "D:\\Fixtures\\Cascade\\Desktop App\\Cascade site",
  );
  await tree
    .getByRole("button", { name: "Desktop App", exact: true })
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "Start CMD here" }).click();
  expect(
    (await calls(page)).filter((call) => call.command === "launch_tool").at(-1)
      ?.args,
  ).toMatchObject({ path: "Desktop App" });
  await nested.click({ button: "right" });
  await page.screenshot({
    path: "test-results/search-folder-context-menu.png",
  });
  await menu
    .getByRole("menuitem", { name: "Open folder", exact: true })
    .click();
  await expect
    .poll(async () =>
      (await calls(page)).some(
        (call) =>
          call.command === "list_directory" &&
          call.args.path === "Desktop App/Cascade site",
      ),
    )
    .toBe(true);
  expect(
    (await calls(page)).filter((call) =>
      ["write_file", "read_file", "create_entry", "create_project"].includes(
        call.command,
      ),
    ),
  ).toEqual([]);
});
