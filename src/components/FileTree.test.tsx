import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import type { FileEntry } from "../types";
import FileTree from "./FileTree";

vi.mock("../api", () => ({ api: { listDirectory: vi.fn() } }));

const entries: FileEntry[] = [
  {
    path: "first.md",
    name: "first.md",
    directory: false,
    size: 12,
    modifiedAt: 0,
  },
  {
    path: "second.md",
    name: "second.md",
    directory: false,
    size: 15,
    modifiedAt: 0,
  },
  { path: "Docs", name: "Docs", directory: true, size: 0, modifiedAt: 0 },
  {
    path: "Secure",
    name: "Secure",
    directory: true,
    size: 0,
    modifiedAt: 0,
    aiExcluded: true,
    aiExclusionReason: "Private workspace folders",
  },
];
const child: FileEntry = {
  path: "Docs/child.md",
  name: "child.md",
  directory: false,
  size: 25,
  modifiedAt: 0,
};

const onOpen = vi.fn();
const onMenu = vi.fn();

function Harness() {
  const [selection, setSelection] = useState<FileEntry[]>([]);
  return (
    <FileTree
      projectId="project-one"
      entries={entries}
      selected="first.md"
      selection={selection}
      onSelectionChange={setSelection}
      refreshVersion={0}
      onOpen={onOpen}
      onMenu={onMenu}
      icon={() => <svg className="file-icon" />}
    />
  );
}

function file(name: string) {
  return screen.getByRole("button", { name });
}

function row(name: string) {
  return file(name).closest(".file-entry")!;
}

describe("file explorer source selection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.listDirectory).mockResolvedValue([child]);
  });
  afterEach(cleanup);

  it("selects with Ctrl or Meta without opening and plain clicks replace the selection", () => {
    render(<Harness />);
    fireEvent.click(file("first.md"));
    expect(onOpen).toHaveBeenCalledExactlyOnceWith(entries[0]);
    fireEvent.click(file("second.md"), { ctrlKey: true });
    fireEvent.click(file("Docs"), { metaKey: true });
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(file("first.md")).toHaveAttribute("aria-pressed", "true");
    expect(file("second.md")).toHaveAttribute("aria-pressed", "true");
    expect(file("Docs")).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(file("second.md"), { ctrlKey: true });
    expect(file("second.md")).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(file("second.md"));
    expect(file("first.md")).toHaveAttribute("aria-pressed", "false");
    expect(file("Docs")).toHaveAttribute("aria-pressed", "false");
    expect(file("second.md")).toHaveAttribute("aria-pressed", "true");
    expect(onOpen).toHaveBeenLastCalledWith(entries[1]);
  });

  it("shares selection across nested folders and preserves the group on right click", async () => {
    render(<Harness />);
    fireEvent.click(file("first.md"));
    fireEvent.click(screen.getByRole("button", { name: "Expand Docs" }));
    const nested = await screen.findByRole("button", { name: "child.md" });
    fireEvent.click(nested, { ctrlKey: true });
    fireEvent.contextMenu(nested);
    expect(onMenu.mock.calls.at(-1)?.[4]).toEqual([entries[0], child]);
    expect(row("first.md")).toHaveClass("multi-selected");
    fireEvent.contextMenu(file("Secure"));
    expect(onMenu.mock.calls.at(-1)?.[4]).toEqual([entries[3]]);
    expect(row("first.md")).not.toHaveClass("multi-selected");
    expect(row("Secure")).toHaveClass("multi-selected");
  });

  it("drags selected files and folders together, and dragging an unselected item replaces them", () => {
    render(<Harness />);
    fireEvent.click(file("first.md"));
    fireEvent.click(file("Docs"), { ctrlKey: true });
    const dataTransfer = { setData: vi.fn(), effectAllowed: "none" };
    fireEvent.dragStart(row("Docs"), { dataTransfer });
    expect(dataTransfer.effectAllowed).toBe("copyMove");
    expect(dataTransfer.setData).toHaveBeenCalledWith(
      "application/x-foldory-files",
      JSON.stringify({ projectId: "project-one", paths: ["first.md", "Docs"] }),
    );
    dataTransfer.setData.mockClear();
    fireEvent.dragStart(row("second.md"), { dataTransfer });
    expect(dataTransfer.setData).toHaveBeenCalledWith(
      "application/x-foldory-files",
      JSON.stringify({ projectId: "project-one", paths: ["second.md"] }),
    );
    expect(file("Docs")).toHaveAttribute("aria-pressed", "false");
    expect(file("second.md")).toHaveAttribute("aria-pressed", "true");
  });

  it("marks excluded entries visibly and describes the privacy rule without hiding them", () => {
    render(<Harness />);
    expect(row("Secure")).toHaveClass("ai-excluded");
    expect(file("Secure")).toHaveAttribute(
      "title",
      "Secure · Excluded from Assistant by default: Private workspace folders",
    );
    expect(row("Docs")).not.toHaveClass("ai-excluded");
  });

  it("accepts drops on folder rows and does not turn a file into a destination", () => {
    const onDrop = vi.fn();
    render(
      <FileTree
        projectId="project-one"
        entries={entries}
        selected=""
        refreshVersion={0}
        onOpen={onOpen}
        onMenu={onMenu}
        onDrop={onDrop}
        icon={() => null}
        cutPaths={["Docs"]}
      />,
    );
    const dataTransfer = {
      types: ["application/x-foldory-files"],
      dropEffect: "none",
    };
    fireEvent.dragOver(row("Docs"), { dataTransfer });
    expect(dataTransfer.dropEffect).toBe("move");
    expect(row("Docs")).toHaveClass("file-drop-target", "cut");
    fireEvent.drop(row("Docs"), { dataTransfer });
    expect(onDrop).toHaveBeenCalledWith(expect.anything(), "Docs");
    expect(row("Docs")).not.toHaveClass("file-drop-target");
    fireEvent.drop(row("first.md"), { dataTransfer });
    expect(onDrop).toHaveBeenCalledTimes(1);
  });
});
