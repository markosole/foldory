import { describe, expect, it } from "vitest";
import {
  activePathReference,
  draggedSourcePaths,
  isCoveredPath,
  pathReferences,
} from "./assistantSources";

describe("assistant path references", () => {
  it("recognizes quoted folder names, nested paths, and both prefixes without consuming URLs or email", () => {
    const text =
      'Summarize @"Project info/Monthly notes" and /Invoices/billed.csv. Contact user@example.invalid https://example.invalid/a';
    const references = pathReferences(text);
    expect(references.map((item) => item.path)).toEqual([
      "Project info/Monthly notes",
      "Invoices/billed.csv",
    ]);
    expect(text.slice(references[0].start, references[0].end)).toBe(
      '@"Project info/Monthly notes"',
    );
    const incomplete = 'Summarize @"Project info/Month';
    expect(activePathReference(incomplete, incomplete.length)?.path).toBe(
      "Project info/Month",
    );
    expect(activePathReference("https://example.invalid/a", 25)).toBeNull();
  });

  it("deduplicates folder coverage without confusing sibling prefixes", () => {
    expect(
      isCoveredPath("Docs\\Nested\\notes.md", [
        { path: "docs", directory: true },
      ]),
    ).toBe(true);
    expect(
      isCoveredPath("Docs-old/notes.md", [{ path: "Docs", directory: true }]),
    ).toBe(false);
    expect(
      isCoveredPath("docs/notes.md/other", [
        { path: "docs/notes.md", directory: false },
      ]),
    ).toBe(false);
    expect(
      isCoveredPath("anywhere/note.md", [{ path: "", directory: true }]),
    ).toBe(true);
  });

  it("rejects another project's drag payload and malformed paths", () => {
    expect(() =>
      draggedSourcePaths(
        JSON.stringify({ projectId: "other", paths: ["Secure"] }),
        "current",
      ),
    ).toThrow("current project");
    expect(() =>
      draggedSourcePaths(
        JSON.stringify({ projectId: "current", paths: [3] }),
        "current",
      ),
    ).toThrow("valid project paths");
    expect(
      draggedSourcePaths(
        JSON.stringify({
          projectId: "current",
          paths: ["Docs", "Docs", "invoice.csv"],
        }),
        "current",
      ),
    ).toEqual(["Docs", "invoice.csv"]);
  });
});
