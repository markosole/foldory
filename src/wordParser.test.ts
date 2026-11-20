import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDocument } from "pdfjs-dist";
import { api } from "./api";
import { parseVisualWord } from "./wordParser";

vi.mock("pdfjs-dist", () => ({
  getDocument: vi.fn(),
  GlobalWorkerOptions: {},
}));
vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?url", () => ({
  default: "/worker.mjs",
}));
vi.mock("./api", () => ({
  api: {
    prepareWordDocument: vi.fn(),
    parseWordPage: vi.fn(),
    completeWordDocument: vi.fn(),
  },
}));

function fixture(count: number) {
  const cleanup = vi.fn();
  const destroy = vi.fn().mockResolvedValue(undefined);
  const getPage = vi.fn().mockImplementation(async (page: number) => ({
    getViewport: ({ scale }: { scale: number }) => ({
      width: 600 * scale,
      height: 800 * scale,
    }),
    render: () => ({ promise: Promise.resolve() }),
    getTextContent: async () => ({
      items: [
        {
          str: `Text ${page}`,
          fontName: "f1",
          transform: [12, 0, 0, 12, 50, 700],
          hasEOL: true,
        },
      ],
      styles: { f1: { fontFamily: "Arial" } },
    }),
    cleanup,
  }));
  const pdf = { numPages: count, getPage, loadingTask: { destroy } };
  vi.mocked(getDocument).mockReturnValue({
    promise: Promise.resolve(pdf),
    destroy,
  } as unknown as ReturnType<typeof getDocument>);
  return { getPage, cleanup, destroy };
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(
    "data:image/jpeg;base64,/9j/",
  );
  vi.mocked(api.prepareWordDocument).mockResolvedValue({
    id: "job",
    pdf: "JVBERi0=",
    renderer: "Word",
    completedPages: {},
  });
  vi.mocked(api.parseWordPage).mockResolvedValue("# Page");
  vi.mocked(api.completeWordDocument).mockResolvedValue({
    path: "report.docx",
    format: "docx",
    content: "# Full document",
    warnings: [],
  });
});
const args = () => ({
  projectId: "p",
  path: "report.docx",
  instructions: "Keep headings",
  signal: new AbortController().signal,
  onProgress: vi.fn(),
});

describe("visual Word pipeline", () => {
  it("processes 50 pages sequentially, skips cached pages and frees page resources", async () => {
    const pdf = fixture(50);
    vi.mocked(api.prepareWordDocument).mockResolvedValue({
      id: "job",
      pdf: "JVBERi0=",
      renderer: "Word",
      completedPages: { "1": "# Cached", "2": "Cached second" },
    });
    let active = 0;
    vi.mocked(api.parseWordPage).mockImplementation(async () => {
      active++;
      expect(active).toBe(1);
      await Promise.resolve();
      active--;
      return "# Page";
    });
    const options = args();
    const result = await parseVisualWord(options);
    expect(pdf.getPage).toHaveBeenCalledTimes(48);
    expect(pdf.getPage).toHaveBeenNthCalledWith(1, 3);
    expect(api.parseWordPage).toHaveBeenCalledTimes(48);
    expect(api.parseWordPage).toHaveBeenCalledWith(
      "p",
      "job",
      50,
      50,
      expect.stringContaining('"sizePt":12'),
      "data:image/jpeg;base64,/9j/",
    );
    expect(pdf.cleanup).toHaveBeenCalledTimes(48);
    expect(pdf.destroy).toHaveBeenCalledOnce();
    expect(api.completeWordDocument).toHaveBeenCalledWith("p", "job", 50);
    expect(result.document.content).toBe("# Full document");
  });
  it("stops at a page boundary and never returns or finalizes an incomplete document", async () => {
    const pdf = fixture(20);
    const controller = new AbortController();
    vi.mocked(api.parseWordPage).mockImplementation(async () => {
      controller.abort();
      return "Cached first";
    });
    await expect(
      parseVisualWord({ ...args(), signal: controller.signal }),
    ).rejects.toThrow("Parsing stopped");
    expect(api.parseWordPage).toHaveBeenCalledOnce();
    expect(pdf.getPage).toHaveBeenCalledOnce();
    expect(api.completeWordDocument).not.toHaveBeenCalled();
    expect(pdf.destroy).toHaveBeenCalledOnce();
  });
  it("rejects unsupported page counts before sending images and cleans up after failed pages", async () => {
    let pdf = fixture(501);
    await expect(parseVisualWord(args())).rejects.toThrow("1 to 500");
    expect(api.parseWordPage).not.toHaveBeenCalled();
    expect(pdf.destroy).toHaveBeenCalledOnce();
    pdf = fixture(10);
    vi.mocked(api.parseWordPage).mockRejectedValue(
      new Error("Vision is unavailable"),
    );
    await expect(parseVisualWord(args())).rejects.toThrow(
      "Vision is unavailable",
    );
    expect(api.completeWordDocument).not.toHaveBeenCalled();
    expect(pdf.destroy).toHaveBeenCalledOnce();
  });
});
