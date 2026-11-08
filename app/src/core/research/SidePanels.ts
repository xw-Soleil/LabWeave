import { setViewInsetsProvider, type ViewInsets } from "@/core/research/ViewInsets";
import { findTabGroupByTabId, FIXED_SIDE_GROUP_IDS, type FixedSideEdge } from "@/core/TabGroup";
import { activeTabAtom, store, tabGroupRootAtom } from "@/state";
import { atom, useAtomValue } from "jotai";

/**
 * 左右两个侧栏浮在画布上面。固定（pinned）时一直显示；没固定时平时收起，
 * 鼠标在触发区（竖栏按钮、窗口边缘）停一会儿临时弹出（peek），离开后收回。
 */
export interface SidePanelState {
  pinned: boolean;
  peek: boolean;
}
export type SidePanelStates = Record<FixedSideEdge, SidePanelState>;

/** 鼠标在触发区停多久才弹出、离开面板多久才收回（毫秒） */
export const SIDE_PEEK_DELAY = 300;
export const SIDE_HIDE_DELAY = 500;
const HOLD_RECHECK_DELAY = 250;
/** 面板和窗口边之间的空隙（像素）；镜头避让时目标也离面板这么远 */
export const SIDE_PANEL_GAP = 8;

const PINNED_STORAGE_KEY = {
  left: "pg-research-side-pinned-left",
  right: "pg-research-side-pinned-right",
} as const satisfies Record<FixedSideEdge, string>;

// 文件面板平时收起，用的时候弹出来；AI 对话一打开就一直在，聊着天不能自己缩回去
const DEFAULT_PINNED: Record<FixedSideEdge, boolean> = { left: false, right: true };

/** 鼠标停在这些元素上时，临时弹出的面板不收回：面板本身、触发区，以及从面板里弹出来的菜单和对话框 */
function holdSelector(edge: FixedSideEdge) {
  return [
    `[data-pg-side-panel="${edge}"]`,
    `[data-pg-side-trigger="${edge}"]`,
    "[data-radix-popper-content-wrapper]",
    '[role="menu"]',
    '[role="dialog"]',
    '[role="alertdialog"]',
    '[role="listbox"]',
  ].join(", ");
}

function readPinned(edge: FixedSideEdge): boolean {
  const stored = typeof localStorage === "undefined" ? null : localStorage.getItem(PINNED_STORAGE_KEY[edge]);
  return stored === null ? DEFAULT_PINNED[edge] : stored === "true";
}

function initialStates(): SidePanelStates {
  return { left: { pinned: readPinned("left"), peek: false }, right: { pinned: readPinned("right"), peek: false } };
}

const sidePanelStatesAtom = atom<SidePanelStates | null>(null);

export function getSidePanelStates(): SidePanelStates {
  return store.get(sidePanelStatesAtom) ?? initialStates();
}

export function useSidePanelStates(): SidePanelStates {
  return useAtomValue(sidePanelStatesAtom, { store }) ?? initialStates();
}

function update(edge: FixedSideEdge, patch: Partial<SidePanelState>) {
  const states = getSidePanelStates();
  const next = { ...states[edge], ...patch };
  if (next.pinned === states[edge].pinned && next.peek === states[edge].peek) return;
  store.set(sidePanelStatesAtom, { ...states, [edge]: next });
}

export function isSidePanelShown(state: SidePanelState) {
  return state.pinned || state.peek;
}

export function setSidePanelPinned(edge: FixedSideEdge, pinned: boolean) {
  cancelTimers(edge);
  update(edge, { pinned, peek: false });
  if (typeof localStorage !== "undefined") localStorage.setItem(PINNED_STORAGE_KEY[edge], String(pinned));
}

/**
 * 竖栏按钮、快捷键切换某个面板：没打开就打开（打开后会自动固定）；
 * 已经固定并且显示的正是它就收起；其余情况（收着、临时弹出、同一侧显示的是别的面板）固定下来并切到它。
 */
