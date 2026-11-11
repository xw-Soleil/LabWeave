import { ProjectTabs } from "@/ProjectTabs";
import { Project, ProjectState } from "@/core/Project";
import { findResearchPanelTab, peekLeftSide } from "@/core/research/ResearchSession";
import { isTemporaryWorkspace } from "@/core/research/TemporaryWorkspace";
import {
  enterSidePanel,
  enterSidePeekTrigger,
  isSidePanelShown,
  leaveSidePeekArea,
  setSidePanelPinned,
  SIDE_PANEL_GAP,
  useSidePanelStates,
  type SidePanelState,
} from "@/core/research/SidePanels";
import { Tab } from "@/core/Tab";
import {
  clampSidePanelWidth,
  getTabGroups,
  parseSidePanelWidth,
  separateFixedSideGroups,
  type FixedSideEdge,
  type TabGroup,
  type TabGroupNode,
  type TabSplit,
} from "@/core/TabGroup";
import { TabWorkspace } from "@/core/TabWorkspace";
import { activeTabAtom, store, tabDropTargetAtom, tabGroupRootAtom, tabsAtom } from "@/state";
import { cn } from "@/utils/cn";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useAtomValue } from "jotai";
import { FolderOutput, MessageSquareText, Minus, PanelRight, Pin, PinOff, Plus } from "lucide-react";
import React, { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  DOCKED_TOP,
  dockedChromeAtom,
  RESEARCH_FLOAT_TOP,
  RESEARCH_SIDE_PANEL_LEFT,
  RIBBON_WIDTH,
  useShortcutText,
  withShortcut,
} from "./activity-rail";
import ResearchWelcome from "./research-welcome";
import { Button } from "./ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./ui/tooltip";

interface ProjectStatusInfo {
  nodes: number;
  edges: number;
  selected: number;
  state: "saved" | "stashed" | "unsaved";
  scalePercent: number;
  noVisibleNodes: boolean;
  temporary: boolean;
}

function readProjectStatus(project: Project): ProjectStatusInfo {
  const manager = project.stageManager;
  const entities = manager.getEntities();
  const view = project.renderer.getCoverWorldRectangle();
  const hasVisibleNode = entities.some((entity) => {
    if (entity.isHiddenBySectionCollapse) return false;
    const rect = entity.collisionBox.getRectangle();
    return view.isCollideWith(rect) && Math.max(rect.width, rect.height) * project.camera.currentScale >= 1;
  });
  return {
    nodes: entities.length,
    edges: manager.getAssociations().length,
    selected: manager.getSelectedStageObjects().length,
    state: (
      {
        [ProjectState.Saved]: "saved",
        [ProjectState.Stashed]: "stashed",
        [ProjectState.Unsaved]: "unsaved",
      } as const
    )[project.projectState],
    scalePercent: Math.round(project.camera.currentScale * 100),
    noVisibleNodes: entities.length > 0 && !hasVisibleNode,
    // 另存为进研究文件夹、换研究文件夹以后，下一次读取就跟着变
    temporary: isTemporaryWorkspace(project),
  };
}

function sameStatus(a: ProjectStatusInfo | null, b: ProjectStatusInfo) {
  return !!a && (Object.keys(b) as (keyof ProjectStatusInfo)[]).every((key) => a[key] === b[key]);
}

/** 节点数、连线数、保存状态和缩放比例；每 250ms 读一次，没变化时不重新渲染 */
function useProjectStatus(project: Project) {
  const [status, setStatus] = useState<ProjectStatusInfo | null>(null);
  useEffect(() => {
    const update = () => {
      const next = readProjectStatus(project);
      setStatus((previous) => (sameStatus(previous, next) ? previous : next));
    };
    update();
    const interval = window.setInterval(update, 250);
    return () => window.clearInterval(interval);
  }, [project]);
  return status;
}

