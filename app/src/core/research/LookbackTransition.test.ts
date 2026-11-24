// @vitest-environment jsdom
import { Vector } from "@graphif/data-structures";
import { Rectangle } from "@graphif/shapes";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ marks: vi.fn() }));
vi.mock("./SnapshotDiff", () => ({ renderSinceLast: mocks.marks }));
vi.mock("@/core/stage/stageObject/collisionBox/collisionBox", () => ({
  CollisionBox: class {
    constructor(readonly shapes: Rectangle[]) {}
    getRectangle() {
      return this.shapes[0];
    }
  },
}));
vi.mock("@/core/stage/stageObject/entity/FileCardNode", () => ({ FileCardNode: class {} }));
vi.mock("@/core/stage/stageObject/entity/ImageNode", () => ({ ImageNode: class {} }));
vi.mock("@/core/stage/stageObject/entity/PenStroke", () => ({ PenStroke: class {} }));
vi.mock("@/core/stage/stageObject/entity/ReferenceBlockNode", () => ({ ReferenceBlockNode: class {} }));
vi.mock("@/core/stage/stageObject/entity/Section", () => ({ Section: class {} }));
vi.mock("@/core/stage/stageObject/entity/SvgNode", () => ({ SvgNode: class {} }));

import type { Project } from "@/core/Project";
import { CollisionBox } from "@/core/stage/stageObject/collisionBox/collisionBox";
import { FileCardNode } from "@/core/stage/stageObject/entity/FileCardNode";
import { ImageNode } from "@/core/stage/stageObject/entity/ImageNode";
import { lookbackTransitionOver, renderLookbackTransition, startLookbackTransition } from "./LookbackTransition";

const boxAt = (x: number, w = 100) => new CollisionBox([new Rectangle(new Vector(x, 0), new Vector(w, 40))]);

function card(uuid: string, x: number, more: Record<string, unknown> = {}, type: { prototype: object } = Object) {
  return Object.assign(Object.create(type.prototype) as object, { uuid, collisionBox: boxAt(x), text: uuid, ...more });
}

/** 假画布：只记透明度和缩放，save / restore 照真的来 */
function canvas() {
  const states: { globalAlpha: number }[] = [];
  return {
    globalAlpha: 1,
    scale: vi.fn(),
    translate: vi.fn(),
    beginPath: vi.fn(),
    rect: vi.fn(),
    arc: vi.fn(),
    clip: vi.fn(),
    save() {
      states.push({ globalAlpha: this.globalAlpha });
    },
    restore() {
      Object.assign(this, states.pop());
    },
    get open() {
      return states.length;
    },
  };
}

type Drawn = { board: string; uuid: string; x: number; alpha: number };
let drawn: Drawn[] = [];

function board(name: string, entities: ReturnType<typeof card>[], links: unknown[] = []) {
  const project = {
    name,
    closing: false,
    looping: true,
    editRevision: 0,
    services: new Set(["entityRenderer"]),
    getService: (id: string) => project.services.has(id) || undefined,
    canvas: { ctx: canvas(), element: { isConnected: true } },
    camera: { location: new Vector(0, 0), currentScale: 1 },
    renderer: {
      w: 800,
      h: 600,
      isOverView: () => false,
      transformWorld2View: (place: unknown) => place,
      renderEdge: vi.fn(),
      renderTags: vi.fn(),
      resizeWindow: vi.fn(),
      tick: vi.fn(),
    },
    stageManager: { getEntities: () => entities, getAssociations: () => links },
    entityRenderer: {
      renderEntity: vi.fn((entity: ReturnType<typeof card>) => {
        drawn.push({
          board: name,
          uuid: entity.uuid,
          x: entity.collisionBox.getRectangle().location.x,
          alpha: Number(project.canvas.ctx.globalAlpha.toFixed(2)),
        });
      }),
      renderSection: vi.fn(),
      renderAllSectionsBigTitle: vi.fn(),
      sortSectionsByZIndex: vi.fn(),
    },
    sectionRenderer: { renderBackgroundColor: vi.fn() },
    sectionMethods: { isEntityHiddenByBigTitleSection: () => false },
    controller: { resetCountdownTimer: vi.fn() },
  };
  return project;
}
const start = (from: unknown, to: unknown) => startLookbackTransition(from as Project, to as Project);
const over = (from: unknown) => lookbackTransitionOver(from as Project);
const view = new Rectangle(new Vector(-400, -300), new Vector(800, 600));

let clock = 0;
/** 过 ms 毫秒（按一帧帧过），返回最后一帧画了什么、是不是由过渡画的 */
function pass(to: unknown, ms: number) {
  let playing = true;
  for (let left = ms; left > 0; left -= 20) {
    clock += 20;
    drawn = [];
    playing = renderLookbackTransition(to as Project, view);
  }
  return { playing, drawn };
}
function firstFrame(to: unknown) {
  drawn = [];
  return { playing: renderLookbackTransition(to as Project, view), drawn };
}
const reduceMotion = (matches: boolean) => vi.stubGlobal("matchMedia", () => ({ matches }));

