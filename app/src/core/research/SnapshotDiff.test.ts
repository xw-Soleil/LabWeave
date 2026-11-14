import { Vector } from "@graphif/data-structures";
import { Rectangle } from "@graphif/shapes";
import { beforeEach, describe, expect, it, vi } from "vitest";

const settings = vi.hoisted(() => ({ ignoreTextNodeTextRenderLessThanFontSize: 0, literatureLibraryPath: "" }));
vi.mock("@/core/service/Settings", () => ({ Settings: settings }));
vi.mock("@tauri-apps/plugin-fs", () => ({}));
vi.mock("sonner", () => ({ toast: {} }));
// 画标记要用到颜色、向量这些类，它们自己也用这个包，所以只换掉 serialize
vi.mock("@graphif/serializer", async (original) => ({
  ...(await original<object>()),
  serialize: (stage: unknown) => stage,
}));
vi.mock("./ResearchFolder", () => ({ ResearchFolder: { getRoot: () => "/research" } }));

import { buildAiSidecar } from "./AiSidecarBuilder";
import { compareBoards, hideSinceLast, renderSinceLast, showSinceLast, sinceLastCounts } from "./SnapshotDiff";

const box = (x: number, y: number, w = 100, h = 50) => ({
  _: "CollisionBox",
  shapes: [{ _: "Rectangle", location: { _: "Vector", x, y }, size: { _: "Vector", x: w, y: h } }],
});
const text = (uuid: string, value: string, x = 0, y = 0) => ({
  _: "TextNode",
  uuid,
  text: value,
  collisionBox: box(x, y),
});
const sidecar = (stage: unknown[]) =>
  buildAiSidecar({ serializedStage: stage, workspaceFile: "/research/a.prg", researchRoot: "/research" }).json;

function fakeBoard(stage: unknown[]) {
  const rect = (card: {
    collisionBox: { shapes: { location: { x: number; y: number }; size: { x: number; y: number } }[] };
  }) => {
    const [{ location, size }] = card.collisionBox.shapes;
    return new Rectangle(new Vector(location.x, location.y), new Vector(size.x, size.y));
  };
  const project = {
    uri: { fsPath: "/research/a.prg" },
    stage,
    editRevision: 1,
    camera: { currentScale: 1 },
    renderer: { transformWorld2View: (value: unknown) => value },
    stageStyleManager: {
      currentStyle: { Background: { name: "bg" }, StageObjectBorder: { toNewAlpha: (a: number) => `border@${a}` } },
    },
    stageManager: {
      get: (id: string) => {
        const card = (project.stage as ReturnType<typeof text>[]).find((item) => item.uuid === id);
        return card && { collisionBox: { getRectangle: () => rect(card) } };
      },
    },
    shapeRenderer: { renderRect: vi.fn(), renderCircle: vi.fn() },
    textRenderer: { renderFittedText: vi.fn() },
  };
  return project;
}
const everything = new Rectangle(new Vector(-10000, -10000), new Vector(20000, 20000));

beforeEach(() => {
  vi.useRealTimers();
});

describe("comparing a board with its last snapshot", () => {
  it("tells new, edited and removed cards apart, and ignores a move or a cut-and-paste", () => {
    const before = sidecar([
      text("stay", "没动过", 0, 0),
      text("moved", "只是挪了位置", 0, 100),
      text("edited", "原来的话", 0, 200),
      text("cut", "剪切再粘贴的", 0, 300),
      text("gone", "删掉的想法", 400, 300),
      { _: "Section", uuid: "group", text: "方法", _collisionBoxNormal: box(600, 0, 300, 200), children: [] },
    ]);
    const after = sidecar([
      text("stay", "没动过", 0, 0),
      text("moved", "只是挪了位置", 900, 900),
      text("edited", "改过的话", 0, 200),
      text("pasted", "剪切再粘贴的", 50, 300),
      text("fresh", "新想法", 0, 400),
      { _: "Section", uuid: "group", text: "方法（改名）", _collisionBoxNormal: box(600, 0, 300, 200), children: [] },
    ]);
    const diff = compareBoards(before, after);
    expect([...diff.added]).toEqual(["fresh"]);
    expect([...diff.edited].sort()).toEqual(["edited", "group"]);
    // 删掉的留着它在快照里的位置和标题，画淡影用
    expect(diff.removed).toEqual([{ id: "gone", title: "删掉的想法", rect: { x: 400, y: 300, w: 100, h: 50 } }]);
  });

  it("counts every card as new when the snapshot does not have this board", () => {
    const diff = compareBoards(undefined, sidecar([text("a", "一"), text("b", "二")]));
    expect([...diff.added]).toEqual(["a", "b"]);
    expect(diff.removed).toEqual([]);
  });
});

