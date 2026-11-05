import { ProjectTabs } from "@/ProjectTabs";
import { Project, ProjectState } from "@/core/Project";
import { emitResearchEvent, isResearchShell } from "@/core/research/ResearchShell";
import WelcomeWindow from "@/sub/WelcomeWindow";
import { Tab } from "@/core/Tab";
import {
  clampSidePanelWidth,
  findFixedSideChild,
  isFixedSideGroupId,
  parseSidePanelWidth,
  type FixedSideEdge,
  type TabGroup,
  type TabGroupNode,
} from "@/core/TabGroup";
import { TabWorkspace } from "@/core/TabWorkspace";
import { activeGroupIdAtom, activeTabAtom, store, tabDropTargetAtom, tabGroupRootAtom, tabsAtom } from "@/state";
import { cn } from "@/utils/cn";
import { isMac } from "@/utils/platform";
import { useAtomValue } from "jotai";
import { Minus, Plus } from "lucide-react";
import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useShortcutText, withShortcut } from "./activity-rail";
import { Button } from "./ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./ui/tooltip";

interface ProjectStatusInfo {
  nodes: number;
  edges: number;
  selected: number;
  state: "saved" | "stashed" | "unsaved";
  scalePercent: number;
  emptyCanvas: boolean;
  noVisibleNodes: boolean;
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
    emptyCanvas: entities.length === 0,
    noVisibleNodes: entities.length > 0 && !hasVisibleNode,
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

function ProjectStatus({ project, isClassroomMode }: { project: Project; isClassroomMode: boolean }) {
  const { t } = useTranslation("projectStatus");
  const status = useProjectStatus(project);
  const viewHint = !status
    ? ""
    : status.emptyCanvas
      ? t("emptyCanvas")
      : status.noVisibleNodes
        ? t("noVisibleNodes")
        : "";
  const text = status
    ? `${t("nodes", { count: status.nodes })} · ${t("edges", { count: status.edges })} · ${t("selected", { count: status.selected })}  |  ${status.scalePercent}%  |  ${t(status.state)}`
    : "";

  return (
    <div
      className={cn(
        "bg-background text-muted-foreground absolute bottom-3 left-3 flex max-w-[calc(100%-1.5rem)] items-center gap-2 rounded-full px-3 py-1.5 text-xs shadow-xs transition-opacity hover:opacity-100",
        isClassroomMode && "opacity-0",
      )}
    >
      <span className="truncate">{viewHint || text}</span>
      <Button variant="ghost" size="sm" className="h-6 shrink-0 px-2 text-xs" onClick={() => project.camera.reset()}>
        {t("fitView")}
      </Button>
    </div>
  );
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
            "text-muted-foreground hover:bg-accent hover:text-foreground dark:hover:bg-accent h-6 min-w-6 rounded-[6px] px-1 text-[11px] font-medium [&_svg:not([class*='size-'])]:size-3.5",
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

/** 科研模式：编辑区底部固定的一行状态栏，取代原版浮在画布左下角的胶囊 */
function ResearchStatusBar({ project, isClassroomMode }: { project: Project; isClassroomMode: boolean }) {
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
        "border-border text-muted-foreground flex h-7 shrink-0 items-center gap-3 border-t px-3 text-[11px] tabular-nums transition-opacity hover:opacity-100",
        isClassroomMode && "opacity-0",
      )}
    >
      <span className="min-w-0 truncate" title={summary}>
        {summary}
      </span>
      <TooltipProvider>
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
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

function SplitView({
  node,
  renderNode,
}: {
  node: Extract<TabGroupNode, { type: "split" }>;
  renderNode: (node: TabGroupNode) => React.ReactNode;
}) {
  const horizontal = node.direction === "horizontal";
  return (
    <div className={cn("flex size-full min-h-0 min-w-0", horizontal ? "flex-row" : "flex-col")}>
      <div className="min-h-0 min-w-0" style={{ flexBasis: `${node.sizes[0]}%`, flexGrow: 0, flexShrink: 1 }}>
        {renderNode(node.children[0])}
      </div>
      <div
        className={cn(
          "bg-border hover:bg-primary z-20 shrink-0 touch-none transition-colors",
          horizontal ? "w-1 cursor-col-resize" : "h-1 cursor-row-resize",
        )}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          const parent = event.currentTarget.parentElement;
          if (!parent) return;
          const rect = parent.getBoundingClientRect();
          const update = (clientX: number, clientY: number) => {
            const total = horizontal ? rect.width : rect.height;
            const position = horizontal ? clientX - rect.left : clientY - rect.top;
            const first = Math.max(10, Math.min(90, (position / total) * 100));
            TabWorkspace.resizeSplit(node.id, [first, 100 - first]);
          };
          const onMove = (moveEvent: PointerEvent) => update(moveEvent.clientX, moveEvent.clientY);
          const onUp = () => {
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onUp);
          };
          window.addEventListener("pointermove", onMove);
          window.addEventListener("pointerup", onUp);
        }}
      />
      <div className="min-h-0 min-w-0 flex-1">{renderNode(node.children[1])}</div>
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

