import { describe, expect, it } from "vitest";
import { matchesProject, projectName, validateProjectName } from "./utils";
import type { Project } from "./types";
const project: Project = {
  id: "p",
  sourceId: "s",
  path: "D:\\Projects\\Redwood",
  name: "Project Redwood",
  alias: "💡 RedwoodBoard",
  client: "Acme Studio",
  tags: ["web", "active"],
  color: "#83a9ff",
  pinned: false,
  hidden: false,
  lastOpened: 0,
  modifiedAt: 0,
  available: true,
};
describe("project discovery in the UI", () => {
  it("searches all metadata with case-insensitive AND terms", () => {
    expect(matchesProject(project, "ACME active")).toBe(true);
    expect(matchesProject(project, "projects redwood")).toBe(true);
    expect(matchesProject(project, "acme missing")).toBe(false);
    expect(projectName(project)).toBe("💡 RedwoodBoard");
    expect(projectName({ ...project, alias: " " })).toBe(project.name);
  });
  it("rejects Windows reserved names and directory traversal before creating", () => {
    for (const name of [
      "..",
      "../outside",
      "a\\b",
      "CON",
      "aux.txt",
      "LPT9",
      "file.",
      " bad",
      "a:b",
      "",
    ])
      expect(validateProjectName(name)).not.toBe("");
    for (const name of [
      "RedwoodBoard",
      "Client Project",
      "💡 Website",
      "com10",
    ])
      expect(validateProjectName(name)).toBe("");
  });
});
