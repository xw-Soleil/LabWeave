import { PdfEngine, PdfiumNative, browserImageDataToBlobConverter } from "@embedpdf/engines/pdfium";
import { init } from "@embedpdf/pdfium";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  lstat: vi.fn(),
  invoke: vi.fn(),
  settings: { researchFolderPath: "/research" },
}));
vi.mock("@/core/service/Settings", () => ({ Settings: mocks.settings }));
vi.mock("@/core/service/Telemetry", () => ({ Telemetry: {} }));
vi.mock("@/utils/platform", () => ({ isWeb: false }));
vi.mock("@/components/ui/dialog", () => ({ Dialog: {} }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/plugin-fs", () => ({ lstat: mocks.lstat }));
vi.mock("./PdfReader", async (original) => ({ ...(await original<object>()), readPdfBuffer: mocks.read }));
import { store, tabsAtom } from "@/state";
import { DocumentTab } from "./DocumentTab";
import { researchWorkspaceAtom } from "./ResearchWorkspace";
import { readPdfText, resolveReadablePdfPath, searchPdf } from "./PdfTools";

class TestWorker extends EventTarget {
  static instances: TestWorker[] = [];
  static text = (page: number) => `Page ${page + 1}`;
  static total = 0;
  static locked = false;
  static held = false;
  static engine?: PdfEngine;
  terminate = vi.fn();
  postMessage = vi.fn((request: { id: string; type: string; data: { name: string; args: any[] } }) => {
    if (request.type !== "ExecuteRequest" || TestWorker.held || this.terminate.mock.calls.length) return;
    const reply = (value: unknown) =>
      queueMicrotask(() =>
        this.dispatchEvent(
          new MessageEvent("message", {
            data: { id: request.id, type: "ExecuteResponse", data: { type: "result", value } },
          }),
        ),
      );
    if (TestWorker.engine) {
      const engine = TestWorker.engine as any;
      engine[request.data.name](...request.data.args).wait(reply, (error: unknown) => {
        this.dispatchEvent(
          new MessageEvent("message", {
            data: { id: request.id, type: "ExecuteResponse", data: { type: "error", value: error } },
          }),
        );
      });
      return;
    }
    const { name, args } = request.data;
    if (name === "openDocumentBuffer")
      reply({
        id: args[0].id,
        pageCount: 20,
        pages: [],
        isEncrypted: TestWorker.locked,
        isOwnerUnlocked: false,
        permissions: 0,
      });
    else if (name === "extractText") reply(TestWorker.text(args[1][0]));
    else if (name === "searchAllPages")
      reply({
        total: TestWorker.total,
        results: Array.from({ length: TestWorker.total }, (_, index) => ({
          pageIndex: index % 20,
          charIndex: 90,
          charCount: 4,
        })),
      });
    else if (name === "getTextSlices") reply(args[1].map(() => "before term after"));
  });
  constructor() {
    super();
    TestWorker.instances.push(this);
    queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: { id: "0", type: "ReadyResponse" } })));
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("Worker", TestWorker);
  TestWorker.instances = [];
  TestWorker.text = (page) => `Page ${page + 1}`;
  TestWorker.total = 0;
  TestWorker.locked = false;
  TestWorker.held = false;
  TestWorker.engine = undefined;
  mocks.settings.researchFolderPath = "/research";
  mocks.lstat.mockResolvedValue({ isSymlink: false });
  mocks.invoke.mockImplementation(async (_name, args) => args.path);
  mocks.read.mockResolvedValue(new ArrayBuffer(10));
  store.set(tabsAtom, []);
  store.set(researchWorkspaceAtom, {
    version: 1,
    activeId: "default",
    workspaces: [
      {
        id: "default",
        name: "",
        projects: [
          { path: "/research" },
          { path: "/library" },
          { path: "C:\\papers" },
          { path: "\\\\server\\share\\research" },
        ],
      },
    ],
    recentProjects: [],
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  for (const worker of TestWorker.instances) expect(worker.terminate).toHaveBeenCalledOnce();
  store.set(tabsAtom, []);
});

