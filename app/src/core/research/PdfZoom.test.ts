// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/core/Project", () => ({ Project: class {} }));
vi.mock("@/core/service/controlService/shortcutKeysEngine/shortcutKeysRegister", () => ({ allKeyBinds: [] }));
vi.mock("@/utils/platform", () => ({ isMac: true }));
vi.mock("@/utils/store", () => ({ createStore: vi.fn() }));
vi.mock("@/core/service/Settings", () => ({ Settings: {} }));
vi.mock("@/core/service/Telemetry", () => ({ Telemetry: {} }));
import { KeyBindsUI } from "@/core/service/controlService/shortcutKeysEngine/KeyBindsUI";
import { bindPdfZoom, zoomPdf } from "./PdfZoom";

let container: HTMLDivElement;
let controller: AbortController;
let active: boolean;
let viewer: Parameters<typeof zoomPdf>[0];
let globalInput: ReturnType<typeof vi.fn<() => boolean>>;
let removeInterceptor: () => void;
beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement("div");
  document.body.append(container);
  vi.spyOn(container, "getBoundingClientRect").mockReturnValue({ left: 240, top: 120 } as DOMRect);
  viewer = {
    container,
    containerTopLeft: [10, 20],
    currentScale: 1,
    updateScale: vi.fn(({ scaleFactor }) => {
      viewer.currentScale = Math.round(viewer.currentScale * scaleFactor! * 100) / 100;
    }),
  } as unknown as typeof viewer;
  globalInput = vi.fn(() => true);
  removeInterceptor = KeyBindsUI.registerInputInterceptor({ onInput: globalInput });
  KeyBindsUI.uiStartListen();
  active = true;
  controller = new AbortController();
  bindPdfZoom(
    container,
    () => viewer,
    () => active,
    controller.signal,
  );
});
afterEach(() => {
  controller.abort();
  KeyBindsUI.uiStopListen();
  removeInterceptor();
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function wheel(options: WheelEventInit) {
  const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, clientX: 400, clientY: 300, ...options });
  container.dispatchEvent(event);
  return event;
}
function key(options: KeyboardEventInit, target: EventTarget = document.body) {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...options });
  target.dispatchEvent(event);
  return event;
}

describe("PDF zoom input", () => {
  it.each(["ctrlKey", "metaKey"])("anchors %s wheel and consumes the shortcut", (modifier) => {
    const event = wheel({ [modifier]: true, deltaY: -30 });
    expect(event.defaultPrevented).toBe(true);
    expect(globalInput).not.toHaveBeenCalled();
    vi.advanceTimersByTime(20);
    expect(viewer.currentScale).toBeGreaterThan(1);
    expect(viewer.updateScale).toHaveBeenCalledWith(expect.objectContaining({ origin: [180, 190], drawingDelay: 150 }));
  });

  it("coalesces bursts into one frame and retains fractional pinch deltas across frames", () => {
    for (let i = 0; i < 10; i++) wheel({ ctrlKey: true, deltaY: -0.1 });
    vi.advanceTimersByTime(20);
    expect(viewer.updateScale).toHaveBeenCalledOnce();
    expect(viewer.currentScale).toBe(1.01);
    for (let i = 0; i < 10; i++) {
      wheel({ ctrlKey: true, deltaY: -0.1 });
      vi.advanceTimersByTime(20);
    }
    expect(viewer.currentScale).toBe(1.02);
  });

  it.each([0, 1, 2])("bounds pixel/line/page wheel zoom like the toolbar (mode %i)", (deltaMode) => {
    viewer.currentScale = 3.99;
    wheel({ ctrlKey: true, deltaY: -120, deltaMode });
    vi.advanceTimersByTime(20);
    expect(viewer.currentScale).toBe(4);
    viewer.currentScale = 0.26;
    wheel({ metaKey: true, deltaY: 120, deltaMode });
    vi.advanceTimersByTime(20);
    expect(viewer.currentScale).toBe(0.25);
    expect(wheel({ ctrlKey: true, deltaY: 120 }).defaultPrevented).toBe(true);
  });

  it.each(["ctrlKey", "metaKey"])("consumes %s plus, minus and reset", (modifier) => {
    for (const name of ["+", "="]) {
      expect(key({ key: name, [modifier]: true }).defaultPrevented).toBe(true);
    }
    expect(viewer.currentScale).toBe(1.44);
    key({ key: "-", [modifier]: true });
    expect(viewer.currentScale).toBe(1.2);
    key({ key: "0", [modifier]: true });
    expect(viewer.currentScale).toBe(1);
    expect(globalInput).not.toHaveBeenCalled();
  });

  it("leaves ordinary scrolling and unrelated keyboard input alone", () => {
    expect(wheel({ deltaY: 20 }).defaultPrevented).toBe(false);
    active = false;
    expect(key({ key: "+", ctrlKey: true }).defaultPrevented).toBe(false);
    active = true;
    expect(key({ key: "+" }).defaultPrevented).toBe(false);
    expect(key({ key: "+", ctrlKey: true, altKey: true }).defaultPrevented).toBe(false);
    const input = document.createElement("textarea");
    document.body.append(input);
    expect(key({ key: "+", metaKey: true }, input).defaultPrevented).toBe(false);
    expect(viewer.updateScale).not.toHaveBeenCalled();
  });

  it("cancels pending zoom and removes listeners when the tab closes", () => {
    wheel({ ctrlKey: true, deltaY: -1 });
    controller.abort();
    vi.advanceTimersByTime(20);
    expect(viewer.updateScale).not.toHaveBeenCalled();
    expect(wheel({ ctrlKey: true, deltaY: -1 }).defaultPrevented).toBe(false);
    expect(key({ key: "+", metaKey: true }).defaultPrevented).toBe(false);
  });
});
