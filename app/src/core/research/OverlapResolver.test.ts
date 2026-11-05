import { describe, expect, it, vi } from "vitest";

vi.mock("@/core/stage/stageObject/entity/Section", () => ({ Section: class Section {} }));
vi.mock("@/core/stage/stageObject/entity/PenStroke", () => ({ PenStroke: class PenStroke {} }));
vi.mock("@/core/stage/stageObject/entity/ImageNode", () => ({ ImageNode: class ImageNode {} }));

import type { Project } from "@/core/Project";
import type { Entity } from "@/core/stage/stageObject/abstract/StageEntity";
import { ImageNode } from "@/core/stage/stageObject/entity/ImageNode";
import { PenStroke } from "@/core/stage/stageObject/entity/PenStroke";
import { Section } from "@/core/stage/stageObject/entity/Section";
import { Color, Vector } from "@graphif/data-structures";
import { Rectangle } from "@graphif/shapes";
import { EntityAlignEffect } from "@/core/service/feedbackService/effectEngine/concrete/EntityAlignEffect";
import {
  applyDragPlacement,
  boxesOverlap,
  findAlignedPlacement,
  findNudgeOffset,
  findOverlappedEntities,
  nudgeEntitiesOutOfOverlap,
  planDragPlacement,
  type Box,
} from "./OverlapResolver";

function box(left: number, top: number, width: number, height: number): Box {
  return { left, top, right: left + width, bottom: top + height };
}

function shifted(b: Box, offset: { x: number; y: number }): Box {
  return { left: b.left + offset.x, top: b.top + offset.y, right: b.right + offset.x, bottom: b.bottom + offset.y };
}

describe("findNudgeOffset", () => {
  it("snaps only within the screen-scaled tolerance", () => {
    const moving = box(5, 200, 100, 100),
      target = box(0, 0, 100, 100);
    expect(findAlignedPlacement([moving], [[target]], 8, true, false)).toEqual({ x: -5, y: 0 });
    expect(findAlignedPlacement([moving], [[target]], 4, true, false)).toEqual({ x: 0, y: 0 });
  });
  it("chooses a collision-free drop while preserving a multi-selection's relative positions", () => {
    const moving = [box(5, 0, 100, 100), box(5, 150, 100, 100)];
    const obstacles = [box(0, 0, 100, 100), box(0, 400, 100, 100)];
    const offset = findAlignedPlacement(moving, [obstacles, obstacles], 8, true, true)!;
    for (const item of moving)
      for (const obstacle of obstacles) expect(boxesOverlap(shifted(item, offset), obstacle)).toBe(false);
  });
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
  const project = {
    sectionMoveDepth: 0,
    camera: { currentScale: 1 },
    stageManager: { getEntities: () => entities },
  } as unknown as Project;

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

describe("drag alignment guides", () => {
  it("renders guides at the same position used when the dragged card is released", () => {
    const stage = fakeStage();
    const moving = stage.entity(rect(5, 200, 100, 100));
    const target = stage.entity(rect(0, 0, 100, 100));
    const plan = planDragPlacement(stage.project, [moving], true, false);
    expect(plan.offset).toEqual({ x: -5, y: 0 });
    expect(plan.alignment?.targets).toEqual([target.collisionBox.getRectangle()]);
    const renderDashedLine = vi.fn();
    const renderer = { transformWorld2View: (point: Vector) => point };
    const previewProject = {
      camera: { currentScale: 1 },
      renderer,
      curveRenderer: { renderDashedLine },
      stageStyleManager: { currentStyle: { CollideBoxSelected: new Color(255, 0, 0) } },
    } as unknown as Project;
    EntityAlignEffect.fromEntity(plan.alignment!.bounds, plan.alignment!.targets[0]).render(previewProject);
    expect(renderDashedLine).toHaveBeenCalledTimes(3);
    expect(renderDashedLine.mock.calls[0].slice(0, 2)).toEqual([new Vector(0, 0), new Vector(0, 300)]);
    applyDragPlacement(stage.project, plan);
    expect(moving.collisionBox.getRectangle()).toEqual(plan.alignment!.bounds);
    expect(target.moves).toEqual([]);
  });

  it("does not show a snap guide or snap when automatic alignment is disabled", () => {
    const stage = fakeStage();
    const moving = stage.entity(rect(5, 200, 100, 100));
    stage.entity(rect(0, 0, 100, 100));
    const plan = planDragPlacement(stage.project, [moving], false, false);
    expect(plan.offset).toEqual({ x: 0, y: 0 });
    expect(plan.alignment).toBeNull();
  });

  it("keeps guides with fractional positions and observes screen-space snapping tolerance", () => {
    const stage = fakeStage();
    const moving = stage.entity(rect(5.1, 200, 100, 100));
    stage.entity(rect(0.1, 0, 100, 100));
    expect(planDragPlacement(stage.project, [moving], true, false).alignment?.targets).toHaveLength(1);
    stage.project.camera.currentScale = 2;
    expect(planDragPlacement(stage.project, [moving], true, false).alignment).toBeNull();
  });
});

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