describe("PDF tool access", () => {
  it.each([
    "../outside.pdf",
    "/research/../outside.pdf",
    "/research-sibling/a.pdf",
    "https://host/a.pdf",
    "/research/a.md",
    "/Research/a.pdf",
    "C:\\papers2\\a.pdf",
    "\\\\server\\other\\research\\a.pdf",
  ])("refuses %s before reading or starting a worker", async (path) => {
    await expect(readPdfText({ path, pages: "1" })).rejects.toThrow("pdf.pathNotAllowed");
    expect(mocks.read).not.toHaveBeenCalled();
    expect(TestWorker.instances).toHaveLength(0);
  });
  it.each([
    "/research/sub/a.pdf",
    "/library/条目/key/key.pdf",
    "c:\\PAPERS\\a.pdf",
    "\\\\SERVER\\share\\research\\a.pdf",
  ])("accepts a registered project's PDF: %s", async (path) => {
    expect(await resolveReadablePdfPath(path)).toMatch(/\.pdf$/);
  });
  it("allows a currently opened external PDF but not its neighbours or a closed tab", async () => {
    const tab = new DocumentTab("/outside/open.pdf", "pdf");
    store.set(tabsAtom, [tab]);
    expect(await resolveReadablePdfPath(tab.path)).toBe(tab.path);
    await expect(resolveReadablePdfPath("/outside/other.pdf")).rejects.toThrow("pdf.pathNotAllowed");
    tab.closing = true;
    await expect(resolveReadablePdfPath(tab.path)).rejects.toThrow("pdf.pathNotAllowed");
  });
  it("rejects symlinked files and directories inside a registered project", async () => {
    mocks.lstat.mockImplementation(async (path) => ({
      isSymlink: path.endsWith("/link") || path.endsWith("/link.pdf"),
    }));
    await expect(resolveReadablePdfPath("/research/link/secret.pdf")).rejects.toThrow("pdf.pathNotAllowed");
    await expect(resolveReadablePdfPath("/research/link.pdf")).rejects.toThrow("pdf.pathNotAllowed");
  });
});

