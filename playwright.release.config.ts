import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

export default defineConfig({
  ...base,
  testMatch: "workspace.spec.ts",
  grep: /code editor keeps|visual Word parsing/,
  projects: [{ name: "release" }],
  use: { ...base.use, baseURL: "http://127.0.0.1:1422" },
  webServer: {
    command: "npm run build && npm run preview -- --port 1422 --strictPort",
    url: "http://127.0.0.1:1422",
    reuseExistingServer: false,
  },
});
