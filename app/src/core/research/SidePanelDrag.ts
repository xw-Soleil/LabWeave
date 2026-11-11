import { sideEdgeOfGroup } from "@/core/research/SidePanels";
import { findTabGroupByTabId, type FixedSideEdge } from "@/core/TabGroup";
import { TabWorkspace } from "@/core/TabWorkspace";
import { store, tabGroupRootAtom } from "@/state";
import { atom } from "jotai";

/** 正拖着侧栏面板、松手会放进哪一边；DockedArea 按它在那一边画一块高亮 */
export const sideDropPreviewAtom = atom<FixedSideEdge | null>(null);

/** 窗口左右边缘这么宽的一条也算「放到这一边」，那一边侧栏收着、看不见时也能拖过去 */
const EDGE_ZONE = 72;

/** 松手的地方落在哪一边：在某个侧栏上，或者贴着窗口左右边缘 */
export function sideDropEdge(x: number, y: number): FixedSideEdge | null {
  const panel = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-pg-side-panel]");
  const edge = panel?.dataset.pgSidePanel;
  if (edge === "left" || edge === "right") return edge;
  if (x < EDGE_ZONE) return "left";
  if (x > window.innerWidth - EDGE_ZONE) return "right";
  return null;
}

export function sideOfTab(tabId: string): FixedSideEdge | undefined {
  return sideEdgeOfGroup(findTabGroupByTabId(store.get(tabGroupRootAtom), tabId)?.id);
}

/** 拖动过程中更新高亮；返回松手时该放进哪一边（和面板现在所在的一边相同时不算） */
export function previewSideDrop(tabId: string, x: number, y: number): FixedSideEdge | null {
  const edge = sideDropEdge(x, y);
  const target = edge && edge !== sideOfTab(tabId) ? edge : null;
  if (store.get(sideDropPreviewAtom) !== target) store.set(sideDropPreviewAtom, target);
  return target;
}

export function finishSideDrop(tabId: string, x: number, y: number): boolean {
  const target = previewSideDrop(tabId, x, y);
  store.set(sideDropPreviewAtom, null);
  return !!target && TabWorkspace.dockToSide(tabId, target);
}

/** 按住面板标题拖到另一边：松手在对面的侧栏上或窗口另一侧边缘就挪过去 */
export function dragSidePanel(tabId: string, start: { clientX: number; clientY: number }) {
  let dragging = false;
  const move = (event: MouseEvent) => {
    if (!dragging && Math.hypot(event.clientX - start.clientX, event.clientY - start.clientY) < 6) return;
    dragging = true;
    document.body.style.cursor = "grabbing";
    previewSideDrop(tabId, event.clientX, event.clientY);
  };
  const up = (event: MouseEvent) => {
    window.removeEventListener("mousemove", move);
    window.removeEventListener("mouseup", up);
    document.body.style.cursor = "";
    if (dragging) finishSideDrop(tabId, event.clientX, event.clientY);
    else store.set(sideDropPreviewAtom, null);
  };
  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", up);
}
