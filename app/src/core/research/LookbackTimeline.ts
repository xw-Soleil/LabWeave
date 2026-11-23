/*
 * 回看切节点的过渡：哪张卡片什么时候动。这里只算时间，画在 LookbackTransition.ts。
 *
 * 先让删掉的淡出，两边都有的同时滑到新位置，然后新加的从原有的卡片往外一张张长出来，
 * 连线等两头都长出来再从起点画到终点，最后浮出「新加 / 改过 / 删掉」的标记。没有的步骤不占时间。
 */

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 毫秒 */
export interface Span {
  start: number;
  end: number;
}

export interface TimelineBoard {
  /** frame 是分组框 */
  items: readonly { id: string; box: Box; frame: boolean }[];
  links: readonly { id: string; ends: readonly string[] }[];
}

export interface Timeline {
  removed: ReadonlySet<string>;
  /** 新加的：什么时候长出来 */
  added: ReadonlyMap<string, Span>;
  removedLinks: ReadonlySet<string>;
  addedLinks: ReadonlyMap<string, Span>;
  /** 删掉的淡出 */
  leave: Span;
  /** 两边都有的：滑到新位置、改过的淡变 */
  move: Span;
  /** 「新加 / 改过 / 删掉」的标记浮出来 */
  marks: Span;
  total: number;
}

const LEAVE = 180;
const MOVE = 400;
const GROW = 260;
const LINK = 220;
const MARKS = 160;
/** 一张张长出来：两张之间最多隔这么久，从第一张到最后一张最多隔这么久 */
const STEP = 40;
const STAGGER = 280;

export const progress = ({ start, end }: Span, time: number) =>
  end > start ? Math.min(1, Math.max(0, (time - start) / (end - start))) : time >= end ? 1 : 0;

export const easeOut = (t: number) => 1 - (1 - t) ** 3;
export const easeInOut = (t: number) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2);
/** 长到头时稍微过一点再收回来 */
export const easeOutBack = (t: number) => 1 + 2.2 * (t - 1) ** 3 + 1.2 * (t - 1) ** 2;

const moves = (a: Box, b: Box) => (["x", "y", "w", "h"] as const).some((side) => Math.abs(a[side] - b[side]) > 0.5);

/**
 * 从原有的卡片出发，顺着连线一圈圈往外；和原有的连不上的，从没有线指向它的那张（整棵都是新的时就是根）往外。
 * 分组框排最前，同一圈里从上到下、从左到右
 */
function growthOrder(after: TimelineBoard, added: ReadonlySet<string>): string[] {
  const neighbours = new Map<string, string[]>();
  const pointedAt = new Set<string>();
  for (const { ends } of after.links) {
    for (const end of ends) neighbours.set(end, [...(neighbours.get(end) ?? []), ...ends]);
    for (const end of ends.slice(1)) pointedAt.add(end);
  }
  const depth = new Map<string, number>();
  const spread = (from: readonly string[]) => {
    for (let ring = from, level = 1; ring.length > 0; level++) {
      const next = new Set(
        ring.flatMap((id) => neighbours.get(id) ?? []).filter((id) => added.has(id) && !depth.has(id)),
      );
      for (const id of next) depth.set(id, level);
      ring = [...next];
    }
  };
  spread(after.items.filter(({ id }) => !added.has(id)).map(({ id }) => id));
  const roots = after.items.map(({ id }) => id).filter((id) => added.has(id) && !depth.has(id) && !pointedAt.has(id));
  for (const id of roots) depth.set(id, 0);
  spread(roots);
  return after.items
    .filter(({ id }) => added.has(id))
    .map((item) => ({ ...item, ring: item.frame ? -1 : (depth.get(item.id) ?? 1) }))
    .sort((a, b) => a.ring - b.ring || a.box.y - b.box.y || a.box.x - b.box.x)
    .map(({ id }) => id);
}

export function planTimeline(before: TimelineBoard, after: TimelineBoard): Timeline {
  const old = new Map(before.items.map((item) => [item.id, item]));
  const now = new Map(after.items.map((item) => [item.id, item]));
  const removed = new Set(before.items.map(({ id }) => id).filter((id) => !now.has(id)));
  const added = new Set(after.items.map(({ id }) => id).filter((id) => !old.has(id)));
  // 换了一头的连线算一条删掉、一条新加
  const linkKey = ({ id, ends }: { id: string; ends: readonly string[] }) => [id, ...ends].join("\n");
  const oldLinks = new Set(before.links.map(linkKey));
  const nowLinks = new Set(after.links.map(linkKey));
  const removedLinks = new Set(before.links.filter((link) => !nowLinks.has(linkKey(link))).map(({ id }) => id));
  const newLinks = after.links.filter((link) => !oldLinks.has(linkKey(link)));

  const leaving = removed.size > 0 || removedLinks.size > 0;
  const moving = after.items.some((item) => old.has(item.id) && moves(old.get(item.id)!.box, item.box));
  const leave = { start: 0, end: leaving ? LEAVE : 0 };
  const moveStart = leaving ? LEAVE / 4 : 0;
  const move = { start: moveStart, end: moveStart + MOVE };
  // 不等滑完，快到位了就开始长
  const growStart = moving ? moveStart + MOVE * 0.6 : leaving ? LEAVE * 0.6 : 0;

  const order = growthOrder(after, added);
  const step = order.length > 1 ? Math.min(STEP, STAGGER / (order.length - 1)) : 0;
  const spans = new Map(
    order.map((id, index) => [id, { start: growStart + index * step, end: growStart + index * step + GROW }]),
  );
  const addedLinks = new Map(
    newLinks.map(({ id, ends }) => {
      const start = Math.max(
        growStart,
        ...ends.map((end) => (spans.has(end) ? spans.get(end)!.start + GROW * 0.7 : 0)),
      );
      return [id, { start, end: start + LINK }];
    }),
  );
  const settled = Math.max(leave.end, move.end, ...[...spans.values(), ...addedLinks.values()].map(({ end }) => end));
  const marks = { start: settled - MARKS / 2, end: settled + MARKS / 2 };
  return { removed, added: spans, removedLinks, addedLinks, leave, move, marks, total: marks.end };
}
