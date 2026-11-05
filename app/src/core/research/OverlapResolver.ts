import type { Project } from "@/core/Project";
import type { Entity } from "@/core/stage/stageObject/abstract/StageEntity";
import { ImageNode } from "@/core/stage/stageObject/entity/ImageNode";
import { PenStroke } from "@/core/stage/stageObject/entity/PenStroke";
import { Section } from "@/core/stage/stageObject/entity/Section";
import { Vector } from "@graphif/data-structures";
import { Rectangle } from "@graphif/shapes";

/** 世界坐标下的轴对齐矩形 */
export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface NudgeOptions {
  /** 挪开后与别的实体至少隔开的距离（世界坐标） */
  gap?: number;
  /** 最多试探多少个候选位置，还找不到空位就放弃，保持重叠。不传时按要比较的矩形对数在 20~300 之间取 */
  maxTries?: number;
}

export const NUDGE_GAP = 20;
export const NUDGE_MAX_TRIES = 300;
const NUDGE_CHECK_BUDGET = 5_000_000;

/** 边贴边不算重叠 */
export function boxesOverlap(a: Box, b: Box): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

function containsStrictly(box: Box, x: number, y: number): boolean {
  return box.left < x && x < box.right && box.top < y && y < box.bottom;
}

function lengthSquared(point: { x: number; y: number }): number {
  return point.x * point.x + point.y * point.y;
}

/**
 * 一组矩形整体平移多少，才能让 moving[i] 不和 obstacles[i] 里的任何矩形重叠。
 * 本来就不重叠时返回 (0, 0)；要挪时挪到与障碍至少隔开 gap 的位置；试探 maxTries 个候选还没找到空位时返回 null。
 *
 * moving[i] 平移 d 后与障碍 o 重叠，当且仅当 d 落在一个开矩形（禁区）里。从原点开始按离原点由近到远试探候选点：
 * 候选点落在哪些禁区里，就把它沿横轴或纵轴推到这些禁区的边上，作为新的候选点。
 */
export function findNudgeOffset(
  moving: readonly Box[],
  obstacles: readonly (readonly Box[])[],
  options: NudgeOptions = {},
): { x: number; y: number } | null {
  const gap = options.gap ?? NUDGE_GAP;
  const forbidden: Box[] = [];
  let overlapping = false;
  moving.forEach((box, index) => {
    for (const obstacle of obstacles[index] ?? []) {
      if (boxesOverlap(box, obstacle)) overlapping = true;
      forbidden.push({
        left: obstacle.left - box.right - gap,
        right: obstacle.right - box.left + gap,
        top: obstacle.top - box.bottom - gap,
        bottom: obstacle.bottom - box.top + gap,
      });
    }
  });
  if (!overlapping) return { x: 0, y: 0 };

  // 每试一个候选点都要扫一遍全部禁区；一次拖很多张、画布上又很多张时少试几个，免得松手时卡住
  const maxTries =
    options.maxTries ?? Math.max(20, Math.min(NUDGE_MAX_TRIES, Math.floor(NUDGE_CHECK_BUDGET / forbidden.length)));
  const seen = new Set<string>(["0,0"]);
  const queue = [{ x: 0, y: 0 }];
  for (let tries = 0; tries < maxTries && queue.length > 0; tries++) {
    let nearest = 0;
    for (let index = 1; index < queue.length; index++) {
      if (lengthSquared(queue[index]) < lengthSquared(queue[nearest])) nearest = index;
    }
    const point = queue[nearest];
    queue.splice(nearest, 1);
    const blockers = forbidden.filter((box) => containsStrictly(box, point.x, point.y));
    if (blockers.length === 0) return point;
    for (const box of blockers) {
      for (const candidate of [
        { x: box.left, y: point.y },
        { x: box.right, y: point.y },
        { x: point.x, y: box.top },
        { x: point.x, y: box.bottom },
      ]) {
        const key = `${candidate.x},${candidate.y}`;
        if (seen.has(key)) continue;
        seen.add(key);
        queue.push(candidate);
      }
    }
  }
  return null;
}

/** 祖先 Section 也在里面的实体会被祖先带着走，只留最外层的 */
function outermostEntities(entities: readonly Entity[]): Entity[] {
  const set = new Set(entities);
  return [...set].filter((entity) => {
    for (let parent = entity.parentSection; parent; parent = parent.parentSection) {
      if (set.has(parent)) return false;
    }
    return true;
  });
}

