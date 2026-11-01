export type TabSplitDirection = "horizontal" | "vertical";
export type TabDropEdge = "left" | "right" | "top" | "bottom";

/** Stable group ids for default left/right docked panels. Empty groups still collapse; ids are recreated on next open. */
export const FIXED_SIDE_GROUP_IDS = {
  left: "pg-side-left",
  right: "pg-side-right",
} as const;

export type FixedSideEdge = keyof typeof FIXED_SIDE_GROUP_IDS;

export function isFixedSideGroupId(id: string): boolean {
  return id === FIXED_SIDE_GROUP_IDS.left || id === FIXED_SIDE_GROUP_IDS.right;
}

export interface TabGroup {
  id: string;
  type: "group";
  tabIds: string[];
  activeTabId?: string;
}

export interface TabSplit {
  id: string;
  type: "split";
  direction: TabSplitDirection;
  children: [TabGroupNode, TabGroupNode];
  sizes: [number, number];
}

export type TabGroupNode = TabGroup | TabSplit;

export function createTabGroup(tabIds: string[] = [], id: string = crypto.randomUUID()): TabGroup {
  return { id, type: "group", tabIds, activeTabId: tabIds.at(-1) };
}

export function getTabGroups(root: TabGroupNode | null): TabGroup[] {
  if (!root) return [];
  if (root.type === "group") return [root];
  return [...getTabGroups(root.children[0]), ...getTabGroups(root.children[1])];
}

export function findTabGroup(root: TabGroupNode | null, groupId: string): TabGroup | undefined {
  return getTabGroups(root).find((group) => group.id === groupId);
}

export function findTabGroupByTabId(root: TabGroupNode | null, tabId: string): TabGroup | undefined {
  return getTabGroups(root).find((group) => group.tabIds.includes(tabId));
}

export function updateTabGroup(
  root: TabGroupNode | null,
  groupId: string,
  update: (group: TabGroup) => TabGroup,
): TabGroupNode | null {
  if (!root) return null;
  if (root.type === "group") return root.id === groupId ? update(root) : root;
  const first = updateTabGroup(root.children[0], groupId, update);
  const second = updateTabGroup(root.children[1], groupId, update);
  if (!first || !second) return first ?? second;
  if (first === root.children[0] && second === root.children[1]) return root;
  return { ...root, children: [first, second] };
}

export function insertTabIntoGroup(
  root: TabGroupNode | null,
  groupId: string,
  tabId: string,
  index?: number,
): TabGroupNode | null {
  return updateTabGroup(root, groupId, (group) => {
    const tabIds = group.tabIds.filter((candidate) => candidate !== tabId);
    tabIds.splice(Math.max(0, Math.min(index ?? tabIds.length, tabIds.length)), 0, tabId);
    return { ...group, tabIds, activeTabId: tabId };
  });
}

export interface RemoveTabResult {
  root: TabGroupNode | null;
  sourceGroupId?: string;
  nextActiveTabId?: string;
}

export function removeTabFromGroups(root: TabGroupNode | null, tabId: string): RemoveTabResult {
  const source = findTabGroupByTabId(root, tabId);
  if (!source) return { root };
  const removedIndex = source.tabIds.indexOf(tabId);
  const remaining = source.tabIds.filter((candidate) => candidate !== tabId);
  const nextActiveTabId =
    source.activeTabId === tabId
      ? remaining[Math.min(removedIndex, remaining.length - 1)]
      : source.activeTabId && remaining.includes(source.activeTabId)
        ? source.activeTabId
        : remaining.at(-1);

  const remove = (node: TabGroupNode): TabGroupNode | null => {
    if (node.type === "group") {
      if (node.id !== source.id) return node;
      return remaining.length > 0 ? { ...node, tabIds: remaining, activeTabId: nextActiveTabId } : null;
    }
    const first = remove(node.children[0]);
    const second = remove(node.children[1]);
    if (!first) return second;
    if (!second) return first;
    if (first === node.children[0] && second === node.children[1]) return node;
    return { ...node, children: [first, second] };
  };

  return { root: root ? remove(root) : null, sourceGroupId: source.id, nextActiveTabId };
}

