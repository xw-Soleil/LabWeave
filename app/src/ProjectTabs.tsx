import { Vector } from "@graphif/data-structures";
import { cn } from "@udecode/cn";
import { useAtomValue } from "jotai";
import { CircleAlert, CloudUpload, X } from "lucide-react";
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import TabContextMenu from "./components/tab-context-menu";
import { Button } from "./components/ui/button";
import { displayWorkspaceName, FileName } from "./components/ui/file-name";
import { Tooltip, TooltipContent, TooltipTrigger } from "./components/ui/tooltip";
import { Project, ProjectState } from "./core/Project";
import { findResearchPanelTab } from "./core/research/ResearchSession";
import { isResearchShell } from "./core/research/ResearchShell";
import { SoundService } from "./core/service/feedbackService/SoundService";
import { Settings } from "./core/service/Settings";
import { ComponentTab, Tab } from "./core/Tab";
import { TabWorkspace } from "./core/TabWorkspace";
import { activeResourceTabAtom } from "./state";
import { replaceTextWhenProtect } from "./utils/font";

// 将 ProjectTabs 移出 App 组件，作为独立组件
export const ProjectTabs = memo(function ProjectTabs({
  groupId,
  tabs,
  activeTab,
  onTabClick,
  onTabClose,
  isClassroomMode,
}: {
  groupId: string;
  tabs: Tab[];
  activeTab: Tab | undefined;
  onTabClick: (tab: Tab) => void;
  onTabClose: (tab: Tab) => void;
  isClassroomMode: boolean;
}) {
  const tabsContainerRef = useRef<HTMLDivElement>(null);
  const scrollPositionRef = useRef(0);
  const [protectingPrivacy, setProtectingPrivacy] = useState(Settings.protectingPrivacy);
  const activeResourceTab = useAtomValue(activeResourceTabAtom);
  const research = isResearchShell();
  const { t } = useTranslation("research");
  const overflow = useOverflowEdges(tabsContainerRef, research, tabs.map((tab) => tab.id).join("\n"));

  useEffect(() => {
    const unwatch = Settings.watch("protectingPrivacy", setProtectingPrivacy);
    return unwatch;
  }, []);

  // 保存滚动位置
  const saveScrollPosition = useCallback(() => {
    if (tabsContainerRef.current) {
      scrollPositionRef.current = tabsContainerRef.current.scrollLeft;
    }
  }, []);

  // 恢复滚动位置
  const restoreScrollPosition = useCallback(() => {
    if (tabsContainerRef.current) {
      tabsContainerRef.current.scrollLeft = scrollPositionRef.current;
    }
  }, []);

  // 处理标签点击
  const handleTabClick = useCallback(
    (tab: Tab) => {
      saveScrollPosition();
      onTabClick(tab);
      // 微任务中恢复滚动位置
      Promise.resolve().then(restoreScrollPosition);
    },
    [onTabClick, saveScrollPosition, restoreScrollPosition],
  );

  // 处理标签关闭
  const handleTabClose = useCallback(
    async (tab: Tab, e: React.MouseEvent) => {
      e.stopPropagation();
      saveScrollPosition();
      await onTabClose(tab);
      Promise.resolve().then(restoreScrollPosition);
    },
    [onTabClose, saveScrollPosition, restoreScrollPosition],
  );

  // 监听滚动
  const handleScroll = useCallback(() => {
    saveScrollPosition();
  }, [saveScrollPosition]);

  // 左键：切换并开始拖动（拖出去浮动或换分组）；中键：关闭
  const handleTabMouseDown = useCallback(
    (tab: Tab, e: React.MouseEvent) => {
      if (e.button === 0) {
        SoundService.play.mouseClickButton();
        handleTabClick(tab);
        const start = new Vector(e.clientX, e.clientY);
        let dragged = false;
        const onMouseUp = (event: MouseEvent) => {
          window.removeEventListener("mousemove", onMouseMove);
          window.removeEventListener("mouseup", onMouseUp);
          const target = TabWorkspace.getDropTarget(event.clientX, event.clientY);
          TabWorkspace.clearDropPreview();
          if (!dragged) return;
          if (target) {
            TabWorkspace.moveTab(tab.id, target);
          } else {
            TabWorkspace.float(tab.id, new Vector(event.clientX - 80, event.clientY - 12));
          }
        };
        const onMouseMove = (event: MouseEvent) => {
          if (new Vector(event.clientX, event.clientY).subtract(start).magnitude() < 8) return;
          dragged = true;
          TabWorkspace.previewDrop(event.clientX, event.clientY);
        };
        window.addEventListener("mousemove", onMouseMove);
        window.addEventListener("mouseup", onMouseUp);
      } else if (e.button === 1) {
        e.preventDefault();
        if (!tab.closable) return;
        saveScrollPosition();
        onTabClose(tab);
        Promise.resolve().then(restoreScrollPosition);
        SoundService.play.cuttingLineRelease();
      }
    },
    [handleTabClick, onTabClose, saveScrollPosition, restoreScrollPosition],
  );

  // 用快捷键等方式切到被挤出可视区的标签时，把它滚进来
  useEffect(() => {
    const container = tabsContainerRef.current;
    if (!research || !container || !activeTab) return;
    const element = Array.from(container.querySelectorAll<HTMLElement>("[data-pg-docked-tab-id]")).find(
      (candidate) => candidate.dataset.pgDockedTabId === activeTab.id,
    );
    if (!element) return;
    const left = element.offsetLeft;
    const right = left + element.offsetWidth;
    if (left < container.scrollLeft) container.scrollLeft = left;
    else if (right > container.scrollLeft + container.clientWidth) container.scrollLeft = right - container.clientWidth;
  }, [research, activeTab]);

  if (research) {
    const shown = (text: string) => (protectingPrivacy ? replaceTextWhenProtect(text) : text);
    const aiPanelTab = findResearchPanelTab("ai");
    const projectLabel = (project: Project) =>
      project.isDraft
        ? { name: t("tabs.untitled", { n: project.uri.path }), title: t("tabs.untitled", { n: project.uri.path }) }
        : project.uri.scheme === "file"
          ? { name: displayWorkspaceName(project.title), title: project.uri.fsPath }
          : { name: project.title, title: project.title };
    const tabLabel = (tab: Tab): { name: string; title: string; context?: string } => {
      if (tab instanceof Project) return projectLabel(tab);
      if (tab === aiPanelTab) return { name: t("tabs.aiChat"), title: t("tabs.aiChat") };
      if (tab instanceof ComponentTab && tab.contextTarget === "activeResourceTab") {
        const context = activeResourceTab instanceof Project ? projectLabel(activeResourceTab).name : undefined;
        return { name: tab.title, title: context ? `${tab.title} · ${context}` : tab.title, context };
      }
      return { name: tab.title, title: tab.title };
    };

    return (
      <div
        data-pg-tab-bar
        data-pg-tab-group-bar-id={groupId}
        className={cn(
          "border-border bg-muted/60 z-10 flex h-8 border-b transition-opacity hover:opacity-100",
          isClassroomMode && "opacity-0",
        )}
      >
        {/* 标签先缩到最窄 96px，还放不下才横向滚动；两头有被挡住的标签时淡出提示 */}
        <div
          ref={tabsContainerRef}
          role="tablist"
          className="scrollbar-hide relative flex min-w-0 flex-1 overflow-x-auto overflow-y-hidden"
          style={edgeFadeMask(overflow)}
          onScroll={handleScroll}
          onWheel={(e) => {
            const container = e.currentTarget;
            if (e.deltaX !== 0 || container.scrollWidth <= container.clientWidth) return;
            container.scrollLeft += e.deltaY;
          }}
        >
          {tabs.map((tab) => {
            const active = activeTab === tab;
            const project = tab instanceof Project ? tab : undefined;
            const unsaved = project !== undefined && (project.isSaving || project.projectState !== ProjectState.Saved);
            const label = tabLabel(tab);
            return (
              <TabContextMenu key={tab.id} tab={tab} onClose={onTabClose}>
                <div
                  role="tab"
                  aria-selected={active}
                  data-pg-docked-tab-id={tab.id}
                  className={cn(
                    "group/tab border-border relative flex h-full max-w-[220px] min-w-24 cursor-pointer items-center gap-1.5 border-r px-3 text-[12px] font-medium whitespace-nowrap select-none",
                    active
                      ? "bg-background text-foreground after:bg-primary after:pointer-events-none after:absolute after:inset-x-0 after:bottom-0 after:h-0.5"
                      : "text-muted-foreground hover:bg-accent hover:text-foreground",
                  )}
                  onMouseDown={(e) => handleTabMouseDown(tab, e)}
                  onMouseEnter={() => SoundService.play.mouseEnterButton()}
                >
                  {unsaved && (
                    <span
                      role="img"
                      aria-label={t("tabs.unsaved")}
                      title={project.isSaving ? t("tabs.saving") : t("tabs.unsaved")}
                      className={cn("size-1.5 shrink-0 rounded-full bg-current", project.isSaving && "animate-pulse")}
                    />
                  )}
                  {!project && tab.icon && <tab.icon className="size-3.5 shrink-0" />}
                  <FileName name={shown(label.name)} title={shown(label.title)} />
                  {label.context && (
                    <span className="text-muted-foreground flex min-w-0 items-center gap-1">
                      <span className="shrink-0">·</span>
                      <FileName name={shown(label.context)} title={shown(label.title)} />
                    </span>
                  )}
                  {tab.closable && (
                    <button
                      type="button"
                      aria-label={t("tabs.close")}
                      title={t("tabs.close")}
                      className={cn(
                        "hover:bg-foreground/10 focus-visible:ring-primary/50 -mr-1.5 ml-auto flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-[4px] opacity-0 outline-none group-hover/tab:opacity-100 focus-visible:opacity-100 focus-visible:ring-2",
                        active && "opacity-100",
                      )}
                      // 点 × 只关闭，不先切过去；中键照常冒泡给标签处理
                      onMouseDown={(e) => {
                        if (e.button === 0) e.stopPropagation();
                      }}
                      onClick={(e) => {
                        SoundService.play.cuttingLineRelease();
                        if (project?.isSaving) {
                          e.stopPropagation();
                          toast.warning(t("tabs.savingWait"));
                          return;
                        }
                        // 未保存时由关闭流程询问是否保存，这里不直接保存
                        void handleTabClose(tab, e);
                      }}
                    >
                      <X className="size-4" />
                    </button>
                  )}
                </div>
              </TabContextMenu>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div
      ref={tabsContainerRef}
      data-pg-tab-bar
      data-pg-tab-group-bar-id={groupId}
      className={cn(
        "scrollbar-hide z-10 flex h-8 items-center gap-1.5 overflow-x-auto px-3 py-1 whitespace-nowrap transition-opacity hover:opacity-100",
        isClassroomMode && "opacity-0",
      )}
      onScroll={handleScroll}
    >
      {tabs.map((tab) => (
        <TabContextMenu key={tab.id} tab={tab} onClose={onTabClose}>
          <Button
            data-pg-docked-tab-id={tab.id}
            className={cn(
              "outline-inset h-full shrink-0 cursor-pointer rounded-full px-3 shadow-xs",
              activeTab === tab
                ? "bg-primary/20 text-foreground hover:bg-primary/25 ring-primary/40 ring-1 ring-inset"
                : "bg-background/80 text-muted-foreground hover:bg-background hover:text-foreground",
              tab instanceof Project && tab.isSaving && "animate-pulse",
            )}
            onMouseDown={(e) => handleTabMouseDown(tab, e)}
            onMouseEnter={() => {
              SoundService.play.mouseEnterButton();
            }}
          >
            <span className="flex items-center gap-1 text-xs">
              {tab.icon && <tab.icon className="size-3" />}
              {(() => {
                const name = tab.title;
                return protectingPrivacy ? replaceTextWhenProtect(name ?? "") : name;
              })()}
              {tab instanceof ComponentTab && tab.contextTarget === "activeResourceTab" && (
                <span className="max-w-32 truncate opacity-70">→ {activeResourceTab?.title ?? "无项目"}</span>
              )}
            </span>
            {tab.closable && (
              <div
                className="flex size-4 cursor-pointer items-center justify-center hover:opacity-100"
                onClick={(e) => {
                  if (tab instanceof Project && tab.isSaving) {
                    // 如果正在保存中，显示提示
                    toast.warning("正在保存中，请勿擅自做多余的操作");
                    SoundService.play.cuttingLineRelease();
                  } else if (tab instanceof Project && tab.projectState === ProjectState.Unsaved) {
                    // 如果是未保存状态，根据项目类型执行不同操作
                    if (tab.uri.scheme === "draft") {
                      // 草稿文件，弹出对话框
                      handleTabClose(tab, e);
                      SoundService.play.cuttingLineRelease();
                    } else {
                      // 已有的文件，直接保存
                      tab.save();
                      SoundService.play.cuttingLineRelease();
                    }
                  } else {
                    // 其他状态，执行关闭操作
                    handleTabClose(tab, e);
                    SoundService.play.cuttingLineRelease();
                  }
                }}
              >
                {tab instanceof Project && tab.isSaving ? (
                  <span className="grid size-3.5 animate-spin grid-cols-2">
                    <span className="border-accent-foreground w-full animate-pulse rounded-full border-1 p-0.5"></span>
                    <span className="border-accent-foreground w-full rounded-full border-1 p-0.5"></span>
                    <span className="border-accent-foreground w-full rounded-full border-1 p-0.5"></span>
                    <span className="border-accent-foreground w-full animate-pulse rounded-full border-1 p-0.5"></span>
                  </span>
                ) : tab instanceof Project && tab.projectState === ProjectState.Saved ? (
                  <X className="scale-75 opacity-75" />
                ) : tab instanceof Project && tab.projectState === ProjectState.Stashed ? (
                  <CloudUpload />
                ) : tab instanceof Project ? (
                  <Tooltip>
                    {/* 醒目提醒用户，崩溃了丢了文件别怪开发者提醒不到位 */}
                    <TooltipTrigger>
                      <CircleAlert className="*:text-destructive! text-destructive!" />
                    </TooltipTrigger>
                    <TooltipContent>未保存！</TooltipContent>
                  </Tooltip>
                ) : (
                  <X className="scale-75 opacity-75" />
                )}
              </div>
            )}
          </Button>
        </TabContextMenu>
      ))}
    </div>
  );
});

/** 标签栏左右两头是否还有被挡住的标签（只在科研模式下计算） */
function useOverflowEdges(ref: React.RefObject<HTMLDivElement | null>, enabled: boolean, tabsKey: string) {
  const [edges, setEdges] = useState({ start: false, end: false });
  useLayoutEffect(() => {
    const container = ref.current;
    if (!enabled || !container) return;
    const update = () => {
      const start = container.scrollLeft > 0;
      const end = Math.ceil(container.scrollLeft + container.clientWidth) < container.scrollWidth;
      setEdges((previous) => (previous.start === start && previous.end === end ? previous : { start, end }));
    };
    update();
    // 标签改名、增减都会改变内容宽度，容器本身的尺寸不一定变，所以每个标签也要观察
    const observer = new ResizeObserver(update);
    observer.observe(container);
    for (const child of Array.from(container.children)) observer.observe(child);
    container.addEventListener("scroll", update, { passive: true });
    return () => {
      observer.disconnect();
      container.removeEventListener("scroll", update);
    };
  }, [ref, enabled, tabsKey]);
  return edges;
}

/** 用遮罩把有内容被挡住的一侧淡出；遮罩只取透明度，black/transparent 不是界面颜色 */
function edgeFadeMask({ start, end }: { start: boolean; end: boolean }): React.CSSProperties | undefined {
  if (!start && !end) return undefined;
  const gradient = `linear-gradient(to right, ${start ? "transparent" : "black"}, black 24px, black calc(100% - 24px), ${end ? "transparent" : "black"})`;
  return { maskImage: gradient, WebkitMaskImage: gradient };
}
