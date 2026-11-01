import { describe, expect, it } from "vitest";
import {
  decideWheelAction,
  wheelDeltaInPixels,
  wheelSourceEvidence,
  WheelSourceTracker,
  wheelZoomFactor,
  type WheelSignal,
} from "./WheelGesture";

const signal = (overrides: Partial<WheelSignal>): WheelSignal => ({
  deltaMode: 0,
  deltaX: 0,
  deltaY: 0,
  timeStamp: 0,
  ...overrides,
});

describe("wheelSourceEvidence", () => {
  it("按行报告的是鼠标", () => {
    expect(wheelSourceEvidence(signal({ deltaMode: 1, deltaY: 3 }))).toBe("mouse");
  });

  it("wheelDeltaY 是 deltaY 的 3 倍的是触控板", () => {
    expect(wheelSourceEvidence(signal({ deltaY: 4, wheelDeltaY: -12 }))).toBe("trackpad");
  });

  it("wheelDeltaY 是 120 的倍数的是鼠标,不管加速后 deltaY 多大多小", () => {
    expect(wheelSourceEvidence(signal({ deltaY: 4, wheelDeltaY: -120 }))).toBe("mouse");
    expect(wheelSourceEvidence(signal({ deltaY: 4.63535543, wheelDeltaY: -240 }))).toBe("mouse");
    expect(wheelSourceEvidence(signal({ deltaY: 96, wheelDeltaY: -360 }))).toBe("mouse");
  });

  it("斜向或带小数的是触控板", () => {
    expect(wheelSourceEvidence(signal({ deltaX: 2, deltaY: 3 }))).toBe("trackpad");
    expect(wheelSourceEvidence(signal({ deltaY: 2.5 }))).toBe("trackpad");
  });

  it("没有证据时不硬猜", () => {
    expect(wheelSourceEvidence(signal({ deltaY: 4 }))).toBeNull();
    expect(wheelSourceEvidence(signal({ deltaY: 100 }))).toBeNull();
  });
});

describe("WheelSourceTracker", () => {
  it("同一次滚动里没有证据的事件沿用开头的判断", () => {
    const tracker = new WheelSourceTracker();
    expect(tracker.resolve(signal({ deltaY: 4, wheelDeltaY: -120, timeStamp: 0 }))).toBe("mouse");
    expect(tracker.resolve(signal({ deltaY: 6, timeStamp: 16 }))).toBe("mouse");
    expect(tracker.resolve(signal({ deltaY: 30, timeStamp: 32 }))).toBe("mouse");
  });

  it("刚用过触控板,随后没有证据的事件当作惯性尾巴", () => {
    const tracker = new WheelSourceTracker();
    expect(tracker.resolve(signal({ deltaY: 2.5, timeStamp: 0 }))).toBe("trackpad");
    expect(tracker.resolve(signal({ deltaY: 3, timeStamp: 600 }))).toBe("trackpad");
  });

  it("很久没用触控板,没有证据的新一次滚动当作鼠标", () => {
    const tracker = new WheelSourceTracker();
    tracker.resolve(signal({ deltaY: 2.5, timeStamp: 0 }));
    expect(tracker.resolve(signal({ deltaY: 3, timeStamp: 5000 }))).toBe("mouse");
  });

  it("有证据时以证据为准", () => {
    const tracker = new WheelSourceTracker();
    tracker.resolve(signal({ deltaY: 2.5, timeStamp: 0 }));
    expect(tracker.resolve(signal({ deltaY: 4, wheelDeltaY: -120, timeStamp: 10 }))).toBe("mouse");
  });
});

describe("wheelDeltaInPixels", () => {
  it("像素原样,行乘 16,页乘页面高度", () => {
    expect(wheelDeltaInPixels(signal({ deltaX: 1, deltaY: 2 }), 800)).toEqual({ x: 1, y: 2 });
    expect(wheelDeltaInPixels(signal({ deltaMode: 1, deltaY: 3 }), 800)).toEqual({ x: 0, y: 48 });
    expect(wheelDeltaInPixels(signal({ deltaMode: 2, deltaY: 1 }), 800)).toEqual({ x: 0, y: 800 });
  });
});

describe("wheelZoomFactor", () => {
  it("向上滚放大、向下滚缩小,滚动量越大倍数越大", () => {
    expect(wheelZoomFactor(-10, true)).toBeGreaterThan(1);
    expect(wheelZoomFactor(10, true)).toBeLessThan(1);
    expect(wheelZoomFactor(-20, false)).toBeGreaterThan(wheelZoomFactor(-10, false));
  });

  it("单次最多 2 倍", () => {
    expect(wheelZoomFactor(-10000, true)).toBe(2);
    expect(wheelZoomFactor(10000, true)).toBe(0.5);
  });
});

describe("decideWheelAction", () => {
  const pixels = { x: 0, y: 40 };

  it("总是移动:鼠标和触控板都按像素直接移动,同样的滚动量移动同样的距离", () => {
    expect(decideWheelAction("pan", "mouse", pixels, false, false)).toEqual({ kind: "pan", dx: 0, dy: 40 });
    expect(decideWheelAction("pan", "trackpad", pixels, false, false)).toEqual({ kind: "pan", dx: 0, dy: 40 });
  });

  it("Shift + 竖向滚动改成横向移动", () => {
    expect(decideWheelAction("pan", "mouse", pixels, false, true)).toEqual({ kind: "pan", dx: 40, dy: 0 });
  });

  it("双指捏合或按着 Ctrl / Cmd 时缩放", () => {
    expect(decideWheelAction("pan", "mouse", pixels, true, false).kind).toBe("zoom");
  });

  it("自动:鼠标缩放,触控板移动", () => {
    expect(decideWheelAction("auto", "mouse", pixels, false, false).kind).toBe("zoom");
    expect(decideWheelAction("auto", "trackpad", pixels, false, false).kind).toBe("pan");
  });

  it("总是缩放", () => {
    expect(decideWheelAction("zoom", "trackpad", pixels, false, false).kind).toBe("zoom");
  });

  it("没有滚动量时什么都不做", () => {
    expect(decideWheelAction("pan", "mouse", { x: 0, y: 0 }, false, false)).toEqual({ kind: "none" });
  });
});
