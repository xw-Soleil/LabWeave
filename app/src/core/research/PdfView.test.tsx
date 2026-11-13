// @vitest-environment jsdom
import { PdfActionType, PdfAnnotationSubtype, PdfZoomMode } from "@embedpdf/models";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  error: vi.fn(),
  writeText: vi.fn(),
  open: vi.fn(),
  annotationLoad: vi.fn(),
  annotationSave: vi.fn(),
  closeAnswer: vi.fn(),
  sendExcerpt: vi.fn(),
}));
vi.mock("./PdfExcerpt", () => ({ sendPdfExcerpt: mocks.sendExcerpt }));
vi.mock("./PdfAnnotationStore", async (original) => {
  const module = await original<typeof import("./PdfAnnotationStore")>();
  return {
    ...module,
    loadAnnotationStore: async () =>
      new module.PdfAnnotationStore({ kind: "external", pathKey: "a".repeat(64) }, await mocks.annotationLoad(), {
        load: mocks.annotationLoad,
        save: mocks.annotationSave,
        move: vi.fn(),
      }),
  };
});
vi.mock("./PdfReader", async (original) => ({ ...(await original<object>()), readPdfBuffer: mocks.read }));
vi.mock("./PdfDocument", async (original) => ({
  ...(await original<object>()),
  openPdfDocument: async () => ({
    document: { getPageLabels: async () => ["iv", "v", "1", "2", "3", "4", "5", "6"] },
    run: (promise: Promise<unknown>) => promise,
    destroy: async () => {},
  }),
}));
vi.mock("@/core/research/ResearchFolder", () => ({
  ResearchFolder: { ensureRootRegistered: vi.fn() },
  notifyResearchFilesChanged: vi.fn(),
}));
vi.mock("@/core/service/Settings", () => ({ Settings: {} }));
vi.mock("@/core/service/Telemetry", () => ({ Telemetry: {} }));
vi.mock("@/components/ui/dialog", () => ({ Dialog: { buttons: mocks.closeAnswer } }));
vi.mock("i18next", () => ({
  default: {
    t: (key: string, options: Record<string, unknown>) =>
      key.endsWith("searchCount") ? `${options.current} / ${options.total}` : key,
  },
}));
vi.mock("sonner", () => ({ toast: { error: mocks.error } }));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: mocks.writeText }));
vi.mock("@tauri-apps/plugin-shell", () => ({ open: mocks.open }));
import { activeTabAtom, store, tabsAtom } from "@/state";
import { readingContextAtom } from "./ReadingContext";
import { DocumentTab } from "./DocumentTab";
import DocumentView from "./DocumentView";
import { annotationColors, newAnnotation } from "./PdfAnnotations";

