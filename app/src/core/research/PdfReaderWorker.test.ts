import { FontCharset, PdfErrorCode, Task, TaskStage, type PdfErrorReason } from "@embedpdf/models";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ create: vi.fn(), post: vi.fn(), open: vi.fn(), send: vi.fn() }));
vi.mock("@embedpdf/engines/pdfium-direct-engine", () => ({ createPdfiumEngine: mocks.create }));
vi.mock("@embedpdf/pdfium/pdfium.wasm?url", () => ({ default: "/assets/pdfium.wasm" }));
vi.mock("@/assets/fonts/NotoSansSC-Regular.otf?url", () => ({ default: "/assets/NotoSansSC-Regular.otf" }));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.create.mockResolvedValue({});
  vi.stubGlobal("self", { location: { href: "http://localhost/assets/reader.js" }, postMessage: mocks.post });
  vi.stubGlobal(
    "XMLHttpRequest",
    class {
      status = 200;
      response = new Uint8Array([1, 2, 3]).buffer;
      open = mocks.open;
      send = mocks.send;
    },
  );
});
afterEach(() => vi.unstubAllGlobals());

async function config() {
  await import("./PdfReaderWorker");
  await vi.waitFor(() => expect(mocks.post).toHaveBeenCalledWith({ id: "0", type: "ReadyResponse" }));
  return mocks.create.mock.calls[0][1].fontFallback as {
    fonts: Record<number, string>;
    fontLoader: (url: string) => Uint8Array | null;
    defaultFont?: string;
  };
}

describe("offline PDF worker assets", () => {
  it("loads local WASM and only the already-bundled Chinese font, on demand", async () => {
    const fallback = await config();
    expect(mocks.create.mock.calls[0][0]).toBe("http://localhost/assets/pdfium.wasm");
    expect(fallback.fonts).toEqual({ [FontCharset.GB2312]: "http://localhost/assets/NotoSansSC-Regular.otf" });
    expect(fallback.defaultFont).toBeUndefined();
    expect(mocks.send).not.toHaveBeenCalled();
    expect(fallback.fontLoader(fallback.fonts[FontCharset.GB2312])).toEqual(new Uint8Array([1, 2, 3]));
    expect(mocks.open).toHaveBeenCalledWith("GET", "http://localhost/assets/NotoSansSC-Regular.otf", false);
    expect(mocks.post).not.toHaveBeenCalledWith({ type: "pdfWorkerFailed" });
  });

  it("rejects unconfigured font URLs without issuing a request", async () => {
    const fallback = await config();
    expect(fallback.fontLoader("https://example.com/font.otf")).toBeNull();
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.post).toHaveBeenCalledWith({ type: "pdfWorkerFailed" });
  });

  it("reports local font read failures even when PDFium swallows the callback exception", async () => {
    const fallback = await config();
    mocks.send.mockImplementationOnce(() => {
      throw new Error("asset unavailable");
    });
    expect(fallback.fontLoader(fallback.fonts[FontCharset.GB2312])).toBeNull();
    expect(mocks.post).toHaveBeenCalledWith({ type: "pdfWorkerFailed" });
  });

  it("reports a WASM initialization failure without becoming ready", async () => {
    mocks.create.mockRejectedValueOnce(new Error("missing wasm"));
    await import("./PdfReaderWorker");
    await vi.waitFor(() => expect(mocks.post).toHaveBeenCalledWith({ type: "pdfWorkerFailed" }));
    expect(mocks.post).not.toHaveBeenCalledWith({ id: "0", type: "ReadyResponse" });
  });
});

const send = (data: unknown) => self.onmessage!({ data } as MessageEvent);

describe("PDF worker request lifetime", () => {
  it("cancels actual engine work and suppresses late progress after cancellation", async () => {
    const task = new Task<unknown, PdfErrorReason>();
    const search = vi.fn(() => task);
    mocks.create.mockResolvedValue({ searchAllPages: search });
    await config();
    send({ id: "search", type: "ExecuteRequest", data: { name: "searchAllPages", args: [] } });
    task.progress({ page: 1 });
    expect(mocks.post).toHaveBeenCalledWith({ id: "search", type: "ExecuteProgress", data: { page: 1 } });
    send({ id: "search", type: "AbortRequest" });
    expect(task.state.stage).toBe(TaskStage.Aborted);
    mocks.post.mockClear();
    task.progress({ page: 2 });
    task.resolve({ total: 10 });
    send({ id: "search", type: "AbortRequest" });
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it.each([
    "openDocumentUrl",
    "getDocumentJavaScriptActions",
    "getPageWidgetJavaScriptActions",
    "setFormFieldValue",
    "saveAsCopy",
  ])("rejects %s without invoking an engine network, script or write path", async (name) => {
    const method = vi.fn();
    mocks.create.mockResolvedValue({ [name]: method });
    await config();
    send({ id: "blocked", type: "ExecuteRequest", data: { name, args: [] } });
    expect(method).not.toHaveBeenCalled();
    expect(mocks.post).toHaveBeenCalledWith(
      expect.objectContaining({ id: "blocked", data: expect.objectContaining({ type: "error" }) }),
    );
  });

  it("reports a synchronous engine failure instead of waiting for a UI timeout", async () => {
    mocks.create.mockResolvedValue({
      getBookmarks: () => {
        throw new Error("failed");
      },
    });
    await config();
    send({ id: "outline", type: "ExecuteRequest", data: { name: "getBookmarks", args: [] } });
    expect(mocks.post).toHaveBeenCalledWith({
      id: "outline",
      type: "ExecuteResponse",
      data: {
        type: "error",
        value: { type: "reject", reason: { code: PdfErrorCode.Unknown, message: "pdfWorkerFailed" } },
      },
    });
  });
});
