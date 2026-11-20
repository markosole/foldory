import { expect, test, type Page } from "@playwright/test";

async function openFiles(page: Page) {
  await page.addInitScript(() => {
    const project = {
      id: "p",
      sourceId: "s",
      path: "D:\\Projects\\Sample",
      name: "Sample",
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
    const entry = (path: string, directory = false) => ({
      path,
      name: path.split("/").pop(),
      directory,
      size: 20,
      modifiedAt: 0,
    });
    const folders: Record<string, ReturnType<typeof entry>[]> = {
      "": [
        entry("src", true),
        entry("empty", true),
        entry("broken", true),
        entry("notes.txt"),
        entry("PROJECT.md"),
      ],
      src: [entry("src/nested", true), entry("src/child.txt")],
      "src/nested": [entry("src/nested/deep.txt")],
      empty: [],
    };
    const files: Record<string, string> = {
      "notes.txt": "Original text",
      "PROJECT.md": "# Project overview\n\nSelectable document content.",
    };
    const calls: { command: string; args: Record<string, unknown> }[] = [];
    let clipboard = "";
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: async (text: string) => {
          clipboard = text;
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
              projects: [project],
              sources: [
                {
                  id: "s",
                  name: "Projects",
                  path: "D:\\Projects",
                  available: true,
                  connected: true,
                },
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
                files: 5,
                projects: 1,
                lastIndexed: 0,
                message: "",
              },
            };
          if (command === "touch_project") return project;
          if (
            command === "list_integrations" ||
            command === "integration_catalog"
          )
            return [];
          if (command === "list_chats") return [];
          if (command === "search_folders") return [];
          if (command === "list_directory") {
            if (args.path === "broken") throw new Error("Folder unavailable");
            return folders[String(args.path)] ?? [];
          }
          if (command === "read_file")
            return {
              path: args.path,
              content: files[String(args.path)] ?? "Nested file",
              revision: "r1",
            };
          if (command === "write_file") {
            files[String(args.path)] = String(args.content);
            return { path: args.path, content: args.content, revision: "r2" };
          }
          if (command === "create_entry") {
            const path = String(args.path);
            const parent = path.split("/").slice(0, -1).join("/");
            folders[parent].push(entry(path, Boolean(args.directory)));
            return null;
          }
          if (command === "launch_tool") return null;
          throw new Error(`Unexpected command: ${command}`);
        },
      },
    });
  });
  await page.goto("/");
  await page
    .getByRole("complementary", { name: "Project library" })
    .getByRole("button", { name: "Sample", exact: true })
    .click();
  await page.getByRole("button", { name: "Files", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "src", exact: true }),
  ).toBeVisible();
}

