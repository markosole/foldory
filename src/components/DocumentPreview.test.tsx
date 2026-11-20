import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import type { FileExamination } from "../types";
import DocumentPreview from "./DocumentPreview";

vi.mock("../api", () => ({
  api: { examineFile: vi.fn(), openExternalUrl: vi.fn() },
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("document examination", () => {
  it("renders every CSV record including quoted newlines without executing cell markup", async () => {
    vi.mocked(api.examineFile).mockResolvedValue({
      path: "amounts.csv",
      format: "csv",
      content:
        'CSV records\nRow 1: ["Status","Billed"]\nRow 2: ["<script>example</script>","120"]\nRow 3: ["Multi\\nline","80"]\n',
      warnings: [],
    });
    const include = vi.fn();
    render(
      <DocumentPreview
        projectId="p"
        path="amounts.csv"
        onInclude={include}
        onError={vi.fn()}
      />,
    );
    expect(await screen.findByRole("cell", { name: "120" })).toBeVisible();
    expect(screen.getByRole("cell", { name: "80" })).toBeVisible();
    expect(
      screen.getByRole("cell", { name: /Multi\s+line/ }),
    ).toHaveTextContent("Multi line");
    expect(document.querySelector("script")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Include in Assistant" }),
    );
    expect(include).toHaveBeenCalledOnce();
  });

  it("ignores stale extraction results after selecting a different document", async () => {
    let resolveOld!: (value: FileExamination) => void;
    vi.mocked(api.examineFile).mockImplementation((_, path) =>
      path === "old.docx"
        ? new Promise((resolve) => {
            resolveOld = resolve;
          })
        : Promise.resolve({
            path,
            format: "docx",
            content: "# New document",
            warnings: ["Images are omitted."],
          }),
    );
    const props = { projectId: "p", onInclude: vi.fn(), onError: vi.fn() };
    const view = render(<DocumentPreview {...props} path="old.docx" />);
    view.rerender(<DocumentPreview {...props} path="new.docx" />);
    expect(
      await screen.findByRole("heading", { name: "New document" }),
    ).toBeVisible();
    resolveOld({
      path: "old.docx",
      format: "docx",
      content: "# Old document",
      warnings: [],
    });
    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: "Old document" }),
      ).toBeNull(),
    );
    expect(screen.getByRole("status")).toHaveTextContent("Images are omitted.");
    fireEvent.click(screen.getByRole("button", { name: "Extracted text" }));
    expect(
      screen.getByLabelText("Extracted document content"),
    ).toHaveTextContent("# New document");
  });
});