function collectSubtree(entity: Entity, into: Set<Entity>): void {
  if (into.has(entity)) return;
  into.add(entity);
  if (entity instanceof Section) {
    for (const child of entity.children) collectSubtree(child, into);
  }
}

/** 涂鸦常用来圈住一片卡片、背景图本来就垫在卡片底下、折叠框里的子实体看不见，它们都不算占地方 */
function occupiesSpace(entity: Entity): boolean {
  return (
    !(entity instanceof PenStroke) &&
    !(entity instanceof ImageNode && entity.isBackground) &&
    !entity.isHiddenBySectionCollapse
  );
}

function boxOf(entity: Entity): Box {
  const rectangle = entity.collisionBox.getRectangle();
  return { left: rectangle.left, top: rectangle.top, right: rectangle.right, bottom: rectangle.bottom };
}

interface Obstacle {
  entity: Entity;
  box: Box;
}

/**
 * 每个最外层实体要避开的是：不在这一组里（含这一组 Section 的子孙）、也不是它自己祖先框的所有占地方的实体。
 * 框里的卡片不避自己所在的框，但要避同框的其他卡片和框外的东西。
 */
function buildOverlapProblem(project: Project, entities: readonly Entity[]) {
  const roots = outermostEntities(entities);
  const group = new Set<Entity>();
  for (const root of roots) collectSubtree(root, group);
  const others: Obstacle[] = project.stageManager
    .getEntities()
    .filter((entity) => !group.has(entity) && occupiesSpace(entity))
    .map((entity) => ({ entity, box: boxOf(entity) }));
  const moving: Box[] = [];
  const obstacles: Obstacle[][] = [];
  for (const root of roots) {
    if (!occupiesSpace(root)) continue;
    const ancestors = new Set<Entity>();
    for (let parent = root.parentSection; parent; parent = parent.parentSection) ancestors.add(parent);
    moving.push(boxOf(root));
    obstacles.push(ancestors.size === 0 ? others : others.filter((other) => !ancestors.has(other.entity)));
  }
  return { roots, moving, obstacles };
}

/** 这一组实体此刻压住了哪些别的实体（只比外接矩形），拖动时用来描红提示 */
export function findOverlappedEntities(project: Project, entities: readonly Entity[]): Set<Entity> {
  const { moving, obstacles } = buildOverlapProblem(project, entities);
  const result = new Set<Entity>();
  moving.forEach((box, index) => {
    for (const other of obstacles[index]) {
      if (boxesOverlap(box, other.box)) result.add(other.entity);
    }
  });
  return result;
}

function selectedChildrenSkippedByMove(section: Section): Entity[] {
  return section.children.flatMap((child) =>
    child.isSelected ? [child] : child instanceof Section ? selectedChildrenSkippedByMove(child) : [],
  );
}

function translateSubtree(entity: Entity, delta: Vector): void {
  entity.move(delta);
  // Section.move 会跳过被选中的子实体（拖动时它们自己也在移动），这里要整棵子树一起走，把跳过的补上
  if (entity instanceof Section) {
    for (const child of selectedChildrenSkippedByMove(entity)) translateSubtree(child, delta);
  }
}

/** sectionMoveDepth > 0 时 move() 不推别的实体，也不连锁调整父框，父框最后统一调整 */
function translateRigidly(project: Project, roots: readonly Entity[], delta: Vector): void {
  project.sectionMoveDepth++;
  try {
    for (const root of roots) translateSubtree(root, delta);
  } finally {
    project.sectionMoveDepth--;
  }
  for (const root of roots) {
    for (let parent = root.parentSection; parent; parent = parent.parentSection) parent.adjustLocationAndSize();
  }
}

