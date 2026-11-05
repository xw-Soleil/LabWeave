import { describe, expect, it, vi } from "vitest";
import { Vector } from "@graphif/data-structures";
import { Rectangle } from "@graphif/shapes";

vi.mock("@/core/Project", () => ({
  Project: class Project {},
  ProjectState: { Saved: "saved", Unsaved: "unsaved" },
  service: (id: string) => (target: { id?: string }) => {
    target.id = id;
    return target;
  },
}));
vi.mock("@/core/render/canvas2d/renderer", () => ({
  Renderer: { FONT_SIZE: 24, NODE_PADDING: 10 },
}));
vi.mock("@/core/service/Settings", () => ({ Settings: { watch: vi.fn() } }));
vi.mock("@/core/service/feedbackService/SoundService", () => ({ SoundService: {} }));
vi.mock("@/utils/font", () => ({
  getMultiLineTextSize: () => new Vector(20, 20),
  getTextSize: () => new Vector(20, 20),
}));
vi.mock("sonner", () => ({ toast: vi.fn() }));

import { StageManager } from "./StageManager";
import { ConnectableEntity } from "@/core/stage/stageObject/abstract/ConnectableEntity";
import { Entity } from "@/core/stage/stageObject/abstract/StageEntity";
import { CollisionBox } from "@/core/stage/stageObject/collisionBox/collisionBox";
import { LineEdge } from "@/core/stage/stageObject/association/LineEdge";
import { ArcEdge } from "@/core/stage/stageObject/association/ArcEdge";
import { serialize, deserialize } from "@graphif/serializer";
import { PenStroke } from "@/core/stage/stageObject/entity/PenStroke";
import { Section } from "@/core/stage/stageObject/entity/Section";
import { TextNode } from "@/core/stage/stageObject/entity/TextNode";

function createStageManager(stage: object[]) {
  return new StageManager({ stage } as never);
}

function textNode(uuid: string, x = 0, y = 0): TextNode {
  return Object.assign(Object.create(TextNode.prototype), {
    uuid,
    collisionBox: new CollisionBox([new Rectangle(new Vector(x, y), new Vector(100, 80))]),
    unknown: false,
  }) as TextNode;
}

/** 反序列化过程中尚未加载的占位节点：uuid 已知、unknown 为 true */
function unknownEntity(uuid: string): TextNode {
  return Object.assign(Object.create(TextNode.prototype), {
    uuid,
    collisionBox: new CollisionBox([new Rectangle(new Vector(0, 0), new Vector(100, 80))]),
    unknown: true,
  }) as TextNode;
}

function section(uuid: string, children: Entity[]): Section {
  const collisionBox = new CollisionBox([new Rectangle(new Vector(0, 0), new Vector(300, 200))]);
  return Object.assign(Object.create(Section.prototype), {
    uuid,
    text: "",
    children,
    isCollapsed: false,
    locked: false,
    unknown: false,
    // Section.collisionBox 是 getter，读取这两个内部字段
    _collisionBoxNormal: collisionBox,
    _collisionBoxWhenCollapsed: collisionBox,
    adjustLocationAndSize: () => {},
    adjustChildrenStateByCollapse: () => {},
  }) as Section;
}

function lineEdge(associationList: ConnectableEntity[], uuid: string = crypto.randomUUID()): LineEdge {
  return new LineEdge({} as never, { associationList, uuid });
}

