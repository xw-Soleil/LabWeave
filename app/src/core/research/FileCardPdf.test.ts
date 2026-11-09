import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ open: vi.fn(), destroy: vi.fn() }));
vi.mock("./PdfDocument", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./PdfDocument")>()),
  openPdfDocument: mocks.open,
}));
vi.mock("i18next", () => ({
  default: { t: (key: string, options?: { error?: string }) => (options?.error ? `${key}: ${options.error}` : key) },
}));
import { extractPdfCardContent, extractPdfText } from "./FileCardContent";
import { pdfWithTimeout, type PdfDocument } from "./PdfDocument";

function textPage(text: string) {
  return {
    getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 900 * scale }),
    render: vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() })),
    streamTextContent: vi.fn(
      () =>
        new ReadableStream({
          start(controller) {
            controller.enqueue({ items: [{ str: text, hasEOL: true }] });
            controller.close();
          },
        }),
    ),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.destroy.mockResolvedValue(undefined);
  vi.stubGlobal("document", {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => ({ fillRect: vi.fn() }),
      toBlob: (callback: (blob: Blob) => void) => callback(new Blob(["cover"], { type: "image/webp" })),
    }),
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("PDF card extraction", () => {
  it("renders the cover before extracting limited AI text and releases the document", async () => {
    const page = textPage("excerpt");
    const document = {
      numPages: 10,
      getPage: vi.fn<(number: number) => Promise<typeof page>>().mockResolvedValue(page),
      getMetadata: vi.fn(async () => ({ info: { Title: "PDF Title" } })),
    };
    mocks.open.mockResolvedValue({ document, run: pdfWithTimeout, destroy: mocks.destroy });
    const card = await extractPdfCardContent("/r/paper.pdf", "paper.pdf", 3);
    expect(mocks.open).toHaveBeenCalledWith("/r/paper.pdf", expect.any(Function), expect.any(AbortSignal));
    expect(card).toMatchObject({
      title: "PDF Title",
      pageCount: 10,
      problem: "",
      excerpt: "excerpt\n\nexcerpt\n\nexcerpt",
    });
    expect(card.thumbnail).toBeInstanceOf(Blob);
    expect(document.getPage.mock.calls.map(([number]) => number)).toEqual([1, 1, 2, 3]);
    expect(page.render.mock.invocationCallOrder[0]).toBeLessThan(page.streamTextContent.mock.invocationCallOrder[0]);
    expect(mocks.destroy).toHaveBeenCalledOnce();
  });
  it("does not extract text when the existing setting is zero", async () => {
    const page = textPage("unused");
    mocks.open.mockResolvedValue({
      document: { numPages: 5, getPage: async () => page, getMetadata: async () => ({ info: {} }) },
      run: pdfWithTimeout,
      destroy: mocks.destroy,
    });
    const card = await extractPdfCardContent("/r/paper.pdf", "paper.pdf", 0);
    expect(card.excerpt).toBe("");
    expect(page.streamTextContent).not.toHaveBeenCalled();
  });
  it("reports password failures without spinning indefinitely", async () => {
    mocks.open.mockRejectedValue(Object.assign(new Error("password"), { name: "PasswordException" }));
    expect(await extractPdfCardContent("/r/locked.pdf", "locked.pdf", 3)).toMatchObject({
      pageCount: 0,
      title: "locked",
      problem: "card.pdfLocked",
    });
  });
  it("still keeps AI text if the cover render stalls and cancels the render", async () => {
    vi.useFakeTimers();
    const page = textPage("kept for AI");
    const cancel = vi.fn();
    page.render.mockReturnValue({ promise: new Promise(() => {}), cancel });
    mocks.open.mockResolvedValue({
      document: { numPages: 1, getPage: async () => page, getMetadata: async () => ({ info: {} }) },
      run: pdfWithTimeout,
      destroy: mocks.destroy,
    });
    const extracting = extractPdfCardContent("/r/slow.pdf", "slow.pdf", 3);
    await vi.advanceTimersByTimeAsync(15001);
    const card = await extracting;
    expect(card.thumbnail).toBeNull();
    expect(card.excerpt).toBe("kept for AI");
    expect(card.problem).toContain("thumbnailFailed");
    expect(cancel).toHaveBeenCalledOnce();
    expect(mocks.destroy).toHaveBeenCalledOnce();
  });
});

describe("bounded PDF text streams", () => {
  it("caps a single large text item and stops before parsing unnecessary pages", async () => {
    const document = { getPage: vi.fn(async () => textPage("字".repeat(20000))) };
    const result = await extractPdfText(document as unknown as PdfDocument, 50, vi.fn());
    expect(result).toHaveLength(4000);
    expect(document.getPage).toHaveBeenCalledOnce();
  });
  it("ends on a stalled scan instead of waiting once for every requested page", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const report = vi.fn();
    const document = { getPage: vi.fn(async () => ({ streamTextContent: () => new ReadableStream({ cancel }) })) };
    const extracting = extractPdfText(document as unknown as PdfDocument, 50, report);
    await vi.advanceTimersByTimeAsync(5001);
    expect(await extracting).toBe("");
    expect(document.getPage).toHaveBeenCalledOnce();
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ message: "pdfTextTimeout" }));
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("retains received text when WKWebView omits the stream end signal", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const report = vi.fn();
    const document = {
      getPage: async () => ({
        streamTextContent: () =>
          new ReadableStream({
            start(controller) {
              controller.enqueue({ items: [{ str: "available text" }] });
            },
            cancel,
          }),
      }),
    };
    const extracting = extractPdfText(document as unknown as PdfDocument, 1, report);
    await vi.advanceTimersByTimeAsync(301);
    expect(await extracting).toBe("available text");
    expect(cancel).toHaveBeenCalledOnce();
    expect(report).not.toHaveBeenCalled();
  });
  it("reports cancellation failures without throwing away the extracted text", async () => {
    vi.useFakeTimers();
    const report = vi.fn();
    const document = {
      getPage: async () => ({
        streamTextContent: () =>
          new ReadableStream({
            start(controller) {
              controller.enqueue({ items: [{ str: "retained" }] });
            },
            cancel() {
              throw new Error("cancel failed");
            },
          }),
      }),
    };
    const extracting = extractPdfText(document as unknown as PdfDocument, 1, report);
    await vi.advanceTimersByTimeAsync(301);
    expect(await extracting).toBe("retained");
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ message: "cancel failed" }));
  });
});
