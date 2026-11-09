import { afterEach, describe, expect, it, vi } from "vitest";
import { Vector } from "@graphif/data-structures";
import { Rectangle } from "@graphif/shapes";
import type { Project } from "@/core/Project";
import { setViewInsetsProvider } from "@/core/research/ViewInsets";

vi.mock("@/core/Project", () => ({ Project: class {}, service: () => (value: unknown) => value }));
vi.mock("@/core/service/Settings", () => ({
  Settings: {
    moveAmplitude: 2,
    moveFriction: 0.1,
    scaleExponent: 0.2,
    scaleCameraByMouseLocation: true,
    cameraResetViewPaddingRate: 1,
    cameraResetMaxScale: 1,
  },
}));
vi.mock("../service/feedbackService/SoundService", () => ({
  SoundService: { play: { viewAdjustSoundFile: vi.fn() } },
}));
vi.mock("@/core/stage/stageObject/abstract/StageEntity", () => ({ Entity: class {} }));
import { Camera } from "./Camera";

describe("camera after direct gestures", () => {
  it("fits the project even when the canvas mounts after the first ten frames", () => {
    const renderer = { w: 0, h: 0, transformWorld2View: () => Vector.getZero() };
    const center = new Vector(4000, -3000);
    const getCenter = vi.fn(() => center.clone());
    const camera = new Camera({
      renderer,
      stageManager: { getCenter, getSize: () => new Vector(2000, 1000) },
    } as unknown as Project);
    for (let i = 0; i < 30; i++) camera.tick();
    expect(getCenter).not.toHaveBeenCalled();
    renderer.w = 1000;
    renderer.h = 500;
    camera.tick();
    expect(camera.location).toEqual(center);
    expect(camera.currentScale).toBe(0.5);
    for (let i = 0; i < 30; i++) camera.tick();
    expect(getCenter).toHaveBeenCalledOnce();
  });
  it("keeps a restored saved view instead of fitting all content on open", () => {
    const renderer = { w: 1000, h: 500, transformWorld2View: () => Vector.getZero() };
    const getCenter = vi.fn(() => new Vector(4000, -3000));
    const camera = new Camera({
      renderer,
      stageManager: { getCenter, getSize: () => new Vector(2000, 1000) },
    } as unknown as Project);
    expect(camera.isInitialViewSettled).toBe(false);
    expect(camera.applySavedView(new Vector(120, -80), 0.75)).toBe(true);
    expect(camera.isInitialViewSettled).toBe(true);
    for (let i = 0; i < 30; i++) camera.tick();
    expect(getCenter).not.toHaveBeenCalled();
    expect(camera.location).toEqual(new Vector(120, -80));
    expect(camera.currentScale).toBe(0.75);
    expect(camera.targetScale).toBe(0.75);
  });
  it("ignores an invalid saved view and still fits all content", () => {
    const renderer = { w: 1000, h: 500, transformWorld2View: () => Vector.getZero() };
    const center = new Vector(4000, -3000);
    const getCenter = vi.fn(() => center.clone());
    const camera = new Camera({
      renderer,
      stageManager: { getCenter, getSize: () => new Vector(2000, 1000) },
    } as unknown as Project);
    expect(camera.applySavedView(new Vector(Number.NaN, 0), 1)).toBe(false);
    expect(camera.applySavedView(new Vector(0, 0), 0)).toBe(false);
    for (let i = 0; i < 5; i++) camera.tick();
    expect(getCenter).toHaveBeenCalledOnce();
    expect(camera.location).toEqual(center);
    expect(camera.isInitialViewSettled).toBe(true);
  });
  it("keeps the exact scale and location over idle frames", () => {
    const renderer = { transformWorld2View: vi.fn(() => new Vector(50, 50)) };
    const camera = new Camera({ renderer } as unknown as Project);
    Object.assign(camera, { hasResetOnOpen: true });
    camera.location = new Vector(689.852530163047, -790.7953028402999);
    camera.currentScale = camera.targetScale = 0.07422735362687596;
    const location = camera.location.clone();
    for (let i = 0; i < 240; i++) camera.tick();
    expect(camera.currentScale).toBe(0.07422735362687596);
    expect(camera.targetScale).toBe(camera.currentScale);
    expect(camera.location).toEqual(location);
  });
});

describe("camera with floating side panels over the canvas", () => {
  const makeCamera = () =>
    new Camera({
      renderer: { w: 1000, h: 500, transformWorld2View: () => Vector.getZero() },
      stageManager: { getCenter: () => new Vector(0, 0), getSize: () => new Vector(2000, 1000) },
    } as unknown as Project);

  afterEach(() => setViewInsetsProvider(null));

  it("fits all content into the part the panels don't cover", () => {
    setViewInsetsProvider(() => ({ left: 0, right: 200 }));
    const camera = makeCamera();
    camera.reset();
    // 可用宽度 800：缩放取 800/2000，内容中心落在左边 800 像素的正中
    expect(camera.currentScale).toBe(0.4);
    expect(camera.location).toEqual(new Vector(250, 0));
  });

  it("centers a rectangle in the uncovered part", () => {
    setViewInsetsProvider(() => ({ left: 300, right: 100 }));
    const camera = makeCamera();
    camera.resetByRectangle(new Rectangle(new Vector(-150, -50), new Vector(300, 100)));
    expect(camera.currentScale).toBe(1);
    expect(camera.location).toEqual(new Vector(-100, 0));
  });

  it("doesn't dodge when the panels would cover most of a narrow canvas", () => {
    setViewInsetsProvider(() => ({ left: 400, right: 400 }));
    const camera = makeCamera();
    camera.reset();
    expect(camera.currentScale).toBe(0.5);
    expect(camera.location).toEqual(new Vector(0, 0));
  });
});
