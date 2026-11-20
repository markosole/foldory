import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

// PDF.js needs these resources for non-Latin text, font fallback and image codecs.
// Serve/package them locally so document rendering never depends on a CDN.
const pdfAssets = ["cmaps", "standard_fonts", "wasm", "iccs"].flatMap(
  (directory) => {
    const root = new URL(
      `./node_modules/pdfjs-dist/${directory}/`,
      import.meta.url,
    );
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => ({
        name: `pdfjs/${directory}/${entry.name}`,
        path: fileURLToPath(new URL(entry.name, root)),
      }));
  },
);
export default defineConfig({
  server: {
    watch: {
      // Tauri watches the native code itself. Its target directory can contain
      // thousands of build artifacts and must not starve Vite's file requests.
      ignored: ["**/src-tauri/**", "**/.qa/**", "**/playwright-report/**"],
    },
  },
  plugins: [
    react(),
    {
      name: "bundled-offline-help",
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          if (request.url?.split("?")[0] !== "/help.html") return next();
          response.setHeader("Content-Type", "text/html; charset=utf-8");
          response.end(
            readFileSync(new URL("./src/content/help.html", import.meta.url)),
          );
        });
      },
      generateBundle() {
        this.emitFile({
          type: "asset",
          fileName: "help.html",
          source: readFileSync(
            new URL("./src/content/help.html", import.meta.url),
          ),
        });
      },
    },
    {
      name: "local-pdfjs-resources",
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          const path = request.url?.split("?")[0];
          if (!path?.startsWith("/pdfjs/")) return next();
          const asset = pdfAssets.find((asset) => `/${asset.name}` === path);
          if (!asset) {
            response.statusCode = 404;
            response.end();
            return;
          }
          response.setHeader(
            "Content-Type",
            path.endsWith(".wasm")
              ? "application/wasm"
              : path.endsWith(".js")
                ? "text/javascript"
                : "application/octet-stream",
          );
          response.end(readFileSync(asset.path));
        });
      },
      generateBundle() {
        for (const asset of pdfAssets)
          this.emitFile({
            type: "asset",
            fileName: asset.name,
            source: readFileSync(asset.path),
          });
      },
    },
  ],
  clearScreen: false,
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test-setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