export function decidePanelToggle(input: { open: boolean; pinned: boolean; frontmost: boolean }) {
  if (!input.open) return "open" as const;
  if (input.pinned && input.frontmost) return "collapse" as const;
  return "pin" as const;
}

/**
 * 键盘焦点切到了某一侧的标签页，而那一侧正收着：说明是别处（快捷键、右键菜单）要用这个面板，固定下来让它显示。
 * 焦点没换（比如收起时焦点还留在面板里）或那一侧本来就看得见时不动。
 */
export function edgeToRevealOnActivate(
  previousTabId: string | undefined,
  next: { tabId: string; edge: FixedSideEdge } | null,
  states: SidePanelStates,
): FixedSideEdge | null {
  if (!next || next.tabId === previousTabId) return null;
  return isSidePanelShown(states[next.edge]) ? null : next.edge;
}

export function sideEdgeOfGroup(groupId: string | undefined): FixedSideEdge | undefined {
  if (groupId === FIXED_SIDE_GROUP_IDS.left) return "left";
  if (groupId === FIXED_SIDE_GROUP_IDS.right) return "right";
  return undefined;
}

function activeSideTab(): { tabId: string; edge: FixedSideEdge } | null {
  const active = store.get(activeTabAtom);
  if (!active || active.closing || active.layout !== "docked") return null;
  const edge = sideEdgeOfGroup(findTabGroupByTabId(store.get(tabGroupRootAtom), active.id)?.id);
  return edge ? { tabId: active.id, edge } : null;
}

let lastActiveSideTabId: string | undefined;
let autoPinSuppressed = 0;

function revealOnActivate() {
  const next = activeSideTab();
  const edge = autoPinSuppressed > 0 ? null : edgeToRevealOnActivate(lastActiveSideTabId, next, getSidePanelStates());
  lastActiveSideTabId = next?.tabId;
  if (edge) setSidePanelPinned(edge, true);
}

/** 启动时恢复面板：按上次固定没固定显示，打开面板时不自动固定 */
export async function withoutAutoPin<T>(task: () => Promise<T>): Promise<T> {
  autoPinSuppressed++;
  try {
    return await task();
  } finally {
    autoPinSuppressed--;
    lastActiveSideTabId = activeSideTab()?.tabId;
  }
}

// ---- 临时弹出 ----

const showTimers: Partial<Record<FixedSideEdge, number>> = {};
const hideTimers: Partial<Record<FixedSideEdge, number>> = {};
let pointer: { x: number; y: number } | null = null;

function trackPointer(event: PointerEvent) {
  pointer = { x: event.clientX, y: event.clientY };
}

function cancelTimers(edge: FixedSideEdge) {
  window.clearTimeout(showTimers[edge]);
  window.clearTimeout(hideTimers[edge]);
  showTimers[edge] = undefined;
  hideTimers[edge] = undefined;
}

/**
 * 鼠标进入触发区。停够 SIDE_PEEK_DELAY 才弹出，划过去不算。
 * beforeShow 在弹出状态设好之后执行（比如先打开文件面板），这样打开面板抢到焦点也不会被当成要固定。
 */
export function enterSidePeekTrigger(edge: FixedSideEdge, beforeShow?: () => void) {
  window.clearTimeout(hideTimers[edge]);
  hideTimers[edge] = undefined;
  const state = getSidePanelStates()[edge];
  if (isSidePanelShown(state) || showTimers[edge] !== undefined) return;
  showTimers[edge] = window.setTimeout(() => {
    showTimers[edge] = undefined;
    if (isSidePanelShown(getSidePanelStates()[edge])) return;
    update(edge, { peek: true });
    beforeShow?.();
  }, SIDE_PEEK_DELAY);
}

/** 鼠标离开触发区或面板：还没弹出就不弹了；已经弹出就过一会儿收回 */
export function leaveSidePeekArea(edge: FixedSideEdge) {
  window.clearTimeout(showTimers[edge]);
  showTimers[edge] = undefined;
  if (getSidePanelStates()[edge].peek) scheduleHide(edge, SIDE_HIDE_DELAY);
}

