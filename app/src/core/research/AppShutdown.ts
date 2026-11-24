import { Dialog } from "@/components/ui/dialog";
import { displayWorkspaceName } from "@/components/ui/file-name";
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
  showWindow: () => Promise<void>;
  destroyWindow: () => Promise<void>;
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

function t(key: string, options?: Record<string, unknown>): string {
  return i18next.t(key, { ns: "research", ...options });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 给人看的工作区名，和标签栏一致：文件名去掉 .prg，草稿叫「未命名 1」 */
export function researchWorkspaceName(project: Project): string {
  if (project.tabName) return project.tabName;
  if (project.isDraft) return t("tabs.untitled", { n: project.uri.path });
  if (project.uri.scheme === "file") return displayWorkspaceName(project.title);
  return project.title;
}

/**
 * 关一块白板前问要不要保存（关标签、关程序共用这一个对话框）。
 * 返回 false：用户点了取消，或者存完了还是没存上。保存出错照样往外抛，由调用的地方提示。
 */
export async function confirmSaveBeforeClose(project: Project): Promise<boolean> {
  if (project.projectState === ProjectState.Stashed) {
    toast(t("shell.closePrompt.stashed"));
    return true;
  }
  if (project.projectState !== ProjectState.Unsaved) return true;
  TabWorkspace.focus(project.id);
  const answer = await Dialog.buttons(t("shell.closePrompt.saveTitle"), researchWorkspaceName(project), [
    { id: "cancel", label: t("shell.closePrompt.cancel"), variant: "ghost" },
    { id: "discard", label: t("shell.closePrompt.discard"), variant: "destructive" },
    { id: "save", label: t("shell.closePrompt.save") },
  ]);
  if (answer === "discard") return true;
  if (answer !== "save") return false;
  await project.save();
  return (project.projectState as ProjectState) === ProjectState.Saved;
}

/** 退出前把还在写的东西都等完；某一步失败不影响后面几步照样写，失败的原因攒起来一起交给用户 */
async function flushBeforeExit(): Promise<unknown[]> {
  const failures: unknown[] = [];
  for (const step of [
    waitForProjectAutoSaves,
    finishPendingSnapshots,
    flushNodeRecordWrites,
    flushActivityLog,
    flushResearchWorkspace,
    flushSettings,
  ]) {
    try {
      await step();
    } catch (error) {
      failures.push(error);
    }
  }
  return failures;
}

/**
 * 关闭整个应用：
 * 1. 窗口还显示着的时候，先把该自动保存的白板存完，再把所有未保存的白板、草稿、笔记和 PDF 批注逐个问清楚；
 *    中间点取消或保存失败就立刻停下，窗口留着、一个标签都不关。
 * 2. 都确认完以后，趁标签还没关先把当前开着的工作区和窗口位置记下来，然后立刻藏起窗口。
 * 3. 在看不见的地方把正在写的快照、便签、活动记录、设置全部落盘，一次性并行销毁所有标签页（释放工作区锁进程），最后销毁窗口退出。
 *    落盘有哪一步失败，就把窗口重新亮出来让用户选「返回」还是「仍然退出」，不会留下一个看不见、退不掉的进程。
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
        t("shell.closePrompt.unsavedTitle"),
        t("shell.closePrompt.unsavedDescription", { count: unsavedProjects.length }),
        [
          { id: "cancel", label: t("shell.closePrompt.cancel"), variant: "ghost" },
          { id: "continue", label: t("shell.closePrompt.continue"), variant: "destructive" },
        ],
      );
      if (response !== "continue") return false;

      for (const project of unsavedProjects) {
        if (project.closing) continue;
        let confirmed: boolean;
        try {
          confirmed = await confirmSaveBeforeClose(project);
        } catch (error) {
          options.onCloseCancelled?.();
          options.onSaveError(error);
          return false;
        }
        if (!confirmed) {
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
    // 记窗口位置、藏窗口失败都不该拦住退出：顶多下次窗口位置没记住，或者收尾时窗口多露一会儿
    await options.saveWindowState().catch((error) => console.warn("[shutdown] Saving window state failed", error));
    const hidden = await options.hideWindow().then(
      () => true,
      (error) => {
        console.warn("[shutdown] Hiding window failed", error);
        return false;
      },
    );
    options.onCloseConfirmed?.();

    const failures = await flushBeforeExit();
    if (failures.length > 0) {
      // 窗口亮不出来就没法问，只能照样退出，免得卡在一个看不见的对话框上
      const visible = hidden
        ? await options.showWindow().then(
            () => true,
            () => false,
          )
        : true;
      const answer = visible
        ? await Dialog.buttons(
            t("shell.closePrompt.flushFailedTitle"),
            t("shell.closePrompt.flushFailed", { message: failures.map(errorText).join(" / ") }),
            [
              { id: "back", label: t("shell.closePrompt.back"), variant: "ghost" },
              { id: "quit", label: t("shell.closePrompt.quitAnyway"), variant: "destructive" },
            ],
          )
        : "quit";
      if (answer !== "quit") {
        appClosing = false;
        setResearchSessionTracking(true);
        return false;
      }
    }

    try {
      await TabWorkspace.disposeAllForShutdown();
      await flushActivityLog();
    } catch (error) {
      // 要写的都在上面写完了，这里只剩释放标签和补记「关了哪几块白板」，失败也要接着退出
      console.error("[shutdown] Tab cleanup failed", error);
    }
    try {
      await options.destroyWindow();
    } catch (error) {
      appClosing = false;
      await options.showWindow().catch(() => undefined);
      throw error;
    }
    return true;
  } finally {
    endResearchSessionChange();
  }
}
