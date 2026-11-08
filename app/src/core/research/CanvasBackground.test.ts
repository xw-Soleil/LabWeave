import { describe, expect, it } from "vitest";
import { DOT_GRID_MIN_SPACING, dotGridLevels, gridIndexRange, isCoarseDot } from "./CanvasBackground";

describe("dot grid background", () => {
  it("keeps the fine layer between one and two minimum spacings on screen", () => {
    for (const scale of [0.01, 0.05, 0.1, 0.33, 0.5, 0.8, 1]) {
      const levels = dotGridLevels(scale);
      if (!levels) throw new Error("expected levels");
      const spacing = levels.fineGap * scale;
      expect(spacing).toBeGreaterThanOrEqual(DOT_GRID_MIN_SPACING);
      expect(spacing).toBeLessThan(DOT_GRID_MIN_SPACING * 2);
    }
  });

  it("fades the fine layer in smoothly as you zoom in", () => {
    expect(dotGridLevels(1)?.fineAlpha).toBe(0);
    expect(dotGridLevels(1.5)?.fineAlpha).toBeCloseTo(0.5);
    expect(dotGridLevels(2)?.fineAlpha).toBe(1);
  });

  it("swaps layers without a jump: the fine layer is fully shown right before it becomes the coarse one", () => {
    const before = dotGridLevels(0.4999);
    const after = dotGridLevels(0.5);
    expect(before?.fineAlpha).toBeCloseTo(1, 2);
    expect(after?.fineAlpha).toBe(0);
    expect(after?.fineGap).toBe((before?.fineGap ?? 0) / 2);
  });

  it("keeps the smallest gap when zoomed far in", () => {
    expect(dotGridLevels(8)).toEqual({ fineGap: 24, fineAlpha: 1 });
  });

  it("draws nothing for a scale that isn't usable yet", () => {
    expect(dotGridLevels(0)).toBeNull();
    expect(dotGridLevels(Number.NaN)).toBeNull();
    expect(dotGridLevels(-1)).toBeNull();
  });

  it("lists grid indices inside the view, negative ones included", () => {
    expect(gridIndexRange(-50, 50, 24)).toEqual([-2, 2]);
    expect(gridIndexRange(0, 24, 24)).toEqual([0, 1]);
  });

  it("puts every other dot in both directions on the coarse layer", () => {
    expect(isCoarseDot(0, 0)).toBe(true);
    expect(isCoarseDot(-2, 4)).toBe(true);
    expect(isCoarseDot(1, 0)).toBe(false);
    expect(isCoarseDot(-3, -2)).toBe(false);
  });
});