describe("PDF tools", () => {
  it("returns page-labelled text for at most ten pages and releases its worker", async () => {
    const result = await readPdfText({ path: "/research/a.pdf", pages: "3-5" });
    expect(result).toEqual({
      path: "/research/a.pdf",
      pageCount: 20,
      pages: [
        { page: 3, text: "Page 3" },
        { page: 4, text: "Page 4" },
        { page: 5, text: "Page 5" },
      ],
      truncated: false,
    });
    expect((await readPdfText({ path: "/research/a.pdf", pages: "1-10" })).pages).toHaveLength(10);
  });
  it.each(["0", "2-1", "1,2", "1.5", "-1", "9007199254740992"])("rejects malformed page range %s", async (pages) => {
    await expect(readPdfText({ path: "/research/a.pdf", pages })).rejects.toThrow("pdf.invalidPages");
    expect(mocks.read).not.toHaveBeenCalled();
  });
  it("rejects over ten pages and out-of-document pages", async () => {
    await expect(readPdfText({ path: "/research/a.pdf", pages: "1-11" })).rejects.toThrow("pdf.tooManyPages");
    expect(mocks.read).not.toHaveBeenCalled();
    await expect(readPdfText({ path: "/research/a.pdf", pages: "21" })).rejects.toThrow("pdf.invalidPages");
  });
  it("caps total text at 20000 characters and reports the page and character where it stopped", async () => {
    TestWorker.text = () => "a".repeat(15000);
    const result = await readPdfText({ path: "/research/a.pdf", pages: "2-4" });
    expect(result.pages.map((page) => page.text.length)).toEqual([15000, 5000]);
    expect(result.stoppedAt).toEqual({ page: 3, character: 5000 });
    expect(result.truncated).toBe(true);
    const requests = TestWorker.instances[0].postMessage.mock.calls.map(([request]) => request);
    expect(requests.filter((request) => request.data.name === "extractText")).toHaveLength(2);
  });
  it("returns at most 50 page-numbered search snippets and rejects empty or excessive queries", async () => {
    TestWorker.total = 70;
    const result = await searchPdf({ path: "/research/a.pdf", query: "term" });
    expect(result.matches).toHaveLength(50);
    expect(result.matches[0]).toEqual({ page: 1, text: "before term after" });
    expect(result.truncated).toBe(true);
    await expect(searchPdf({ path: "/research/a.pdf", query: " " })).rejects.toThrow("pdf.invalidQuery");
    await expect(searchPdf({ path: "/research/a.pdf", query: "x".repeat(201) })).rejects.toThrow("pdf.invalidQuery");
  });
  it("handles scanned pages and no search hits without inventing text", async () => {
    TestWorker.text = () => "";
    expect((await readPdfText({ path: "/research/a.pdf", pages: "1" })).pages).toEqual([{ page: 1, text: "" }]);
    expect((await searchPdf({ path: "/research/a.pdf", query: "missing" })).matches).toEqual([]);
  });
  it("enforces PDF copy permissions and exposes only stable error codes", async () => {
    TestWorker.locked = true;
    await expect(readPdfText({ path: "/research/a.pdf", pages: "1" })).rejects.toThrow("pdf.copyNotAllowed");
    mocks.read.mockRejectedValueOnce(new Error("internal sensitive path"));
    await expect(searchPdf({ path: "/research/a.pdf", query: "word" })).rejects.toThrow("pdf.readFailed");
  });
  it("terminates an outstanding engine task on abort", async () => {
    TestWorker.held = true;
    const controller = new AbortController();
    const result = readPdfText({ path: "/research/a.pdf", pages: "1" }, { signal: controller.signal });
    const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(TestWorker.instances).toHaveLength(1));
    controller.abort();
    await rejected;
  });
  it("times out a stuck worker and frees it", async () => {
    vi.useFakeTimers();
    TestWorker.held = true;
    const result = readPdfText({ path: "/research/a.pdf", pages: "1" });
    const rejected = expect(result).rejects.toThrow("pdf.timeout");
    await vi.advanceTimersByTimeAsync(26000);
    await rejected;
  });

  it("reads and searches a small self-contained PDF through the real offline PDFium engine", async () => {
    const stream = "BT /F1 12 Tf 40 100 Td (A Needle in the paper) Tj ET";
    const bytes = new TextEncoder().encode(
      `%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >> endobj\n4 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\n5 0 obj << /Length ${stream.length} >> stream\n${stream}\nendstream endobj\ntrailer << /Root 1 0 R >>\n%%EOF`,
    );
    const wasmBinary = await readFile(createRequire(import.meta.url).resolve("@embedpdf/pdfium/pdfium.wasm"));
    const network = vi.fn(() => {
      throw new Error("network forbidden");
    });
    vi.stubGlobal("fetch", network);
    const wasm = await init({ wasmBinary });
    const engine = new PdfEngine(new PdfiumNative(wasm, { fontFallback: null }), {
      imageConverter: browserImageDataToBlobConverter,
    });
    TestWorker.engine = engine;
    mocks.read.mockImplementation(async () => bytes.slice().buffer);
    try {
      expect((await readPdfText({ path: "/research/a.pdf", pages: "1" })).pages[0].text).toContain(
        "A Needle in the paper",
      );
      expect((await searchPdf({ path: "/research/a.pdf", query: "needle" })).matches).toEqual([
        { page: 1, text: "A Needle in the paper" },
      ]);
      expect(network).not.toHaveBeenCalled();
    } finally {
      await engine.destroy().toPromise();
    }
  });
});
