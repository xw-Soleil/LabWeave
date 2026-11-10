import { PdfActionType, PdfErrorCode, PdfZoomMode } from "@embedpdf/models";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("./DocumentFile", () => ({ DocumentRangeReader: { open: mocks.open } }));
import {
  pdfDestination,
  PDF_READER_TIMEOUT,
  PdfReaderEngine,
  pdfPageNumber,
  pdfPageTransform,
  pdfExternalUrl,
  readPdfBuffer,
} from "./PdfReader";

class TestWorker extends EventTarget {
  postMessage = vi.fn();
  terminate = vi.fn();
  send(data: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
  ready() {
    this.send({ id: "0", type: "ReadyResponse" });
  }
}

describe("PDF reader worker lifetime", () => {
  let worker: TestWorker;
  let engine: PdfReaderEngine;
  let report = vi.fn<(error: Error) => void>();
  beforeEach(() => {
    vi.useFakeTimers();
    worker = new TestWorker();
    report = vi.fn();
    engine = new PdfReaderEngine(worker as unknown as Worker, report);
  });
  afterEach(() => {
    engine.destroy();
    vi.useRealTimers();
  });

  it("transfers the file to its local worker and resolves the actual open task", async () => {
    worker.ready();
    const content = new ArrayBuffer(32);
    const task = engine.openDocumentBuffer({ id: "local", content });
    const [request, transfer] = worker.postMessage.mock.calls.at(-1)!;
    expect(transfer).toEqual([content]);
    expect(request.data.name).toBe("openDocumentBuffer");
    worker.send({ id: request.id, type: "ExecuteResponse", data: { type: "result", value: { id: "local" } } });
    await expect(task.toPromise()).resolves.toEqual({ id: "local" });
    vi.advanceTimersByTime(PDF_READER_TIMEOUT + 1);
    expect(report).not.toHaveBeenCalled();
  });

  it("terminates a worker that never becomes ready and releases all pending tasks", () => {
    const task = engine.openDocumentBuffer({ id: "local", content: new ArrayBuffer(1) });
    const rejected = vi.fn();
    task.wait(vi.fn(), rejected);
    vi.advanceTimersByTime(PDF_READER_TIMEOUT + 1);
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(report).toHaveBeenCalledWith(new Error("pdfTimeout"));
    expect(rejected).toHaveBeenCalledOnce();
    expect(engine.tasks.size).toBe(0);
  });

  it("reports password errors and stops the session", () => {
    worker.ready();
    engine.openDocumentBuffer({ id: "local", content: new ArrayBuffer(1) });
    const [request] = worker.postMessage.mock.calls.at(-1)!;
    worker.send({
      id: request.id,
      type: "ExecuteResponse",
      data: { type: "error", value: { type: "reject", reason: { code: PdfErrorCode.Password } } },
    });
    expect(report).toHaveBeenCalledWith(new Error("pdfLocked"));
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("does not treat viewport cancellation as a broken worker", () => {
    worker.ready();
    const task = engine.openDocumentBuffer({ id: "local", content: new ArrayBuffer(1) });
    task.abort({ code: PdfErrorCode.Cancelled, message: "cancelled" });
    vi.advanceTimersByTime(PDF_READER_TIMEOUT + 1);
    expect(report).not.toHaveBeenCalled();
    expect(worker.terminate).not.toHaveBeenCalled();
    expect(engine.tasks.size).toBe(0);
  });

  it("reports a failed postMessage immediately instead of waiting for the watchdog", () => {
    worker.ready();
    worker.postMessage.mockImplementationOnce(() => {
      throw new DOMException("cannot clone", "DataCloneError");
    });
    const task = engine.openDocumentBuffer({ id: "local", content: new ArrayBuffer(1) });
    const rejected = vi.fn();
    task.wait(vi.fn(), rejected);
    expect(rejected).toHaveBeenCalledOnce();
    expect(report).toHaveBeenCalledOnce();
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("does not submit requests cancelled before worker startup", () => {
    const task = engine.openDocumentBuffer({ id: "local", content: new ArrayBuffer(1) });
    task.abort({ code: PdfErrorCode.Cancelled, message: "cancelled" });
    worker.ready();
    expect(worker.postMessage.mock.calls.some(([request]) => request.type === "ExecuteRequest")).toBe(false);
  });

  it("lets plugin teardown close documents after the tab terminated the worker", async () => {
    worker.ready();
    engine.destroy();
    await expect(
      engine.closeDocument({ id: "local" } as Parameters<typeof engine.closeDocument>[0]).toPromise(),
    ).resolves.toBe(true);
    await expect(engine.closeAllDocuments().toPromise()).resolves.toBe(true);
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(report).not.toHaveBeenCalled();
  });

  it.each(["error", "messageerror", "startup"])("reports %s once and ignores late events after close", (kind) => {
    if (kind === "startup") worker.send({ type: "pdfWorkerFailed" });
    else worker.dispatchEvent(new Event(kind));
    worker.dispatchEvent(new Event("error"));
    engine.destroy();
    vi.advanceTimersByTime(PDF_READER_TIMEOUT + 1);
    expect(report).toHaveBeenCalledOnce();
    expect(worker.terminate).toHaveBeenCalledOnce();
  });
});

describe("PDF local buffer reading", () => {
  beforeEach(() => vi.clearAllMocks());
  it("reads only the requested scoped handle and closes it on success", async () => {
    const reader = { size: 4, read: vi.fn(async () => new Uint8Array([1, 2, 3, 4])), close: vi.fn(async () => {}) };
    mocks.open.mockResolvedValue(reader);
    const signal = new AbortController().signal;
    expect(new Uint8Array(await readPdfBuffer("C:\\papers\\a.pdf", signal, vi.fn()))).toEqual(
      new Uint8Array([1, 2, 3, 4]),
    );
    expect(mocks.open).toHaveBeenCalledWith("C:\\papers\\a.pdf", signal);
    expect(reader.read).toHaveBeenCalledWith(0, 4);
    expect(reader.close).toHaveBeenCalledOnce();
  });
  it("rejects an empty PDF and closes its handle", async () => {
    const reader = { size: 0, close: vi.fn(async () => {}) };
    mocks.open.mockResolvedValue(reader);
    await expect(readPdfBuffer("/empty.pdf", new AbortController().signal, vi.fn())).rejects.toThrow("pdfEmpty");
    expect(reader.close).toHaveBeenCalledOnce();
  });
  it.each([128 * 1024 * 1024 + 1, Number.MAX_SAFE_INTEGER, NaN, -1])(
    "rejects unsafe file size %s before allocating or reading the file",
    async (size) => {
      const reader = { size, read: vi.fn(async () => new Uint8Array(1)), close: vi.fn(async () => {}) };
      mocks.open.mockResolvedValue(reader);
      await expect(readPdfBuffer("/large.pdf", new AbortController().signal, vi.fn())).rejects.toThrow("pdfTooLarge");
      expect(reader.read).not.toHaveBeenCalled();
      expect(reader.close).toHaveBeenCalledOnce();
    },
  );
  it("closes a late-opened handle after cancellation", async () => {
    let finish!: (value: unknown) => void;
    mocks.open.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const controller = new AbortController();
    const result = readPdfBuffer("/a.pdf", controller.signal, vi.fn());
    controller.abort();
    await expect(result).rejects.toThrow("fileClosed");
    const close = vi.fn(async () => {});
    finish({ close });
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
  });
  it("reports a late opening/cleanup failure after the tab has closed", async () => {
    let reject!: (error: Error) => void;
    mocks.open.mockImplementationOnce(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    );
    const report = vi.fn();
    const controller = new AbortController();
    const result = readPdfBuffer("/slow.pdf", controller.signal, report);
    controller.abort();
    await expect(result).rejects.toThrow("fileClosed");
    reject(new Error("close failed"));
    await vi.waitFor(() => expect(report).toHaveBeenCalledWith(new Error("close failed")));
  });
  it("allows the size limit itself and closes a failed read", async () => {
    const reader = {
      size: 128 * 1024 * 1024,
      read: vi.fn(async () => {
        throw new Error("disk failed");
      }),
      close: vi.fn(async () => {}),
    };
    mocks.open.mockResolvedValue(reader);
    await expect(readPdfBuffer("/large.pdf", new AbortController().signal, vi.fn())).rejects.toThrow("disk failed");
    expect(reader.read).toHaveBeenCalledWith(0, reader.size);
    expect(reader.close).toHaveBeenCalledOnce();
  });
  it("surfaces close errors rather than silently leaking a handle", async () => {
    mocks.open.mockResolvedValue({
      size: 2,
      read: async () => new Uint8Array(2),
      close: async () => {
        throw new Error("close failed");
      },
    });
    await expect(readPdfBuffer("/a.pdf", new AbortController().signal, vi.fn())).rejects.toThrow("close failed");
  });
});

describe("PDF navigation", () => {
  it.each(["", "0", "2.2", "1e1", "-1", "11", "NaN"])("rejects invalid page %s", (value) => {
    expect(pdfPageNumber(value, 10)).toBeUndefined();
  });
  it("accepts a trimmed page number", () => expect(pdfPageNumber(" 10 ", 10)).toBe(10));
  it("follows only in-document bookmark destinations", () => {
    const destination = { pageIndex: 2, zoom: { mode: PdfZoomMode.FitPage as const }, view: [] };
    expect(pdfDestination({ type: "destination", destination })).toEqual(destination);
    expect(pdfDestination({ type: "action", action: { type: PdfActionType.Goto, destination } })).toEqual(destination);
    expect(pdfDestination({ type: "action", action: { type: PdfActionType.RemoteGoto, destination } })).toBeUndefined();
    expect(
      pdfDestination({ type: "action", action: { type: PdfActionType.LaunchAppOrOpenFile, path: "a.exe" } }),
    ).toBeUndefined();
  });
  it.each([
    "javascript:alert(1)",
    "file:///secret.pdf",
    "data:text/html,test",
    "mailto:a@example.com",
    "C:\\a.pdf",
    "//example.com",
    "invalid",
  ])("does not activate PDF URI %s", (uri) =>
    expect(pdfExternalUrl({ type: "action", action: { type: PdfActionType.URI, uri } })).toBeUndefined(),
  );
  it("permits explicit HTTP(S) links", () => {
    expect(
      pdfExternalUrl({ type: "action", action: { type: PdfActionType.URI, uri: "https://example.com/paper" } }),
    ).toBe("https://example.com/paper");
    expect(pdfExternalUrl({ type: "action", action: { type: PdfActionType.URI, uri: "http://example.com" } })).toBe(
      "http://example.com",
    );
  });
  it("keeps each rotated page inside its positive layout bounds", () => {
    expect(pdfPageTransform(0, 600, 800)).toBe("none");
    expect(pdfPageTransform(1, 600, 800)).toBe("translateX(800px) rotate(90deg)");
    expect(pdfPageTransform(2, 600, 800)).toBe("translate(600px, 800px) rotate(180deg)");
    expect(pdfPageTransform(3, 600, 800)).toBe("translateY(600px) rotate(270deg)");
  });
});
