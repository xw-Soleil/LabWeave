import { FontCharset } from "@embedpdf/models";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ create: vi.fn(), ready: vi.fn(), post: vi.fn(), open: vi.fn(), send: vi.fn() }));
vi.mock("@embedpdf/engines", () => ({
  EngineRunner: class {
    ready = mocks.ready;
  },
}));
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
  await vi.waitFor(() => expect(mocks.ready).toHaveBeenCalledOnce());
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
    expect(mocks.post).not.toHaveBeenCalled();
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
});