beforeEach(() => {
  clock = 1000;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  reduceMotion(false);
  mocks.marks.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("the transition between two boards being looked back at", () => {
  it("slides kept cards, fades removed ones, grows new ones, and hands every card its own place back", () => {
    const from = board("旧", [card("留", 0), card("删", 300)]);
    const to = board("新", [card("留", 500), card("加", 800)]);
    const kept = to.stageManager.getEntities()[0];
    const [own, oldCtx, oldPlace] = [kept.collisionBox, from.canvas.ctx, from.camera.location];
    to.camera.location = new Vector(7, 7);
    start(from, to);
    expect(to.renderer.tick).toHaveBeenCalledOnce();
    expect(to.controller.resetCountdownTimer).toHaveBeenCalledOnce();

    // 第一帧和旧白板一样：留下的在原处，要删的还在，新加的还没有
    expect(firstFrame(to)).toEqual({
      playing: true,
      drawn: [
        { board: "旧", uuid: "删", x: 300, alpha: 1 },
        { board: "新", uuid: "留", x: 0, alpha: 1 },
      ],
    });
    const middle = pass(to, 240).drawn;
    expect(middle.map(({ uuid }) => uuid)).toEqual(["留"]);
    expect(middle[0].x).toBeGreaterThan(100);
    expect(middle[0].x).toBeLessThan(450);
    const late = pass(to, 200).drawn;
    expect(late.map(({ uuid }) => uuid)).toEqual(["留", "加"]);
    expect(late[1].alpha).toBeGreaterThan(0);
    expect(late[1].alpha).toBeLessThanOrEqual(1);

    // 借的位置、画布、镜头每一帧都还
    expect(kept.collisionBox).toBe(own);
    expect(from.canvas.ctx).toBe(oldCtx);
    expect(from.camera.location).toBe(oldPlace);
    expect(to.canvas.ctx.open).toBe(0);
    expect(pass(to, 1000).playing).toBe(false);
    expect(Object.keys(kept)).toEqual(Object.keys(card("留", 500)));
  });

  it("draws the old board on the new canvas with the new camera", () => {
    const from = board("旧", [card("删", 0)]);
    const to = board("新", []);
    let seen: unknown[] = [];
    from.entityRenderer.renderEntity.mockImplementation(() => {
      seen = [from.canvas.ctx, from.camera.location, from.camera.currentScale, from.renderer.w];
    });
    to.camera = { location: new Vector(30, 40), currentScale: 2 };
    to.renderer.w = 640;
    start(from, to);
    firstFrame(to);
    expect(seen).toEqual([to.canvas.ctx, to.camera.location, 2, 640]);
  });

  it("cross-fades a card whose content changed and leaves one that only moved alone", () => {
    const from = board("旧", [card("改", 0, { text: "以前" }), card("挪", 200)]);
    const to = board("新", [card("改", 0, { text: "后来" }), card("挪", 400)]);
    start(from, to);
    firstFrame(to);
    const { drawn: middle } = pass(to, 200);
    expect(middle.map(({ board: name, uuid }) => `${name}${uuid}`)).toEqual(["旧改", "新改", "新挪"]);
    expect(middle[0].alpha).toBeGreaterThan(0.3);
    expect(middle[1].alpha).toBeGreaterThan(0.3);
    expect(middle[2].alpha).toBe(1);
  });

  it("stretches a picture, which draws itself by its own scale", () => {
    const from = board("旧", [card("图", 0, { collisionBox: boxAt(0, 100) }, ImageNode)]);
    const to = board("新", [card("图", 0, { collisionBox: boxAt(0, 200) }, ImageNode)]);
    start(from, to);
    firstFrame(to);
    expect(to.canvas.ctx.scale).toHaveBeenCalledWith(0.5, 1);
  });

  it("keeps showing the old picture until the new one is decoded, then stops", () => {
    const picture = { attachmentId: "a", bitmap: {}, ensureThumbnail: vi.fn() };
    const from = board("旧", [card("图", 0, picture, FileCardNode)]);
    const to = board("新", [card("图", 0, { ...picture, bitmap: undefined }, FileCardNode)]);
    start(from, to);
    firstFrame(to);
    expect(pass(to, 900)).toMatchObject({ playing: true, drawn: [{ board: "旧", uuid: "图" }] });
    expect(picture.ensureThumbnail).toHaveBeenCalled();
    Object.assign(to.stageManager.getEntities()[0], { bitmap: {} });
    pass(to, 20);
    expect(pass(to, 20).playing).toBe(false);
  });

  it("does not wait forever for a picture that cannot be decoded", () => {
    const from = board("旧", [card("图", 0, { state: "success" })]);
    const to = board("新", [card("图", 0, { state: "loading" })]);
    start(from, to);
    firstFrame(to);
    expect(pass(to, 1000).playing).toBe(true);
    expect(pass(to, 600).playing).toBe(false);
  });

  it("draws connections with their cards where they are in that frame, and a new one growing from its start", () => {
    const [a, b] = [card("甲", 500), card("乙", 900)];
    const edge = { uuid: "线", associationList: [a, b], collisionBox: boxAt(500, 500) };
    const oldEdge = { uuid: "旧线", associationList: [a, b], collisionBox: boxAt(0, 500) };
    const from = board("旧", [card("甲", 0), card("乙", 900)], [oldEdge]);
    const to = board("新", [a, b], [edge]);
    start(from, to);
    let seenAt = 0;
    from.renderer.renderEdge.mockImplementation(() => {
      seenAt = from.stageManager.getEntities()[0].collisionBox.getRectangle().location.x;
    });
    firstFrame(to);
    expect(from.renderer.renderEdge).toHaveBeenCalledWith(view, oldEdge);
    expect(to.renderer.renderEdge).not.toHaveBeenCalled();
    pass(to, 100);
    expect(seenAt).toBeGreaterThan(0);
    pass(to, 260);
    expect(to.canvas.ctx.arc).toHaveBeenCalled();
    expect(to.renderer.renderEdge).toHaveBeenCalledWith(view, edge);
  });

  it("starts counting only once the board is on screen, and never jumps ahead after a slow frame", () => {
    const from = board("旧", [card("留", 0)]);
    const to = board("新", [card("留", 500)]);
    to.canvas.element.isConnected = false;
    start(from, to);
    expect(pass(to, 1000).drawn[0].x).toBe(0);
    to.canvas.element.isConnected = true;
    firstFrame(to);
    clock += 5000;
    expect(firstFrame(to).drawn[0].x).toBeLessThan(50);
  });

  it("ends at once when another transition starts from the board it is playing on", async () => {
    const [one, two, three] = [board("一", [card("留", 0)]), board("二", [card("留", 500)]), board("三", [])];
    start(one, two);
    firstFrame(two);
    const ended = over(one);
    start(two, three);
    expect(renderLookbackTransition(two as unknown as Project, view)).toBe(false);
    expect(renderLookbackTransition(three as unknown as Project, view)).toBe(true);
    await ended;
  });

  it("ends at once when the new board is edited or the old one is gone", () => {
    const from = board("旧", [card("留", 0)]);
    const to = board("新", [card("留", 500)]);
    start(from, to);
    firstFrame(to);
    to.editRevision++;
    expect(pass(to, 20).playing).toBe(false);
    start(from, to);
    firstFrame(to);
    from.services.clear();
    expect(pass(to, 20).playing).toBe(false);
  });

  it("does not play when the system asks for less motion", async () => {
    reduceMotion(true);
    const [from, to] = [board("旧", []), board("新", [])];
    start(from, to);
    expect(to.renderer.tick).not.toHaveBeenCalled();
    expect(firstFrame(to).playing).toBe(false);
    await over(from);
  });

  it("gives everything back, reports once and stops when a frame cannot be drawn", () => {
    const from = board("旧", [card("留", 0)]);
    const to = board("新", [card("留", 500)]);
    const kept = to.stageManager.getEntities()[0];
    const own = kept.collisionBox;
    const reported = vi.fn((event: ErrorEvent) => event.preventDefault());
    window.addEventListener("error", reported);
    start(from, to);
    firstFrame(to);
    to.entityRenderer.renderEntity.mockImplementation(() => {
      throw new Error("画不出来");
    });
    expect(pass(to, 20).playing).toBe(false);
    expect(pass(to, 20).playing).toBe(false);
    window.removeEventListener("error", reported);
    expect(reported).toHaveBeenCalledOnce();
    expect(kept.collisionBox).toBe(own);
    expect(to.canvas.ctx.open).toBe(0);
  });

  it("holds the old board until it is over, but not when the new one is closing too or nobody draws it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const settled = vi.fn();
    const from = board("旧", [card("留", 0)]);
    const to = board("新", [card("留", 500)]);
    start(from, to);
    void over(from).then(settled);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    firstFrame(to);
    pass(to, 1000);
    await vi.waitFor(() => expect(settled).toHaveBeenCalledOnce());

    start(from, to);
    to.closing = true;
    await over(from);

    // 已经在等了，新白板才开始拆
    to.closing = false;
    start(from, to);
    const waiting = over(from);
    await over(to);
    await waiting;

    start(from, to);
    const abandoned = over(from);
    await vi.advanceTimersByTimeAsync(3000);
    await abandoned;
  });
});
