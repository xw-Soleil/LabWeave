import type { Tab } from "@/core/Tab";
import { TabWorkspace } from "@/core/TabWorkspace";
import { store, tabsAtom } from "@/state";
import { isTabVisibleInWorkspace } from "./ResearchSession";

// 大纲面板本身（解析、编辑器那一套）用到才加载，竖栏只需要认得它、开关它
export const noteOutlineTabIds = new Set<string>();

export function findNoteOutlineTab(tabs: Tab[] = store.get(tabsAtom)) {
  return tabs.find((tab) => !tab.closing && noteOutlineTabIds.has(tab.id));
}

/** 竖栏「大纲」按钮：没开就打开（放在上次放的那一边，默认右边），显示着就关掉，被同一侧别的面板挡着就切过来 */
export async function toggleNoteOutline() {
  const existing = findNoteOutlineTab();
  if (!existing) {
    (await import("./NoteOutline")).openNoteOutline();
    return;
  }
  if (isTabVisibleInWorkspace(existing.id)) {
    noteOutlineTabIds.delete(existing.id);
    await TabWorkspace.close(existing.id);
  } else TabWorkspace.focus(existing.id);
}
