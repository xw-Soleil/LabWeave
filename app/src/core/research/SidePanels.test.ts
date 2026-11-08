// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";

// 真的 @/state 会顺带加载 Tauri 接口；这里只测纯函数，给一个空的 store
vi.mock("@/state", async () => {
  const { atom, createStore } = await import("jotai");
  return { store: createStore(), activeTabAtom: atom(undefined), tabGroupRootAtom: atom(null) };
});

import { decidePanelToggle, edgeToRevealOnActivate, occludedInsets, type SidePanelStates } from "./SidePanels";

const states = (left: Partial<SidePanelStates["left"]>, right: Partial<SidePanelStates["right"]> = {}) => ({
  left: { pinned: false, peek: false, ...left },
  right: { pinned: true, peek: false, ...right },
});

describe("panel toggle from the rail or a shortcut", () => {
  it("opens a panel that isn't open yet", () => {
    expect(decidePanelToggle({ open: false, pinned: true, frontmost: false })).toBe("open");
  });

  it("collapses a pinned panel that is showing", () => {
    expect(decidePanelToggle({ open: true, pinned: true, frontmost: true })).toBe("collapse");
  });

  it("pins a collapsed or peeking panel instead of closing it", () => {
    expect(decidePanelToggle({ open: true, pinned: false, frontmost: true })).toBe("pin");
  });

  it("brings the panel forward when another one is shown on the same side", () => {
    expect(decidePanelToggle({ open: true, pinned: true, frontmost: false })).toBe("pin");
  });
});

describe("revealing a collapsed side when one of its panels gets focus", () => {
  it("pins the side when a tab on a hidden side becomes active", () => {
    expect(edgeToRevealOnActivate(undefined, { tabId: "find", edge: "left" }, states({}))).toBe("left");
  });

  it("leaves a side alone that is already showing (pinned or peeking)", () => {
    expect(edgeToRevealOnActivate(undefined, { tabId: "ai", edge: "right" }, states({}))).toBeNull();
    expect(edgeToRevealOnActivate(undefined, { tabId: "files", edge: "left" }, states({ peek: true }))).toBeNull();
  });

  it("does not re-open a side the user just collapsed while focus stayed in it", () => {
    expect(edgeToRevealOnActivate("ai", { tabId: "ai", edge: "right" }, states({}, { pinned: false }))).toBeNull();
  });

  it("ignores focus on the editor area", () => {
    expect(edgeToRevealOnActivate("files", null, states({}))).toBeNull();
  });
});

describe("how much of a canvas the floating panels cover", () => {
  const rect = (left: number, top: number, width: number, height: number) => new DOMRect(left, top, width, height);
  const canvas = rect(0, 0, 1200, 800);

  it("measures from the canvas edge to the far side of each panel plus a gap", () => {
    expect(
      occludedInsets(canvas, [
        { edge: "left", rect: rect(56, 44, 240, 748) },
        { edge: "right", rect: rect(872, 44, 320, 748) },
      ]),
    ).toEqual({ left: 304, right: 336 });
  });

  it("ignores panels that don't overlap this canvas, e.g. the other half of a split", () => {
    const rightHalf = rect(600, 0, 600, 800);
    expect(occludedInsets(rightHalf, [{ edge: "left", rect: rect(56, 44, 240, 748) }])).toEqual({ left: 0, right: 0 });
    expect(occludedInsets(rightHalf, [{ edge: "right", rect: rect(872, 44, 320, 748) }])).toEqual({
      left: 0,
      right: 336,
    });
  });

  it("ignores collapsed panels that have no size", () => {
    expect(occludedInsets(canvas, [{ edge: "left", rect: rect(0, 0, 0, 0) }])).toEqual({ left: 0, right: 0 });
  });
});