/**
 * 科研模式的分栏：分隔线只画 1px，鼠标可按的范围左右各多 4px，悬停或拖动时显示 2px 强调色线。
 * 直接挂在左右分栏上的固定侧栏（文件面板、AI 对话）按像素定宽，拖宽后记住；其余分栏照旧按比例。
 */
function ResearchSplitView({
  node,
  renderNode,
  sideWidths,
  onSideWidthChange,
  onSideWidthCommit,
}: {
  node: Extract<TabGroupNode, { type: "split" }>;
  renderNode: (node: TabGroupNode) => React.ReactNode;
  sideWidths: SidePanelWidths;
  onSideWidthChange: (edge: FixedSideEdge, width: number) => void;
  onSideWidthCommit: (edge: FixedSideEdge, width: number) => void;
}) {
  const { t } = useTranslation("research");
  const [dragging, setDragging] = useState(false);
  const horizontal = node.direction === "horizontal";
  const side = findFixedSideChild(node);
  const childStyle = (index: 0 | 1): React.CSSProperties => {
    if (side) {
      return index === side.index
        ? { flex: "0 0 auto", width: sideWidths[side.edge], maxWidth: "50%" }
        : { flex: "1 1 0%" };
    }
    return index === 0 ? { flexBasis: `${node.sizes[0]}%`, flexGrow: 0, flexShrink: 1 } : { flex: "1 1 0%" };
  };

  const startResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const parent = event.currentTarget.parentElement?.parentElement;
    if (!parent) return;
    const rect = parent.getBoundingClientRect();
    let sideWidth = side ? sideWidths[side.edge] : 0;
    const update = (clientX: number, clientY: number) => {
      if (side) {
        sideWidth = clampSidePanelWidth(side.index === 0 ? clientX - rect.left : rect.right - clientX, rect.width);
        onSideWidthChange(side.edge, sideWidth);
        return;
      }
      const total = horizontal ? rect.width : rect.height;
      const position = horizontal ? clientX - rect.left : clientY - rect.top;
      const first = Math.max(10, Math.min(90, (position / total) * 100));
      TabWorkspace.resizeSplit(node.id, [first, 100 - first]);
    };
    const onMove = (moveEvent: PointerEvent) => update(moveEvent.clientX, moveEvent.clientY);
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      setDragging(false);
      if (side) onSideWidthCommit(side.edge, sideWidth);
    };
    setDragging(true);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  return (
    <div className={cn("flex size-full min-h-0 min-w-0", horizontal ? "flex-row" : "flex-col")}>
      <div className="min-h-0 min-w-0" style={childStyle(0)}>
        {renderNode(node.children[0])}
      </div>
      <div
        role="separator"
        aria-orientation={horizontal ? "vertical" : "horizontal"}
        aria-label={side ? t("shell.resizeSidePanel") : undefined}
        className={cn("bg-border relative z-20 shrink-0", horizontal ? "w-px" : "h-px")}
      >
        <div
          className={cn(
            "group absolute touch-none",
            horizontal ? "-inset-x-1 inset-y-0 cursor-col-resize" : "inset-x-0 -inset-y-1 cursor-row-resize",
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
      <div className="min-h-0 min-w-0" style={childStyle(1)}>
        {renderNode(node.children[1])}
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
  // 科研模式的侧栏只有一页时不显示标签行，拖进来就整块高亮，松手后标签放进这一组
  if (!tabBar) {
    if (!isResearchShell()) return null;
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
      className="bg-primary pointer-events-none absolute z-30 w-0.5"
      style={{ left, top: tabBarRect.top - groupRect.top, height: tabBarRect.height }}
    />
  );
}

export default function DockedArea({
  onTabClick,
  onTabClose,
  isClassroomMode,
  leftInset,
  topInset,
}: {
  onTabClick: (tab: Tab) => void;
  onTabClose: (tab: Tab) => void;
  isClassroomMode: boolean;
  /** CSS length reserved on the left edge (e.g. for the research activity rail). */
  leftInset?: string;
  /** CSS length reserved on the top edge (e.g. for the research title bar). */
  topInset?: string;
}) {
  const root = useAtomValue(tabGroupRootAtom);
  const tabs = useAtomValue(tabsAtom);
  const activeGroupId = useAtomValue(activeGroupIdAtom);
  const research = isResearchShell();
  const { t } = useTranslation("research");
  const empty = research && !tabs.some((tab) => tab instanceof Project && !tab.closing);
  const [sideWidths, setSideWidths] = useState<SidePanelWidths>(() =>
    research ? readSidePanelWidths() : { left: 0, right: 0 },
  );
  const changeSideWidth = (edge: FixedSideEdge, width: number) =>
    setSideWidths((current) => (current[edge] === width ? current : { ...current, [edge]: width }));
  const commitSideWidth = (edge: FixedSideEdge, width: number) =>
    localStorage.setItem(SIDE_PANEL_WIDTH_STORAGE_KEY[edge], String(width));

  const focusGroupTab = (activeTab: Tab | undefined) => {
    if (activeTab && store.get(activeTabAtom) !== activeTab) TabWorkspace.focus(activeTab.id);
  };

  // 科研模式：分组之间只有 1px 分隔线，不画边框和焦点框；标签行 → 内容 → 状态栏自上而下排，内容不被压住
  const renderResearchGroup = (node: TabGroup, groupTabs: Tab[], activeTab: Tab | undefined) => {
    // 侧栏只有面板自己这一页时不要标签行；放进了工作区或多页时照常显示，才能切换、关闭和拖走
    const showTabBar =
      !isFixedSideGroupId(node.id) || groupTabs.length > 1 || groupTabs.some((tab) => tab instanceof Project);
    return (
      <section
        key={node.id}
        data-pg-tab-group-id={node.id}
        className="relative flex size-full min-h-0 min-w-0 flex-col overflow-hidden"
        onPointerDownCapture={() => focusGroupTab(activeTab)}
      >
        {showTabBar && (
          <div className="relative z-10 shrink-0">
            <ProjectTabs
              groupId={node.id}
              tabs={groupTabs}
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
        {activeTab instanceof Project && (
          <ResearchStatusBar key={activeTab.id} project={activeTab} isClassroomMode={isClassroomMode} />
        )}
        <DropPreview groupId={node.id} />
      </section>
    );
  };

  const renderNode = (node: TabGroupNode, atWindowTop = true): React.ReactNode => {
    if (node.type === "split") {
      if (research) {
        return (
          <ResearchSplitView
            key={node.id}
            node={node}
            renderNode={(child) => renderNode(child, false)}
            sideWidths={sideWidths}
            onSideWidthChange={changeSideWidth}
            onSideWidthCommit={commitSideWidth}
          />
        );
      }
      return (
        <SplitView
          key={node.id}
          node={node}
          renderNode={(child) =>
            renderNode(child, atWindowTop && (node.direction === "horizontal" || child === node.children[0]))
          }
        />
      );
    }
    const groupTabs = node.tabIds.flatMap((id) => {
      const tab = tabs.find((candidate) => candidate.id === id && candidate.layout === "docked");
      return tab ? [tab] : [];
    });
    const activeTab = groupTabs.find((tab) => tab.id === node.activeTabId) ?? groupTabs.at(-1);
    if (research) return renderResearchGroup(node, groupTabs, activeTab);
    return (
      <section
        key={node.id}
        data-pg-tab-group-id={node.id}
        className={cn(
          "relative flex size-full min-h-0 min-w-0 flex-col overflow-hidden",
          root?.type === "split" && "border-border border",
          root?.type === "split" && activeGroupId === node.id && "border-primary/60",
        )}
        onPointerDownCapture={() => focusGroupTab(activeTab)}
      >
        <div
          className={cn(
            "relative z-10 shrink-0",
            atWindowTop && "pt-[calc(2rem*var(--pg-ui-scale,1))] sm:pt-[calc(3.5rem*var(--pg-ui-scale,1))]",
            atWindowTop && isMac && root?.type === "group" && "w-[35%] pt-7 sm:pt-7",
          )}
        >
          <ProjectTabs
            groupId={node.id}
            tabs={groupTabs}
            activeTab={activeTab}
            onTabClick={onTabClick}
            onTabClose={onTabClose}
            isClassroomMode={isClassroomMode}
          />
        </div>
        <div
          className={cn(
            "min-h-0 min-w-0 overflow-hidden",
            activeTab instanceof Project ? "absolute inset-0" : "relative flex-1",
          )}
        >
          {activeTab && React.createElement(activeTab.getComponent())}
          {activeTab instanceof Project && (
            <ProjectStatus key={activeTab.id} project={activeTab} isClassroomMode={isClassroomMode} />
          )}
        </div>
        <DropPreview groupId={node.id} />
      </section>
    );
  };

  return (
    <div
      className="absolute inset-0 min-h-0 min-w-0 overflow-hidden"
      style={{ ...(leftInset ? { left: leftInset } : {}), ...(topInset ? { top: topInset } : {}) }}
    >
      {empty ? (
        <div className="flex h-full min-w-0">
          {root && <div className="relative h-full w-72 max-w-[40%] shrink-0">{renderNode(root)}</div>}
          <div className="flex min-w-0 flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
            <h1 className="text-lg font-semibold">{t("workspace.title")}</h1>
            <p className="text-muted-foreground max-w-md text-sm">{t("drop.noBoard")}</p>
            <div className="flex flex-wrap justify-center gap-2">
              <Button onClick={() => emitResearchEvent("newWorkspace")}>{t("workspace.new")}</Button>
              <Button variant="outline" onClick={() => WelcomeWindow.open()}>
                {t("welcome.openOther")}
              </Button>
            </div>
          </div>
        </div>
      ) : (
        root && renderNode(root)
      )}
    </div>
  );
}