function StatusBarButton({
  label,
  keyBindId,
  className,
  onClick,
  children,
}: {
  label: string;
  keyBindId: string;
  className?: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  const shortcut = useShortcutText(keyBindId);
  return (
    <Tooltip>
      <TooltipTrigger>
        <Button
          variant="ghost"
          aria-label={label}
          className={cn(
            "text-muted-foreground hover:bg-accent hover:text-foreground dark:hover:bg-accent h-6 min-w-6 rounded-full px-1 text-[11px] font-medium [&_svg:not([class*='size-'])]:size-3.5",
            className,
          )}
          onClick={onClick}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top">{withShortcut(label, shortcut)}</TooltipContent>
    </Tooltip>
  );
}

/** 白板左下角浮着的状态条：节点数、保存状态、缩放 */
function ResearchStatusBar({
  project,
  isClassroomMode,
  left,
}: {
  project: Project;
  isClassroomMode: boolean;
  /** 左侧栏固定显示时要让开它 */
  left: string;
}) {
  const { t } = useTranslation("research");
  const status = useProjectStatus(project);
  // 白板可能因为打开设置等原因暂停了渲染，按钮改了视野要让它马上重画
  const act = (action: () => void) => () => {
    action();
    project.loop();
  };
  const summary = status
    ? [
        t("statusBar.nodes", { count: status.nodes }),
        t("statusBar.edges", { count: status.edges }),
        ...(status.selected > 0 ? [t("statusBar.selected", { count: status.selected })] : []),
        t(`statusBar.${status.state}`),
        ...(status.noVisibleNodes ? [t("statusBar.noVisibleNodes")] : []),
      ].join(" · ")
    : "";

  return (
    <div
      className={cn(
        "bg-background/95 border-border/60 text-muted-foreground absolute bottom-2 z-10 flex h-7 max-w-[calc(100%-1rem)] items-center gap-2 rounded-full border pr-1 pl-3 text-[11px] tabular-nums shadow-xs transition-opacity hover:opacity-100",
        isClassroomMode && "opacity-0",
      )}
      style={{ left }}
    >
      {status?.temporary && (
        <span
          className="flex shrink-0 cursor-default items-center gap-1 font-medium text-amber-700 dark:text-amber-400"
          title={t("statusBar.outsideFolderHint")}
        >
          <FolderOutput aria-hidden="true" className="size-3.5" />
          {t("statusBar.outsideFolder")}
        </span>
      )}
      <span className="min-w-0 truncate" title={summary}>
        {summary}
      </span>
      <TooltipProvider>
        <div className="flex shrink-0 items-center gap-0.5">
          <StatusBarButton
            label={t("statusBar.zoomOut")}
            keyBindId="CameraScaleZoomOut"
            onClick={act(() => project.camera.zoomOutByKeyboardPress())}
          >
            <Minus />
          </StatusBarButton>
          <StatusBarButton
            label={t("statusBar.zoomReset")}
            keyBindId="resetCameraScale"
            className="min-w-11"
            onClick={act(() => project.camera.resetScale())}
          >
            {status ? `${status.scalePercent}%` : ""}
          </StatusBarButton>
          <StatusBarButton
            label={t("statusBar.zoomIn")}
            keyBindId="CameraScaleZoomIn"
            onClick={act(() => project.camera.zoomInByKeyboardPress())}
          >
            <Plus />
          </StatusBarButton>
          <StatusBarButton
            label={t("statusBar.fitTitle")}
            keyBindId="resetView"
            className="px-2"
            onClick={act(() => project.camera.reset())}
          >
            {t("statusBar.fit")}
          </StatusBarButton>
        </div>
      </TooltipProvider>
    </div>
  );
}

const SIDE_PANEL_WIDTH_STORAGE_KEY = {
  left: "pg-research-side-panel-width-left",
  right: "pg-research-side-panel-width-right",
} as const satisfies Record<FixedSideEdge, string>;

type SidePanelWidths = Record<FixedSideEdge, number>;

// 分组树只在内存里，重启后由会话重新打开面板，所以宽度单独记在 localStorage
function readSidePanelWidths(): SidePanelWidths {
  return {
    left: parseSidePanelWidth(localStorage.getItem(SIDE_PANEL_WIDTH_STORAGE_KEY.left), "left"),
    right: parseSidePanelWidth(localStorage.getItem(SIDE_PANEL_WIDTH_STORAGE_KEY.right), "right"),
  };
}

/** 分组挨着窗口的哪几条边：挨着上边和左右边时要给红绿灯、菜单、右上角按钮让位置 */
interface GroupEdges {
  top: boolean;
  right: boolean;
  bottom: boolean;
  left: boolean;
}

const WINDOW_EDGES: GroupEdges = { top: true, right: true, bottom: true, left: true };

function childEdges(edges: GroupEdges, split: TabSplit, index: 0 | 1): GroupEdges {
  if (split.direction === "horizontal") return index === 0 ? { ...edges, right: false } : { ...edges, left: false };
  return index === 0 ? { ...edges, bottom: false } : { ...edges, top: false };
}

/** 白板之间的分屏：分隔线只画 1px，鼠标可按的范围左右各多 4px，悬停或拖动时显示 2px 强调色线 */
function ResearchSplitView({
  node,
  renderChild,
}: {
  node: TabSplit;
  renderChild: (child: TabGroupNode, index: 0 | 1) => React.ReactNode;
}) {
  const [dragging, setDragging] = useState(false);
  const horizontal = node.direction === "horizontal";

  const startResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const parent = event.currentTarget.parentElement?.parentElement;
    if (!parent) return;
    const rect = parent.getBoundingClientRect();
    const onMove = (moveEvent: PointerEvent) => {
      const total = horizontal ? rect.width : rect.height;
      const position = horizontal ? moveEvent.clientX - rect.left : moveEvent.clientY - rect.top;
      const first = Math.max(10, Math.min(90, (position / total) * 100));
      TabWorkspace.resizeSplit(node.id, [first, 100 - first]);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      setDragging(false);
    };
    setDragging(true);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  return (
    <div className={cn("flex size-full min-h-0 min-w-0", horizontal ? "flex-row" : "flex-col")}>
      <div className="relative min-h-0 min-w-0" style={{ flexBasis: `${node.sizes[0]}%`, flexGrow: 0, flexShrink: 1 }}>
        {renderChild(node.children[0], 0)}
      </div>
      <div
        role="separator"
        aria-orientation={horizontal ? "vertical" : "horizontal"}
        className={cn("bg-border relative z-20 shrink-0", horizontal ? "w-px" : "h-px")}
      >
        <div
          className={cn(
            "group absolute touch-none",
            // 拖动区比 1px 的分隔线宽，不用对得很准
            horizontal ? "-inset-x-1.5 inset-y-0 cursor-col-resize" : "inset-x-0 -inset-y-1.5 cursor-row-resize",
          )}
          onPointerDown={startResize}
        >
          <div
            className={cn(
              "bg-primary pointer-events-none absolute opacity-0 transition-opacity group-hover:opacity-100",
              dragging && "opacity-100",
              horizontal ? "inset-y-0 left-1/2 w-0.5 -translate-x-1/2" : "inset-x-0 top-1/2 h-0.5 -translate-y-1/2",
            )}
          />
        </div>
      </div>
      <div className="relative min-h-0 min-w-0" style={{ flex: "1 1 0%" }}>
        {renderChild(node.children[1], 1)}
      </div>
    </div>
  );
}

function DropPreview({ groupId }: { groupId: string }) {
  const target = useAtomValue(tabDropTargetAtom);
  if (target?.groupId !== groupId) return null;
  if (target.edge) {
    const edgeClass = {
      left: "top-0 bottom-0 left-0 w-1/2",
      right: "top-0 right-0 bottom-0 w-1/2",
      top: "top-0 right-0 left-0 h-1/2",
      bottom: "right-0 bottom-0 left-0 h-1/2",
    }[target.edge];
    return <div className={cn("bg-primary/25 border-primary pointer-events-none absolute z-30 border-2", edgeClass)} />;
  }

  const group = Array.from(document.querySelectorAll<HTMLElement>("[data-pg-tab-group-id]")).find(
    (candidate) => candidate.dataset.pgTabGroupId === groupId,
  );
  if (!group) return null;
  const tabBar = group.querySelector<HTMLElement>("[data-pg-tab-bar]");
  if (!tabBar) {
    return <div className="bg-primary/10 border-primary pointer-events-none absolute inset-0 z-30 border-2" />;
  }
  const tabs = Array.from(tabBar.querySelectorAll<HTMLElement>("[data-pg-docked-tab-id]"));
  const groupRect = group.getBoundingClientRect();
  const tabBarRect = tabBar.getBoundingClientRect();
  const nextTab = tabs[target.index ?? tabs.length];
  const previousTab = tabs[Math.min((target.index ?? tabs.length) - 1, tabs.length - 1)];
  const left = nextTab
    ? nextTab.getBoundingClientRect().left - groupRect.left
    : previousTab
      ? previousTab.getBoundingClientRect().right - groupRect.left
      : tabBarRect.left - groupRect.left;

  return (
    <div
      className="bg-primary pointer-events-none absolute z-40 w-0.5"
      style={{ left, top: tabBarRect.top - groupRect.top, height: tabBarRect.height }}
    />
  );
}

/**
 * 左右侧栏：浮在画布上面的圆角卡片，画布不因为它变窄。
 * 收起时移到窗口外面、变透明，但不卸载：对话、文件列表、正在进行的拖动都还在。
 * 不标 data-pg-tab-group-id，白板标签拖不进来；侧栏里的标签可以拖出去放进编辑区。
 */
function SidePanelOverlay({
  edge,
  group,
  tabs,
  activeTab,
  state,
  width,
  onWidthChange,
  onWidthCommit,
  onTabClick,
  onTabClose,
  isClassroomMode,
  docked,
}: {
  edge: FixedSideEdge;
  group: TabGroup;
  tabs: Tab[];
  activeTab: Tab | undefined;
  state: SidePanelState;
  width: number;
  onWidthChange: (edge: FixedSideEdge, width: number) => void;
  onWidthCommit: (edge: FixedSideEdge, width: number) => void;
  onTabClick: (tab: Tab) => void;
  onTabClose: (tab: Tab) => void;
  isClassroomMode: boolean;
  /** 贴边排法：没有白板露在外面时，侧栏贴着竖栏和窗口边，不再是浮着的圆角卡片 */
  docked: boolean;
}) {
  const { t } = useTranslation("research");
  const ref = useRef<HTMLDivElement>(null);
  const [resizing, setResizing] = useState(false);
  const shown = isSidePanelShown(state);

  // 收起时把焦点从面板里拿走，免得接着打的字进了看不见的输入框
  useEffect(() => {
    if (shown) return;
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && ref.current?.contains(focused)) focused.blur();
  }, [shown]);

  const startResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !ref.current) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const rect = ref.current.getBoundingClientRect();
    let next = width;
    const onMove = (moveEvent: PointerEvent) => {
      const raw = edge === "left" ? moveEvent.clientX - rect.left : rect.right - moveEvent.clientX;
      next = clampSidePanelWidth(raw, window.innerWidth);
      onWidthChange(edge, next);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      setResizing(false);
      onWidthCommit(edge, next);
    };
    setResizing(true);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  const pinLabel = state.pinned ? t("shell.unpinSidePanel") : t("shell.pinSidePanel");

  return (
    <div
      ref={ref}
      data-pg-side-panel={edge}
      data-pg-side-shown={shown}
      aria-hidden={!shown}
      className={cn(
        "group/side absolute z-30 transition-[translate,opacity] duration-200 ease-out",
        !shown && "pointer-events-none opacity-0",
        !shown && (edge === "left" ? "-translate-x-[calc(100%+5rem)]" : "translate-x-[calc(100%+1rem)]"),
        isClassroomMode && "opacity-0",
      )}
      style={{
        top: docked ? DOCKED_TOP : RESEARCH_FLOAT_TOP,
        bottom: docked ? 0 : SIDE_PANEL_GAP,
        width,
        maxWidth: "calc(100% - 6rem)",
        ...(edge === "left"
          ? { left: docked ? RIBBON_WIDTH : RESEARCH_SIDE_PANEL_LEFT }
          : { right: docked ? 0 : SIDE_PANEL_GAP }),
      }}
      onPointerEnter={() => enterSidePanel(edge)}
      onPointerLeave={() => leaveSidePeekArea(edge)}
      onPointerDownCapture={() => {
        if (activeTab && store.get(activeTabAtom) !== activeTab) TabWorkspace.focus(activeTab.id);
      }}
    >
      <section
        className={cn(
          "flex size-full min-h-0 min-w-0 flex-col overflow-hidden",
          docked
            ? cn(
                "bg-background border-border/70",
                edge === "left" ? "border-r" : "border-l",
                // 临时弹出来盖在正文上时才要阴影
                !state.pinned && "shadow-lg",
              )
            : "bg-background border-border/70 rounded-[12px] border shadow-lg",
        )}
      >
        {/* 只有面板自己这一页时不要标签行；放进了多页时才显示，能切换、关闭，也能拖到编辑区 */}
        {tabs.length > 1 && (
          <div className="flex shrink-0 px-1.5 pt-1.5">
            <ProjectTabs
              groupId={group.id}
              tabs={tabs}
              activeTab={activeTab}
              onTabClick={onTabClick}
              onTabClose={onTabClose}
              isClassroomMode={isClassroomMode}
            />
          </div>
        )}
        <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
          {activeTab && React.createElement(activeTab.getComponent())}
        </div>
      </section>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t("shell.resizeSidePanel")}
        className={cn(
          "group/resize absolute w-2 cursor-col-resize touch-none",
          docked ? "inset-y-0" : "inset-y-3",
          edge === "left" ? "-right-1" : "-left-1",
        )}
        onPointerDown={startResize}
      >
        <div
          className={cn(
            "bg-primary pointer-events-none absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 rounded-full opacity-0 transition-opacity group-hover/resize:opacity-100",
            resizing && "opacity-100",
          )}
        />
      </div>
      {/* 图钉在卡片外侧，不和面板自己的标题栏按钮挤在一起；临时弹出时一直显示，固定以后悬停才显示。
          贴边排法里固定着的侧栏不放图钉（会压在正文标题栏上），点竖栏按钮收起 */}
      {!(docked && state.pinned) && (
        <button
          type="button"
          aria-label={pinLabel}
          title={pinLabel}
          className={cn(
            "bg-background border-border/70 text-muted-foreground hover:text-foreground absolute top-1.5 flex size-6 cursor-pointer items-center justify-center rounded-full border shadow-xs transition-opacity",
            edge === "left" ? "left-[calc(100%+0.375rem)]" : "right-[calc(100%+0.375rem)]",
            state.pinned && "opacity-0 group-hover/side:opacity-100 focus-visible:opacity-100",
          )}
          onClick={() => setSidePanelPinned(edge, !state.pinned)}
        >
          {state.pinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
        </button>
      )}
    </div>
  );
}