class TestWorker extends EventTarget {
  static instances: TestWorker[] = [];
  static heldMethods = new Set<string>();
  static ready = true;
  static externalAnnotations = false;
  terminate = vi.fn();
  postMessage = vi.fn((request: { id: string; type: string; data: { name: string; args: any[] } }) => {
    if (request.type !== "ExecuteRequest" || this.terminate.mock.calls.length) return;
    const { name, args } = request.data;
    if (TestWorker.heldMethods.has(name)) return;
    let value: unknown = true;
    if (name === "openDocumentBuffer")
      value = {
        id: args[0].id,
        pageCount: 8,
        isEncrypted: false,
        isOwnerUnlocked: true,
        permissions: 0xffffffff,
        normalizedRotation: true,
        pages: Array.from({ length: 8 }, (_, index) => ({
          index,
          size: { width: 600, height: 800 },
          rotation: 0,
          objectNumber: index + 1,
        })),
      };
    if (name === "getBookmarks")
      value = {
        bookmarks: [
          {
            title: "Introduction",
            target: {
              type: "destination",
              destination: { pageIndex: 2, zoom: { mode: PdfZoomMode.FitPage }, view: [] },
            },
          },
        ],
      };
    if (name === "renderPage" || name === "renderPageRect") value = new Blob(["test"], { type: "image/bmp" });
    // 真的后台线程里没有画布：要它压成 bmp 以外的格式会失败，只有原始像素和 bmp 给得出来
    if (name === "renderPageRect" && args[3]?.imageType !== "image/bmp") {
      this.send({
        id: request.id,
        type: "ExecuteResponse",
        data: { type: "error", value: { type: "reject", reason: { code: 1, message: "ImageConverterError" } } },
      });
      return;
    }
    if (name === "renderPageRectRaw") value = { data: new Uint8ClampedArray(8), width: 2, height: 1 };
    if (name === "getPageGeometry")
      value = {
        runs: [80, 110].map((y, row) => ({
          rect: { x: 40, y, width: 40, height: 12 },
          charStart: row * 4,
          // 松框（按字体声明的高度）12 高，贴着字的紧框只有中间 7 高
          glyphs: Array.from({ length: 4 }, (_, index) => ({
            x: 40 + index * 10,
            y,
            width: 10,
            height: 12,
            flags: 0,
            tightX: 40 + index * 10,
            tightY: y + 3,
            tightWidth: 10,
            tightHeight: 7,
          })),
        })),
      };
    if (name === "getTextSlices") value = ["test\nnext"];
    if (name === "getPageAnnotations")
      value =
        args[1].index === 0
          ? [
              { type: "action", action: { type: PdfActionType.URI, uri: "https://example.com/paper" } },
              { type: "destination", destination: { pageIndex: 2, zoom: { mode: PdfZoomMode.FitPage }, view: [] } },
              { type: "action", action: { type: PdfActionType.URI, uri: "javascript:alert(1)" } },
              { type: "action", action: { type: PdfActionType.URI, uri: "file:///secret.pdf" } },
              { type: "action", action: { type: PdfActionType.LaunchAppOrOpenFile, path: "C:\\secret.pdf" } },
            ].map((target, index) => ({
              type: PdfAnnotationSubtype.LINK,
              id: String(index),
              pageIndex: 0,
              rect: { origin: { x: 100, y: 100 + index * 20 }, size: { width: 80, height: 15 } },
              target,
            }))
          : [];
    if (name === "getPageAnnotations" && TestWorker.externalAnnotations && args[1].index === 0)
      value = [
        ...(value as unknown[]),
        {
          type: PdfAnnotationSubtype.HIGHLIGHT,
          id: "embedded-highlight",
          pageIndex: 0,
          rect: { origin: { x: 40, y: 80 }, size: { width: 40, height: 12 } },
          color: "#ffd400",
          contents: "A comment embedded in the original PDF",
        },
      ];
    if (name === "searchAllPages")
      value = {
        total: 2,
        results: [1, 4].map((pageIndex) => ({
          pageIndex,
          charIndex: 0,
          charCount: 4,
          rects: [{ origin: { x: 40, y: 80 }, size: { width: 50, height: 12 } }],
        })),
      };
    queueMicrotask(() => this.send({ id: request.id, type: "ExecuteResponse", data: { type: "result", value } }));
  });
  constructor(
    readonly url: URL,
    readonly options: WorkerOptions,
  ) {
    super();
    TestWorker.instances.push(this);
    if (TestWorker.ready) queueMicrotask(() => this.send({ id: "0", type: "ReadyResponse" }));
  }
  send(data: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
}

let root: Root;
let container: HTMLDivElement;
let resize: (() => void)[];
let shownTabs: DocumentTab[];
beforeEach(() => {
  vi.clearAllMocks();
  TestWorker.instances = [];
  TestWorker.heldMethods.clear();
  TestWorker.ready = true;
  TestWorker.externalAnnotations = false;
  resize = [];
  shownTabs = [];
  mocks.annotationLoad.mockResolvedValue({ annotations: [], revision: null });
  mocks.annotationSave.mockImplementation(async (_target, _revision, annotations) => ({
    annotations,
    revision: crypto.randomUUID(),
  }));
  mocks.read.mockImplementation(async () => new ArrayBuffer(16));
  mocks.writeText.mockResolvedValue(undefined);
  mocks.open.mockResolvedValue(undefined);
  vi.stubGlobal("Worker", TestWorker);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private callback: () => void) {
        resize.push(callback);
      }
      observe() {
        queueMicrotask(this.callback);
      }
      disconnect() {}
    },
  );
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 800,
    bottom: 600,
    width: 800,
    height: 600,
    toJSON() {},
  });
  HTMLElement.prototype.scrollTo = vi.fn(function (this: HTMLElement, options?: ScrollToOptions | number) {
    if (typeof options === "object") {
      this.scrollTop = options.top ?? 0;
      this.scrollLeft = options.left ?? 0;
    }
  });
  URL.createObjectURL = vi.fn(() => "blob:test");
  URL.revokeObjectURL = vi.fn();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  for (const tab of shownTabs) await tab.dispose();
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const button = (key: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="document.${key}"]`)!;
async function show(tab: DocumentTab) {
  shownTabs.push(tab);
  store.set(tabsAtom, shownTabs);
  store.set(activeTabAtom, tab);
  await act(async () => {
    root.render(<DocumentView tab={tab} />);
  });
  await act(async () => {
    await vi.waitFor(() => expect(button("pdf.search")).not.toBeNull());
  });
  await act(async () => {
    container.querySelectorAll("img").forEach((image) => image.dispatchEvent(new Event("load")));
  });
}
async function click(key: string) {
  await act(async () => button(key).click());
}
async function key(target: Element, name: string, extra: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...extra });
  await act(async () => {
    target.dispatchEvent(event);
  });
  return event;
}
async function type(input: HTMLInputElement, text: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("EmbedPDF reading tabs with real plugins", () => {
  it("opens a local module worker, restores page and zoom, and releases each switched session", async () => {
    const first = new DocumentTab("/r/a.pdf", "pdf");
    first.pdfLocation = { page: 5, scale: 1.8 };
    await show(first);
    expect(TestWorker.instances[0].options.type).toBe("module");
    expect(TestWorker.instances[0].url.pathname).toContain("PdfReaderWorker.ts");
    expect(container.textContent).toContain("180%");
    expect(container.querySelector<HTMLInputElement>('[aria-label="document.page"]')!.value).toBe("5");
    await click("nextPage");
    expect(first.pdfLocation.page).toBe(6);
    await show(new DocumentTab("C:\\papers\\b.pdf", "pdf"));
    expect(TestWorker.instances[0].terminate).toHaveBeenCalledOnce();
    await show(first);
    expect(container.querySelector<HTMLInputElement>('[aria-label="document.page"]')!.value).toBe("6");
    expect(container.textContent).toContain("180%");
  });

  it("shows the outline, jumps to a bookmark, and opens the empty annotation sidebar", async () => {
    await show(new DocumentTab("/r/a.pdf", "pdf"));
    const tabs = container.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    await act(async () => {
      tabs[1].dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    });
    const outline = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((element) =>
      element.textContent?.includes("Introduction"),
    );
    expect(outline).toBeDefined();
    await act(async () => outline!.click());
    expect(container.querySelector<HTMLInputElement>('[aria-label="document.page"]')!.value).toBe("3");
    await act(async () => {
      tabs[2].dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    });
    expect(container.textContent).toContain("document.annotation.empty");
    await click("pdf.toggleSidebar");
    expect(container.querySelector("aside")).toBeNull();
  });

  it.each(["fit-width", "fit-page"])("restores %s and recalculates it on viewport resize", async (mode) => {
    const tab = new DocumentTab("/r/a.pdf", "pdf");
    tab.pdfLocation = { page: 3, scale: mode };
    await show(tab);
    const before = Number(button("pdf.zoom").textContent!.replace("%", ""));
    vi.mocked(Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth")!.get!).mockReturnValue(400);
    vi.mocked(Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth")!.get!).mockReturnValue(400);
    await act(async () => {
      resize.forEach((callback) => callback());
    });
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(Number(button("pdf.zoom").textContent!.replace("%", ""))).toBeLessThan(before);
    });
    expect(tab.pdfLocation.scale).toBe(mode);
    await show(new DocumentTab("/r/b.pdf", "pdf"));
    await show(tab);
    expect(tab.pdfLocation.scale).toBe(mode);
  });

  it("navigates by thumbnail, highlights the current page and resets to actual size", async () => {
    const tab = new DocumentTab("/r/a.pdf", "pdf");
    await show(tab);
    const thumbnail = container.querySelector<HTMLButtonElement>(
      'aside button[aria-label="document.pdf.thumbnailPage"]',
    )!;
    await act(async () => thumbnail.click());
    expect(thumbnail.getAttribute("aria-current")).toBe("page");
    await key(container.querySelector(".pg-document-pdf")!, "0", { metaKey: true });
    expect(button("pdf.zoom").textContent).toBe("100%");
    expect(tab.pdfLocation.scale).toBe(1);
  });

  it("searches through the real plugin, highlights matches, navigates and closes with Escape", async () => {
    await show(new DocumentTab("/r/a.pdf", "pdf"));
    const viewport = container.querySelector(".pg-document-pdf")!;
    expect((await key(viewport, "f", { metaKey: true })).defaultPrevented).toBe(true);
    const input = container.querySelector<HTMLInputElement>('[aria-label="document.pdf.searchQuery"]')!;
    expect(document.activeElement).toBe(input);
    await type(input, "test");
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(container.textContent).toContain("1 / 2");
    });
    expect(container.querySelector('[style*="background-color: rgb(255, 191, 0)"]')).not.toBeNull();
    await key(input, "Enter");
    expect(container.textContent).toContain("2 / 2");
    expect(container.querySelector<HTMLInputElement>('[aria-label="document.page"]')!.value).toBe("5");
    await key(input, "Enter", { shiftKey: true });
    expect(container.textContent).toContain("1 / 2");
    await key(input, "Escape");
    expect(container.querySelector('[role="search"]')).toBeNull();
    expect(document.activeElement).toBe(viewport);
    expect(container.querySelector('[style*="background-color: rgb(255, 191, 0)"]')).toBeNull();
  });

  it.each([{ metaKey: true }, { ctrlKey: true }])(
    "selects across lines and copies with the keyboard and toolbar (%j)",
    async (modifier) => {
      const tab = new DocumentTab("/r/a.pdf", "pdf");
      tab.pdfLocation.scale = 1;
      await show(tab);
      const page = container.querySelector('[data-pdf-page="0"]')!;
      for (const [type, clientX, clientY] of [
        ["pointerdown", 41, 85],
        ["pointermove", 79, 115],
        ["pointerup", 79, 115],
      ] as const) {
        await act(async () => {
          page.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY, button: 0 }));
        });
      }
      expect(button("pdf.copy").disabled).toBe(false);
      expect(store.get(readingContextAtom)).toMatchObject({
        path: tab.path,
        page: 1,
        pageCount: 8,
        selection: { text: "test\nnext", page: 1 },
      });
      expect(page.querySelector('[style*="isolation: isolate"]')).not.toBeNull();
      expect((await key(page, "c", modifier)).defaultPrevented).toBe(true);
      expect(mocks.writeText).toHaveBeenLastCalledWith("test\nnext");
      const request = TestWorker.instances[0].postMessage.mock.calls
        .map(([request]) => request)
        .find((request) => request.data?.name === "getTextSlices");
      expect(request?.data.args[1]).toEqual([{ pageIndex: 0, charIndex: 0, charCount: 8 }]);
      await click("pdf.copy");
      expect(mocks.writeText).toHaveBeenCalledTimes(2);
      mocks.writeText.mockRejectedValueOnce(new Error("clipboard failed"));
      await click("pdf.copy");
      expect(mocks.error).toHaveBeenCalledOnce();
    },
  );

  it("shows a startup failure with retry, and does not accept late callbacks from the closed tab", async () => {
    mocks.read.mockRejectedValueOnce(new Error("fileChanged"));
    const tab = new DocumentTab("/r/a.pdf", "pdf");
    await act(async () => root.render(<DocumentView tab={tab} />));
    expect(container.textContent).toContain("document.errors.fileChanged");
    expect(TestWorker.instances[0].terminate).toHaveBeenCalledOnce();
    const retry = Array.from(container.querySelectorAll("button")).find(
      (item) => item.textContent === "document.retry",
    )!;
    await act(async () => retry.click());
    await act(async () => {
      await vi.waitFor(() => expect(button("pdf.search")).not.toBeNull());
    });
    const lastWorker = TestWorker.instances.at(-1)!;
    await act(async () => root.render(null));
    expect(lastWorker.terminate).toHaveBeenCalledOnce();
    await act(async () => lastWorker.send({ type: "pdfWorkerFailed" }));
    expect(mocks.error).not.toHaveBeenCalled();
  });

  it("reports a later worker/render failure instead of leaving an empty page", async () => {
    await show(new DocumentTab("/r/a.pdf", "pdf"));
    const worker = TestWorker.instances[0];
    const requests = worker.postMessage.mock.calls.map(([request]) => request);
    expect(requests.some((request) => request.data?.name === "renderPageRect")).toBe(true);
    await act(async () => worker.dispatchEvent(new Event("error")));
    expect(container.textContent).toContain("document.errors.pdfWorkerFailed");
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("releases page image URLs on load and every remaining URL on close", async () => {
    let nextUrl = 0;
    vi.mocked(URL.createObjectURL).mockImplementation(() => `blob:test-${nextUrl++}`);
    for (let cycle = 0; cycle < 3; cycle++) {
      await show(new DocumentTab(`/r/${cycle}.pdf`, "pdf"));
      const loaded = Array.from(container.querySelectorAll("img"), (image) => image.src);
      expect(loaded.length).toBeGreaterThan(0);
      for (const url of loaded) expect(URL.revokeObjectURL).toHaveBeenCalledWith(url);
      await act(async () => root.render(null));
    }
    const created = vi.mocked(URL.createObjectURL).mock.results.map((result) => result.value);
    const revoked = vi.mocked(URL.revokeObjectURL).mock.calls.map(([url]) => url);
    expect(new Set(revoked)).toEqual(new Set(created));
    expect(TestWorker.instances.every((worker) => worker.terminate.mock.calls.length === 1)).toBe(true);
  });

  it("surfaces tile image decoding errors", async () => {
    await show(new DocumentTab("/r/a.pdf", "pdf"));
    const tile = container.querySelector<HTMLImageElement>("[data-pdf-page] img:not([class])")!;
    expect(tile).not.toBeNull();
    await act(async () => tile.dispatchEvent(new Event("error")));
    expect(container.textContent).toContain("document.errors.pdfRenderFailed");
    expect(TestWorker.instances[0].terminate).toHaveBeenCalledOnce();
  });

  it("keeps search shortcuts inside the reading area and search bar", async () => {
    await show(new DocumentTab("/r/a.pdf", "pdf"));
    expect((await key(button("pdf.toggleSidebar"), "f", { ctrlKey: true })).defaultPrevented).toBe(false);
    expect(container.querySelector('[role="search"]')).toBeNull();
    expect((await key(container.querySelector(".pg-document-pdf")!, "f", { ctrlKey: true })).defaultPrevented).toBe(
      true,
    );
  });

  it("opens safe external PDF links only on click and follows internal destinations", async () => {
    await show(new DocumentTab("/r/a.pdf", "pdf"));
    expect(mocks.open).not.toHaveBeenCalled();
    const links = container.querySelectorAll<HTMLButtonElement>('[data-pdf-page="0"] button');
    expect(links).toHaveLength(2);
    await act(async () => links[0].click());
    expect(mocks.open).toHaveBeenCalledExactlyOnceWith("https://example.com/paper");
    mocks.open.mockRejectedValueOnce(new Error("browser failed"));
    await act(async () => links[0].click());
    expect(mocks.error).toHaveBeenCalledOnce();
    await act(async () => links[1].click());
    expect(container.querySelector<HTMLInputElement>('[aria-label="document.page"]')!.value).toBe("3");
    expect(
      TestWorker.instances[0].postMessage.mock.calls.some(([request]) =>
        /JavaScript|openDocumentUrl|saveAsCopy/.test(request.data?.name),
      ),
    ).toBe(false);
  });

  it("discards superseded search results, late progress and results after Escape", async () => {
    TestWorker.heldMethods.add("searchAllPages");
    await show(new DocumentTab("/r/a.pdf", "pdf"));
    const worker = TestWorker.instances[0];
    await click("pdf.search");
    const input = container.querySelector<HTMLInputElement>('[aria-label="document.pdf.searchQuery"]')!;
    const requests = () =>
      worker.postMessage.mock.calls
        .map(([request]) => request)
        .filter((request) => request.data?.name === "searchAllPages");
    await type(input, "old");
    await vi.waitFor(() => expect(requests()).toHaveLength(1));
    await type(input, "new");
    await vi.waitFor(() => expect(requests()).toHaveLength(2));
    const result = {
      total: 1,
      results: [
        {
          pageIndex: 1,
          charIndex: 0,
          charCount: 3,
          rects: [{ origin: { x: 20, y: 20 }, size: { width: 20, height: 10 } }],
        },
      ],
    };
    await act(async () => {
      worker.send({ id: requests()[1].id, type: "ExecuteResponse", data: { type: "result", value: result } });
      worker.send({ id: requests()[0].id, type: "ExecuteProgress", data: { results: result.results } });
      worker.send({
        id: requests()[0].id,
        type: "ExecuteResponse",
        data: { type: "result", value: { ...result, total: 99 } },
      });
    });
    expect(container.textContent).toContain("1 / 1");
    expect(container.textContent).not.toContain("99");
    await type(input, "closed");
    await vi.waitFor(() => expect(requests()).toHaveLength(3));
    await key(input, "Escape");
    await act(async () =>
      worker.send({ id: requests()[2].id, type: "ExecuteResponse", data: { type: "result", value: result } }),
    );
    await click("pdf.search");
    expect(container.textContent).toContain("0 / 0");
  });

  it("terminates loading sessions on close and ignores a late file read", async () => {
    let finish!: (buffer: ArrayBuffer) => void;
    mocks.read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await act(async () => root.render(<DocumentView tab={new DocumentTab("/r/slow.pdf", "pdf")} />));
    const signal = mocks.read.mock.calls[0][1] as AbortSignal;
    await act(async () => root.render(null));
    expect(signal.aborted).toBe(true);
    expect(TestWorker.instances[0].terminate).toHaveBeenCalledOnce();
    await act(async () => finish(new ArrayBuffer(1)));
    expect(
      TestWorker.instances[0].postMessage.mock.calls.some(([request]) => request.data?.name === "openDocumentBuffer"),
    ).toBe(false);
    expect(mocks.error).not.toHaveBeenCalled();
  });

  it("closes a pending document open and ignores its response after switching tabs", async () => {
    TestWorker.heldMethods.add("openDocumentBuffer");
    await act(async () => root.render(<DocumentView tab={new DocumentTab("/r/slow.pdf", "pdf")} />));
    const worker = TestWorker.instances[0];
    const request = worker.postMessage.mock.calls
      .map(([request]) => request)
      .find((request) => request.data?.name === "openDocumentBuffer");
    expect(request).toBeDefined();
    TestWorker.heldMethods.clear();
    const next = new DocumentTab("/r/next.pdf", "pdf");
    await show(next);
    expect(worker.terminate).toHaveBeenCalledOnce();
    await act(async () =>
      worker.send({ id: request!.id, type: "ExecuteResponse", data: { type: "result", value: { id: "stale" } } }),
    );
    expect(button("pdf.search")).not.toBeNull();
    expect(container.textContent).toContain("next.pdf");
    expect(mocks.error).not.toHaveBeenCalled();
  });

  it("shows timeout and releases the worker if startup never finishes", async () => {
    vi.useFakeTimers();
    TestWorker.ready = false;
    await act(async () => root.render(<DocumentView tab={new DocumentTab("/r/slow.pdf", "pdf")} />));
    await act(async () => vi.advanceTimersByTime(25001));
    expect(container.textContent).toContain("document.errors.pdfTimeout");
    expect(TestWorker.instances[0].terminate).toHaveBeenCalledOnce();
  });

  it("rejects invalid page input without changing the location", async () => {
    const tab = new DocumentTab("/r/a.pdf", "pdf");
    await show(tab);
    const input = container.querySelector<HTMLInputElement>('[aria-label="document.page"]')!;
    await type(input, "999");
    await key(input, "Enter");
    expect(input.value).toBe("1");
    expect(tab.pdfLocation.page).toBe(1);
  });
});

describe("PDF annotation tools and persistence", () => {
  it("allows closing while annotation JSON is loading and ignores its late result", async () => {
    let finish!: (value: { annotations: []; revision: null }) => void;
    mocks.annotationLoad.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const tab = new DocumentTab("/r/a.pdf", "pdf");
    await show(tab);
    expect(tab.loadingAnnotations).toBe(true);
    expect(await tab.beforeClose!()).toBe(true);
    tab.closing = true;
    await act(async () => root.render(null));
    await act(async () => finish({ annotations: [], revision: null }));
    expect(tab.annotations).toBeUndefined();
    expect(mocks.annotationSave).not.toHaveBeenCalled();
  });

  async function draw(
    tool: string,
    points: number[][] = [
      [100, 100],
      [200, 140],
    ],
  ) {
    await click(`annotation.${tool}`);
    const layer = container.querySelector<SVGSVGElement>('[data-pdf-annotations="0"]')!;
    layer.setPointerCapture = vi.fn();
    layer.releasePointerCapture = vi.fn();
    vi.spyOn(layer, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 600, height: 800 } as DOMRect);
    for (const [index, point] of points.entries()) {
      const type = index === 0 ? "pointerdown" : index === points.length - 1 ? "pointerup" : "pointermove";
      await act(async () =>
        layer.dispatchEvent(
          new MouseEvent(type, { bubbles: true, cancelable: true, clientX: point[0], clientY: point[1], button: 0 }),
        ),
      );
    }
  }
  const pressed = (tool: string) =>
    container.querySelector(`[aria-label="document.annotation.${tool}"]`)!.getAttribute("aria-pressed");
  const clickOnPage = (id: string) =>
    act(async () => {
      container
        .querySelector(`[data-annotation-id="${id}"]`)!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  const note = () =>
    newAnnotation(
      "note",
      annotationColors.yellow,
      { pageIndex: 0, rects: [[30, 600, 52, 622]] },
      { index: 0, size: { width: 600, height: 800 }, rotation: 0, objectNumber: 1 },
      { runs: [] },
    );

  it("finishes an annotation after switching tabs before its geometry arrives", async () => {
    TestWorker.heldMethods.add("getPageGeometry");
    const tab = new DocumentTab("/r/a.pdf", "pdf");
    await show(tab);
    await draw("note");
    const worker = TestWorker.instances[0];
    expect(tab.pendingAnnotations).toBe(true);
    await show(new DocumentTab("/r/b.pdf", "pdf"));
    expect(worker.terminate).not.toHaveBeenCalled();
    await act(async () => {
      for (const [request] of worker.postMessage.mock.calls)
        if (request.data?.name === "getPageGeometry")
          worker.send({ id: request.id, type: "ExecuteResponse", data: { type: "result", value: { runs: [] } } });
    });
    expect(tab.annotations!.annotations).toHaveLength(1);
    expect(tab.pendingAnnotations).toBe(false);
    expect(worker.terminate).toHaveBeenCalledOnce();
    await act(async () => tab.save());
    expect(tab.hasUnsavedChanges).toBe(false);
  });

  it("waits for an unfinished annotation before asking to save on close", async () => {
    TestWorker.heldMethods.add("getPageGeometry");
    const tab = new DocumentTab("/r/a.pdf", "pdf");
    await show(tab);
    await draw("note");
    mocks.closeAnswer.mockResolvedValue("save");
    const closing = tab.beforeClose!();
    expect(mocks.closeAnswer).not.toHaveBeenCalled();
    const worker = TestWorker.instances[0];
    await act(async () => {
      for (const [request] of worker.postMessage.mock.calls)
        if (request.data?.name === "getPageGeometry")
          worker.send({ id: request.id, type: "ExecuteResponse", data: { type: "result", value: { runs: [] } } });
      expect(await closing).toBe(true);
    });
    expect(mocks.annotationSave).toHaveBeenCalledOnce();
    expect(tab.annotations!.annotations).toHaveLength(1);
  });

  it.each(["note", "text", "image", "ink"])(
    "creates %s in PDF coordinates, edits comments/tags, and saves JSON without calling a PDF mutation",
    async (tool) => {
      const tab = new DocumentTab("/r/a.pdf", "pdf");
      await show(tab);
      await draw(tool, [
        [100, 100],
        [150, 120],
        [200, 140],
      ]);
      expect(tab.annotations!.annotations).toHaveLength(1);
      const item = tab.annotations!.annotations[0];
      expect(item.type).toBe(tool);
      expect(item.position.pageIndex).toBe(0);
      expect(item.pageLabel).toBe("iv");
      if (tool === "note") expect(item.position.rects).toEqual([[189, 649, 211, 671]]);
      if (tool === "image") expect(item.position.rects).toEqual([[100, 660, 200, 700]]);
      if (tool === "ink") expect(item.position.paths?.[0].slice(0, 4)).toEqual([100, 700, 150, 680]);
      // 做完一次就回到普通光标；手绘要连着画好几笔，留在手绘上
      expect(pressed(tool)).toBe(String(tool === "ink"));
      if (tool === "image" || tool === "ink") {
        // 框图、手绘画完不弹批注栏；点页面上的批注才打开
        expect(container.querySelector('[aria-label="document.annotation.comment"]')).toBeNull();
        if (tool === "ink") await click("annotation.select");
        await clickOnPage(item.id);
      }
      const comment = container.querySelector<HTMLTextAreaElement>('[aria-label="document.annotation.comment"]')!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(comment, "A useful result");
        comment.dispatchEvent(new Event("input", { bubbles: true }));
      });
      const tags = container.querySelector<HTMLInputElement>('[aria-label="document.annotation.tags"]')!;
      await type(tags, "research");
      await key(tags, "Enter");
      expect(tab.annotations!.annotations[0].tags).toEqual([{ name: "research" }]);
      expect(tab.annotations!.annotations[0].comment).toBe("A useful result");
      await act(async () => tab.save());
      expect(tab.hasUnsavedChanges).toBe(false);
      expect(mocks.annotationSave).toHaveBeenCalled();
      const methods = TestWorker.instances[0].postMessage.mock.calls.map(([request]) => request.data?.name);
      expect(
        methods.some((method) => /createAnnotation|updateAnnotation|removeAnnotation|saveAsCopy/.test(method)),
      ).toBe(false);
    },
  );

  it("keeps undo/redo on the PDF tab across switches and does not consume text-field undo", async () => {
    const tab = new DocumentTab("/r/a.pdf", "pdf");
    await show(tab);
    await draw("note");
    const area = container.querySelector(".pg-document-pdf")!;
    expect((await key(area, "z", { metaKey: true })).defaultPrevented).toBe(true);
    expect(tab.annotations!.annotations).toEqual([]);
    await key(area, "z", { metaKey: true, shiftKey: true });
    expect(tab.annotations!.annotations).toHaveLength(1);
    const input = container.querySelector("textarea")!;
    expect((await key(input, "z", { ctrlKey: true })).defaultPrevented).toBe(false);
    await show(new DocumentTab("/r/b.pdf", "pdf"));
    await show(tab);
    await click("annotation.undo");
    expect(tab.annotations!.annotations).toEqual([]);
  });

  it("erases only the intersected ink across a complete gesture and undoes it in one step", async () => {
    const tab = new DocumentTab("/r/a.pdf", "pdf");
    await show(tab);
    await draw("ink", [
      [100, 100],
      [200, 100],
    ]);
    await draw("note", [
      [150, 90],
      [150, 100],
    ]);
    const before = tab.annotations!.annotations;
    await draw("eraser", [
      [150, 80],
      [150, 120],
    ]);
    expect(tab.annotations!.annotations[0].position.paths).toHaveLength(2);
    expect(tab.annotations!.annotations[1]).toBe(before[1]);
    await click("annotation.undo");
    expect(tab.annotations!.annotations).toEqual(before);
    await click("annotation.redo");
    expect(tab.annotations!.annotations[0].position.paths).toHaveLength(2);
  });

  it("auto-saves after editing stops and can discard a pending edit on close", async () => {
    const tab = new DocumentTab("/r/a.pdf", "pdf");
    await show(tab);
    vi.useFakeTimers();
    await draw("note");
    expect(mocks.annotationSave).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(500));
    expect(mocks.annotationSave).toHaveBeenCalledOnce();
    expect(tab.hasUnsavedChanges).toBe(false);
    await draw("note");
    mocks.closeAnswer.mockResolvedValue("discard");
    expect(await tab.beforeClose!()).toBe(true);
    await act(async () => vi.advanceTimersByTimeAsync(500));
    expect(mocks.annotationSave).toHaveBeenCalledOnce();
  });

  it("filters and recolors cards and keeps failed saves dirty for close/retry", async () => {
    const tab = new DocumentTab("/r/a.pdf", "pdf");
    await show(tab);
    await draw("note");
    const card = container.querySelector("[data-annotation-card]")!;
    await act(async () =>
      card.querySelector<HTMLButtonElement>('[aria-label="document.annotation.colors.blue"]')!.click(),
    );
    expect(tab.annotations!.annotations[0].color).toBe(annotationColors.blue);
    const filter = container.querySelector<HTMLInputElement>('[aria-label="document.annotation.filter"]')!;
    await type(filter, "missing");
    expect(container.querySelector("[data-annotation-card]")).toBeNull();
    await type(filter, "");
    expect(container.querySelector("[data-annotation-card]")).not.toBeNull();
    mocks.annotationSave.mockRejectedValueOnce(new Error("annotationChanged"));
    await act(async () => tab.save());
    expect(tab.hasUnsavedChanges).toBe(true);
    expect(container.textContent).toContain("document.errors.annotationChanged");
    mocks.closeAnswer.mockResolvedValue("cancel");
    expect(await tab.beforeClose!()).toBe(false);
    await act(async () => tab.save());
    expect(tab.hasUnsavedChanges).toBe(false);
  });

  it.each(["highlight", "underline"])(
    "uses a contextual selection menu to create Zotero %s with text",
    async (type) => {
      const tab = new DocumentTab("/r/a.pdf", "pdf");
      tab.pdfLocation.scale = 1;
      await show(tab);
      const page = container.querySelector<HTMLElement>('[data-pdf-page="0"]')!;
      for (const [type, clientX, clientY] of [
        ["pointerdown", 41, 85],
        ["pointermove", 79, 115],
        ["pointerup", 79, 115],
      ] as const) {
        await act(async () =>
          page.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY, button: 0 })),
        );
      }
      const menu = container.querySelector('[aria-label="document.annotation.selectionMenu"]')!;
      expect(menu).not.toBeNull();
      await act(async () =>
        menu.querySelector<HTMLButtonElement>(`[aria-label="document.annotation.${type}"]`)!.click(),
      );
      await act(async () =>
        menu.querySelector<HTMLButtonElement>('[aria-label="document.annotation.colors.green"]')!.click(),
      );
      expect(tab.annotations!.annotations[0]).toMatchObject({
        type,
        color: annotationColors.green,
        text: "test\nnext",
        position: { pageIndex: 0 },
      });
      expect(tab.annotations!.annotations[0].position.rects?.[0][1]).toBeGreaterThan(600);
    },
  );

  it("highlights a selection and sends it to the board with its page and annotation", async () => {
    const tab = new DocumentTab("/r/a.pdf", "pdf");
    tab.pdfLocation.scale = 1;
    await show(tab);
    const page = container.querySelector<HTMLElement>('[data-pdf-page="0"]')!;
    for (const [type, clientX, clientY] of [
      ["pointerdown", 41, 85],
      ["pointermove", 79, 115],
      ["pointerup", 79, 115],
    ] as const) {
      await act(async () =>
        page.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY, button: 0 })),
      );
    }
    // 蓝块是我们自己画的那一层：一行一条，贴着字（不是 12 高的松框），不透明所以叠在一起也不出深浅条纹
    const blocks = [...page.querySelectorAll<HTMLElement>('[data-pdf-selection="0"] > div')];
    expect(blocks).toHaveLength(2);
    for (const block of blocks) expect(block.style.background).toBe("rgb(204, 228, 255)");
    expect(parseFloat(blocks[0].style.top)).toBeCloseTo(81.6);
    expect(parseFloat(blocks[0].style.height)).toBeCloseTo(9.8);
    expect(parseFloat(blocks[1].style.top)).toBeCloseTo(111.6);
    // 选区插件自己画的框还在（它那一层要接鼠标），但是透明的
    const own = [...page.querySelectorAll<HTMLElement>('div[style*="mix-blend-mode"]:not([data-pdf-selection]) > div')];
    for (const block of own) expect(block.style.background).toBe("transparent");
    const menu = container.querySelector('[aria-label="document.annotation.selectionMenu"]')!;
    const send = [...menu.querySelectorAll("button")].find(
      (button) => button.textContent === "document.toBoard.action",
    )!;
    await act(async () => send.click());
    const [highlight] = tab.annotations!.annotations;
    expect(highlight).toMatchObject({ type: "highlight", text: "test\nnext" });
    // 高亮存下来的框和蓝块是同一批，不是松框
    const [, bottom, , top] = highlight.position.rects![0];
    expect(top - bottom).toBeCloseTo(9.8, 1);
    await vi.waitFor(() => expect(mocks.sendExcerpt).toHaveBeenCalled());
    expect(mocks.sendExcerpt).toHaveBeenCalledWith({
      path: "/r/a.pdf",
      title: "a",
      page: 1,
      pageLabel: highlight.pageLabel,
      pageCount: 8,
      annotationId: highlight.id,
      text: "test\nnext",
    });
  });

  it("clears the blue blocks and the selection menu on a click in the margin", async () => {
    const tab = new DocumentTab("/r/a.pdf", "pdf");
    tab.pdfLocation.scale = 1;
    await show(tab);
    const page = container.querySelector<HTMLElement>('[data-pdf-page="0"]')!;
    const press = async (events: readonly (readonly [string, number, number])[]) => {
      for (const [type, clientX, clientY] of events)
        await act(async () =>
          page.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY, button: 0 })),
        );
    };
    await press([
      ["pointerdown", 41, 85],
      ["pointermove", 79, 115],
      ["pointerup", 79, 115],
    ]);
    expect(page.querySelectorAll('[data-pdf-selection="0"] > div')).toHaveLength(2);
    expect(container.querySelector('[aria-label="document.annotation.selectionMenu"]')).not.toBeNull();
    await press([
      ["pointerdown", 300, 400],
      ["pointerup", 300, 400],
    ]);
    expect(page.querySelector("[data-pdf-selection]")).toBeNull();
    expect(container.querySelector('[aria-label="document.annotation.selectionMenu"]')).toBeNull();
  });

  it("keeps the highlight colours stacked in the selection menu until the pointer is over them", async () => {
    const tab = new DocumentTab("/r/a.pdf", "pdf");
    tab.pdfLocation.scale = 1;
    await show(tab);
    const page = container.querySelector<HTMLElement>('[data-pdf-page="0"]')!;
    for (const [type, clientX, clientY] of [
      ["pointerdown", 41, 85],
      ["pointermove", 79, 115],
      ["pointerup", 79, 115],
    ] as const) {
      await act(async () =>
        page.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY, button: 0 })),
      );
    }
    const menu = container.querySelector('[aria-label="document.annotation.selectionMenu"]')!;
    const group = menu.querySelector<HTMLElement>('[aria-label="document.annotation.color"]')!;
    const dots = [...group.querySelectorAll<HTMLButtonElement>("button")];
    expect(dots).toHaveLength(8);
    // 聚拢：八个圆点每个只露出 8px；散开：各占 20px
    expect(group.style.width).toBe("84px");
    expect(dots.map((dot) => dot.style.left)).toEqual(["0px", "8px", "16px", "24px", "32px", "40px", "48px", "56px"]);
    await act(async () => group.dispatchEvent(new MouseEvent("pointerover", { bubbles: true })));
    expect(group.style.width).toBe("168px");
    expect(dots[7].style.left).toBe("140px");
    await act(async () => group.dispatchEvent(new MouseEvent("pointerout", { bubbles: true })));
    expect(group.style.width).toBe("84px");
    await act(async () => dots[2].click());
    expect(tab.annotations!.annotations[0]).toMatchObject({ type: "highlight", color: annotationColors.green });
  });

  it("returns to the pointer after one highlight and leaves the sidebar alone", async () => {
    const tab = new DocumentTab("/r/a.pdf", "pdf");
    tab.pdfLocation.scale = 1;
    await show(tab);
    await click("annotation.highlight");
    const page = container.querySelector<HTMLElement>('[data-pdf-page="0"]')!;
    for (const [type, clientX, clientY] of [
      ["pointerdown", 41, 85],
      ["pointermove", 79, 115],
      ["pointerup", 79, 115],
    ] as const) {
      await act(async () =>
        page.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY, button: 0 })),
      );
    }
    await vi.waitFor(() => expect(tab.annotations!.annotations).toHaveLength(1));
    expect(tab.annotations!.annotations[0].type).toBe("highlight");
    expect(pressed("highlight")).toBe("false");
    expect(pressed("select")).toBe("true");
    expect(container.querySelector("[data-annotation-card]")).toBeNull();
  });

  it("draws a region over text without selecting the text, and frames it only while selected or hovered", async () => {
    const tab = new DocumentTab("/r/a.pdf", "pdf");
    tab.pdfLocation.scale = 1;
    await show(tab);
    await draw("image", [
      [41, 85],
      [79, 115],
      [79, 115],
    ]);
    await vi.waitFor(() => expect(tab.annotations!.annotations).toHaveLength(1));
    const [region] = tab.annotations!.annotations;
    expect(region.type).toBe("image");
    expect(container.querySelector('[aria-label="document.annotation.selectionMenu"]')).toBeNull();
    expect(pressed("select")).toBe("true");
    const frame = () => container.querySelector(`[data-annotation-id="${region.id}"] [data-region-frame]`)!;
    expect(frame().getAttribute("class")).toContain("opacity-100");
    await act(async () => {
      container
        .querySelector('[data-pdf-page="0"]')!
        .dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 300, clientY: 500, button: 0 }));
    });
    expect(frame().getAttribute("class")).toContain("opacity-0 group-hover:opacity-100");
    // 框是中性色的细线，线宽不随缩放变粗
    const lines = [...frame().querySelectorAll("rect")];
    expect(lines.map((line) => line.getAttribute("vector-effect"))).toEqual([
      "non-scaling-stroke",
      "non-scaling-stroke",
    ]);
    expect(lines.some((line) => line.getAttribute("stroke") === region.color)).toBe(false);
  });

  it("sends a boxed region to the board as an image", async () => {
    const tab = new DocumentTab("/r/a.pdf", "pdf");
    await show(tab);
    await draw("image");
    const [region] = tab.annotations!.annotations;
    expect(region.type).toBe("image");
    await clickOnPage(region.id);
    const card = container.querySelector(`[data-annotation-card="${region.id}"]`)!;
    await act(async () => card.querySelector<HTMLButtonElement>('[aria-label="document.toBoard.action"]')!.click());
    await vi.waitFor(() => expect(mocks.sendExcerpt).toHaveBeenCalled());
    const [excerpt] = mocks.sendExcerpt.mock.calls[0];
    expect(excerpt).toMatchObject({ path: "/r/a.pdf", page: 1, annotationId: region.id });
    // 给出去的是原始像素，压成图片在页面这边做
    expect(excerpt.image.pixels).toMatchObject({ width: 2, height: 1 });
    expect(excerpt.image.pixels.data).toHaveLength(8);
    expect(excerpt.image.width).toBeGreaterThan(0);
    expect(mocks.error).not.toHaveBeenCalled();
    expect(excerpt.text).toBeUndefined();
  });

  it("lists embedded PDF annotations as external and read only without adding them to the JSON", async () => {
    TestWorker.externalAnnotations = true;
    const tab = new DocumentTab("/r/a.pdf", "pdf");
    await show(tab);
    const trigger = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find(
      (button) => button.textContent === "document.pdf.annotations",
    )!;
    await act(async () => {
      trigger.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
      trigger.click();
    });
    expect(container.textContent).toContain("document.annotation.external");
    expect(container.textContent).toContain("A comment embedded in the original PDF");
    expect(container.querySelector("textarea")).toBeNull();
    expect(button("annotation.delete")).toBeNull();
    expect(tab.annotations!.annotations).toEqual([]);
    expect(mocks.annotationSave).not.toHaveBeenCalled();
  });

  it("keeps the captured selection when switching tabs before selected text arrives", async () => {
    const tab = new DocumentTab("/r/a.pdf", "pdf");
    tab.pdfLocation.scale = 1;
    await show(tab);
    const page = container.querySelector<HTMLElement>('[data-pdf-page="0"]')!;
    for (const [type, clientX, clientY] of [
      ["pointerdown", 41, 85],
      ["pointermove", 79, 115],
      ["pointerup", 79, 115],
    ] as const) {
      await act(async () =>
        page.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY, button: 0 })),
      );
    }
    TestWorker.heldMethods.add("getTextSlices");
    const menu = container.querySelector('[aria-label="document.annotation.selectionMenu"]')!;
    await act(async () =>
      menu.querySelector<HTMLButtonElement>('[aria-label="document.annotation.colors.green"]')!.click(),
    );
    const worker = TestWorker.instances[0];
    expect(tab.pendingAnnotations).toBe(true);
    await show(new DocumentTab("/r/b.pdf", "pdf"));
    expect(worker.terminate).not.toHaveBeenCalled();
    await act(async () => {
      for (const [request] of worker.postMessage.mock.calls)
        if (request.data?.name === "getTextSlices")
          worker.send({ id: request.id, type: "ExecuteResponse", data: { type: "result", value: ["test\nnext"] } });
    });
    expect(tab.annotations!.annotations).toHaveLength(1);
    expect(tab.annotations!.annotations[0]).toMatchObject({ text: "test\nnext", pageLabel: "iv" });
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(mocks.error).not.toHaveBeenCalled();
    await act(async () => tab.save());
    expect(tab.hasUnsavedChanges).toBe(false);
  });

  it("loads read-only records without mutation controls and blocks editing after a load failure", async () => {
    const record = { ...note(), readOnly: true, comment: "other author's note" };
    mocks.annotationLoad.mockResolvedValueOnce({ annotations: [record], revision: "v1" });
    const tab = new DocumentTab("/r/a.pdf", "pdf");
    await show(tab);
    const trigger = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find(
      (button) => button.textContent === "document.pdf.annotations",
    )!;
    await act(async () => {
      trigger.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
      trigger.click();
    });
    expect(container.textContent).toContain("other author's note");
    expect(container.querySelector("textarea")?.readOnly).toBe(true);
    expect(button("annotation.delete")).toBeNull();
    mocks.annotationLoad.mockRejectedValueOnce(new Error("annotationCorrupt"));
    await show(new DocumentTab("/r/b.pdf", "pdf"));
    expect(container.textContent).toContain("document.errors.annotationCorrupt");
    expect(button("annotation.note").disabled).toBe(true);
  });
});
