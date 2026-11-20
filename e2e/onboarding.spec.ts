import { expect, test, type Page } from "@playwright/test";
import type { Bootstrap, Settings, Template } from "../src/types";

// Exercise the real UI against isolated IPC, never the user's library or credentials.
async function fixture(page: Page) {
  await page.addInitScript(() => {
    const data: Bootstrap = JSON.parse(
      sessionStorage.getItem("onboarding-fixture") || "null",
    ) || {
      sources: [],
      projects: [],
      templates: [
        {
          id: "default",
          name: "Standard project",
          directories: ["Docs", "App", "Secure/Access"],
          files: [{ path: "PROJECT.md", content: "# {{name}}" }],
        },
      ],
      settings: {
        onboardingCompleted: false,
        tools: [],
        aiBaseUrl: "http://127.0.0.1:1234/v1",
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
    const prefs = JSON.parse(
      sessionStorage.getItem("onboarding-ai") || "null",
    ) || { preferredLocalModels: [], selections: {} };
    const calls: { command: string; args: Record<string, unknown> }[] = [];
    const save = () =>
      sessionStorage.setItem("onboarding-fixture", JSON.stringify(data));
    let token = 0;
    Object.assign(window, {
      fixtureCalls: calls,
      fixtureData: data,
      isTauri: true,
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
      __TAURI_INTERNALS__: {
        metadata: { currentWindow: { label: "main" } },
        transformCallback: () => ++token,
        invoke: async (command: string, args: Record<string, unknown> = {}) => {
          calls.push({ command, args });
          if (command.startsWith("plugin:")) return ++token;
          if (command === "bootstrap") return structuredClone(data);
          if (
            [
              "list_integrations",
              "integration_catalog",
              "list_chats",
              "search_folders",
            ].includes(command)
          )
            return [];
          if (command === "detect_supported_tools")
            return {
              codex: { cli: true, desktop: true },
              cursor: { cli: true, desktop: true },
              claude: { cli: true, desktop: false },
            };
          if (command === "choose_directory")
            return data.sources.length ? "E:\\Client work" : "D:\\Projects";
          if (command === "add_source") {
            const path = String(args.path);
            data.sources.push({
              id: String(data.sources.length),
              name: path.split("\\").pop()!,
              path,
              available: true,
              connected: true,
            });
            save();
            return structuredClone(data);
          }
          if (command === "remove_source") {
            data.sources = data.sources.filter(({ id }) => id !== args.id);
            save();
            return structuredClone(data);
          }
          if (command === "save_settings") {
            data.settings = structuredClone(args.settings as Settings);
            save();
            return data.settings;
          }
          if (command === "save_template") {
            const template = structuredClone(args.template as Template);
            data.templates = [
              ...data.templates.filter(({ id }) => id !== template.id),
              template,
            ];
            save();
            return template;
          }
          if (command === "save_ai_key") {
            const endpoint = data.settings.aiProviders?.find(
              ({ provider }) => provider === args.provider,
            );
            if (endpoint) endpoint.hasKey = Boolean(args.key);
            save();
            return null;
          }
          if (command === "ai_preferences") return structuredClone(prefs);
          if (command === "set_ai_selection") {
            prefs.selections[String(args.mode)] = args.choice;
            sessionStorage.setItem("onboarding-ai", JSON.stringify(prefs));
            return structuredClone(prefs);
          }
          if (command === "ai_provider_catalog")
            return {
              connection: "ready",
              models: [{ id: "test-model", label: "Test model" }],
              detail: "Model catalog fetched successfully.",
            };
          if (command === "open_ai_provider" || command === "open_external_url")
            return null;
          throw new Error(`Unexpected fixture command: ${command}`);
        },
      },
    });
  });
  await page.goto("/");
  await expect(
    page.getByRole("dialog", { name: "Set up your workspace" }),
  ).toBeVisible();
}

test("first-run wizard adds multiple sources, creates a protected template, persists its default and can be rerun", async ({
  page,
}) => {
  await fixture(page);
  const dialog = page.getByRole("dialog");
  await page.keyboard.press("Control+Shift+N");
  await expect(dialog).toHaveCount(1);
  await dialog.getByRole("button", { name: /Add a project source/ }).click();
  await expect(dialog.getByText("D:\\Projects", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: /Add a project source/ }).click();
  await expect(dialog.getByText("2 added")).toBeVisible();
  await page.screenshot({ path: ".qa/onboarding-sources.png" });
  await dialog.getByRole("button", { name: "Continue", exact: true }).click();
  await dialog.getByRole("button", { name: "Skip AI / set up later" }).click();
  await dialog.getByRole("button", { name: /Create a template/ }).click();
  await dialog
    .getByRole("textbox", { name: "Template name", exact: true })
    .fill("Client website");
  await dialog.getByRole("button", { name: "Add folders & files" }).click();
  await dialog
    .getByRole("textbox", { name: "Folders", exact: true })
    .fill("Docs\nDesign/Assets\nApp\nSecure");
  await expect(dialog.getByText("Assets", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Choose protected items" }).click();
  await dialog
    .getByRole("button", { name: "Secure Docs", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", { name: "Unsecure Secure/Docs", exact: true }),
  ).toBeVisible();
  await dialog
    .getByRole("button", { name: "Secure PROJECT.md", exact: true })
    .click();
  await page.screenshot({ path: ".qa/onboarding-template.png" });
  await dialog
    .getByRole("button", { name: "Save template", exact: true })
    .click();
  await dialog.getByRole("button", { name: /Create a template/ }).click();
  await dialog
    .getByRole("textbox", { name: "Template name", exact: true })
    .fill("Notes project");
  await dialog
    .getByRole("button", { name: "Save template", exact: true })
    .click();
  await dialog.getByRole("button", { name: /Client website/ }).click();
  await dialog.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(
    dialog.getByRole("heading", { name: "Less digging. More understanding." }),
  ).toBeVisible();
  await page.screenshot({ path: ".qa/onboarding-inspector.png" });
  await dialog.getByRole("button", { name: "Start working" }).click();
  await expect(dialog).toHaveCount(0);
  const saved = (await page.evaluate(() =>
    JSON.parse(sessionStorage.getItem("onboarding-fixture")!),
  )) as Bootstrap;
  expect(saved.settings.onboardingCompleted).toBe(true);
  expect(saved.templates).toHaveLength(3);
  const template = saved.templates.find(
    ({ id }) => id === saved.settings.defaultTemplateId,
  )!;
  expect(template.name).toBe("Client website");
  expect(template.directories).toContain("Secure/Docs");
  expect(template.files[0].path).toBe("Secure/PROJECT.md");
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Settings", exact: true }),
  ).toBeVisible();
  await expect(dialog).toHaveCount(0);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "How To & Help" }).click();
  await expect(
    page.getByRole("heading", {
      name: "A place for your projects. A guide for everything else.",
    }),
  ).toBeVisible();
  await page.screenshot({ path: ".qa/how-to-help.png" });
  await page.getByRole("link", { name: "08 Project inspector" }).click();
  await expect(
    page.getByRole("heading", { name: "Meet the project inspector." }),
  ).toBeInViewport();
  await page.getByRole("button", { name: "Run onboarding" }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("2 added")).toBeVisible();
  await dialog.getByRole("button", { name: "Skip setup" }).click();
  await page.keyboard.press("Control+Shift+N");
  await expect(
    page.getByRole("combobox", { name: "Project template", exact: true }),
  ).toContainText("Client website");
});

test("AI setup signs in, discovers models without a key, saves a custom key and refreshes choices", async ({
  page,
}) => {
  await fixture(page);
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Continue", exact: true }).click();
  await dialog.getByRole("button", { name: "Codex Provider sign-in" }).click();
  await dialog.getByRole("button", { name: "Sign in to Codex" }).click();
  await expect(
    dialog.getByText("Connected · 1 models available"),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (
          window as unknown as {
            fixtureCalls: { command: string; args: unknown }[];
          }
        ).fixtureCalls.filter(({ command }) => command === "open_ai_provider"),
      ),
    )
    .toContainEqual({
      command: "open_ai_provider",
      args: { provider: "codex", signIn: true },
    });
  await dialog
    .getByRole("button", { name: "LM Studio On your computer" })
    .click();
  await dialog
    .getByRole("textbox", { name: "Endpoint URL or IP:port" })
    .fill("127.0.0.1:1234");
  await dialog.getByRole("button", { name: "Save & test connection" }).click();
  await expect(
    dialog.getByRole("combobox", { name: "Model", exact: true }),
  ).toHaveValue("test-model");
  expect(
    await page.evaluate(() =>
      (
        window as unknown as { fixtureCalls: { command: string }[] }
      ).fixtureCalls.some(({ command }) => command === "save_ai_key"),
    ),
  ).toBe(false);
  await page.screenshot({ path: ".qa/onboarding-ai.png" });
  await dialog.getByRole("button", { name: "Custom Your endpoint" }).click();
  await dialog
    .getByRole("textbox", { name: "Endpoint URL or IP:port" })
    .fill("https://models.example.test/v1");
  await dialog.getByLabel("API key Optional").fill("fixture-key");
  await dialog.getByRole("button", { name: "Save & test connection" }).click();
  await expect(
    dialog.getByRole("combobox", { name: "Model", exact: true }),
  ).toHaveValue("test-model");
  await expect(dialog.getByLabel("API key Optional")).toHaveValue("");
  await dialog
    .getByRole("checkbox", {
      name: "Remove the stored key and connect without one",
    })
    .check();
  await dialog.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(
    dialog.getByRole("heading", {
      name: "Make your next project feel familiar.",
    }),
  ).toBeVisible();
  const state = await page.evaluate(() => ({
    data: JSON.parse(sessionStorage.getItem("onboarding-fixture")!),
    prefs: JSON.parse(sessionStorage.getItem("onboarding-ai")!),
  }));
  expect(
    state.data.settings.aiProviders.find(
      ({ provider }: { provider: string }) => provider === "custom",
    ).hasKey,
  ).toBe(false);
  for (const mode of ["assistant", "globalAssistant", "inspector"])
    expect(state.prefs.selections[mode]).toEqual({
      provider: "custom",
      model: "test-model",
    });
});

test("skip is remembered and onboarding fits a compact window with reduced motion", async ({
  page,
}) => {
  await page.setViewportSize({ width: 960, height: 640 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await fixture(page);
  const dialog = page.getByRole("dialog");
  await page.screenshot({ path: ".qa/onboarding-compact.png" });
  await expect(
    dialog.getByRole("button", { name: "Continue", exact: true }),
  ).toBeInViewport();
  await dialog.getByRole("button", { name: "Skip setup" }).click();
  await expect(dialog).toHaveCount(0);
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Settings", exact: true }),
  ).toBeVisible();
  await expect(dialog).toHaveCount(0);
});

test("standalone help has all topics and works without external assets", async ({
  page,
  baseURL,
}) => {
  const external: string[] = [];
  page.on("request", (request) => {
    if (!request.url().startsWith(baseURL!)) external.push(request.url());
  });
  await page.goto("/help.html");
  await expect(
    page.getByRole("navigation", { name: "Help topics" }).getByRole("link"),
  ).toHaveCount(12);
  await page.getByRole("link", { name: "06 AI connections" }).click();
  await expect(
    page.getByRole("heading", { name: "Choose where your AI requests go." }),
  ).toBeInViewport();
  expect(external).toEqual([]);
});
