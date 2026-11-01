import { describe, expect, it, vi } from "vitest";

vi.mock("@/core/stage/stageObject/entity/Section", () => ({ Section: class Section {} }));
vi.mock("@/core/stage/stageObject/entity/PenStroke", () => ({ PenStroke: class PenStroke {} }));
vi.mock("@/core/stage/stageObject/entity/ImageNode", () => ({ ImageNode: class ImageNode {} }));

import type { Project } from "@/core/Project";
import type { Entity } from "@/core/stage/stageObject/abstract/StageEntity";
import { ImageNode } from "@/core/stage/stageObject/entity/ImageNode";
import { PenStroke } from "@/core/stage/stageObject/entity/PenStroke";
import { Section } from "@/core/stage/stageObject/entity/Section";
import { Vector } from "@graphif/data-structures";
import { Rectangle } from "@graphif/shapes";
import {
  boxesOverlap,
  findNudgeOffset,
  findOverlappedEntities,
  nudgeEntitiesOutOfOverlap,
  type Box,
} from "./OverlapResolver";

function box(left: number, top: number, width: number, height: number): Box {
  return { left, top, right: left + width, bottom: top + height };
}

function shifted(b: Box, offset: { x: number; y: number }): Box {
  return { left: b.left + offset.x, top: b.top + offset.y, right: b.right + offset.x, bottom: b.bottom + offset.y };
}

describe("findNudgeOffset", () => {
  it("does not move a group that overlaps nothing, touching edges included", () => {
    expect(findNudgeOffset([box(0, 0, 100, 100)], [[box(100, 0, 100, 100), box(0, 300, 50, 50)]])).toEqual({
      x: 0,
      y: 0,
    });
  });

  it("moves along the shorter way out and keeps the gap", () => {
    const moving = box(0, 0, 100, 100);
    const obstacle = box(90, 0, 100, 100);
    const offset = findNudgeOffset([moving], [[obstacle]], { gap: 20 });
    expect(offset).toEqual({ x: -30, y: 0 });
    expect(boxesOverlap(shifted(moving, offset!), obstacle)).toBe(false);
  });

  it("picks the nearest free spot when the first way out is blocked by another obstacle", () => {
    const moving = box(0, 0, 100, 100);
    // 向左挪 30 会撞上左边那张；向上挪 20 还压着右边那张；向下被长条挡住；最近的空位在上方 110
    const obstacles = [box(80, 0, 100, 100), box(-160, 0, 140, 100), box(0, 90, 100, 300)];
    const offset = findNudgeOffset([moving], [obstacles], { gap: 10 })!;
    for (const obstacle of obstacles) expect(boxesOverlap(shifted(moving, offset), obstacle)).toBe(false);
    expect(offset).toEqual({ x: 0, y: -110 });
  });

  it("moves a group as one piece and also keeps the other members clear", () => {
    const first = box(0, 0, 100, 100);
    const second = box(0, 150, 100, 100);
    const obstacles = [box(60, 0, 100, 100), box(-200, 150, 170, 100)];
    // 只有第一张压住了障碍；单看它向左挪 60 最近，但那样第二张会撞上左下的障碍
    const offset = findNudgeOffset([first, second], [obstacles, obstacles], { gap: 20 })!;
    expect(offset).not.toBeNull();
    for (const moved of [shifted(first, offset), shifted(second, offset)]) {
      for (const obstacle of obstacles) expect(boxesOverlap(moved, obstacle)).toBe(false);
    }
    expect(offset).not.toEqual({ x: -60, y: 0 });
    expect(offset).toEqual({ x: 0, y: 120 });
  });

  it("gives up after maxTries candidates", () => {
    expect(findNudgeOffset([box(0, 0, 100, 100)], [[box(50, 50, 100, 100)]], { maxTries: 1 })).toBeNull();
    expect(findNudgeOffset([box(0, 0, 100, 100)], [[box(50, 50, 100, 100)]], { maxTries: 2 })).not.toBeNull();
  });

  it("gives up when there is no free spot nearby", () => {
    const wall: Box[] = [];
    for (let x = -10; x <= 10; x++) for (let y = -10; y <= 10; y++) wall.push(box(x * 100, y * 100, 100, 100));
    expect(findNudgeOffset([box(0, 0, 100, 100)], [wall], { maxTries: 50 })).toBeNull();
  });
});

type FakeEntity = Entity & { moves: Vector[]; depthsSeen: number[] };
type FakeSection = FakeEntity & { children: FakeEntity[]; adjustLocationAndSize: ReturnType<typeof vi.fn> };

function fakeStage() {
  const entities: Entity[] = [];
  const project = { sectionMoveDepth: 0, stageManager: { getEntities: () => entities } } as unknown as Project;

  function entity(rectangle: Rectangle, extra: object = {}, prototype: object = {}): FakeEntity {
    const created = Object.assign(Object.create(prototype), {
      collisionBox: { getRectangle: () => rectangle },
      parentSection: null,
      isSelected: false,
      isHiddenBySectionCollapse: false,
      nearestLockedAncestorSection: null,
      moves: [] as Vector[],
      depthsSeen: [] as number[],
      move(delta: Vector) {
        created.moves.push(delta);
        created.depthsSeen.push(project.sectionMoveDepth);
        rectangle.location = rectangle.location.add(delta);
      },
      ...extra,
    }) as FakeEntity;
    entities.push(created);
    return created;
  }

  /** 和 Section.move 一样：带着没被选中的子实体一起走 */
  function section(rectangle: Rectangle, children: FakeEntity[]): FakeSection {
    const created = entity(rectangle, { children, adjustLocationAndSize: vi.fn() }, Section.prototype) as FakeSection;
    created.move = (delta: Vector) => {
      created.moves.push(delta);
      created.depthsSeen.push(project.sectionMoveDepth);
      rectangle.location = rectangle.location.add(delta);
      for (const child of children) if (!child.isSelected) child.move(delta);
    };
    for (const child of children) child.parentSection = created as unknown as Section;
    return created;
  }

  return { project, entity, section };
}

