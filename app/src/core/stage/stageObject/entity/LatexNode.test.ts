import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/core/Project", () => ({ Project: class Project {} }));
vi.mock("@/core/service/Settings", () => ({ Settings: {} }));
vi.mock("@/core/stage/stageObject/tools/entityDetailsManager", () => ({ DetailsManager: class DetailsManager {} }));
vi.mock("@/core/research/MathImage", () => ({ mathImageCache: { load: vi.fn() } }));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
vi.mock("@/core/render/canvas2d/renderer", () => ({ Renderer: { FONT_SIZE: 24, NODE_PADDING: 10 } }));
vi.mock("@/utils/font", () => ({
  getTextSize: () => new Vector(50, 24),
  getMultiLineTextSize: () => new Vector(20, 20),
}));
vi.mock("./TextNode", () => ({ TextNode: class {} }));
vi.mock("./ConnectPoint", () => ({ ConnectPoint: class {} }));
vi.mock("./ImageNode", () => ({ ImageNode: class {} }));
vi.mock("../association/MutiTargetUndirectedEdge", () => ({ MultiTargetUndirectedEdge: class {} }));

import { mathImageCache, type MathImageResult } from "@/core/research/MathImage";
import { Color, Vector } from "@graphif/data-structures";
import { deserialize, serialize } from "@graphif/serializer";
import { Rectangle } from "@graphif/shapes";
import { toast } from "sonner";
import { CollisionBox } from "../collisionBox/collisionBox";
import { LineEdge } from "../association/LineEdge";
import { LatexNode } from "./LatexNode";
import { Section } from "./Section";

const project = { stageStyleManager: { currentStyle: { StageObjectBorder: new Color(20, 30, 40) } } };
const ready: MathImageResult = {
  status: "ready",
  value: {
    image: {} as HTMLImageElement,
    width: 80,
    height: 40,
    fontSize: 32,
    layout: { width: 64, height: 24, descent: 2 },
    layoutOffset: { x: 8, y: 8 },
  },
};

beforeEach(() => {
  vi.mocked(mathImageCache.load).mockReset().mockResolvedValue(ready);
  vi.mocked(toast.error).mockClear();
});

