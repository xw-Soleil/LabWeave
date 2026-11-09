import { Vector } from "@graphif/data-structures";
import { cn } from "@udecode/cn";
import { useAtomValue } from "jotai";
import { FolderOutput, X } from "lucide-react";
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import TabContextMenu from "./components/tab-context-menu";
import { displayWorkspaceName, FileName } from "./components/ui/file-name";
import { Project, ProjectState } from "./core/Project";
import { findResearchPanelTab } from "./core/research/ResearchSession";
import { isTemporaryWorkspace } from "./core/research/TemporaryWorkspace";
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
  // 换了研究文件夹，哪些白板算「文件夹外」也跟着变
  const [, setResearchRoot] = useState(Settings.researchFolderPath);
  const activeResourceTab = useAtomValue(activeResourceTabAtom);
  const { t } = useTranslation("research");
  const overflow = useOverflowEdges(tabsContainerRef, tabs.map((tab) => tab.id).join("\n"));

  useEffect(() => {
    const unwatch = Settings.watch("protectingPrivacy", setProtectingPrivacy);
    return unwatch;
  }, []);
  useEffect(() => Settings.watch("researchFolderPath", setResearchRoot), []);

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
    if (!container || !activeTab) return;
    const element = Array.from(container.querySelectorAll<HTMLElement>("[data-pg-docked-tab-id]")).find(
      (candidate) => candidate.dataset.pgDockedTabId === activeTab.id,
    );
    if (!element) return;
    const left = element.offsetLeft;
    const right = left + element.offsetWidth;
    if (left < container.scrollLeft) container.scrollLeft = left;
    else if (right > container.scrollLeft + container.clientWidth) container.scrollLeft = right - container.clientWidth;
  }, [activeTab]);

  const shown = (text: string) => (protectingPrivacy ? replaceTextWhenProtect(text) : text);
  const aiPanelTab = findResearchPanelTab("ai");
  const projectLabel = (project: Project) =>
    project.isDraft
      ? { name: t("tabs.untitled", { n: project.uri.path }), title: t("tabs.untitled", { n: project.uri.path }) }
      : project.uri.scheme === "file"
        ? {
            name: displayWorkspaceName(project.title),
            title: isTemporaryWorkspace(project)
              ? t("tabs.outsideFolder", { path: project.uri.fsPath, interpolation: { escapeValue: false } })
              : project.uri.fsPath,
          }
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
    // 标签浮在白板上：一组圆角小药丸，宽度按内容，不再横贯整行
    <div
      data-pg-tab-bar
      data-pg-tab-group-bar-id={groupId}
      className={cn(
        "bg-background/95 border-border/60 pointer-events-auto z-10 flex h-7 max-w-full min-w-0 rounded-full border p-0.5 shadow-xs transition-opacity hover:opacity-100",
        isClassroomMode && "opacity-0",
      )}
    >
      {/* 标签先缩到最窄 96px，还放不下才横向滚动；两头有被挡住的标签时淡出提示 */}
      <div
        ref={tabsContainerRef}
        role="tablist"
        className="scrollbar-hide relative flex min-w-0 flex-1 gap-0.5 overflow-x-auto overflow-y-hidden rounded-full"
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
          const unsaved =
            tab.hasUnsavedChanges ||
            (project !== undefined && (project.isSaving || project.projectState !== ProjectState.Saved));
          const temporary = project !== undefined && isTemporaryWorkspace(project);
          const label = tabLabel(tab);
          return (
            <TabContextMenu key={tab.id} tab={tab} onClose={onTabClose}>
              <div
                role="tab"
                aria-selected={active}
                data-pg-docked-tab-id={tab.id}
                className={cn(
                  "group/tab relative flex h-full max-w-[220px] min-w-24 cursor-pointer items-center gap-1.5 rounded-full px-2.5 text-[12px] font-medium whitespace-nowrap select-none",
                  active ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-accent hover:text-foreground",
                )}
                onMouseDown={(e) => handleTabMouseDown(tab, e)}
                onMouseEnter={() => SoundService.play.mouseEnterButton()}
              >
                {unsaved && (
                  <span
                    role="img"
                    aria-label={t("tabs.unsaved")}
                    title={project?.isSaving ? t("tabs.saving") : t("tabs.unsaved")}
                    className={cn("size-1.5 shrink-0 rounded-full bg-current", project?.isSaving && "animate-pulse")}
                  />
                )}
                {!project && tab.icon && <tab.icon className="size-3.5 shrink-0" />}
                {temporary && <FolderOutput aria-hidden="true" className="size-3.5 shrink-0 opacity-70" />}
                <FileName name={shown(label.name)} title={shown(label.title)} className={cn(temporary && "italic")} />
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
                      "hover:bg-foreground/10 focus-visible:ring-primary/50 -mr-1 ml-auto flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-full opacity-0 outline-none group-hover/tab:opacity-100 focus-visible:opacity-100 focus-visible:ring-2",
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
                    <X className="size-3.5" />
                  </button>
                )}
              </div>
            </TabContextMenu>
          );
        })}
      </div>
    </div>
  );
});

/** 标签栏左右两头是否还有被挡住的标签 */
function useOverflowEdges(ref: React.RefObject<HTMLDivElement | null>, tabsKey: string) {
  const [edges, setEdges] = useState({ start: false, end: false });
  useLayoutEffect(() => {
    const container = ref.current;
    if (!container) return;
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
  }, [ref, tabsKey]);
  return edges;
}

/** 用遮罩把有内容被挡住的一侧淡出；遮罩只取透明度，black/transparent 不是界面颜色 */
function edgeFadeMask({ start, end }: { start: boolean; end: boolean }): React.CSSProperties | undefined {
  if (!start && !end) return undefined;
  const gradient = `linear-gradient(to right, ${start ? "transparent" : "black"}, black 24px, black calc(100% - 24px), ${end ? "transparent" : "black"})`;
  return { maskImage: gradient, WebkitMaskImage: gradient };
}