function rect(left: number, top: number, width: number, height: number) {
  return new Rectangle(new Vector(left, top), new Vector(width, height));
}

function collide(a: Entity, b: Entity): boolean {
  return a.collisionBox.getRectangle().isCollideWith(b.collisionBox.getRectangle());
}

describe("nudgeEntitiesOutOfOverlap", () => {
  it("moves only the given entity, without the push chain, and leaves the others alone", () => {
    const stage = fakeStage();
    const dragged = stage.entity(rect(0, 0, 100, 100));
    const other = stage.entity(rect(90, 0, 100, 100));
    nudgeEntitiesOutOfOverlap(stage.project, [dragged]);
    expect(other.moves).toEqual([]);
    expect(dragged.moves).toHaveLength(1);
    expect(dragged.depthsSeen).toEqual([1]);
    expect(stage.project.sectionMoveDepth).toBe(0);
    expect(collide(dragged, other)).toBe(false);
  });

  it("does nothing when nothing overlaps", () => {
    const stage = fakeStage();
    const dragged = stage.entity(rect(0, 0, 100, 100));
    stage.entity(rect(300, 0, 100, 100));
    nudgeEntitiesOutOfOverlap(stage.project, [dragged]);
    expect(dragged.moves).toEqual([]);
  });

  it("does not avoid its own section but avoids siblings, then refits the section", () => {
    const stage = fakeStage();
    const child = stage.entity(rect(0, 0, 100, 100));
    const sibling = stage.entity(rect(50, 0, 100, 100));
    const parent = stage.section(rect(-30, -80, 210, 210), [child, sibling]);
    nudgeEntitiesOutOfOverlap(stage.project, [child]);
    expect(parent.moves).toEqual([]);
    expect(sibling.moves).toEqual([]);
    expect(child.moves).toHaveLength(1);
    expect(collide(child, sibling)).toBe(false);
    expect(parent.adjustLocationAndSize).toHaveBeenCalled();

    const another = fakeStage();
    const lonely = another.entity(rect(0, 0, 50, 50));
    another.section(rect(-30, -80, 110, 160), [lonely]);
    nudgeEntitiesOutOfOverlap(another.project, [lonely]);
    expect(lonely.moves).toEqual([]);
  });

  it("moves a dragged section together with all its children, selected ones included, exactly once", () => {
    const stage = fakeStage();
    const selectedChild = stage.entity(rect(0, 0, 100, 100), { isSelected: true });
    const plainChild = stage.entity(rect(0, 120, 100, 100));
    const section = stage.section(rect(-30, -80, 160, 330), [selectedChild, plainChild]);
    section.isSelected = true;
    const other = stage.entity(rect(100, 0, 100, 100));
    nudgeEntitiesOutOfOverlap(stage.project, [section, selectedChild]);
    const offset = section.moves[0];
    expect(section.moves).toHaveLength(1);
    expect(selectedChild.moves).toEqual([offset]);
    expect(plainChild.moves).toEqual([offset]);
    expect(other.moves).toEqual([]);
    expect(collide(section, other)).toBe(false);
  });

  it("ignores pen strokes, background images and entities hidden in collapsed sections", () => {
    const stage = fakeStage();
    const dragged = stage.entity(rect(0, 0, 100, 100));
    stage.entity(rect(-500, -500, 1000, 1000), {}, PenStroke.prototype);
    stage.entity(rect(-500, -500, 1000, 1000), { isBackground: true }, ImageNode.prototype);
    stage.entity(rect(0, 0, 100, 100), { isHiddenBySectionCollapse: true });
    nudgeEntitiesOutOfOverlap(stage.project, [dragged]);
    expect(dragged.moves).toEqual([]);
    expect(findOverlappedEntities(stage.project, [dragged]).size).toBe(0);
  });

  it("does not move entities inside a locked section", () => {
    const stage = fakeStage();
    const dragged = stage.entity(rect(0, 0, 100, 100), { nearestLockedAncestorSection: {} as Section });
    stage.entity(rect(50, 0, 100, 100));
    nudgeEntitiesOutOfOverlap(stage.project, [dragged]);
    expect(dragged.moves).toEqual([]);
  });
});

describe("findOverlappedEntities", () => {
  it("lists what the dragged group currently covers", () => {
    const stage = fakeStage();
    const first = stage.entity(rect(0, 0, 100, 100));
    const second = stage.entity(rect(300, 0, 100, 100));
    const coveredByFirst = stage.entity(rect(90, 90, 50, 50));
    const coveredBySecond = stage.entity(rect(350, 50, 100, 100));
    stage.entity(rect(100, 0, 50, 50));
    expect(findOverlappedEntities(stage.project, [first, second])).toEqual(new Set([coveredByFirst, coveredBySecond]));
  });
});
