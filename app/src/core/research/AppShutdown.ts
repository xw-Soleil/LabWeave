import { Dialog } from "@/components/ui/dialog";
import { Project, ProjectState } from "@/core/Project";
import { flushSettings, Settings } from "@/core/service/Settings";
import { TabWorkspace } from "@/core/TabWorkspace";
import { store, tabsAtom } from "@/state";
import i18next from "i18next";
import { toast } from "sonner";
import { flushActivityLog } from "./ActivityLog";
import { flushNodeRecordWrites } from "./NodeRecord";
import {
  beginResearchSessionChange,
  endResearchSessionChange,
  persistResearchSession,
  setResearchSessionTracking,
} from "./ResearchSession";
import { flushResearchWorkspace } from "./ResearchWorkspace";
import { finishPendingSnapshots } from "./Snapshot";

export interface CloseResearchAppOptions {
  saveWindowState: () => Promise<void>;
  hideWindow: () => Promise<void>;
  destroyWindow: () => Promise<void>;
  workspaceName: (project: Project) => string;
  onAutoSaveError: (project: Project, error: unknown) => void;
  onSaveError: (error: unknown) => void;
  onCloseCancelled?: () => void;
  onCloseConfirmed?: () => void;
}

let appClosing = false;

export function resetAppShutdownForTest(): void {
  appClosing = false;
}

function liveProjects(): Project[] {
  return store.get(tabsAtom).filter((tab): tab is Project => tab instanceof Project && !tab.closing);
}

async function waitForProjectAutoSaves(): Promise<void> {
  await Promise.all(liveProjects().map((project) => project.getService("autoSaveBackup")?.waitForIdle()));
}

/**
 * 关闭整个应用：
 * 1. 窗口还显示着的时候，先把该自动保存的白板存完，再把所有未保存的白板、草稿、笔记和 PDF 批注逐个问清楚；
 *    中间点取消或保存失败就立刻停下，窗口留着、一个标签都不关。
 * 2. 都确认完以后，趁标签还没关先把当前开着的工作区和窗口位置记下来，然后立刻藏起窗口。
 * 3. 在看不见的地方把正在写的快照、便签、活动记录、设置全部落盘，一次性并行销毁所有标签页（释放工作区锁进程），最后销毁窗口退出。
 */
export async function requestCloseResearchApp(options: CloseResearchAppOptions): Promise<boolean> {
  if (appClosing) return false;
  if (!beginResearchSessionChange()) {
    toast.error(i18next.t("projectTree.switchBusy", { ns: "research" }));
    return false;
  }

  try {
    await waitForProjectAutoSaves();

    if (Settings.autoSaveWhenClose || Settings.autoSave) {
      for (const project of liveProjects()) {
        if (project.uri.scheme !== "file" || project.projectState !== ProjectState.Unsaved) continue;
        try {
          await project.save();
        } catch (error) {
          options.onAutoSaveError(project, error);
        }
      }
    }

    const unsavedProjects = liveProjects().filter(
      (project) => project.projectState === ProjectState.Unsaved || project.projectState === ProjectState.Stashed,
    );
    if (unsavedProjects.length > 0) {
      const response = await Dialog.buttons(
        "检测到未保存文件",
        `当前有 ${unsavedProjects.length} 个未保存的文件。直接关闭可能有文件被清空的风险，建议先手动保存文件。`,
        [
          { id: "cancel", label: "取消", variant: "ghost" },
          { id: "continue", label: "继续关闭", variant: "destructive" },
        ],
      );
      if (response !== "continue") return false;

      for (const project of unsavedProjects) {
        if (project.closing) continue;
        if (project.projectState === ProjectState.Stashed) {
          toast("文件还没有保存，但已经暂存，在“最近打开的文件”中可恢复文件");
          continue;
        }
        if (project.projectState !== ProjectState.Unsaved) continue;
        TabWorkspace.focus(project.id);
        const answer = await Dialog.buttons("是否保存更改？", options.workspaceName(project), [
          { id: "cancel", label: "取消", variant: "ghost" },
          { id: "discard", label: "不保存", variant: "destructive" },
          { id: "save", label: "保存" },
        ]);
        if (answer === "save") {
          try {
            await project.save();
          } catch (error) {
            options.onCloseCancelled?.();
            options.onSaveError(error);
            return false;
          }
          if ((project.projectState as ProjectState) !== ProjectState.Saved) {
            options.onCloseCancelled?.();
            return false;
          }
        } else if (answer !== "discard") {
          options.onCloseCancelled?.();
          return false;
        }
      }
    }

    for (const tab of store.get(tabsAtom)) {
      if (tab.closing || !tab.beforeClose) continue;
      if (!(await tab.beforeClose())) {
        options.onCloseCancelled?.();
        return false;
      }
    }

    appClosing = true;
    persistResearchSession();
    setResearchSessionTracking(false);
    await options.saveWindowState();
    await options.hideWindow();
    options.onCloseConfirmed?.();

    await waitForProjectAutoSaves();
    await finishPendingSnapshots();
    await flushNodeRecordWrites();
    await flushActivityLog();
    await Promise.all([flushResearchWorkspace(), flushSettings()]);

    try {
      await TabWorkspace.disposeAllForShutdown();
    } catch (error) {
      console.error("[shutdown] Tab cleanup failed", error);
    }
    await flushActivityLog();
    await options.destroyWindow();
    return true;
  } finally {
    endResearchSessionChange();
  }
}
