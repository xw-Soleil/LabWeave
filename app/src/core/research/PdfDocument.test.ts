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
    expect(session.reader.bytesRead).toBe(262144);
    expect(mocks.getDocument.mock.calls[0][0]).toMatchObject({
      disableAutoFetch: true,
      disableStream: true,
      rangeChunkSize: 262144,
      isOffscreenCanvasSupported: false,
      isImageDecoderSupported: false,
    });
    expect(mocks.getDocument.mock.calls[0][0]).not.toHaveProperty("data");
    const transport = mocks.transport as {
      requestDataRange(begin: number, end: number): void;
      onDataRange: ReturnType<typeof vi.fn>;
    };
    transport.requestDataRange(262144, 524288);
    await vi.waitFor(() => expect(transport.onDataRange).toHaveBeenCalledOnce());
    expect(session.reader.bytesRead).toBe(524288);
    expect(file.seek).toHaveBeenCalledOnce();
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
  it("clips the initial chunk to a small file and caps merged range reads", async () => {
    file.stat.mockResolvedValueOnce({ size: 100000 });
    const small = await openPdfDocument("/small.pdf", vi.fn());
    expect(small.reader.bytesRead).toBe(100000);
    await small.destroy();
    const session = await openPdfDocument("/large.pdf", vi.fn());
    file.read.mockClear();
    const transport = mocks.transport as {
      requestDataRange(begin: number, end: number): void;
      onDataRange: ReturnType<typeof vi.fn>;
    };
    transport.requestDataRange(262144, 900000);
    await vi.waitFor(() => expect(transport.onDataRange).toHaveBeenCalledOnce());
    expect(file.read.mock.calls.map(([buffer]) => buffer.length)).toEqual([262144, 262144, 113568]);
    await session.destroy();
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
  it("still terminates the native worker if pdf.js cleanup throws", async () => {
    const session = await openPdfDocument("/a.pdf", vi.fn());
    mocks.workerDestroy.mockImplementationOnce(() => {
      throw new Error("cleanup failed");
    });
    await expect(session.destroy()).rejects.toThrow("cleanup failed");
    expect(workers[0].terminate).toHaveBeenCalledOnce();
    expect(file.close).toHaveBeenCalledOnce();
  });
  it("reports a stalled file close without blocking the caller or leaving the worker alive", async () => {
    vi.useFakeTimers();
    file.close.mockReturnValue(new Promise(() => {}));
    const report = vi.fn();
    const session = await openPdfDocument("/a.pdf", report);
    const closing = session.destroy();
    await vi.advanceTimersByTimeAsync(1001);
    await closing;
    expect(workers[0].terminate).toHaveBeenCalledOnce();
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ message: "pdfTimeout" }));
  });
  it("closes a handle when cancellation arrives during stat", async () => {
    const controller = new AbortController();
    file.stat.mockReturnValue(new Promise(() => {}));
    const result = expect(openPdfDocument("/a.pdf", vi.fn(), controller.signal)).rejects.toThrow("fileClosed");
    await vi.waitFor(() => expect(file.stat).toHaveBeenCalledOnce());
    controller.abort();
    await vi.waitFor(() => expect(file.close).toHaveBeenCalledOnce());
    await result;
    expect(workers).toHaveLength(0);
  });
  it("does not start pdf.js after cancellation during the initial range", async () => {
    const controller = new AbortController();
    let finish!: (count: number) => void;
    file.read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const result = expect(openPdfDocument("/a.pdf", vi.fn(), controller.signal)).rejects.toThrow("fileClosed");
    await vi.waitFor(() => expect(file.read).toHaveBeenCalledOnce());
    controller.abort();
    finish(65536);
    await result;
    expect(mocks.getDocument).not.toHaveBeenCalled();
    expect(file.close).toHaveBeenCalledOnce();
  });
  it("stops the worker when a post-load operation times out", async () => {
    vi.useFakeTimers();
    const report = vi.fn();
    const session = await openPdfDocument("/a.pdf", report);
    const result = expect(session.run(new Promise(() => {}), 50)).rejects.toThrow("pdfTimeout");
    await vi.advanceTimersByTimeAsync(51);
    await result;
    expect(workers[0].terminate).toHaveBeenCalledOnce();
    expect(file.close).toHaveBeenCalledOnce();
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ message: "pdfTimeout" }));
  });
  it("closes a handle that arrives after the open deadline", async () => {
    vi.useFakeTimers();
    let finish!: (handle: typeof file) => void;
    mocks.open.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const result = expect(openPdfDocument("/a.pdf", vi.fn())).rejects.toThrow("pdfTimeout");
    await vi.advanceTimersByTimeAsync(20001);
    await result;
    finish(file);
    await vi.advanceTimersByTimeAsync(0);
    expect(file.close).toHaveBeenCalledOnce();
    expect(file.stat).not.toHaveBeenCalled();
    expect(workers).toHaveLength(0);
  });
});
