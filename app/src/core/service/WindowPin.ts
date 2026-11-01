import { isWindowAlwaysOnTopAtom, store } from "@/state";
import { getCurrentWindow } from "@tauri-apps/api/window";

/** 科研模式「视图 → 窗口置顶」对应的快捷键 id，菜单按它显示勾选状态 */
export const WINDOW_PIN_KEYBIND_ID = "researchToggleAlwaysOnTop";

/**
 * 切换窗口置顶。原版标题栏的置顶按钮、科研模式的快捷键和菜单共用。
 * 系统调用成功后才改状态，失败时按钮和菜单的勾选不会和窗口实际情况对不上。
 */
export async function toggleWindowAlwaysOnTop() {
  const next = !store.get(isWindowAlwaysOnTopAtom);
  await getCurrentWindow().setAlwaysOnTop(next);
  store.set(isWindowAlwaysOnTopAtom, next);
}