describe("LatexNode shared image rendering", () => {
  it("tightens a saved card in place and refreshes edges and nested sections without moving other cards", async () => {
    let complete!: (result: MathImageResult) => void;
    const pending = new Promise<MathImageResult>((resolve) => {
      complete = resolve;
    });
    vi.mocked(mathImageCache.load).mockReturnValue(pending);
    const solveOverlaps = vi.fn();
    const workspace = {
      ...project,
      stageManager: { getAssociations: () => [] },
      sectionCollisionSolver: { solveOverlaps },
    };
    const original = new LatexNode(workspace as never, {
      uuid: "saved-formula",
      latexSource: String.raw`\TeX`,
      collisionBox: new CollisionBox([new Rectangle(new Vector(10, 20), new Vector(300, 180))]),
    });
    const node = deserialize(serialize(original), workspace) as LatexNode;
    const target = new LatexNode(workspace as never, {
      collisionBox: new CollisionBox([new Rectangle(new Vector(500, 20), new Vector(80, 40))]),
    });
    const group = new Section(workspace as never, { children: [node] });
    const outer = new Section(workspace as never, { children: [group] });
    node.parentSection = group;
    group.parentSection = outer;
    const edge = new LineEdge(workspace as never, { associationList: [node, target], pathStyle: "straight" });
    const previousLine = edge.bodyLine;
    const previousCollision = edge.collisionBox;
    const targetBefore = target.rectangle.clone();

    complete(ready);
    await vi.waitFor(() => expect(node.state).toBe("success"));
    expect(node.uuid).toBe("saved-formula");
    expect(node.rectangle.location).toEqual(new Vector(10, 20));
    expect(node.rectangle.size).toEqual(new Vector(80, 40));
    expect(group.rectangle).toEqual(new Rectangle(new Vector(-20, -10), new Vector(140, 100)));
    expect(outer.rectangle).toEqual(new Rectangle(new Vector(-50, -40), new Vector(200, 160)));
    expect(group.children).toEqual([node]);
    expect(outer.children).toEqual([group]);
    expect(edge.associationList).toEqual([node, target]);
    expect(edge.bodyLine).not.toBe(previousLine);
    expect(edge.bodyLine.start).toEqual(new Vector(90, 40));
    expect(edge.bodyLine.end).toEqual(new Vector(500, 40));
    expect(edge.collisionBox).not.toBe(previousCollision);
    expect(target.rectangle).toEqual(targetBefore);
    expect(solveOverlaps).not.toHaveBeenCalled();
  });

  it("preserves display mode, theme color and scaled image/collision dimensions", async () => {
    const node = new LatexNode(project as never, { latexSource: String.raw`\TeX`, fontScaleLevel: 2 });
    await vi.waitFor(() => expect(node.state).toBe("success"));
    expect(mathImageCache.load).toHaveBeenCalledExactlyOnceWith({
      source: String.raw`\TeX`,
      mode: "display",
      color: project.stageStyleManager.currentStyle.StageObjectBorder.toString(),
    });
    expect(node.svgOriginalSize).toEqual(new Vector(80, 40));
    expect(node.rectangle.size).toEqual(new Vector(160, 80));
    expect(node.image).toBe(ready.value.image);
    expect(node.currentRenderedColorCss).toBe(project.stageStyleManager.currentStyle.StageObjectBorder.toString());
    node.increaseFontSize();
    expect(node.rectangle.size).toEqual(node.svgOriginalSize.multiply(node.getScale()));
    node.decreaseFontSize();
    expect(node.rectangle.size).toEqual(new Vector(160, 80));
  });

  it("keeps custom colors and source updates, with no runtime image fields in storage", async () => {
    const color = new Color(100, 20, 40);
    const node = new LatexNode(project as never, { latexSource: "x", color });
    await vi.waitFor(() => expect(node.state).toBe("success"));
    expect(node.currentRenderedColorCss).toBe(color.toString());
    await node.updateLatex("y");
    expect(mathImageCache.load).toHaveBeenLastCalledWith({ source: "y", mode: "display", color: color.toString() });
    await node.reRenderWithColor("red");
    expect(node.currentRenderedColorCss).toBe("red");
    const stored = serialize(node);
    expect(stored.latexSource).toBe("y");
    expect(stored).not.toHaveProperty("image");
    expect(stored).not.toHaveProperty("svgOriginalSize");
    expect(stored).not.toHaveProperty("state");
  });

  it("ignores stale completions after a source/color change", async () => {
    let resolve!: (result: MathImageResult) => void;
    vi.mocked(mathImageCache.load).mockReturnValueOnce(new Promise((done) => (resolve = done)));
    const node = new LatexNode(project as never, { latexSource: "old" });
    await node.updateLatex("new", "blue");
    resolve({ status: "failed", error: new Error("stale") });
    await Promise.resolve();
    expect(node.state).toBe("success");
    expect(node.latexSource).toBe("new");
    expect(node.currentRenderedColorCss).toBe("blue");
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("preserves card error reporting but stays quiet when no DOM is available", async () => {
    const node = new LatexNode(project as never, { latexSource: "x" });
    vi.mocked(mathImageCache.load).mockResolvedValueOnce({ status: "failed", error: new Error("bad latex") });
    await node.updateLatex("bad");
    expect(node.state).toBe("error");
    expect(toast.error).toHaveBeenCalledExactlyOnceWith("LaTeX 渲染失败：Error: bad latex");
    vi.mocked(toast.error).mockClear();
    vi.mocked(mathImageCache.load).mockResolvedValueOnce({ status: "unavailable" });
    await node.updateLatex("x");
    expect(node.state).toBe("error");
    expect(toast.error).not.toHaveBeenCalled();
  });
});
