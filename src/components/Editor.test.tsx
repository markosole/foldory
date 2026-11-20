import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Editor from "./Editor";
import { api } from "../api";
import { beforeNavigate } from "../navigation";

vi.mock("../api", () => ({
  api: {
    readFile: vi.fn(),
    writeFile: vi.fn(),
    launchTool: vi.fn(),
    openExternalUrl: vi.fn(),
  },
}));
vi.mock("./CodeSurface", () => ({
  default: (props: {
    content: string;
    path: string;
    onChange: (value: string) => void;
  }) => (
    <textarea
      aria-label={`Edit ${props.path}`}
      value={props.content}
      onChange={(event) => props.onChange(event.target.value)}
    />
  ),
}));
const read = vi.mocked(api.readFile);
const write = vi.mocked(api.writeFile);
async function openEditor() {
  await act(async () => {
    render(<Editor projectId="one" path="notes.txt" onError={vi.fn()} />);
  });
}

describe("editor saves and recovery", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    read.mockResolvedValue({
      path: "notes.txt",
      content: "Original",
      revision: "r1",
    });
    write.mockReset();
  });
  afterEach(async () => {
    cleanup();
    await act(async () => {
      await Promise.resolve();
    });
    vi.useRealTimers();
  });

  it("debounces edits and saves the disk revision", async () => {
    write.mockResolvedValue({
      path: "notes.txt",
      content: "Changed twice",
      revision: "r2",
    });
    await openEditor();
    fireEvent.change(screen.getByLabelText("Edit notes.txt"), {
      target: { value: "Changed" },
    });
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    fireEvent.change(screen.getByLabelText("Edit notes.txt"), {
      target: { value: "Changed twice" },
    });
    expect(write).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(650);
    });
    expect(write).toHaveBeenCalledExactlyOnceWith(
      "one",
      "notes.txt",
      "Changed twice",
      "r1",
      false,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Saved");
    expect(localStorage.getItem("foldory:draft:one:notes.txt")).toBeNull();
  });

  it("serializes newer edits behind an in-flight write and flushes navigation", async () => {
    let finishFirst:
      | ((value: { path: string; content: string; revision: string }) => void)
      | undefined;
    let finishSecond:
      | ((value: { path: string; content: string; revision: string }) => void)
      | undefined;
    write
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishFirst = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishSecond = resolve;
          }),
      );
    await openEditor();
    fireEvent.change(screen.getByLabelText("Edit notes.txt"), {
      target: { value: "First edit" },
    });
    let navigation: Promise<void> = Promise.resolve();
    await act(async () => {
      navigation = beforeNavigate();
      await Promise.resolve();
    });
    expect(write).toHaveBeenCalledTimes(1);
    fireEvent.change(screen.getByLabelText("Edit notes.txt"), {
      target: { value: "Second edit" },
    });
    expect(write).toHaveBeenCalledTimes(1);
    await act(async () => {
      finishFirst?.({
        path: "notes.txt",
        content: "First edit",
        revision: "r2",
      });
    });
    expect(write).toHaveBeenNthCalledWith(
      2,
      "one",
      "notes.txt",
      "Second edit",
      "r2",
      false,
    );
    await act(async () => {
      finishSecond?.({
        path: "notes.txt",
        content: "Second edit",
        revision: "r3",
      });
      await navigation;
    });
    expect(screen.getByRole("status")).toHaveTextContent("Saved");
  });

  it("blocks navigation after a conflict and retains a recovery draft", async () => {
    write.mockRejectedValue(new Error("Conflict: file changed on disk"));
    await openEditor();
    fireEvent.change(screen.getByLabelText("Edit notes.txt"), {
      target: { value: "Keep this draft" },
    });
    await act(async () => {
      await expect(beforeNavigate()).rejects.toThrow("Conflict");
    });
    expect(screen.getByRole("alert")).toHaveTextContent("file changed on disk");
    expect(screen.getByLabelText("Edit notes.txt")).toHaveValue(
      "Keep this draft",
    );
    expect(
      JSON.parse(localStorage.getItem("foldory:draft:one:notes.txt") || "{}")
        .content,
    ).toBe("Keep this draft");
  });

  it("offers explicit draft restoration without silently overwriting disk", async () => {
    localStorage.setItem(
      "foldory:draft:one:notes.txt",
      JSON.stringify({
        content: "Recovered work",
        revision: "older",
        savedAt: Date.now(),
      }),
    );
    write.mockRejectedValue(new Error("Conflict: external edit"));
    await openEditor();
    expect(screen.getByLabelText("Edit notes.txt")).toHaveValue("Original");
    expect(write).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Restore draft" }));
    expect(screen.getByLabelText("Edit notes.txt")).toHaveValue(
      "Recovered work",
    );
    await act(async () => {
      vi.advanceTimersByTime(650);
    });
    expect(write).toHaveBeenCalledWith(
      "one",
      "notes.txt",
      "Recovered work",
      "older",
      false,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("external edit");
  });

  it("refreshes a clean open file after an assistant write and saves subsequent edits against its new revision", async () => {
    let view!: ReturnType<typeof render>;
    const props = { projectId: "one", path: "notes.txt", onError: vi.fn() };
    await act(async () => {
      view = render(<Editor {...props} refreshVersion={0} />);
    });
    read.mockResolvedValue({
      path: "notes.txt",
      content: "Saved by assistant",
      revision: "assistant-revision",
    });
    await act(async () => {
      view.rerender(<Editor {...props} refreshVersion={1} />);
    });
    expect(screen.getByLabelText("Edit notes.txt")).toHaveValue(
      "Saved by assistant",
    );
    write.mockResolvedValue({
      path: "notes.txt",
      content: "Then edited locally",
      revision: "local-revision",
    });
    fireEvent.change(screen.getByLabelText("Edit notes.txt"), {
      target: { value: "Then edited locally" },
    });
    await act(async () => {
      vi.advanceTimersByTime(650);
    });
    expect(write).toHaveBeenCalledWith(
      "one",
      "notes.txt",
      "Then edited locally",
      "assistant-revision",
      false,
    );
  });

  it("preserves unsaved local edits when the assistant changes the file on disk", async () => {
    let view!: ReturnType<typeof render>;
    const props = { projectId: "one", path: "notes.txt", onError: vi.fn() };
    await act(async () => {
      view = render(<Editor {...props} refreshVersion={0} />);
    });
    fireEvent.change(screen.getByLabelText("Edit notes.txt"), {
      target: { value: "Unsaved local work" },
    });
    read.mockResolvedValue({
      path: "notes.txt",
      content: "Saved by assistant",
      revision: "assistant-revision",
    });
    await act(async () => {
      view.rerender(<Editor {...props} refreshVersion={1} />);
    });
    await act(async () => {
      vi.advanceTimersByTime(650);
    });
    expect(screen.getByLabelText("Edit notes.txt")).toHaveValue(
      "Unsaved local work",
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "assistant changed this file",
    );
    expect(
      JSON.parse(localStorage.getItem("foldory:draft:one:notes.txt") || "{}")
        .content,
    ).toBe("Unsaved local work");
    expect(write).not.toHaveBeenCalled();
  });
});
