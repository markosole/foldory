import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const projectDirectory = path.dirname(fileURLToPath(import.meta.url));
const tauriCli = fileURLToPath(
  new URL("./node_modules/@tauri-apps/cli/tauri.js", import.meta.url),
);

function splitFlags(value) {
  return (value.match(/(?:[^\s"]+|"[^"]*")+/g) ?? []).map((flag) =>
    flag.startsWith('"') && flag.endsWith('"') ? flag.slice(1, -1) : flag,
  );
}

function releaseEnvironment() {
  const environment = { ...process.env };
  if (args[0] !== "build") return environment;

  const encoded = environment.CARGO_ENCODED_RUSTFLAGS
    ? environment.CARGO_ENCODED_RUSTFLAGS.split("\x1f").filter(Boolean)
    : splitFlags(environment.RUSTFLAGS ?? "");
  delete environment.RUSTFLAGS;

  const roots = [
    [projectDirectory, "/workspace"],
    [path.dirname(projectDirectory), "/workspace-root"],
    [environment.USERPROFILE, "/user-profile"],
    [environment.HOME, "/user-home"],
  ];
  const seen = new Set();
  for (const [source, replacement] of roots) {
    if (!source) continue;
    for (const variant of [source, source.replaceAll("\\", "/")]) {
      const key = variant.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      encoded.push("--remap-path-prefix", `${variant}=${replacement}`);
    }
  }
  environment.CARGO_ENCODED_RUSTFLAGS = encoded.join("\x1f");
  return environment;
}

function removeReleaseSymbols(directory) {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) removeReleaseSymbols(entryPath);
    else if (path.extname(entry.name).toLowerCase() === ".pdb")
      fs.rmSync(entryPath, { force: true });
  }
}

const command = spawn(process.execPath, [tauriCli, ...args], {
  stdio: "inherit",
  env: releaseEnvironment(),
});

command.on("error", (error) => {
  console.error(`Could not start the Tauri CLI: ${error.message}`);
  process.exitCode = 1;
});

command.on("exit", (code, signal) => {
  if (signal) {
    console.error(`The Tauri CLI stopped after receiving ${signal}.`);
    process.exitCode = 1;
    return;
  }

  if (code !== 0) {
    process.exitCode = code ?? 1;
    return;
  }

  if (args[0] !== "build" || process.platform !== "win32") return;

  removeReleaseSymbols(
    path.join(projectDirectory, "src-tauri", "target", "release"),
  );

  const privacyCheck = spawn(
    process.execPath,
    [
      fileURLToPath(
        new URL("./scripts/verify-release-privacy.mjs", import.meta.url),
      ),
    ],
    { cwd: projectDirectory, stdio: "inherit" },
  );

  privacyCheck.on("error", (error) => {
    console.error(`Could not verify the release artifact: ${error.message}`);
    process.exitCode = 1;
  });
  privacyCheck.on("exit", (privacyCode) => {
    if (privacyCode !== 0) {
      process.exitCode = privacyCode ?? 1;
      return;
    }
    if (process.env.FOLDORY_SKIP_OPEN_BUILD === "1") return;
    const hookCommand = spawn(
      process.env.ComSpec ?? "cmd.exe",
      ["/d", "/c", "open_build.bat"],
      { cwd: projectDirectory, stdio: "inherit" },
    );
    hookCommand.on("error", (error) => {
      console.error(`Could not run the post-build hook: ${error.message}`);
      process.exitCode = 1;
    });
    hookCommand.on("exit", (hookCode) => {
      process.exitCode = hookCode ?? 1;
    });
  });
});