/**
 * 贴住窗口左右边缘的一条细感应区：鼠标停一会儿弹出收着的侧栏。拖着东西经过时不算。
 * 宽 10px：Windows 上最外面 6px 是调窗口大小的把手（WindowResizeHandles），里面还剩 4px 能感应
 */
function SideEdgeTrigger({ edge, onPeek, docked }: { edge: FixedSideEdge; onPeek: () => void; docked: boolean }) {
  return (
    <div
      aria-hidden="true"
      data-pg-side-trigger={edge}
      className={cn("absolute bottom-0 z-20 w-2.5", edge === "left" ? "left-0" : "right-0")}
      style={{ top: docked ? DOCKED_TOP : RESEARCH_FLOAT_TOP }}
      onPointerEnter={(event) => event.buttons === 0 && onPeek()}
      onPointerLeave={() => leaveSidePeekArea(edge)}
    />
  );
}

/** 贴边排法顶上那一条，照 Obsidian 放标签；空白处按住能拖动窗口，双击放大 */
function TabStrip() {
  return (
    <div
      aria-hidden="true"
      className="bg-background border-border/70 absolute inset-x-0 top-0 h-10 border-b"
      onMouseDown={(event) => {
        if (event.buttons !== 1) return;
        if (event.detail === 2) void getCurrentWindow().toggleMaximize();
        else void getCurrentWindow().startDragging();
      }}
    />
  );
}

