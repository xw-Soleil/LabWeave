import { describe, expect, it } from "vitest";
import {
  decideWheelAction,
  mouseZoomFactor,
  wheelDeltaInPixels,
  wheelNotches,
  WheelSmoother,
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

describe("wheelNotches", () => {
  it("有 wheelDelta 时按它数格,不管加速后 deltaY 多大多小", () => {
    expect(wheelNotches(signal({ deltaY: 4, wheelDeltaY: -120 }), { x: 0, y: 4 })).toEqual({ x: 0, y: 1 });
    expect(wheelNotches(signal({ deltaY: 96, wheelDeltaY: -360 }), { x: 0, y: 96 })).toEqual({ x: 0, y: 3 });
    expect(wheelNotches(signal({ deltaY: -4, wheelDeltaY: 120 }), { x: 0, y: -4 })).toEqual({ x: 0, y: -1 });
  });

  it("横向(Shift + 滚轮)按 wheelDeltaX 数格", () => {
    expect(wheelNotches(signal({ deltaX: 4, wheelDeltaX: -120 }), { x: 4, y: 0 })).toEqual({ x: 1, y: 0 });
  });

  it("没有 wheelDelta 时按 3 行或 100 像素一格折算", () => {
    expect(wheelNotches(signal({ deltaMode: 1, deltaY: 3 }), { x: 0, y: 48 })).toEqual({ x: 0, y: 1 });
    expect(wheelNotches(signal({ deltaY: 100 }), { x: 0, y: 100 })).toEqual({ x: 0, y: 1 });
  });
});

describe("mouseZoomFactor", () => {
  it("每格固定倍数,往上拨放大,几格连乘", () => {
    expect(mouseZoomFactor(-1, 15)).toBeCloseTo(1.15);
    expect(mouseZoomFactor(1, 15)).toBeCloseTo(1 / 1.15);
    expect(mouseZoomFactor(-2, 15)).toBeCloseTo(1.15 * 1.15);
  });

  it("单次最多 2 倍", () => {
    expect(mouseZoomFactor(-20, 50)).toBe(2);
    expect(mouseZoomFactor(20, 50)).toBe(0.5);
  });
});

describe("decideWheelAction", () => {
  const base = {
    behavior: "pan" as const,
    source: "trackpad" as const,
    pixels: { x: 0, y: 40 },
    notches: { x: 0, y: 1 },
    pinchOrModifier: false,
    shift: false,
    mouse: { panPx: 100, zoomPercent: 15 },
  };

  it("总是移动:触控板按像素立刻移动,鼠标每格移动固定距离并平滑过渡", () => {
    expect(decideWheelAction(base)).toEqual({ kind: "pan", dx: 0, dy: 40, smooth: false });
    expect(decideWheelAction({ ...base, source: "mouse" })).toEqual({ kind: "pan", dx: 0, dy: 100, smooth: true });
    expect(decideWheelAction({ ...base, source: "mouse", notches: { x: 0, y: 3 } })).toEqual({
      kind: "pan",
      dx: 0,
      dy: 300,
      smooth: true,
    });
  });

  it("Shift + 竖向滚动改成横向移动", () => {
    expect(decideWheelAction({ ...base, shift: true })).toEqual({ kind: "pan", dx: 40, dy: 0, smooth: false });
    expect(decideWheelAction({ ...base, source: "mouse", shift: true })).toEqual({
      kind: "pan",
      dx: 100,
      dy: 0,
      smooth: true,
    });
  });

  it("双指捏合立刻缩放;按着 Ctrl / Cmd 拨鼠标滚轮每格缩放固定倍数并平滑过渡", () => {
    const pinch = decideWheelAction({ ...base, pinchOrModifier: true });
    expect(pinch).toEqual({ kind: "zoom", factor: wheelZoomFactor(40, true), smooth: false });
    const mouse = decideWheelAction({ ...base, source: "mouse", pinchOrModifier: true, notches: { x: 0, y: -1 } });
    expect(mouse.kind === "zoom" && mouse.smooth).toBe(true);
    expect(mouse.kind === "zoom" && mouse.factor).toBeCloseTo(1.15);
  });

  it("自动:鼠标缩放,触控板移动", () => {
    expect(decideWheelAction({ ...base, behavior: "auto", source: "mouse" }).kind).toBe("zoom");
    expect(decideWheelAction({ ...base, behavior: "auto" }).kind).toBe("pan");
  });

  it("总是缩放", () => {
    expect(decideWheelAction({ ...base, behavior: "zoom" })).toEqual({
      kind: "zoom",
      factor: wheelZoomFactor(40, false),
      smooth: false,
    });
  });

  it("没有滚动量时什么都不做", () => {
    expect(decideWheelAction({ ...base, pixels: { x: 0, y: 0 } })).toEqual({ kind: "none" });
    expect(decideWheelAction({ ...base, source: "mouse", notches: { x: 0, y: 0 } })).toEqual({ kind: "none" });
  });
});

describe("WheelSmoother", () => {
  /** 按 60 帧 / 秒走 frames 帧,返回加起来移动了多少、缩放了多少 */
  function run(smoother: WheelSmoother, from: number, frames: number) {
    let dy = 0;
    let factor = 1;
    for (let i = 1; i <= frames; i++) {
      const step = smoother.step(from + i * 16);
      if (!step) break;
      dy += step.dy;
      factor *= step.factor;
    }
    return { dy, factor };
  }

  it("一格的移动先快后慢,约 0.15 秒走完大部分,最后一点不差", () => {
    const smoother = new WheelSmoother();
    smoother.addPan(0, 100, 0);
    const first = smoother.step(16)!;
    expect(first.dy).toBeGreaterThan(20);
    expect(first.dy).toBeLessThan(40);
    const soon = run(smoother, 16, 8);
    expect(first.dy + soon.dy).toBeGreaterThan(90);
    const rest = run(smoother, 16 + 8 * 16, 60);
    expect(first.dy + soon.dy + rest.dy).toBeCloseTo(100, 10);
    expect(smoother.active).toBe(false);
    expect(smoother.step(2000)).toBeNull();
  });

  it("连续拨时新的一格接在剩下的路程后面", () => {
    const smoother = new WheelSmoother();
    smoother.addPan(0, 100, 0);
    const part = run(smoother, 0, 3);
    smoother.addPan(0, 100, 48);
    const rest = run(smoother, 48, 120);
    expect(part.dy + rest.dy).toBeCloseTo(200, 10);
  });

  it("缩放按倍数叠加,以最后一次的位置为中心", () => {
    const smoother = new WheelSmoother();
    smoother.addZoom(1.15, { x: 10, y: 20 }, 0);
    smoother.addZoom(1.15, { x: 30, y: 40 }, 5);
    const first = smoother.step(16)!;
    expect(first.anchor).toEqual({ x: 30, y: 40 });
    const rest = run(smoother, 16, 120);
    expect(first.factor * rest.factor).toBeCloseTo(1.15 * 1.15, 10);
    expect(smoother.active).toBe(false);
  });

  it("取消后不再移动", () => {
    const smoother = new WheelSmoother();
    smoother.addPan(0, 100, 0);
    smoother.step(16);
    smoother.cancel();
    expect(smoother.step(32)).toBeNull();
  });

  it("隔了很久才走下一帧,也不会一步跳完", () => {
    const smoother = new WheelSmoother();
    smoother.addPan(0, 100, 0);
    expect(smoother.step(5000)!.dy).toBeLessThan(100);
  });
});