export function findAlignedPlacement(
  moving: readonly Box[],
  obstacles: readonly (readonly Box[])[],
  tolerance: number,
  align: boolean,
  grid: boolean,
): { x: number; y: number } | null {
  if (moving.length === 0) return { x: 0, y: 0 };
  const bounds = {
    left: Math.min(...moving.map((box) => box.left)),
    right: Math.max(...moving.map((box) => box.right)),
    top: Math.min(...moving.map((box) => box.top)),
    bottom: Math.max(...moving.map((box) => box.bottom)),
  };
  const xs = new Set<number>(),
    ys = new Set<number>();
  if (align)
    for (const other of obstacles.flat()) {
      for (const d of [
        other.left - bounds.left,
        other.right - bounds.right,
        (other.left + other.right - bounds.left - bounds.right) / 2,
      ])
        if (Math.abs(d) <= tolerance) xs.add(d);
      for (const d of [
        other.top - bounds.top,
        other.bottom - bounds.bottom,
        (other.top + other.bottom - bounds.top - bounds.bottom) / 2,
      ])
        if (Math.abs(d) <= tolerance) ys.add(d);
    }
  if (grid) {
    for (const x of [bounds.left, bounds.right]) xs.add(Math.round(x / 50) * 50 - x);
    for (const y of [bounds.top, bounds.bottom]) ys.add(Math.round(y / 50) * 50 - y);
  }
  const nearest = (values: Set<number>) => [...values].sort((a, b) => Math.abs(a) - Math.abs(b)).slice(0, 8);
  const xCandidates = nearest(xs),
    yCandidates = nearest(ys);
  const candidates = xCandidates.flatMap((x) => yCandidates.map((y) => ({ x, y, axes: 2 })));
  candidates.push(...xCandidates.map((x) => ({ x, y: 0, axes: 1 })), ...yCandidates.map((y) => ({ x: 0, y, axes: 1 })));
  candidates.sort((a, b) => b.axes - a.axes || lengthSquared(a) - lengthSquared(b));
  for (const candidate of candidates) {
    const clear = moving.every(
      (box, index) =>
        !(obstacles[index] ?? []).some((other) =>
          boxesOverlap(
            {
              left: box.left + candidate.x,
              right: box.right + candidate.x,
              top: box.top + candidate.y,
              bottom: box.bottom + candidate.y,
            },
            other,
          ),
        ),
    );
    if (clear) return { x: candidate.x, y: candidate.y };
  }
  return findNudgeOffset(moving, obstacles);
}

export function planDragPlacement(project: Project, entities: readonly Entity[], align: boolean, grid: boolean) {
  const { roots, moving, obstacles } = buildOverlapProblem(project, entities);
  const offset = findAlignedPlacement(
    moving,
    obstacles.map((items) => items.map((item) => item.box)),
    8 / Math.max(project.camera.currentScale, 0.01),
    align,
    grid,
  );
  const bounds = moving.length
    ? Rectangle.getBoundingRectangle(
        moving.map(
          (box) => new Rectangle(new Vector(box.left, box.top), new Vector(box.right - box.left, box.bottom - box.top)),
        ),
      )
    : null;
  if (bounds && offset) bounds.location = bounds.location.add(new Vector(offset.x, offset.y));
  const targets =
    align && bounds && offset
      ? [...new Set(obstacles.flat().map((item) => item.entity))]
          .filter((entity) => !entity.isAlignExcluded)
          .map((entity) => entity.collisionBox.getRectangle())
          .filter((rect) =>
            [
              rect.left - bounds.left,
              rect.right - bounds.right,
              rect.center.x - bounds.center.x,
              rect.top - bounds.top,
              rect.bottom - bounds.bottom,
              rect.center.y - bounds.center.y,
            ].some((difference) => Math.abs(difference) < 1e-7),
          )
      : [];
  return { roots, offset, alignment: bounds && targets.length ? { bounds, targets } : null };
}

export function applyDragPlacement(project: Project, plan: ReturnType<typeof planDragPlacement>) {
  if (plan.offset) translateRigidly(project, plan.roots, new Vector(plan.offset.x, plan.offset.y));
}

/**
 * 把传入的实体当作一个整体（保持相对位置，Section 连同子实体）平移最短的距离，让它们不再压住别的实体。
 * 只挪传入的实体，别的实体一概不动；连线不算；找不到空位就保持原样。不记录历史，由调用方记。
 */
export function nudgeEntitiesOutOfOverlap(project: Project, entities: Entity[], options?: NudgeOptions): void {
  const { roots, moving, obstacles } = buildOverlapProblem(project, entities);
  if (moving.length === 0) return;
  if (roots.some((root) => root.nearestLockedAncestorSection !== null)) return;
  const offset = findNudgeOffset(
    moving,
    obstacles.map((list) => list.map((other) => other.box)),
    options,
  );
  if (offset === null || (offset.x === 0 && offset.y === 0)) return;
  translateRigidly(project, roots, new Vector(offset.x, offset.y));
}
