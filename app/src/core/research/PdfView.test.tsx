// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Bus = {
  on(name: string, handler: (event: any) => void, options?: { signal?: AbortSignal }): void;
  dispatch(name: string, event: object): void;
};
type TestViewer = {
  options: { abortSignal?: AbortSignal; eventBus: Bus };
  currentPageNumber: number;
  currentScale: number;
  currentScaleValue: string;
  finished: Set<number>;
  setDocument: ReturnType<typeof vi.fn>;
};
const mocks = vi.hoisted(() => ({
  viewers: [] as TestViewer[],
  destroy: vi.fn(),
  open: vi.fn(),
  error: vi.fn(),
}));
vi.mock("./PdfDocument", () => ({ loadPdfJs: vi.fn(async () => ({})), openPdfDocument: mocks.open }));
vi.mock("pdfjs-dist/legacy/web/pdf_viewer.mjs", () => ({
  EventBus: class implements Bus {
    listeners = new Map<string, Set<(event: any) => void>>();
    on(name: string, handler: (event: any) => void, options?: { signal?: AbortSignal }) {
      const handlers = this.listeners.get(name) ?? new Set();
      handlers.add(handler);
      this.listeners.set(name, handlers);
      options?.signal?.addEventListener("abort", () => handlers.delete(handler), { once: true });
    }
    dispatch(name: string, event: object) {
      this.listeners.get(name)?.forEach((handler) => handler(event));
    }
  },
  PDFLinkService: class {
    setViewer = vi.fn();
    setDocument = vi.fn();
  },
  PDFViewer: class implements TestViewer {
    page = 1;
    scale = "page-width";
    finished = new Set<number>();
    renderingQueue = { isViewFinished: (page: { id: number }) => this.finished.has(page.id) };
    getPageView(index: number) {
      return { id: index + 1 };
    }
    update = vi.fn();
    setDocument = vi.fn((document: unknown) => {
      if (document) this.options.eventBus.dispatch("pagesinit", {});
    });
    constructor(readonly options: TestViewer["options"]) {
      mocks.viewers.push(this);
    }
    get currentPageNumber() {
      return this.page;
    }
    set currentPageNumber(page: number) {
      if (page === this.page) return;
      this.page = page;
      this.options.eventBus.dispatch("pagechanging", { pageNumber: page });
    }
    get currentScaleValue() {
      return this.scale;
    }
    set currentScaleValue(value: string) {
      this.scale = value;
      this.finished.clear();
      this.options.eventBus.dispatch("scalechanging", { scale: this.currentScale });
    }
    get currentScale() {
      return Number(this.scale) || 1;
    }
    set currentScale(value: number) {
      this.currentScaleValue = String(value);
    }
  },
}));
vi.mock("@/core/research/ResearchFolder", () => ({
  ResearchFolder: { ensureRootRegistered: vi.fn() },
  notifyResearchFilesChanged: vi.fn(),
}));
vi.mock("@/core/service/Settings", () => ({ Settings: {} }));
vi.mock("@/core/service/Telemetry", () => ({ Telemetry: {} }));
vi.mock("@/components/ui/dialog", () => ({ Dialog: {} }));
vi.mock("i18next", () => ({ default: { t: (key: string) => key } }));
vi.mock("sonner", () => ({ toast: { error: mocks.error } }));
import { DocumentTab } from "./DocumentTab";
import DocumentView from "./DocumentView";

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.viewers = [];
  mocks.destroy.mockResolvedValue(undefined);
  mocks.open.mockImplementation(async (_path, _onError, signal) => ({
    document: { numPages: 8 },
    destroy: mocks.destroy,
    signal,
  }));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function rendered(viewer: TestViewer, page: number) {
  viewer.finished.add(page);
  viewer.options.eventBus.dispatch("pagerendered", { pageNumber: page });
}