/** 右侧栏收起后留在右下角的圆按钮，点一下展开并固定 */
function SideBubble({ isAI }: { isAI: boolean }) {
  const { t } = useTranslation("research");
  const label = t("shell.showSidePanel");
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className="bg-background border-border/60 text-muted-foreground hover:text-foreground absolute right-3 bottom-3 z-30 flex size-10 cursor-pointer items-center justify-center rounded-full border shadow-md transition-colors"
      onClick={() => setSidePanelPinned("right", true)}
    >
      {isAI ? <MessageSquareText className="size-4.5" /> : <PanelRight className="size-4.5" />}
    </button>
  );
}

export default function DockedArea({
  onTabClick,
  onTabClose,
  isClassroomMode,
}: {
  onTabClick: (tab: Tab) => void;
  onTabClose: (tab: Tab) => void;
  isClassroomMode: boolean;
}) {
  const root = useAtomValue(tabGroupRootAtom);
  const tabs = useAtomValue(tabsAtom);
  const docked = useAtomValue(dockedChromeAtom);
  const sideStates = useSidePanelStates();
  const [sideWidths, setSideWidths] = useState<SidePanelWidths>(() => readSidePanelWidths());
  const changeSideWidth = (edge: FixedSideEdge, width: number) =>
    setSideWidths((current) => (current[edge] === width ? current : { ...current, [edge]: width }));
  const commitSideWidth = (edge: FixedSideEdge, width: number) =>
    localStorage.setItem(SIDE_PANEL_WIDTH_STORAGE_KEY[edge], String(width));

  // 没有工作区时 AI 对话用不上，先藏起来
  const hasWorkspace = tabs.some((tab) => tab instanceof Project && !tab.closing);
  const aiTab = findResearchPanelTab("ai", tabs);
  const hiddenTabId = hasWorkspace ? undefined : aiTab?.id;
  const { main, sides } = separateFixedSideGroups(root);

  const groupTabsOf = (group: TabGroup) =>
    group.tabIds.flatMap((id) => {
      const tab = tabs.find((candidate) => candidate.id === id && candidate.layout === "docked");
      return tab && tab.id !== hiddenTabId ? [tab] : [];
    });
  const shownTabOf = (group: TabGroup, groupTabs: Tab[]) =>
    groupTabs.find((tab) => tab.id === group.activeTabId) ?? groupTabs.at(-1);

  const focusGroupTab = (activeTab: Tab | undefined) => {
    if (activeTab && store.get(activeTabAtom) !== activeTab) TabWorkspace.focus(activeTab.id);
  };

  const leftTabs = sides.left ? groupTabsOf(sides.left) : [];
  const rightTabs = sides.right ? groupTabsOf(sides.right) : [];
  // 左侧栏固定显示时，挨着左边的白板把状态条挪到它右边
  const statusLeftBesidePanel =
    leftTabs.length > 0 && sideStates.left.pinned
      ? `calc(${RESEARCH_SIDE_PANEL_LEFT} + ${sideWidths.left + SIDE_PANEL_GAP}px)`
      : `${SIDE_PANEL_GAP}px`;

  const leftPinned = leftTabs.length > 0 && sideStates.left.pinned;
  const rightPinned = rightTabs.length > 0 && sideStates.right.pinned;
  // 贴边排法：正文让开竖栏和固定住的侧栏，中间没有空隙
  const dockedLeft = leftPinned ? `calc(${RIBBON_WIDTH} + ${sideWidths.left}px)` : RIBBON_WIDTH;
  const dockedRight = rightPinned ? `${sideWidths.right}px` : "0px";

  // 标签和状态条都浮在白板上；白板铺满分组，其他页（设置等）从标签下面开始
  const renderGroup = (group: TabGroup, edges: GroupEdges) => {
    const groupTabs = groupTabsOf(group);
    const activeTab = shownTabOf(group, groupTabs);
    const project = activeTab instanceof Project ? activeTab : undefined;
    // 白板铺满窗口，左边竖栏和两边面板浮在画布上面；文档等其他页不铺画布，
    // 给竖栏和固定住的面板让出位置（临时弹出的照旧盖在上面），切换时平滑滑开。
    // 白板本身不跟着变宽变窄，画布的视野不会跳。
    const dockLeft =
      project || !edges.left
        ? "0px"
        : docked
          ? dockedLeft
          : leftPinned
            ? `calc(${RESEARCH_SIDE_PANEL_LEFT} + ${sideWidths.left + SIDE_PANEL_GAP}px)`
            : RESEARCH_SIDE_PANEL_LEFT;
    const dockRight =
      project || !edges.right
        ? "0px"
        : docked
          ? dockedRight
          : rightPinned
            ? `${sideWidths.right + SIDE_PANEL_GAP * 2}px`
            : "0px";
    // 贴边时标签从正文左边开始，和 Obsidian 一样排在正文正上方；挨着窗口上边时还要让开红绿灯
    const tabsLeft = docked
      ? edges.top && edges.left
        ? `max(var(--pg-top-left-inset, 8px), calc(${dockLeft} + 6px))`
        : `calc(${dockLeft} + 6px)`
      : edges.top && edges.left
        ? "var(--pg-top-left-inset, 8px)"
        : `${SIDE_PANEL_GAP}px`;
    return (
      <section
        key={group.id}
        data-pg-tab-group-id={group.id}
        className="relative size-full min-h-0 min-w-0 overflow-hidden"
        onPointerDownCapture={() => focusGroupTab(activeTab)}
      >
        {docked && <TabStrip />}
        <div
          className={cn(
            "absolute bottom-0 transition-[left,right] duration-200 ease-out motion-reduce:transition-none",
            project ? "top-0" : "top-10",
          )}
          style={{ left: dockLeft, right: dockRight }}
        >
          {activeTab && React.createElement(activeTab.getComponent())}
        </div>
        <div
          className={cn(
            "pointer-events-none absolute inset-x-0 z-30 flex transition-[padding] duration-200 ease-out motion-reduce:transition-none",
            docked ? "top-0 h-10 items-end" : "top-1",
          )}
          style={{
            paddingLeft: tabsLeft,
            paddingRight: edges.top && edges.right ? "var(--pg-top-right-inset, 8px)" : `${SIDE_PANEL_GAP}px`,
          }}
        >
          <ProjectTabs
            groupId={group.id}
            tabs={groupTabs}
            activeTab={activeTab}
            onTabClick={onTabClick}
            onTabClose={onTabClose}
            isClassroomMode={isClassroomMode}
            variant={docked ? "strip" : "floating"}
          />
        </div>
        {project && (
          <ResearchStatusBar
            key={project.id}
            project={project}
            isClassroomMode={isClassroomMode}
            left={edges.left ? statusLeftBesidePanel : `${SIDE_PANEL_GAP}px`}
          />
        )}
        <DropPreview groupId={group.id} />
      </section>
    );
  };

  const renderNode = (node: TabGroupNode, edges: GroupEdges): React.ReactNode =>
    node.type === "split" ? (
      <ResearchSplitView
        key={node.id}
        node={node}
        renderChild={(child, index) => renderNode(child, childEdges(edges, node, index))}
      />
    ) : (
      renderGroup(node, edges)
    );

  const mainHasTabs = getTabGroups(main).some((group) => groupTabsOf(group).length > 0);
  const rightActive = sides.right ? shownTabOf(sides.right, rightTabs) : undefined;

  return (
    <div className="absolute inset-0 min-h-0 min-w-0 overflow-hidden">
      {main && mainHasTabs ? (
        renderNode(main, WINDOW_EDGES)
      ) : (
        <>
          <TabStrip />
          <div
            className="absolute bottom-0 transition-[left,right] duration-200 ease-out motion-reduce:transition-none"
            style={{ top: DOCKED_TOP, left: dockedLeft, right: dockedRight }}
          >
            <ResearchWelcome />
          </div>
        </>
      )}
      {(
        [
          ["left", sides.left, leftTabs],
          ["right", sides.right, rightTabs],
        ] as const
      ).map(([edge, group, groupTabs]) =>
        group && groupTabs.length > 0 ? (
          <SidePanelOverlay
            key={edge}
            edge={edge}
            group={group}
            tabs={groupTabs}
            activeTab={shownTabOf(group, groupTabs)}
            state={sideStates[edge]}
            width={sideWidths[edge]}
            onWidthChange={changeSideWidth}
            onWidthCommit={commitSideWidth}
            onTabClick={onTabClick}
            onTabClose={onTabClose}
            isClassroomMode={isClassroomMode}
            docked={docked}
          />
        ) : null,
      )}
      {!sideStates.left.pinned && <SideEdgeTrigger edge="left" onPeek={peekLeftSide} docked={docked} />}
      {rightTabs.length > 0 && !sideStates.right.pinned && (
        <SideEdgeTrigger edge="right" onPeek={() => enterSidePeekTrigger("right")} docked={docked} />
      )}
      {/* 贴边排法里不要右下角的圆按钮，从竖栏的 AI 按钮打开 */}
      {!docked && rightTabs.length > 0 && !isSidePanelShown(sideStates.right) && (
        <SideBubble isAI={rightActive !== undefined && rightActive === aiTab} />
      )}
    </div>
  );
}
