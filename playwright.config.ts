import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  use: {
    baseURL: "http://127.0.0.1:1421",
    channel: "chrome",
    headless: true,
    viewport: { width: 1440, height: 940 },
  },
  webServer: {
    command: "npx vite --host 127.0.0.1 --port 1421 --strictPort",
    url: "http://127.0.0.1:1421",
    reuseExistingServer: true,
  },
});
