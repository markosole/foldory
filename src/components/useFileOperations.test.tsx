import {
  cleanup,
  createEvent,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { api } from "../api";
import { beforeNavigate } from "../navigation";
import type { FileEntry, FileOperationPlan } from "../types";
import { ASSISTANT_FILES_MIME } from "../assistantSources";
import useFileOperations from "./useFileOperations";

vi.mock("../api", () => ({
  api: { previewFileOperation: vi.fn(), executeFileOperation: vi.fn() },
}));
vi.mock("../navigation", () => ({ beforeNavigate: vi.fn() }));
const entries: FileEntry[] = [
  {
    path: "Secure/Bundle",
    name: "Bundle",
    directory: true,
    size: 0,
    modifiedAt: 0,
  },
];
const plan: FileOperationPlan = {
  items: [{ source: "Secure/Bundle", destination: "Docs/Bundle" }],
  protectedCount: 2,
  protectionChanges: [],
  confirmationToken: "reviewed-plan",
};
const onChanged = vi.fn();
const onError = vi.fn();

function Harness({ projectId = "p0" }: { projectId?: string }) {
  const operations = useFileOperations({ projectId, onChanged, onError });
  return (
    <>
      <button onClick={() => operations.cut(entries)}>Cut</button>
      <button onClick={() => operations.copy(entries)}>Copy</button>
      <button
        onClick={() => void operations.paste("Docs")}
        disabled={!operations.clipboard || operations.busy}
      >
        Paste
      </button>
      <button onClick={() => void operations.remove(entries)}>Delete</button>
      <div
        data-testid="drop"
        onDrop={(event) => operations.drop(event, "Docs")}
      />
      <p role="status">{operations.status}</p>
      {operations.dialog}
    </>
  );
}

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
});
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(beforeNavigate).mockResolvedValue(undefined);
  vi.mocked(api.previewFileOperation).mockResolvedValue(plan);
  vi.mocked(api.executeFileOperation).mockResolvedValue({
    completed: plan.items,
  });
});
afterEach(cleanup);