test("chevrons expand nested folders independently of folder navigation, including empty/error states", async ({
  page,
}) => {
  await openFiles(page);
  await page.getByRole("button", { name: "Expand src", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "child.txt", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Parent folder" })).toHaveCount(
    0,
  );
  await page
    .getByRole("button", { name: "Expand nested", exact: true })
    .click();
  await page.getByRole("button", { name: "deep.txt", exact: true }).click();
  await expect(page.locator(".cm-content")).toHaveText("Nested file");
  await page
    .getByRole("button", { name: "Refresh files", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "deep.txt", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Collapse src", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "child.txt", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "src", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Parent folder" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "child.txt", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Parent folder" }).click();
  await page.getByRole("button", { name: "Expand empty", exact: true }).click();
  await expect(page.getByText("Empty folder", { exact: true })).toBeVisible();
  await page
    .getByRole("button", { name: "Expand broken", exact: true })
    .click();
  await expect(page.getByText("Error: Folder unavailable")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Retry", exact: true }),
  ).toBeVisible();
});

test("file context actions use the clicked path and refresh expanded children after creation", async ({
  page,
}) => {
  await openFiles(page);
  await page.getByRole("button", { name: "Expand src", exact: true }).click();
  await page
    .getByRole("button", { name: "child.txt", exact: true })
    .click({ button: "right" });
  const fileMenu = page.getByRole("menu", { name: "child.txt" });
  await expect(fileMenu.locator(".launcher-menu-label")).toHaveText(
    "Supported tools",
  );
  expect(
    await fileMenu
      .getByRole("menuitem")
      .evaluateAll((items) =>
        items.every((item) =>
          Boolean(item.querySelector(":scope > svg, :scope > img")),
        ),
      ),
  ).toBe(true);
  await fileMenu
    .getByRole("menuitem", { name: "Start CMD here", exact: true })
    .click();
  expect(
    await page.evaluate(() =>
      (
        window as unknown as {
          fixtureCalls: { command: string; args: Record<string, unknown> }[];
        }
      ).fixtureCalls
        .filter((call) => call.command === "launch_tool")
        .at(-1),
    ),
  ).toEqual({
    command: "launch_tool",
    args: { projectId: "p", toolId: "cmd", path: "src" },
  });
  await page
    .getByRole("button", { name: "child.txt", exact: true })
    .click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "Copy relative path", exact: true })
    .click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    "src/child.txt",
  );
  await page
    .getByRole("button", { name: "src", exact: true })
    .click({ button: "right" });
  const folderMenu = page.getByRole("menu", { name: "src" });
  expect(
    await folderMenu
      .getByRole("menuitem")
      .evaluateAll((items) =>
        items.every((item) =>
          Boolean(item.querySelector(":scope > svg, :scope > img")),
        ),
      ),
  ).toBe(true);
  await folderMenu
    .getByRole("menuitem", { name: "Start Cursor Desktop here", exact: true })
    .click();
  expect(
    await page.evaluate(() =>
      (
        window as unknown as {
          fixtureCalls: { command: string; args: Record<string, unknown> }[];
        }
      ).fixtureCalls
        .filter((call) => call.command === "launch_tool")
        .at(-1),
    ),
  ).toEqual({
    command: "launch_tool",
    args: { projectId: "p", toolId: "cursor-desktop", path: "src" },
  });
  await page
    .getByRole("button", { name: "src", exact: true })
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "New file…", exact: true }).click();
  await page.getByPlaceholder("notes.md").fill("created.txt");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "created.txt", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".file-content-heading")).toContainText(
    "created.txt",
  );
  await expect(
    page.locator('.file-entry.selected button[title^="src/created.txt"]'),
  ).toBeVisible();
});

test("global, input, document and editor menus replace native menus without breaking editing", async ({
  page,
}) => {
  await openFiles(page);
  expect(
    await page.locator(".workspace-tabs").evaluate((element) => {
      const event = new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
      });
      element.dispatchEvent(event);
      return event.defaultPrevented;
    }),
  ).toBe(true);
  await expect(
    page.getByRole("menu", { name: "Workspace actions" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  const search = page.getByRole("textbox", { name: "Filter projects" });
  await search.fill("Sample");
  await search.press("Control+a");
  await search.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Copy", exact: false }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    "Sample",
  );
  await search.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Cut", exact: false }).click();
  await expect(search).toHaveValue("");
  await search.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Paste", exact: false }).click();
  await expect(search).toHaveValue("Sample");
  await page.getByRole("button", { name: "notes.txt", exact: true }).click();
  const editor = page.locator(".cm-content");
  await editor.click();
  await page.keyboard.press("Control+a");
  await editor.click({ button: "right" });
  await expect(
    page.getByRole("menu", { name: "Editor actions" }),
  ).toBeVisible();
  await page.getByRole("menuitem", { name: "Paste", exact: false }).click();
  await expect(editor).toHaveText("Sample");
  await editor.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Undo", exact: false }).click();
  await expect(editor).toHaveText("Original text");
  await page.getByRole("button", { name: "Overview", exact: true }).click();
  await page.locator(".markdown").click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "Select all", exact: false })
    .click();
  expect(
    await page.evaluate(() => window.getSelection()?.toString()),
  ).toContain("Selectable document content");
  await expect(page.locator(".workspace-tabs")).toHaveCSS(
    "user-select",
    "none",
  );
  await expect(page.locator(".markdown")).toHaveCSS("user-select", "text");
  await expect(search).toHaveCSS("user-select", "text");
});

