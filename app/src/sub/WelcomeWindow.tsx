import { Button } from "@/components/ui/button";
import { FileName } from "@/components/ui/file-name";
import { Project } from "@/core/Project";
import { ResearchFolder } from "@/core/research/ResearchFolder";
import {
  chooseResearchFolder,
  listResearchWorkspaces,
  openResearchWorkspace,
  researchFilesVersionAtom,
  type ResearchWorkspaceItem,
} from "@/core/research/ResearchSession";
import { emitResearchEvent } from "@/core/research/ResearchShell";
import { closeEmptyDrafts, onNewDraft, onOpenFile } from "@/core/service/GlobalMenu";
import { Settings } from "@/core/service/Settings";
import { createSubWindow } from "@/core/subWindowOpen";
import { TabWorkspace } from "@/core/TabWorkspace";
import { store, tabsAtom } from "@/state";
import SettingsWindow from "@/sub/SettingsWindow";
import { cn } from "@/utils/cn";
import { Vector } from "@graphif/data-structures";
import { Rectangle } from "@graphif/shapes";
import { FilePlus, FolderOpen, FolderSearch, LoaderCircle, Settings as SettingsIcon } from "lucide-react";
import { useAtomValue } from "jotai";
import { useEffect, useLayoutEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

const welcomeTabIds = new Set<string>();

function isWelcomeTab(tab: { id: string }): boolean {
  return welcomeTabIds.has(tab.id);
}

function getWelcomeRect() {
  const scale = Settings.uiScalePercent / 100;
  const viewport = new Vector(innerWidth / scale, innerHeight / scale);
  const size = new Vector(Math.min(960, viewport.x * 0.85), Math.min(640, viewport.y * 0.8));
  return new Rectangle(viewport.subtract(size).divide(2), size);
}

export default function WelcomeWindow({ tabId }: { tabId: string }) {
  useLayoutEffect(() => {
    const recenter = () => {
      const tab = TabWorkspace.get(tabId);
      if (!tab || tab.layout !== "floating" || tab.closing) return;
      // floatingRect 使用缩放后的 UI 坐标，不能再按未缩放的视口裁剪。
      tab.floatingRect = getWelcomeRect();
      store.set(tabsAtom, [...store.get(tabsAtom)]);
    };
    recenter();
    window.addEventListener("resize", recenter);
    const unwatch = Settings.watch("uiScalePercent", recenter);
    return () => {
      window.removeEventListener("resize", recenter);
      unwatch();
    };
  }, [tabId]);
  // 点击外部 / Escape 等路径关闭时也要清掉标记，避免下次 open 误判
  useEffect(() => () => void welcomeTabIds.delete(tabId), [tabId]);

  return <ResearchWelcome tabId={tabId} />;
}

async function closeWelcome(tabId: string) {
  await TabWorkspace.close(tabId);
  welcomeTabIds.delete(tabId);
}

function ResearchWelcome({ tabId }: { tabId: string }) {
  const { t } = useTranslation("research");
  const filesVersion = useAtomValue(researchFilesVersionAtom);
  const [root, setRoot] = useState(ResearchFolder.getRoot());
  const [workspaces, setWorkspaces] = useState<ResearchWorkspaceItem[] | null>(null);
  const [listError, setListError] = useState("");

  useEffect(() => Settings.watch("researchFolderPath", setRoot), []);

  useEffect(() => {
    if (!root) return;
    let disposed = false;
    setListError("");
    listResearchWorkspaces().then(
      (items) => !disposed && setWorkspaces(items),
      (error: unknown) => !disposed && setListError(String(error)),
    );
    return () => {
      disposed = true;
    };
  }, [root, filesVersion]);

  const showError = (error: unknown) => toast.error(t("workspace.failed", { message: String(error) }));

  const chooseFolder = () => {
    chooseResearchFolder().catch(showError);
  };

  const openWorkspace = async (absPath: string) => {
    await closeWelcome(tabId);
    await openResearchWorkspace(absPath).catch(showError);
  };

  const openOtherFile = async () => {
    // 先关欢迎窗，避免系统文件对话框触发 closeWhenClickOutside 的竞态
    await closeWelcome(tabId);
    const opened = await onOpenFile(undefined, "科研工作台-欢迎页");
    if (opened instanceof Project) await closeEmptyDrafts(opened);
  };

  const sectionTitle = "text-muted-foreground text-[11px] font-semibold tracking-wide";
  const actionRow =
    "hover:bg-accent flex h-7 w-full cursor-pointer items-center gap-2 rounded-[6px] px-2 text-left text-[13px] font-medium";

  return (
    <div className="text-foreground flex h-full w-full overflow-auto p-6 text-[13px]">
      <div className="m-auto flex w-full max-w-3xl flex-col gap-6">
        <div className="flex flex-col gap-1">
          <span className="text-[14px] font-semibold">{t("welcome.title")}</span>
          <span className="text-muted-foreground">{t("welcome.subtitle")}</span>
        </div>

        <div className="flex flex-col gap-8 sm:flex-row">
          <div className="flex min-w-0 flex-1 flex-col gap-6">
            {root ? (
              <div className="flex flex-col gap-1">
                <span className={sectionTitle}>{t("welcome.folder")}</span>
                <div className="border-border flex h-10 items-center gap-2 rounded-[8px] border pr-1 pl-3">
                  <FolderOpen className="text-muted-foreground size-4 shrink-0" />
                  <PathTail path={root} className="flex-1" />
                  <Button variant="ghost" className="h-7 rounded-[6px] px-2 text-[13px]" onClick={chooseFolder}>
                    {t("welcome.changeFolder")}
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                <Button className="h-8 rounded-[6px] text-[13px]" onClick={chooseFolder}>
                  <FolderSearch className="size-4" />
                  {t("welcome.chooseFolder")}
                </Button>
                <span className="text-muted-foreground text-[12px]">{t("welcome.noFolderHint")}</span>
              </div>
            )}

            {root && (
              <div className="flex flex-col gap-1">
                <div className="flex h-7 items-center justify-between gap-2">
                  <span className={sectionTitle}>
                    {t("welcome.workspaces")}
                    {workspaces && workspaces.length > 0 && (
                      <span className="ml-1.5 font-normal tabular-nums">{workspaces.length}</span>
                    )}
                  </span>
                  <Button
                    className="h-7 rounded-[6px] px-2 text-[13px]"
                    onClick={async () => {
                      // 输入框是模态对话框，点它也算点了欢迎窗外面，所以先关掉欢迎窗
                      await closeWelcome(tabId);
                      emitResearchEvent("newWorkspace");
                    }}
                  >
                    <FilePlus className="size-4" />
                    {t("welcome.newWorkspace")}
                  </Button>
                </div>
                <div className="flex max-h-64 flex-col overflow-y-auto">
                  {listError ? (
                    <span className="text-destructive px-2 py-1 text-[12px]">
                      {t("workspace.listFailed", { message: listError })}
                    </span>
                  ) : workspaces === null ? (
                    <LoaderCircle className="text-muted-foreground m-2 size-4 animate-spin" />
                  ) : workspaces.length === 0 ? (
                    <span className="text-muted-foreground px-2 py-1">{t("welcome.noWorkspaces")}</span>
                  ) : (
                    workspaces.map((item) => {
                      const folder = parentPath(item.relPath);
                      return (
                        <button
                          key={item.absPath}
                          type="button"
                          className="hover:bg-accent flex h-7 w-full shrink-0 cursor-pointer items-center gap-3 rounded-[6px] px-2 text-left"
                          onClick={() => void openWorkspace(item.absPath)}
                        >
                          <FileName name={item.name} title={item.absPath} className="flex-1" />
                          {item.open && (
                            <span className="text-muted-foreground shrink-0 text-[11px]">{t("workspace.opened")}</span>
                          )}
                          {folder && (
                            <PathTail path={folder} className="text-muted-foreground max-w-[40%] text-[12px]" />
                          )}
                        </button>
                      );
                    })
                  )}
                </div>
              </div>
            )}
          </div>

          <div className="flex flex-col gap-6 sm:w-64">
            <div className="flex flex-col gap-2">
              <span className={sectionTitle}>{t("welcome.howTo.title")}</span>
              <ol className="text-muted-foreground flex list-decimal flex-col gap-2 pl-5 leading-[1.5]">
                <li>{t("welcome.howTo.step1")}</li>
                <li>{t("welcome.howTo.step2")}</li>
                <li>{t("welcome.howTo.step3")}</li>
              </ol>
            </div>
            <div className="-mx-2 flex flex-col">
              <button
                type="button"
                className={actionRow}
                onClick={() =>
                  void (async () => {
                    await onNewDraft();
                    await closeWelcome(tabId);
                  })().catch(showError)
                }
              >
                <FilePlus className="text-muted-foreground size-4 shrink-0" />
                <span className="truncate">{t("welcome.draft")}</span>
              </button>
              <button type="button" className={actionRow} onClick={() => void openOtherFile().catch(showError)}>
                <FolderOpen className="text-muted-foreground size-4 shrink-0" />
                <span className="truncate">{t("welcome.openOther")}</span>
              </button>
              <button
                type="button"
                className={actionRow}
                onClick={() => {
                  void closeWelcome(tabId);
                  SettingsWindow.open("settings");
                }}
              >
                <SettingsIcon className="text-muted-foreground size-4 shrink-0" />
                <span className="truncate">{t("welcome.settings")}</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** 去掉最后一段，得到所在文件夹；没有上级时返回空字符串 */
function parentPath(path: string) {
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return index > 0 ? path.slice(0, index) : "";
}

/**
 * 路径从开头省略、只留最后两段：`…/parent/folder`，最后一段尽量完整显示，悬停看完整路径。
 * 有用的信息在结尾，普通的末尾省略号会把文件夹名本身截掉。
 */
function PathTail({ path, className }: { path: string; className?: string }) {
  const trimmed = path.replace(/[\\/]+$/, "") || path;
  const segments = trimmed.split(/[\\/]/).filter(Boolean);
  const last = segments.at(-1) ?? trimmed;
  const separator = trimmed.includes("\\") && !trimmed.includes("/") ? "\\" : "/";
  const head =
    segments.length > 2
      ? `…${separator}${segments.at(-2)}${separator}`
      : trimmed.slice(0, Math.max(0, trimmed.length - last.length));
  return (
    <span className={cn("flex min-w-0 overflow-hidden whitespace-nowrap", className)} title={path}>
      <span className="min-w-0 shrink-[999] truncate">{head}</span>
      <span className="min-w-0 truncate">{last}</span>
    </span>
  );
}

WelcomeWindow.open = () => {
  const existing = store.get(tabsAtom).find((tab) => !tab.closing && isWelcomeTab(tab));
  if (existing) {
    TabWorkspace.focus(existing.id);
    return existing;
  }

  const tab = createSubWindow("WelcomeWindow", {
    children: (componentTab) => <WelcomeWindow tabId={componentTab.id} />,
    rect: getWelcomeRect(),
    canDock: false,
    closable: true,
    titleBarOverlay: true,
    closeWhenClickOutside: false,
  });
  welcomeTabIds.add(tab.id);
  return tab;
};

WelcomeWindow.closeAll = async () => {
  const welcomeTabs = store.get(tabsAtom).filter((tab) => !tab.closing && isWelcomeTab(tab));
  await Promise.all(
    welcomeTabs.map(async (tab) => {
      await TabWorkspace.close(tab.id);
      welcomeTabIds.delete(tab.id);
    }),
  );
};
