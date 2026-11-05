import { describe, expect, it, vi } from "vitest";
import { Vector } from "@graphif/data-structures";

vi.mock("@/core/service/Settings", () => ({
  Settings: {
    moveAmplitude: 2,
    moveFriction: 0.1,
    scaleExponent: 0.2,
    scaleCameraByMouseLocation: true,
    researchWheelBehavior: "pan",
    researchMouseWheelPanStep: 100,
    researchMouseWheelZoomStep: 15,
  },
}));
vi.mock("@/core/Project", () => ({ Project: class {}, service: () => (value: unknown) => value }));
vi.mock("@/core/service/feedbackService/SoundService", () => ({ SoundService: {} }));
vi.mock("@/core/stage/stageObject/abstract/StageEntity", () => ({ Entity: class {} }));
vi.mock("@/core/service/feedbackService/effectEngine/concrete/MouseTipFeedbackEffect", () => ({
  MouseTipFeedbackEffect: {},
}));
vi.mock("@/utils/externalOpen", () => ({ openBrowserOrFileByEntity: vi.fn() }));
vi.mock("@/utils/platform", () => ({ isMac: false }));

import { Settings } from "@/core/service/Settings";
import { ControllerCameraClass } from "./ControllerCamera";
import type { Project } from "@/core/Project";
import { Camera } from "@/core/stage/Camera";

function setup() {
  const project = {
    controller: {
      isCameraLocked: false,
      pressingKeySet: new Set<string>(),
      isMouseDown: [false, false, false],
      setCursorName: vi.fn(),
    },
    canvas: { clientToView: (x: number, y: number) => new Vector(x, y) },
    renderer: {
      w: 100,
      h: 100,
      transformView2World: (p: Vector) =>
        p.subtract(new Vector(50, 50)).divide(camera.currentScale).add(camera.location),
      transformWorld2View: (p: Vector) =>
        p.subtract(camera.location).multiply(camera.currentScale).add(new Vector(50, 50)),
    },
  } as unknown as Project;
  const camera = (project.camera = new Camera(project));
  camera.targetScale = 2;
  Object.assign(camera, { hasResetOnOpen: true });
  return { camera, project, control: new ControllerCameraClass(project) };
}
const wheel = (values: Partial<WheelEvent>) =>
  ({
    deltaMode: 0,
    deltaX: 0,
    deltaY: 0,
    clientX: 50,
    clientY: 50,
    timeStamp: 1000,
    ctrlKey: false,
    ...values,
  }) as WheelEvent;

describe("trackpad camera handoff", () => {
  it.each([1e-6, 1e6])("supports gesture zoom beyond the old limits at %s", (scale) => {
    const { camera, project } = setup();
    camera.applyGesture(new Vector(50, 50), new Vector(60, 60), scale);
    expect(camera.currentScale).toBe(scale);
    expect(project.renderer.transformWorld2View(Vector.getZero()).x).toBeCloseTo(60);
    const location = camera.location.clone();
    for (let i = 0; i < 10; i++) camera.tick();
    expect(camera.currentScale).toBe(scale);
    expect(camera.location).toEqual(location);
  });
  it("mouse drag survives a zoom between pointer moves without snapping to the old world anchor", () => {
    const { camera, control, project } = setup();
    project.controller.isMouseDown[1] = true;
    control.mousedown({ button: 1, clientX: 50, clientY: 50 } as MouseEvent);
    control.mousemove({ clientX: 60, clientY: 50 } as MouseEvent);
    expect(camera.location.x).toBe(-10);
    control.mousewheel(wheel({ ctrlKey: true, deltaY: -10.5, clientX: 60, timeStamp: 1000 }));
    const location = camera.location.x;
    control.mousemove({ clientX: 60, clientY: 50 } as MouseEvent);
    expect(camera.location.x).toBe(location);
    control.mouseup({ button: 1 } as MouseEvent);
    expect(control.isUsingMouseGrabMove).toBe(false);
  });
  it("handles touch-screen pinch with the same anchor and leaves no release acceleration", () => {
    const { camera, control, project } = setup();
    const touches = (points: number[][]) =>
      ({
        touches: points.map(([clientX, clientY]) => ({ clientX, clientY })),
        preventDefault: vi.fn(),
      }) as unknown as TouchEvent;
    control.touchstart(
      touches([
        [30, 50],
        [70, 50],
      ]),
    );
    control.touchmove(
      touches([
        [20, 60],
        [100, 60],
      ]),
    );
    expect(camera.currentScale).toBe(2);
    expect(project.renderer.transformWorld2View(new Vector(0, 0))).toEqual(new Vector(60, 60));
    control.touchend(touches([]));
    const location = camera.location.clone();
    for (let i = 0; i < 240; i++) camera.tick();
    expect(camera.location).toEqual(location);
  });
});

