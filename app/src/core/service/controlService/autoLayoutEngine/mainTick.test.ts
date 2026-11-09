// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";

vi.mock("@/core/service/Settings", () => ({
  Settings: { isEnableEntityCollision: false, isEnableSectionCollision: false },
}));
vi.mock("@/core/Project", () => ({
  Project: class Project {},
  service: () => (target: unknown) => target,
}));

import type { Project } from "@/core/Project";
import { ConnectableEntity } from "@/core/stage/stageObject/abstract/ConnectableEntity";
import { CollisionBox } from "@/core/stage/stageObject/collisionBox/collisionBox";
import { Vector } from "@graphif/data-structures";
import { Rectangle } from "@graphif/shapes";
import { AutoLayout } from "./mainTick";

function createEntity(uuid: string, x: number, y: number, width: number, height: number): ConnectableEntity {
  return {
    uuid,
    collisionBox: new CollisionBox([new Rectangle(new Vector(x, y), new Vector(width, height))]),
    moveTo: vi.fn(),
  } as unknown as ConnectableEntity;
}

describe("AutoLayout.autoLayoutDAG", () => {
  it("returns a layout summary and keeps the first root as the layout anchor", () => {
    const root = createEntity("root", 10, 20, 100, 50);
    const child = createEntity("child", 0, 0, 160, 50);
    const grandchild = createEntity("grandchild", 0, 0, 80, 50);
    const children = new Map<ConnectableEntity, ConnectableEntity[]>([
      [root, [child]],
      [child, [grandchild]],
      [grandchild, []],
    ]);
    const recordStep = vi.fn();
    const project = {
      graphMethods: {
        nodeChildrenArray: (entity: ConnectableEntity) => children.get(entity) ?? [],
      },
      historyManager: { recordStep },
    } as unknown as Project;

    const result = new AutoLayout(project).autoLayoutDAG([root, child, grandchild]);

    expect(result).toEqual({ movedCount: 3, internalEdgeCount: 2 });
    expect(recordStep).toHaveBeenCalledOnce();
    expect((root.moveTo as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({ x: 10, y: 20 });
    expect((child.moveTo as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({ x: 260, y: 20 });
    expect((grandchild.moveTo as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({ x: 570, y: 20 });
  });

  it("stacks cards in the same column by their real height so tall cards do not overlap", () => {
    // 11-09 实测：两张 200 高的文件卡片排在同一列，原来只隔 100，压在了一起
    const goal = createEntity("goal", 10, 20, 280, 200);
    const paper = createEntity("paper", 0, 0, 280, 200);
    const note = createEntity("note", 0, 0, 280, 40);
    const result = createEntity("result", 0, 0, 280, 200);
    const children = new Map<ConnectableEntity, ConnectableEntity[]>([
      [goal, [result]],
      [paper, [result]],
      [note, [result]],
    ]);
    const project = {
      graphMethods: { nodeChildrenArray: (entity: ConnectableEntity) => children.get(entity) ?? [] },
      historyManager: { recordStep: vi.fn() },
    } as unknown as Project;

    new AutoLayout(project).autoLayoutDAG([goal, paper, note, result]);

    const placed = (entity: ConnectableEntity) => (entity.moveTo as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(placed(goal)).toMatchObject({ x: 10, y: 20 });
    expect(placed(paper)).toMatchObject({ x: 10, y: 270 });
    expect(placed(note)).toMatchObject({ x: 10, y: 520 });
    expect(placed(result)).toMatchObject({ x: 440, y: 20 });
  });
});