describe("StageManager.updateReferences", () => {
  it("straightens only selected edges and preserves their identity and saved style", () => {
    const a = textNode("a"),
      b = textNode("b", 300);
    const selected = lineEdge([a, b], "line");
    const unselected = lineEdge([b, a], "other");
    const arc = new ArcEdge({} as never, { associationList: [a, b], uuid: "arc", text: "关系" });
    arc.isSelected = selected.isSelected = true;
    const project = { stage: [a, b, selected, unselected, arc], historyManager: { recordStep: vi.fn() } };
    const manager = new StageManager(project as never);
    manager.straightenSelectedEdges();
    expect(selected.pathStyle).toBe("straight");
    expect(unselected.pathStyle).toBe("inherit");
    const replacement = manager.get("arc") as LineEdge;
    expect(replacement).toBeInstanceOf(LineEdge);
    expect(replacement.text).toBe("关系");
    expect(replacement.source).toBe(a);
    expect(replacement.target).toBe(b);
    expect(project.historyManager.recordStep).toHaveBeenCalledOnce();
    const restored = deserialize(serialize([replacement]), project) as LineEdge[];
    expect(restored[0].pathStyle).toBe("straight");
  });
  it("replaces unknown edge endpoints with the real entities on stage", () => {
    const source = textNode("source-uuid", 0, 0);
    const target = textNode("target-uuid", 300, 0);
    const edge = lineEdge([unknownEntity("source-uuid"), unknownEntity("target-uuid")]);
    const manager = createStageManager([source, target, edge]);

    manager.updateReferences();

    expect(edge.source).toBe(source);
    expect(edge.target).toBe(target);
    expect(edge.source.unknown).toBe(false);
  });

  it("only replaces the endpoint that is still unknown", () => {
    const source = textNode("source-uuid");
    const edge = lineEdge([source, unknownEntity("target-uuid")]);
    const target = textNode("target-uuid");
    const manager = createStageManager([source, target, edge]);

    manager.updateReferences();

    expect(edge.source).toBe(source);
    expect(edge.target).toBe(target);
  });

  it("keeps unknown endpoints whose uuid is not on stage", () => {
    const edge = lineEdge([unknownEntity("source-uuid"), unknownEntity("missing-uuid")]);
    const manager = createStageManager([textNode("source-uuid"), edge]);

    manager.updateReferences();

    expect(edge.source.unknown).toBe(false);
    expect(edge.target.unknown).toBe(true);
  });

  it("does not resolve endpoints against entities that cannot be connected", () => {
    // PenStroke 是 Entity 但不是 ConnectableEntity，不能作为 Edge 端点
    const penStroke = Object.assign(Object.create(PenStroke.prototype), {
      uuid: "pen-uuid",
      collisionBox: new CollisionBox([new Rectangle(new Vector(0, 0), new Vector(100, 80))]),
    }) as PenStroke;
    const edge = lineEdge([unknownEntity("pen-uuid"), unknownEntity("other-uuid")]);
    const manager = createStageManager([penStroke, edge]);

    manager.updateReferences();

    expect(edge.source.unknown).toBe(true);
  });

  it("rebuilds the section runtime tree", () => {
    const node = textNode("node-uuid", 10, 10);
    const sectionObject = section("section-uuid", [node]);
    const manager = createStageManager([sectionObject, node]);

    manager.updateReferences();

    expect(sectionObject.children).toEqual([node]);
    expect(node.parentSection).toBe(sectionObject);
    expect(manager.getRootSections()).toEqual([sectionObject]);
    expect(manager.getTopLevelEntities()).toEqual([sectionObject]);
    expect(node.sectionDepth).toBe(1);
  });

  it("assigns symmetric shifting indexes to multi-edges of the same geometry group", () => {
    const source = textNode("a", 0, 0);
    const target = textNode("b", 300, 0);
    const first = lineEdge([source, target], "11111111-1111-1111-1111-111111111111");
    const second = lineEdge([target, source], "22222222-2222-2222-2222-222222222222");
    const selfLoop = lineEdge([source, source], "33333333-3333-3333-3333-333333333333");
    const manager = createStageManager([source, target, first, second, selfLoop]);

    manager.updateReferences();

    expect([first.shiftingIndex, second.shiftingIndex].sort()).toEqual([-1, 1]);
    expect(selfLoop.shiftingIndex).toBe(0);
  });

  it("separates relations even when different anchors lead to the same visible path", () => {
    const source = textNode("a", 0, 0),
      target = textNode("b", 300, 0);
    const first = lineEdge([source, target], "a-edge"),
      second = lineEdge([target, source], "b-edge");
    first.sourceRectangleRate = new Vector(1, 0.5);
    first.targetRectangleRate = new Vector(0, 0.5);
    const manager = createStageManager([source, target, first, second]);
    manager.updateReferences();
    expect([first.shiftingIndex, second.shiftingIndex]).toEqual([-1, 1]);
    manager.updateReferences();
    expect([first.shiftingIndex, second.shiftingIndex]).toEqual([-1, 1]);
  });

  it("scans the association list once regardless of entity count", () => {
    // 回归护栏：修复前每个实体都会触发一次全量关系扫描，调用次数随实体数线性增长（O(N*E)）
    const stage: object[] = [];
    for (let i = 0; i < 200; i++) {
      const node = textNode(`node-${i}`, i, 0);
      stage.push(node, lineEdge([node, node]));
    }
    const manager = createStageManager(stage);
    const associationsSpy = vi.spyOn(StageManager.prototype, "getAssociations");

    manager.updateReferences();

    expect(associationsSpy).toHaveBeenCalledOnce();
    associationsSpy.mockRestore();
  });
});
