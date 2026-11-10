// @vitest-environment jsdom
import { PdfZoomMode } from "@embedpdf/models";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ read: vi.fn(), error: vi.fn(), writeText: vi.fn() }));
vi.mock("./PdfReader", async (original) => ({ ...(await original<object>()), readPdfBuffer: mocks.read }));
vi.mock("@/core/research/ResearchFolder", () => ({
  ResearchFolder: { ensureRootRegistered: vi.fn() },
  notifyResearchFilesChanged: vi.fn(),
}));
vi.mock("@/core/service/Settings", () => ({ Settings: {} }));
vi.mock("@/core/service/Telemetry", () => ({ Telemetry: {} }));
vi.mock("@/components/ui/dialog", () => ({ Dialog: {} }));
vi.mock("i18next", () => ({
  default: {
    t: (key: string, options: Record<string, unknown>) =>
      key.endsWith("searchCount") ? `${options.current} / ${options.total}` : key,
  },
}));
vi.mock("sonner", () => ({ toast: { error: mocks.error } }));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: mocks.writeText }));
import { activeTabAtom, store } from "@/state";
import { DocumentTab } from "./DocumentTab";
import DocumentView from "./DocumentView";

class TestWorker extends EventTarget {
  static instances: TestWorker[] = [];
  terminate = vi.fn();
  postMessage = vi.fn((request: { id: string; type: string; data: { name: string; args: any[] } }) => {
    if (request.type !== "ExecuteRequest" || this.terminate.mock.calls.length) return;
    const { name, args } = request.data;
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
    if (name === "getPageGeometry")
      value = {
        runs: [80, 110].map((y, row) => ({
          rect: { x: 40, y, width: 40, height: 12 },
          charStart: row * 4,
          glyphs: Array.from({ length: 4 }, (_, index) => ({ x: 40 + index * 10, y, width: 10, height: 12, flags: 0 })),
        })),
      };
    if (name === "getTextSlices") value = ["test\nnext"];
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
    queueMicrotask(() => this.send({ id: "0", type: "ReadyResponse" }));
  }
  send(data: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
}

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks();
  TestWorker.instances = [];
  mocks.read.mockImplementation(async () => new ArrayBuffer(16));
  mocks.writeText.mockResolvedValue(undefined);
  vi.stubGlobal("Worker", TestWorker);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private callback: () => void) {}
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
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const button = (key: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="document.${key}"]`)!;
async function show(tab: DocumentTab) {
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

  it("shows the outline, jumps to a bookmark, and keeps annotations as an empty placeholder", async () => {
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
    expect(container.textContent).toContain("document.pdf.annotationsPlaceholder");
    await click("pdf.toggleSidebar");
    expect(container.querySelector("aside")).toBeNull();
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