/** Default share for a newly split side panel (left/right). Vertical splits stay half. */
export const DEFAULT_SIDE_SPLIT_RATIO = 20;

/**
 * 科研模式下固定侧栏按像素定宽（不随窗口按比例伸缩），这里是默认、最小、最大宽度。
 * AI 对话要显示整段回答，默认比文件面板宽一些。
 */
export const SIDE_PANEL_WIDTH = {
  min: 220,
  max: 480,
  default: { left: 240, right: 320 },
} as const;

/** 侧栏宽度限制在 [min, max] 之内，并且不超过所在分栏的一半，给编辑区留出地方 */
export function clampSidePanelWidth(width: number, containerWidth = Infinity): number {
  const max = Math.max(SIDE_PANEL_WIDTH.min, Math.min(SIDE_PANEL_WIDTH.max, containerWidth / 2));
  return Math.round(Math.min(max, Math.max(SIDE_PANEL_WIDTH.min, width)));
}

/** 读取存下来的侧栏宽度；没存过或存的不是数字时用默认值 */
export function parseSidePanelWidth(stored: string | null, edge: FixedSideEdge): number {
  const width = stored === null || stored.trim() === "" ? NaN : Number(stored);
  return Number.isFinite(width) ? clampSidePanelWidth(width) : SIDE_PANEL_WIDTH.default[edge];
}

/** 左右分栏里直接挂着的固定侧栏：返回它在 children 里的位置和是哪一侧；没有时返回 undefined */
export function findFixedSideChild(split: TabSplit): { index: 0 | 1; edge: FixedSideEdge } | undefined {
  if (split.direction !== "horizontal") return undefined;
  for (const index of [0, 1] as const) {
    const child = split.children[index];
    if (child.type !== "group") continue;
    if (child.id === FIXED_SIDE_GROUP_IDS.left) return { index, edge: "left" };
    if (child.id === FIXED_SIDE_GROUP_IDS.right) return { index, edge: "right" };
  }
  return undefined;
}

export function splitTabGroup(
  root: TabGroupNode | null,
  targetGroupId: string,
  newGroup: TabGroup,
  edge: TabDropEdge,
  splitId: string = crypto.randomUUID(),
  sizes?: [number, number],
): TabGroupNode | null {
  if (!root) return newGroup;
  const direction: TabSplitDirection = edge === "left" || edge === "right" ? "horizontal" : "vertical";
  const newGroupFirst = edge === "left" || edge === "top";
  const resolvedSizes: [number, number] =
    sizes ??
    (direction === "horizontal"
      ? newGroupFirst
        ? [DEFAULT_SIDE_SPLIT_RATIO, 100 - DEFAULT_SIDE_SPLIT_RATIO]
        : [100 - DEFAULT_SIDE_SPLIT_RATIO, DEFAULT_SIDE_SPLIT_RATIO]
      : [50, 50]);
  const replace = (node: TabGroupNode): TabGroupNode => {
    if (node.type === "group") {
      if (node.id !== targetGroupId) return node;
      return {
        id: splitId,
        type: "split",
        direction,
        children: newGroupFirst ? [newGroup, node] : [node, newGroup],
        sizes: resolvedSizes,
      };
    }
    const first = replace(node.children[0]);
    const second = replace(node.children[1]);
    if (first === node.children[0] && second === node.children[1]) return node;
    return { ...node, children: [first, second] };
  };
  return replace(root);
}

export function updateTabSplitSizes(
  root: TabGroupNode | null,
  splitId: string,
  sizes: [number, number],
): TabGroupNode | null {
  if (!root || root.type === "group") return root;
  if (root.id === splitId) return { ...root, sizes };
  const first = updateTabSplitSizes(root.children[0], splitId, sizes);
  const second = updateTabSplitSizes(root.children[1], splitId, sizes);
  if (!first || !second || (first === root.children[0] && second === root.children[1])) return root;
  return { ...root, children: [first, second] };
}
