// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  open: vi.fn(),
  getDocument: vi.fn(),
  workerDestroy: vi.fn(),
  transport: undefined as unknown,
}));
vi.mock("@tauri-apps/plugin-fs", () => ({ open: mocks.open, SeekMode: { Start: 0 } }));
vi.mock("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url", () => ({ default: "/pdf.worker.mjs" }));
vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
  PDFWorker: { create: () => ({ destroy: mocks.workerDestroy }) },
  PDFDataRangeTransport: class {
    requestDataRange = vi.fn<(begin: number, end: number) => void>();
    onDataRange = vi.fn();
    constructor(
      readonly length: number,
      readonly initial: Uint8Array,
    ) {
      mocks.transport = this;
    }
  },
  getDocument: mocks.getDocument,
}));
import { openPdfDocument, pdfWithTimeout } from "./PdfDocument";

let workers: Array<EventTarget & { terminate: ReturnType<typeof vi.fn> }>;
let file: {
  stat: ReturnType<typeof vi.fn>;
  seek: ReturnType<typeof vi.fn>;
  read: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
};
let destroy: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.clearAllMocks();
  workers = [];
  vi.stubGlobal(
    "Worker",
    class extends EventTarget {
      terminate = vi.fn();
      constructor() {
        super();
        workers.push(this);
      }
    },
  );
  file = {
    stat: vi.fn(async () => ({ size: 1024 * 1024 })),
    seek: vi.fn(async (offset: number) => offset),
    read: vi.fn(async (buffer: Uint8Array) => buffer.length),
    close: vi.fn(async () => {}),
  };
  mocks.open.mockResolvedValue(file);
  destroy = vi.fn(async () => {});
  mocks.getDocument.mockReturnValue({ promise: Promise.resolve({ numPages: 12 }), destroy });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("PDF worker and range lifecycle", () => {
  it("loads only an initial range, disables eager loading and serves further requested ranges", async () => {
    const session = await openPdfDocument("/allowed/a.pdf", vi.fn());
    expect(mocks.open).toHaveBeenCalledWith("/allowed/a.pdf", { read: true });
    expect(session.reader.bytesRead).toBe(65536);
    expect(mocks.getDocument.mock.calls[0][0]).toMatchObject({
      disableAutoFetch: true,
      disableStream: true,
      rangeChunkSize: 65536,
      isOffscreenCanvasSupported: false,
      isImageDecoderSupported: false,
    });
    expect(mocks.getDocument.mock.calls[0][0]).not.toHaveProperty("data");
    const transport = mocks.transport as {
      requestDataRange(begin: number, end: number): void;
      onDataRange: ReturnType<typeof vi.fn>;
    };
    transport.requestDataRange(65536, 131072);
    await vi.waitFor(() => expect(transport.onDataRange).toHaveBeenCalledOnce());
    expect(session.reader.bytesRead).toBe(131072);
    await Promise.all([session.destroy(), session.destroy()]);
    expect(workers[0].terminate).toHaveBeenCalledOnce();
    expect(file.close).toHaveBeenCalledOnce();
  });
  it("terminates the native worker even if pdf.js never acknowledges destruction", async () => {
    vi.useFakeTimers();
    destroy.mockReturnValue(new Promise(() => {}));
    const session = await openPdfDocument("/a.pdf", vi.fn());
    const closing = session.destroy();
    await vi.advanceTimersByTimeAsync(1001);
    await closing;
    expect(workers[0].terminate).toHaveBeenCalledOnce();
    expect(file.close).toHaveBeenCalledOnce();
  });
  it("times out a stalled load, releases the handle and terminates the worker", async () => {
    vi.useFakeTimers();
    mocks.getDocument.mockReturnValue({ promise: new Promise(() => {}), destroy });
    const result = expect(openPdfDocument("/a.pdf", vi.fn())).rejects.toThrow("pdfTimeout");
    await vi.advanceTimersByTimeAsync(20001);
    await result;
    expect(workers[0].terminate).toHaveBeenCalledOnce();
    expect(file.close).toHaveBeenCalledOnce();
  });
  it("reports late range errors and stops the worker instead of leaving the viewer waiting", async () => {
    const report = vi.fn();
    await openPdfDocument("/a.pdf", report);
    file.read.mockRejectedValueOnce(new Error("access denied"));
    (mocks.transport as { requestDataRange(begin: number, end: number): void }).requestDataRange(65536, 131072);
    await vi.waitFor(() => expect(report).toHaveBeenCalledWith(expect.objectContaining({ message: "access denied" })));
    await vi.waitFor(() => expect(workers[0].terminate).toHaveBeenCalledOnce());
  });
  it("aborts an open document and does not report intentional closure as failure", async () => {
    const controller = new AbortController();
    const report = vi.fn();
    const session = await openPdfDocument("/a.pdf", report, controller.signal);
    controller.abort();
    await session.destroy();
    expect(workers[0].terminate).toHaveBeenCalledOnce();
    expect(report).not.toHaveBeenCalled();
  });
  it("surfaces worker failure and rejects pending operations", async () => {
    const report = vi.fn();
    const session = await openPdfDocument("/a.pdf", report);
    const pending = expect(session.run(new Promise(() => {}))).rejects.toThrow("pdfWorkerFailed");
    workers[0].dispatchEvent(new Event("error"));
    await pending;
    await session.destroy();
    expect(report).toHaveBeenCalledOnce();
  });
  it("clears the deadline timer on successful operations", async () => {
    vi.useFakeTimers();
    await expect(pdfWithTimeout(Promise.resolve(42))).resolves.toBe(42);
    expect(vi.getTimerCount()).toBe(0);
  });
});