async function show(tab: DocumentTab) {
  const count = mocks.viewers.length;
  await act(async () => root.render(<DocumentView tab={tab} />));
  await act(async () => vi.waitFor(() => expect(mocks.viewers).toHaveLength(count + 1)));
}

describe("PDF reading tabs", () => {
  it("disconnects the real pdf.js viewer's internal observer using its lifetime signal", async () => {
    const disconnect = vi.fn();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect = disconnect;
      },
    );
    await import("pdfjs-dist/legacy/build/pdf.mjs");
    const { PDFViewer, EventBus } = await vi.importActual<typeof import("pdfjs-dist/legacy/web/pdf_viewer.mjs")>(
      "pdfjs-dist/legacy/web/pdf_viewer.mjs",
    );
    const controller = new AbortController();
    container.append(document.createElement("div"));
    const options = { container, eventBus: new EventBus(), abortSignal: controller.signal };
    const viewer = new PDFViewer(options);
    viewer.setDocument(null as never);
    controller.abort();
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it("releases the viewer lifetime and ignores late events when closed", async () => {
    await show(new DocumentTab("/r/a.pdf", "pdf"));
    const viewer = mocks.viewers[0];
    expect(viewer.options.abortSignal).toBeInstanceOf(AbortSignal);
    await act(async () => root.render(null));
    expect(viewer.options.abortSignal!.aborted).toBe(true);
    expect(viewer.setDocument).toHaveBeenLastCalledWith(null);
    expect(mocks.destroy).toHaveBeenCalledOnce();
    expect(() => viewer.options.eventBus.dispatch("pagesinit", {})).not.toThrow();
    mocks.open.mock.calls[0][1](new Error("handle close failed"));
    expect(mocks.error).toHaveBeenCalledOnce();
  });

  it("restores each tab's page and zoom after switching away and back", async () => {
    const first = new DocumentTab("/r/a.pdf", "pdf");
    const second = new DocumentTab("/r/b.pdf", "pdf");
    await show(first);
    await act(async () => {
      mocks.viewers[0].currentPageNumber = 5;
      mocks.viewers[0].currentScale = 1.8;
    });
    await show(second);
    expect(mocks.viewers[1].currentPageNumber).toBe(1);
    await show(first);
    expect(mocks.viewers[2].currentPageNumber).toBe(5);
    expect(mocks.viewers[2].currentScale).toBe(1.8);
    expect(container.querySelector("input")!.value).toBe("5");
  });

  it("stops a later page that stalls after the first page rendered", async () => {
    vi.useFakeTimers();
    await show(new DocumentTab("/r/a.pdf", "pdf"));
    const viewer = mocks.viewers[0];
    await act(async () => {
      rendered(viewer, 1);
      viewer.currentPageNumber = 2;
    });
    await act(async () => vi.advanceTimersByTimeAsync(25001));
    expect(container.textContent).toContain("document.errors.pdfTimeout");
    expect(viewer.options.abortSignal!.aborted).toBe(true);
    expect(mocks.destroy).toHaveBeenCalledOnce();
  });

  it("does not let a background page clear the current page's deadline", async () => {
    vi.useFakeTimers();
    await show(new DocumentTab("/r/a.pdf", "pdf"));
    const viewer = mocks.viewers[0];
    await act(async () => {
      viewer.currentPageNumber = 3;
      rendered(viewer, 2);
    });
    await act(async () => vi.advanceTimersByTimeAsync(25001));
    expect(container.textContent).toContain("document.errors.pdfTimeout");
  });

  it("does not time out an already rendered cached page", async () => {
    vi.useFakeTimers();
    await show(new DocumentTab("/r/a.pdf", "pdf"));
    const viewer = mocks.viewers[0];
    await act(async () => {
      rendered(viewer, 1);
      rendered(viewer, 2);
      viewer.currentPageNumber = 2;
      viewer.currentPageNumber = 1;
    });
    await act(async () => vi.advanceTimersByTimeAsync(25001));
    expect(mocks.destroy).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("document.errors.pdfTimeout");
  });
});