test("dialog chrome cannot be selected while form fields remain selectable", async ({
  page,
}) => {
  await openFiles(page);
  await page.getByRole("button", { name: "Projects dashboard" }).click();
  await page
    .locator(".dashboard")
    .getByRole("button", { name: "New project", exact: true })
    .click();

  const dialog = page.getByRole("dialog", { name: "Create project" });
  const projectName = dialog.getByRole("textbox", { name: "Project name" });
  await expect(dialog).toHaveCSS("user-select", "none");
  await expect(projectName).toHaveCSS("user-select", "text");

  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  await dialog.getByRole("button", { name: "Close" }).focus();
  await page.keyboard.press("Control+a");
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe("");
});

test("panel dividers drag and clamp to 100–420px, support keyboard resizing, and persist", async ({
  page,
}) => {
  await openFiles(page);
  for (const name of ["Resize project library", "Resize file explorer"]) {
    const divider = page.getByRole("separator", { name });
    const box = (await divider.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + 100);
    await page.mouse.down();
    await page.mouse.move(box.x + 500, box.y + 100);
    await page.mouse.up();
    await expect(divider).toHaveAttribute("aria-valuenow", "420");
    const expandedBox = (await divider.boundingBox())!;
    await page.mouse.move(expandedBox.x + 3, expandedBox.y + 100);
    await page.mouse.down();
    await page.mouse.move(0, expandedBox.y + 100);
    await page.mouse.up();
    await expect(divider).toHaveAttribute("aria-valuenow", "100");
    await divider.press("Home");
    await expect(divider).toHaveAttribute("aria-valuenow", "100");
    const panel = page.locator(
      `#${await divider.getAttribute("aria-controls")}`,
    );
    expect((await panel.boundingBox())!.width).toBe(100);
    await divider.press("ArrowLeft");
    await expect(divider).toHaveAttribute("aria-valuenow", "100");
    await divider.press("ArrowRight");
    await expect(divider).toHaveAttribute("aria-valuenow", "110");
    await divider.press("End");
    await expect(divider).toHaveAttribute("aria-valuenow", "420");
  }
  await page.getByRole("button", { name: "Hide file explorer" }).click();
  await page.getByRole("button", { name: "Show file explorer" }).click();
  await expect(
    page.getByRole("separator", { name: "Resize file explorer" }),
  ).toHaveAttribute("aria-valuenow", "420");
  await page.reload();
  await expect(
    page.getByRole("separator", { name: "Resize project library" }),
  ).toHaveAttribute("aria-valuenow", "420");
  await page
    .getByRole("complementary", { name: "Project library" })
    .getByRole("button", { name: "Sample", exact: true })
    .click();
  await page.getByRole("button", { name: "Files", exact: true }).click();
  await expect(
    page.getByRole("separator", { name: "Resize file explorer" }),
  ).toHaveAttribute("aria-valuenow", "420");
  await page.screenshot({ path: "test-results/panels-and-tree.png" });
  await page
    .getByRole("separator", { name: "Resize project library" })
    .press("Home");
  await page
    .getByRole("separator", { name: "Resize file explorer" })
    .press("Home");
  await page.getByRole("button", { name: "Expand src", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "child.txt", exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: "test-results/panels-minimum.png" });
});

test("text context menus work inside dialogs and stay inside the viewport", async ({
  page,
}) => {
  await openFiles(page);
  await page
    .getByRole("complementary", { name: "Project library" })
    .getByRole("button", { name: "Sample", exact: true })
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "Rename display label…" }).click();
  const dialog = page.getByRole("dialog");
  const input = dialog.getByRole("textbox").first();
  await input.fill("Renamed");
  await input.press("Control+a");
  await input.click({ button: "right" });
  await expect(
    dialog.getByRole("menu", { name: "Text actions" }),
  ).toBeVisible();
  await page.getByRole("menuitem", { name: "Copy", exact: false }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    "Renamed",
  );
  await input.click({ button: "right" });
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await expect(input).toBeFocused();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  const viewport = page.viewportSize()!;
  await page.mouse.click(viewport.width - 3, viewport.height - 3, {
    button: "right",
  });
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  const bounds = (await menu.boundingBox())!;
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height);
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
});
