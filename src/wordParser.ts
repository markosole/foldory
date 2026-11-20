import type { PDFDocumentProxy } from "pdfjs-dist";
import { api } from "./api";
import type { FileExamination } from "./types";

export interface WordProgress {
  completed: number;
  total: number;
  page?: number;
  image?: string;
  renderer?: string;
}

/** Render only one page at a time; never hold a document-sized array of bitmaps. */
export async function openWordPdf(base64: string): Promise<PDFDocumentProxy> {
  const { getDocument, GlobalWorkerOptions } = await import("pdfjs-dist");
  const { default: workerUrl } =
    await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
  GlobalWorkerOptions.workerSrc = workerUrl;
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const task = getDocument({
    data: bytes,
    useSystemFonts: true,
    stopAtErrors: true,
    cMapUrl: "/pdfjs/cmaps/",
    standardFontDataUrl: "/pdfjs/standard_fonts/",
    wasmUrl: "/pdfjs/wasm/",
    iccUrl: "/pdfjs/iccs/",
  });
  try {
    return await task.promise;
  } catch (error) {
    await task.destroy();
    throw error;
  }
}

export async function renderWordPage(pdf: PDFDocumentProxy, number: number) {
  const page = await pdf.getPage(number);
  const rawViewport = page.getViewport({ scale: 1 });
  // Fixed pixel budget works for portrait, landscape and unusually large paper sizes.
  const viewport = page.getViewport({
    scale: Math.min(2, 1800 / Math.max(rawViewport.width, rawViewport.height)),
  });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  try {
    await page.render({ canvas, viewport }).promise;
    const content = await page.getTextContent();
    const text = content.items.flatMap((item) =>
      "str" in item
        ? [
            {
              text: item.str,
              font: content.styles[item.fontName]?.fontFamily ?? item.fontName,
              sizePt:
                Math.round(
                  Math.hypot(item.transform[2], item.transform[3]) * 10,
                ) / 10,
              x: Math.round(item.transform[4]),
              y: Math.round(item.transform[5]),
              endOfLine: item.hasEOL,
            },
          ]
        : [],
    );
    return {
      image: canvas.toDataURL("image/jpeg", 0.88),
      text: JSON.stringify(text),
    };
  } finally {
    canvas.width = 0;
    canvas.height = 0;
    page.cleanup();
  }
}

export class WordParsingStopped extends Error {
  constructor() {
    super("Parsing stopped. Completed pages are retained; resume when ready.");
  }
}

export async function parseVisualWord({
  projectId,
  path,
  instructions,
  signal,
  onProgress,
}: {
  projectId: string;
  path: string;
  instructions: string;
  signal: AbortSignal;
  onProgress: (value: WordProgress) => void;
}): Promise<{ id: string; document: FileExamination }> {
  const check = () => {
    if (signal.aborted) throw new WordParsingStopped();
  };
  check();
  const prepared = await api.prepareWordDocument(projectId, path, instructions);
  check();
  const pdf = await openWordPdf(prepared.pdf);
  try {
    if (pdf.numPages < 1 || pdf.numPages > 500)
      throw new Error(
        "Visual parsing supports 1 to 500 pages. Split larger Word documents before parsing.",
      );
    const cached = prepared.completedPages;
    let completed = Object.keys(cached).filter(
      (n) => Number(n) >= 1 && Number(n) <= pdf.numPages,
    ).length;
    onProgress({ completed, total: pdf.numPages, renderer: prepared.renderer });
    for (let page = 1; page <= pdf.numPages; page++) {
      check();
      if (cached[String(page)] !== undefined) continue;
      const rendered = await renderWordPage(pdf, page);
      check();
      onProgress({
        completed,
        total: pdf.numPages,
        page,
        image: rendered.image,
        renderer: prepared.renderer,
      });
      // The in-flight page finishes and is cached when stopped; no next request starts.
      await api.parseWordPage(
        projectId,
        prepared.id,
        page,
        pdf.numPages,
        rendered.text,
        rendered.image,
      );
      completed++;
      check();
      onProgress({
        completed,
        total: pdf.numPages,
        page,
        renderer: prepared.renderer,
      });
    }
    check();
    const result = await api.completeWordDocument(
      projectId,
      prepared.id,
      pdf.numPages,
    );
    check();
    return { id: prepared.id, document: result };
  } finally {
    await pdf.loadingTask.destroy();
  }
}