/** 鼠标回到弹出的面板上，取消收回 */
export function enterSidePanel(edge: FixedSideEdge) {
  window.clearTimeout(hideTimers[edge]);
  hideTimers[edge] = undefined;
}

function scheduleHide(edge: FixedSideEdge, delay: number) {
  window.clearTimeout(hideTimers[edge]);
  hideTimers[edge] = window.setTimeout(() => {
    hideTimers[edge] = undefined;
    if (!getSidePanelStates()[edge].peek) return;
    if (isPeekHeld(edge)) {
      scheduleHide(edge, HOLD_RECHECK_DELAY);
      return;
    }
    update(edge, { peek: false });
  }, delay);
}

/** 正在面板里打字，或者鼠标停在面板、触发区、面板弹出的菜单上时，不收回 */
function isPeekHeld(edge: FixedSideEdge): boolean {
  const panel = document.querySelector(`[data-pg-side-panel="${edge}"]`);
  const focused = document.activeElement;
  if (panel && focused && panel.contains(focused) && focused.matches("input, textarea, [contenteditable='true']")) {
    return true;
  }
  if (!pointer) return false;
  return !!document.elementFromPoint(pointer.x, pointer.y)?.closest(holdSelector(edge));
}

/** 从临时弹出的面板里往画布上拖东西：一开始拖就收起，不挡住落点（面板不卸载，拖动照常进行） */
export function hidePeekForDrag(edge: FixedSideEdge) {
  if (!getSidePanelStates()[edge].peek) return;
  cancelTimers(edge);
  update(edge, { peek: false });
}

// ---- 镜头避让 ----

/** 浮动面板挡住了这个画布左右各多少（视图像素），按屏幕上的实际位置算 */
export function occludedInsets(
  canvas: DOMRect,
  panels: { edge: FixedSideEdge; rect: DOMRect }[],
  gap = SIDE_PANEL_GAP,
): ViewInsets {
  let left = 0;
  let right = 0;
  for (const { edge, rect } of panels) {
    if (rect.width === 0 || rect.bottom <= canvas.top || rect.top >= canvas.bottom) continue;
    if (rect.right <= canvas.left || rect.left >= canvas.right) continue;
    if (edge === "left") left = Math.max(left, rect.right + gap - canvas.left);
    else right = Math.max(right, canvas.right - rect.left + gap);
  }
  return { left, right };
}

function visiblePanels(): { edge: FixedSideEdge; rect: DOMRect }[] {
  return Array.from(document.querySelectorAll<HTMLElement>("[data-pg-side-panel][data-pg-side-shown='true']")).flatMap(
    (element) => {
      const edge = element.dataset.pgSidePanel;
      return edge === "left" || edge === "right"
        ? [{ edge: edge as FixedSideEdge, rect: element.getBoundingClientRect() }]
        : [];
    },
  );
}

/** 启动后由 App 调用：开始跟踪焦点和鼠标，并把镜头避让接到 Camera 上。返回取消函数 */
export function registerSidePanels() {
  lastActiveSideTabId = activeSideTab()?.tabId;
  const stops = [store.sub(activeTabAtom, revealOnActivate), store.sub(tabGroupRootAtom, revealOnActivate)];
  window.addEventListener("pointermove", trackPointer, true);
  setViewInsetsProvider((project) => {
    const element = project.canvas?.element;
    if (!element?.isConnected || element.clientWidth === 0) return { left: 0, right: 0 };
    const rect = element.getBoundingClientRect();
    const insets = occludedInsets(rect, visiblePanels());
    // 屏幕像素换成画布的视图像素
    const scale = rect.width / element.clientWidth || 1;
    return { left: insets.left / scale, right: insets.right / scale };
  });
  return () => {
    stops.forEach((stop) => stop());
    window.removeEventListener("pointermove", trackPointer, true);
    setViewInsetsProvider(null);
    for (const edge of ["left", "right"] as const) cancelTimers(edge);
  };
}
