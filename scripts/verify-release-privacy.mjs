import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectDirectory = path.dirname(
  path.dirname(fileURLToPath(import.meta.url)),
);
const releaseDirectory = path.join(
  projectDirectory,
  "src-tauri",
  "target",
  "release",
);

function walk(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(entryPath) : [entryPath];
  });
}

const candidates = walk(releaseDirectory).filter((file) => {
  const relative = path.relative(releaseDirectory, file).toLowerCase();
  const extension = path.extname(file).toLowerCase();
  return (
    relative === "foldory.exe" ||
    relative === "foldory.pdb" ||
    (relative.startsWith(`bundle${path.sep}`) &&
      [".exe", ".msi", ".pdb"].includes(extension))
  );
});

if (
  !candidates.some(
    (file) => path.basename(file).toLowerCase() === "foldory.exe",
  )
) {
  console.error(
    "Privacy check failed: the release executable does not exist. Build it first.",
  );
  process.exit(1);
}

const profile = process.env.USERPROFILE || process.env.HOME || "";
const markers = [
  profile,
  profile.replaceAll("\\", "/"),
  profile && path.basename(profile),
  projectDirectory,
  projectDirectory.replaceAll("\\", "/"),
  path.dirname(projectDirectory),
  path.dirname(projectDirectory).replaceAll("\\", "/"),
]
  .filter((marker) => marker.length >= 4)
  .map((marker) => marker.toLowerCase());

const failures = [];
for (const file of candidates) {
  const bytes = fs.readFileSync(file);
  const singleByte = bytes.toString("latin1").toLowerCase();
  const wide = bytes.toString("utf16le").toLowerCase();
  if (
    markers.some(
      (marker) => singleByte.includes(marker) || wide.includes(marker),
    )
  ) {
    failures.push(path.relative(projectDirectory, file));
  }
}

if (failures.length) {
  console.error(
    "Privacy check failed: local developer or build-machine paths remain in:",
  );
  for (const file of failures) console.error(`- ${file}`);
  process.exit(1);
}

console.log(
  `Privacy check passed for ${candidates.length} release artifact(s).`,
);