describe("file operations", () => {
  it("flushes the editor before previewing, pastes a cut folder, then clears the cut clipboard", async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Cut" }));
    fireEvent.click(screen.getByRole("button", { name: "Paste" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    const request = {
      kind: "move",
      paths: ["Secure/Bundle"],
      destination: "Docs",
    };
    expect(api.previewFileOperation).toHaveBeenCalledWith("p0", request);
    expect(api.executeFileOperation).toHaveBeenCalledWith(
      "p0",
      request,
      "reviewed-plan",
    );
    expect(beforeNavigate).toHaveBeenCalled();
    expect(vi.mocked(beforeNavigate).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(api.previewFileOperation).mock.invocationCallOrder[0],
    );
    expect(screen.getByRole("button", { name: "Paste" })).toBeDisabled();
  });

  it("retains copied items for repeated pastes", async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    fireEvent.click(screen.getByRole("button", { name: "Paste" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: "Paste" })).toBeEnabled();
    expect(api.executeFileOperation).toHaveBeenCalledWith(
      "p0",
      { kind: "copy", paths: ["Secure/Bundle"], destination: "Docs" },
      plan.confirmationToken,
    );
  });

  it.each(["Cut", "Copy"])(
    "requires explicit confirmation when %s would expose a protected descendant",
    async (action) => {
      vi.mocked(api.previewFileOperation).mockResolvedValue({
        ...plan,
        protectionChanges: [
          {
            source: "Secure/Bundle/note.txt",
            destination: "Docs/Bundle/note.txt",
            reason: "Inherited private folder",
          },
        ],
      });
      render(<Harness />);
      fireEvent.click(screen.getByRole("button", { name: action }));
      fireEvent.click(screen.getByRole("button", { name: "Paste" }));
      await screen.findByRole("dialog", {
        name: /outside protected locations/,
      });
      expect(screen.getByText("Secure/Bundle/note.txt")).toBeInTheDocument();
      expect(api.executeFileOperation).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(api.executeFileOperation).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Paste" }));
      fireEvent.click(await screen.findByRole("button", { name: /anyway/ }));
      await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    },
  );

  it("confirms permanent folder deletion, warns about excluded contents, and supports cancellation", async () => {
    vi.mocked(api.previewFileOperation).mockResolvedValue({
      ...plan,
      items: [{ source: "Secure/Bundle" }],
    });
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await screen.findByRole("dialog", {
      name: "Permanently delete selected items?",
    });
    expect(
      screen.getByText(/does not use the Recycle Bin/),
    ).toBeInTheDocument();
    expect(screen.getByText(/2 protected or excluded/)).toBeInTheDocument();
    expect(api.executeFileOperation).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(api.executeFileOperation).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Delete permanently" }),
    );
    await waitFor(() =>
      expect(api.executeFileOperation).toHaveBeenCalledWith(
        "p0",
        { kind: "delete", paths: ["Secure/Bundle"] },
        plan.confirmationToken,
      ),
    );
  });

  it("retains cut items and reports a conflict or stale confirmation without updating paths", async () => {
    vi.mocked(api.executeFileOperation).mockRejectedValue(
      new Error("The selected items changed"),
    );
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Cut" }));
    fireEvent.click(screen.getByRole("button", { name: "Paste" }));
    await waitFor(() =>
      expect(onError).toHaveBeenCalledWith("Error: The selected items changed"),
    );
    expect(onChanged).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Paste" })).toBeEnabled();
  });

  it("does not preview or mutate if editor saving fails", async () => {
    vi.mocked(beforeNavigate).mockRejectedValue(new Error("Save conflict"));
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(onError).toHaveBeenCalled());
    expect(api.previewFileOperation).not.toHaveBeenCalled();
    expect(api.executeFileOperation).not.toHaveBeenCalled();
  });

  it("keeps only unfinished cut items after a partial batch failure", async () => {
    vi.mocked(api.executeFileOperation).mockResolvedValue({
      completed: [],
      error: "Folder partially copied",
    });
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Cut" }));
    fireEvent.click(screen.getByRole("button", { name: "Paste" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(onError).toHaveBeenCalledWith("Folder partially copied");
    expect(screen.getByRole("button", { name: "Paste" })).toBeEnabled();
  });

  it("clears the clipboard on project changes", async () => {
    const { rerender } = render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Cut" }));
    expect(screen.getByRole("button", { name: "Paste" })).toBeEnabled();
    rerender(<Harness projectId="other" />);
    expect(screen.getByRole("button", { name: "Paste" })).toBeDisabled();
  });

  it("updates copied paths when a later drag moves those items", async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    fireEvent.drop(screen.getByTestId("drop"), {
      dataTransfer: {
        types: [ASSISTANT_FILES_MIME],
        getData: () =>
          JSON.stringify({ projectId: "p0", paths: ["Secure/Bundle"] }),
      },
    });
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Paste" }));
    await waitFor(() =>
      expect(api.previewFileOperation).toHaveBeenLastCalledWith("p0", {
        kind: "copy",
        paths: ["Docs/Bundle"],
        destination: "Docs",
      }),
    );
  });

  it("moves dropped selections, supports Ctrl-copy, and refuses another project's drag", async () => {
    render(<Harness />);
    const dataTransfer = {
      types: [ASSISTANT_FILES_MIME],
      getData: () =>
        JSON.stringify({ projectId: "p0", paths: ["Secure/Bundle"] }),
    };
    fireEvent.drop(screen.getByTestId("drop"), { dataTransfer });
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(api.previewFileOperation).toHaveBeenLastCalledWith("p0", {
      kind: "move",
      paths: ["Secure/Bundle"],
      destination: "Docs",
    });
    const copyDrop = createEvent.drop(screen.getByTestId("drop"), {
      dataTransfer,
    });
    Object.defineProperty(copyDrop, "ctrlKey", { value: true });
    fireEvent(screen.getByTestId("drop"), copyDrop);
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(2));
    expect(api.previewFileOperation).toHaveBeenLastCalledWith("p0", {
      kind: "copy",
      paths: ["Secure/Bundle"],
      destination: "Docs",
    });
    fireEvent.drop(screen.getByTestId("drop"), {
      dataTransfer: {
        ...dataTransfer,
        getData: () =>
          JSON.stringify({ projectId: "other", paths: ["Secure/Bundle"] }),
      },
    });
    expect(api.previewFileOperation).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledWith(
      expect.stringContaining("current project"),
    );
  });
});