describe("wheel", () => {
  it("moves a trackpad scroll by the scrolled pixels right away, with no easing left for later frames", () => {
    const { camera, control } = setup();
    camera.currentScale = camera.targetScale = 2;
    const start = camera.location.clone();
    control.mousewheel(wheel({ deltaY: 40, wheelDeltaY: -120 } as Partial<WheelEvent>));
    expect(camera.location).toEqual(start.add(new Vector(0, 20)));
    for (let i = 0; i < 60; i++) camera.tick();
    expect(camera.location).toEqual(start.add(new Vector(0, 20)));
  });

  it("stops leftover inertia, queued movement and an old zoom target when the wheel pans", () => {
    const { camera, control } = setup();
    camera.currentScale = camera.targetScale = 1;
    camera.speed = new Vector(5, 3);
    camera.accelerateCommander = new Vector(1, 1);
    camera.isStartZoomIn = true;
    camera.bombMove(new Vector(1000, 1000));
    const start = camera.location.clone();
    control.mousewheel(wheel({ deltaX: 20, deltaY: 12 }));
    expect(camera.location).toEqual(start.add(new Vector(20, 12)));
    for (let i = 0; i < 240; i++) camera.tick();
    expect(camera.location).toEqual(start.add(new Vector(20, 12)));
    expect(camera.currentScale).toBe(1);
  });

  it("moves a mouse notch a fixed distance, however small the accelerated delta, easing out over the next frames", () => {
    const { camera, control } = setup();
    camera.currentScale = camera.targetScale = 2;
    const start = camera.location.clone();
    control.mousewheel(wheel({ deltaY: 4, wheelDeltaY: -120 } as Partial<WheelEvent>));
    expect(camera.location).toEqual(start);
    camera.tick();
    const firstFrame = camera.location.y - start.y;
    expect(firstFrame).toBeGreaterThan(0);
    expect(firstFrame).toBeLessThan(50);
    for (let i = 0; i < 120; i++) camera.tick();
    // 100 屏幕像素,缩放 2 倍时是 50 世界坐标
    expect(camera.location.y - start.y).toBeCloseTo(50);
    expect(camera.location.x).toBe(start.x);
  });

  it("counts a fast spin as several notches and adds a quick next notch to the rest of the move", () => {
    const { camera, control } = setup();
    camera.currentScale = camera.targetScale = 1;
    const start = camera.location.clone();
    control.mousewheel(wheel({ deltaY: 96, wheelDeltaY: -360, timeStamp: 1000 } as Partial<WheelEvent>));
    camera.tick();
    control.mousewheel(wheel({ deltaY: 4, wheelDeltaY: -120, timeStamp: 1016 } as Partial<WheelEvent>));
    for (let i = 0; i < 120; i++) camera.tick();
    expect(camera.location.y - start.y).toBeCloseTo(400);
  });

  it("stops an unfinished mouse wheel move when a drag starts", () => {
    const { camera, control, project } = setup();
    camera.currentScale = camera.targetScale = 1;
    control.mousewheel(wheel({ deltaY: 4, wheelDeltaY: -120 } as Partial<WheelEvent>));
    camera.tick();
    project.controller.isMouseDown[1] = true;
    control.mousedown({ button: 1, clientX: 50, clientY: 50 } as MouseEvent);
    const location = camera.location.clone();
    for (let i = 0; i < 60; i++) camera.tick();
    expect(camera.location).toEqual(location);
  });

  it("zooms a fixed step per mouse notch with Cmd held, eased, keeping the point under the pointer fixed", () => {
    const { camera, control, project } = setup();
    camera.currentScale = camera.targetScale = 1;
    const anchor = project.renderer.transformView2World(new Vector(70, 30));
    control.mousewheel(
      wheel({ deltaY: -4, wheelDeltaY: 120, metaKey: true, clientX: 70, clientY: 30 } as Partial<WheelEvent>),
    );
    expect(camera.currentScale).toBe(1);
    camera.tick();
    expect(camera.currentScale).toBeGreaterThan(1);
    expect(camera.currentScale).toBeLessThan(1.15);
    for (let i = 0; i < 120; i++) camera.tick();
    expect(camera.currentScale).toBeCloseTo(1.15);
    expect(project.renderer.transformWorld2View(anchor).x).toBeCloseTo(70);
    expect(project.renderer.transformWorld2View(anchor).y).toBeCloseTo(30);
  });

  it("zooms around the view center when zooming at the pointer is turned off", () => {
    const { camera, control, project } = setup();
    camera.currentScale = camera.targetScale = 1;
    const center = project.renderer.transformView2World(new Vector(50, 50));
    Settings.scaleCameraByMouseLocation = false;
    try {
      control.mousewheel(wheel({ deltaY: -20.5, ctrlKey: true, clientX: 70, clientY: 30 }));
    } finally {
      Settings.scaleCameraByMouseLocation = true;
    }
    expect(camera.currentScale).toBeGreaterThan(1);
    expect(project.renderer.transformWorld2View(center).x).toBeCloseTo(50);
    expect(project.renderer.transformWorld2View(center).y).toBeCloseTo(50);
  });

  it("zooms around the pointer on pinch (ctrlKey wheel) right away and keeps the point under it fixed", () => {
    const { camera, control, project } = setup();
    camera.currentScale = camera.targetScale = 1;
    const anchor = project.renderer.transformView2World(new Vector(70, 30));
    control.mousewheel(wheel({ deltaY: -20.5, ctrlKey: true, clientX: 70, clientY: 30 }));
    expect(camera.currentScale).toBeGreaterThan(1);
    expect(project.renderer.transformWorld2View(anchor).x).toBeCloseTo(70);
    expect(project.renderer.transformWorld2View(anchor).y).toBeCloseTo(30);
  });
});