describe("the marks on the canvas", () => {
  it("draws nothing while the comparison is off", () => {
    const board = fakeBoard([text("a", "一")]);
    renderSinceLast(board as never, everything);
    expect(board.shapeRenderer.renderRect).not.toHaveBeenCalled();
    expect(sinceLastCounts(board as never)).toBeUndefined();
  });

  it("outlines new cards, dots edited ones and leaves a faint titled shadow where a card was removed", () => {
    const base = sidecar([text("edited", "原来的话", 0, 200), text("gone", "删掉的想法", 400, 300)]);
    const board = fakeBoard([text("edited", "改过的话", 0, 200), text("fresh", "新想法", 0, 400)]);
    showSinceLast(board as never, "2026-11-21 1030", base);
    expect(sinceLastCounts(board as never)).toEqual({ name: "2026-11-21 1030", added: 1, edited: 1, removed: 1 });
    renderSinceLast(board as never, everything);

    const [ghost, outline] = board.shapeRenderer.renderRect.mock.calls;
    // 淡影在卡片原来的位置，很淡
    expect(ghost[0]).toMatchObject({ location: { x: 400, y: 300 }, size: { x: 100, y: 50 } });
    expect(ghost[1]).toBe("border@0.05");
    expect(board.textRenderer.renderFittedText.mock.calls[0][0]).toBe("删掉的想法");
    // 描边比卡片大一圈，不填色
    expect(outline[0]).toMatchObject({ location: { x: -5, y: 395 }, size: { x: 110, y: 60 } });
    expect(outline[1].a).toBe(0);
    // 小点在改过的卡片右上角
    expect(board.shapeRenderer.renderCircle.mock.calls).toHaveLength(1);
    expect(board.shapeRenderer.renderCircle.mock.calls[0][0]).toMatchObject({ x: 100, y: 200 });

    hideSinceLast(board as never);
    board.shapeRenderer.renderRect.mockClear();
    renderSinceLast(board as never, everything);
    expect(board.shapeRenderer.renderRect).not.toHaveBeenCalled();
  });

  it("skips what is outside the view and keeps lines visible when zoomed far out", () => {
    const board = fakeBoard([text("near", "近处新加的", 0, 0), text("far", "远处新加的", 5000, 5000)]);
    board.camera.currentScale = 0.1;
    showSinceLast(board as never, "s", sidecar([]));
    renderSinceLast(board as never, new Rectangle(new Vector(-200, -200), new Vector(600, 600)));
    expect(board.shapeRenderer.renderRect).toHaveBeenCalledOnce();
    // 缩到 10% 时线宽不会细到看不见
    expect(board.shapeRenderer.renderRect.mock.calls[0][3]).toBe(1.5);
  });

  it("compares again after the board was edited, at most twice a second", () => {
    vi.useFakeTimers();
    const board = fakeBoard([text("a", "一")]);
    showSinceLast(board as never, "s", sidecar([text("a", "一")]));
    expect(sinceLastCounts(board as never)).toMatchObject({ added: 0, edited: 0 });
    board.stage = [text("a", "一"), text("b", "刚加的")];
    board.editRevision = 2;
    vi.advanceTimersByTime(100);
    renderSinceLast(board as never, everything);
    expect(sinceLastCounts(board as never)).toMatchObject({ added: 0 });
    vi.advanceTimersByTime(500);
    renderSinceLast(board as never, everything);
    expect(sinceLastCounts(board as never)).toMatchObject({ added: 1 });
  });
});
