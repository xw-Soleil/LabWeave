import { Button } from "@/components/ui/button";
import { FileName } from "@/components/ui/file-name";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Project } from "@/core/Project";
import { ResearchFolder } from "@/core/research/ResearchFolder";
import {
  findResearchPanelTab,
  listResearchWorkspaces,
  openResearchWorkspace,
  peekFilesPanel,
  researchFilesVersionAtom,
  workspacePopoverOpenAtom,
  type ResearchWorkspaceItem,
} from "@/core/research/ResearchSession";
import { emitResearchEvent } from "@/core/research/ResearchShell";
import { isSidePanelShown, leaveSidePeekArea, sideEdgeOfGroup, useSidePanelStates } from "@/core/research/SidePanels";
import { KeyBindsUI } from "@/core/service/controlService/shortcutKeysEngine/KeyBindsUI";
import { Settings } from "@/core/service/Settings";
import { findTabGroupByTabId, getTabGroups, separateFixedSideGroups, type FixedSideEdge } from "@/core/TabGroup";
import { LibraryTab, openLibraryTab } from "@/core/research/LibraryTab";
import { activeTabAtom, tabGroupRootAtom, tabsAtom } from "@/state";
import SettingsWindow from "@/sub/SettingsWindow";
import { cn } from "@/utils/cn";
import { formatKeyBindSequenceToString } from "@/utils/keyDisplay";
import { isMac } from "@/utils/platform";
import { atom, useAtom, useAtomValue } from "jotai";
import {
  FolderOpen,
  FolderSearch,
  LayoutDashboard,
  Library,
  LoaderCircle,
  MessageSquareText,
  Plus,
  Settings as SettingsIcon,
} from "lucide-react";
import React, { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

/*
 * 画布铺满整个窗口，竖栏、标签、侧栏都浮在上面。这些都不在缩放层里，所以手动乘 UI 缩放。
 * 最上面一行（约 36px）留给红绿灯、标签和右上角的按钮；竖栏和侧栏从它下面开始。
 */
export const RESEARCH_FLOAT_TOP = "calc(2.75rem * var(--pg-ui-scale, 1))";
/** 竖栏离窗口左边 8px、宽 2.25rem；左侧栏紧挨在它右边，再空 8px */
export const RESEARCH_SIDE_PANEL_LEFT = "calc(1rem + 2.25rem * var(--pg-ui-scale, 1))";

/*
 * 没有白板露在外面时（笔记、PDF、文献库、欢迎页）照 Obsidian 排：
 * 顶上一条放标签，竖栏、左右侧栏都贴着窗口边，彼此用细线隔开，不再浮着。
 */
export const DOCKED_TOP = "2.5rem";
export const RIBBON_WIDTH = "calc(2.5rem * var(--pg-ui-scale, 1))";

/** 主编辑区里有没有白板露在外面；没有就用贴边的排法 */
export const dockedChromeAtom = atom((get) => {
  const tabs = get(tabsAtom);
  const { main } = separateFixedSideGroups(get(tabGroupRootAtom));
  return !getTabGroups(main).some((group) => {
    const groupTabs = group.tabIds.flatMap((id) => tabs.filter((tab) => tab.id === id && tab.layout === "docked"));
    return (groupTabs.find((tab) => tab.id === group.activeTabId) ?? groupTabs.at(-1)) instanceof Project;
  });
});

/** 快捷键的显示文本（macOS 上写成「⌘2」）；没绑或停用时为空。改键后自动更新 */
export function useShortcutText(keyBindId: string): string {
  const [text, setText] = useState(() => shortcutText(KeyBindsUI.getUIKeyBind(keyBindId)));
  useEffect(() => KeyBindsUI.onKeyBindChange(keyBindId, (keyBind) => setText(shortcutText(keyBind))), [keyBindId]);
  return text;
}

function shortcutText(keyBind: { key: string; isEnabled: boolean } | undefined): string {
  if (!keyBind?.isEnabled || !keyBind.key) return "";
  return formatKeyBindSequenceToString(keyBind.key, isMac ? "" : "+", " ");
}

/** 提示框文字末尾带上快捷键，如「AI 对话 (⌘2)」 */
export function withShortcut(label: string, shortcut: string): string {
  return shortcut ? `${label} (${shortcut})` : label;
}

function RailButton({
  label,
  keyBindId,
  active,
  onClick,
  children,
  buttonRef,
  unavailableHint,
  peekEdge,
  onPeek,
  hideTooltip,
}: {
  label: string;
  keyBindId: string;
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  buttonRef?: React.Ref<HTMLButtonElement>;
  /** 有值时按钮变灰、点了没反应，提示框改显示这句说明；不用 disabled，否则悬停时不出提示框 */
  unavailableHint?: string;
  /** 鼠标停在按钮上会弹出这一侧的侧栏 */
  peekEdge?: FixedSideEdge;
  onPeek?: () => void;
  /** 侧栏弹出来以后不再显示提示框，免得盖在面板上 */
  hideTooltip?: boolean;
}) {
  const shortcut = useShortcutText(keyBindId);
  const unavailable = unavailableHint !== undefined;
  return (
    <Tooltip open={hideTooltip ? false : undefined}>
      <TooltipTrigger>
        <Button
          ref={buttonRef}
          variant="ghost"
          aria-label={label}
          aria-pressed={unavailable ? undefined : active}
          aria-disabled={unavailable || undefined}
          data-pg-side-trigger={peekEdge}
          // 拖着卡片经过时不弹出
          onPointerEnter={onPeek ? (event) => event.buttons === 0 && onPeek() : undefined}
          onPointerLeave={peekEdge ? () => leaveSidePeekArea(peekEdge) : undefined}
          className={cn(
            "size-[calc(1.75rem*var(--pg-ui-scale,1))] rounded-[6px] p-0 [&_svg:not([class*='size-'])]:size-[calc(1rem*var(--pg-ui-scale,1))]",
            unavailable
              ? "text-muted-foreground hover:text-muted-foreground cursor-default opacity-40 hover:bg-transparent dark:hover:bg-transparent"
              : active
                ? "bg-primary/10 text-primary hover:bg-primary/10 hover:text-primary dark:hover:bg-primary/10"
                : "text-muted-foreground hover:bg-accent hover:text-foreground dark:hover:bg-accent",
          )}
          onClick={unavailable ? undefined : onClick}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="right">{unavailable ? unavailableHint : withShortcut(label, shortcut)}</TooltipContent>
    </Tooltip>
  );
}

function WorkspaceList({ onOpened }: { onOpened: () => void }) {
  const { t } = useTranslation("research");
  const tabs = useAtomValue(tabsAtom);
  const filesVersion = useAtomValue(researchFilesVersionAtom);
  const [root, setRoot] = useState(ResearchFolder.getRoot());
  const [items, setItems] = useState<ResearchWorkspaceItem[] | null>(null);
  const [error, setError] = useState("");
  const openCount = tabs.filter((tab) => tab instanceof Project && !tab.closing && tab.uri.scheme === "file").length;

  useEffect(() => Settings.watch("researchFolderPath", setRoot), []);

  useEffect(() => {
    let disposed = false;
    setError("");
    listResearchWorkspaces().then(
      (result) => !disposed && setItems(result),
      (reason: unknown) => !disposed && setError(String(reason)),
    );
    return () => {
      disposed = true;
    };
  }, [root, filesVersion, openCount]);

  const folderName = root ? (root.split(/[\\/]/).filter(Boolean).pop() ?? root) : "";

  return (
    <div className="flex flex-col gap-2 text-[13px]">
      <div className="flex min-w-0 items-baseline justify-between gap-2 px-2">
        <span className="shrink-0 font-semibold">{t("workspace.title")}</span>
        {root ? (
          <FileName
            name={folderName}
            title={root}
            keepExtension={false}
            className="text-muted-foreground text-[11px]"
          />
        ) : (
          <span className="text-muted-foreground text-[11px]">{t("workspace.noFolder")}</span>
        )}
      </div>
      <div className="flex max-h-72 flex-col overflow-y-auto">
        {error ? (
          <span className="text-destructive px-2 text-[12px]">{t("workspace.listFailed", { message: error })}</span>
        ) : items === null ? (
          <LoaderCircle className="text-muted-foreground m-2 size-4 animate-spin" />
        ) : items.length === 0 ? (
          <span className="text-muted-foreground px-2 text-[12px]">
            {root ? t("workspace.empty") : t("workspace.noFolder")}
          </span>
        ) : (
          items.map((item) => (
            <button
              key={item.absPath}
              type="button"
              className="hover:bg-accent flex min-w-0 cursor-pointer flex-col items-stretch rounded-[6px] px-2 py-1 text-left"
              onClick={() => {
                onOpened();
                openResearchWorkspace(item.absPath).catch((reason: unknown) =>
                  toast.error(t("workspace.failed", { message: String(reason) })),
                );
              }}
            >
              <span className="flex min-w-0 items-center gap-2">
                <FileName name={item.name} title={item.absPath} tailChars={2} className="flex-1" />
                {/* 和文件面板一样，已打开的工作区只标一个小圆点 */}
                {item.open && (
                  <span
                    role="img"
                    aria-label={t("workspace.opened")}
                    title={t("workspace.opened")}
                    className="bg-primary size-1.5 shrink-0 rounded-full"
                  />
                )}
              </span>
              <FileName
                name={item.relPath}
                title={item.absPath}
                tailChars={2}
                className="text-muted-foreground text-[11px]"
              />
            </button>
          ))
        )}
      </div>
      <div className="flex gap-2 border-t px-2 pt-2">
        <Button
          size="sm"
          className="h-7 flex-1 rounded-[6px] text-[13px]"
          onClick={() => {
            onOpened();
            emitResearchEvent("newWorkspace");
          }}
        >
          <Plus />
          {t("workspace.new")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 rounded-[6px] text-[13px]"
          onClick={() => {
            onOpened();
            emitResearchEvent("chooseFolder");
          }}
        >
          <FolderSearch />
          {root ? t("workspace.changeFolder") : t("workspace.chooseFolder")}
        </Button>
      </div>
    </div>
  );
}

/**
 * 科研工作台左侧竖栏：工作区、AI 对话、文件，底部是设置。
 * 按钮只发 research 事件，真正干活的模块各自监听。
 */
export default function ActivityRail({ isClassroomMode }: { isClassroomMode: boolean }) {
  const { t } = useTranslation("research");
  const tabs = useAtomValue(tabsAtom);
  const root = useAtomValue(tabGroupRootAtom);
  const sideStates = useSidePanelStates();
  const [popoverOpen, setPopoverOpen] = useAtom(workspacePopoverOpenAtom);
  const workspaceButtonRef = useRef<HTMLButtonElement>(null);

  // 面板在侧栏里时，按钮亮着表示「侧栏显示着，最前面就是它」；不在侧栏里（定制成了浮动等）时，打开着就算
  const panelShown = (panel: "files" | "ai") => {
    const tab = findResearchPanelTab(panel, tabs);
    if (!tab) return false;
    const group = findTabGroupByTabId(root, tab.id);
    const edge = sideEdgeOfGroup(group?.id);
    return !edge || (isSidePanelShown(sideStates[edge]) && group?.activeTabId === tab.id);
  };
  // 没打开工作区时 AI 对话收起（见 DockedArea），按钮也变灰
  const hasWorkspace = tabs.some((tab) => tab instanceof Project && !tab.closing);
  const activeTab = useAtomValue(activeTabAtom);
  const docked = useAtomValue(dockedChromeAtom);

  return (
    <nav
      aria-label={t("shell.title")}
      data-pg-rail={docked ? "docked" : "floating"}
      className={cn(
        "absolute z-30 flex flex-col items-center gap-[calc(0.25rem*var(--pg-ui-scale,1))] transition-opacity hover:opacity-100",
        // 贴边时和 Obsidian 的竖栏一样：一整条贴着左边，设置沉到最下面
        docked
          ? "bg-background border-border/70 bottom-0 left-0 border-r py-[calc(0.375rem*var(--pg-ui-scale,1))]"
          : "bg-background/95 border-border/60 left-2 rounded-[10px] border p-[calc(0.1875rem*var(--pg-ui-scale,1))] shadow-xs",
        isClassroomMode && "opacity-0",
      )}
      style={docked ? { top: DOCKED_TOP, width: RIBBON_WIDTH } : { top: RESEARCH_FLOAT_TOP }}
    >
      {/* 共用一个 Provider：在相邻按钮之间移动时提示框立刻切换，不用每个都再等一次 */}
      <TooltipProvider>
        <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
          <PopoverAnchor asChild>
            <div>
              <RailButton
                label={t("shell.rail.workspace")}
                keyBindId="researchFocusWorkspace"
                active={popoverOpen}
                buttonRef={workspaceButtonRef}
                onClick={() => {
                  if (popoverOpen) setPopoverOpen(false);
                  else emitResearchEvent("focusWorkspace");
                }}
              >
                <LayoutDashboard />
              </RailButton>
            </div>
          </PopoverAnchor>
          <PopoverContent
            side="right"
            align="start"
            className="w-80 rounded-[8px] p-2"
            onInteractOutside={(event) => {
              // 点竖栏按钮本身由按钮自己切换，避免先被关掉又立刻打开
              if (workspaceButtonRef.current?.contains(event.target as Node)) event.preventDefault();
            }}
          >
            <WorkspaceList onOpened={() => setPopoverOpen(false)} />
          </PopoverContent>
        </Popover>
        <RailButton
          label={t("shell.rail.ai")}
          keyBindId="researchToggleAIChat"
          active={panelShown("ai")}
          unavailableHint={hasWorkspace ? undefined : t("shell.rail.aiNeedsWorkspace")}
          onClick={() => emitResearchEvent("toggleAI")}
        >
          <MessageSquareText />
        </RailButton>
        <RailButton
          label={t("shell.rail.files")}
          keyBindId="researchToggleFileManager"
          active={panelShown("files")}
          onClick={() => emitResearchEvent("toggleFiles")}
          peekEdge="left"
          onPeek={peekFilesPanel}
          hideTooltip={isSidePanelShown(sideStates.left)}
        >
          <FolderOpen />
        </RailButton>
        <RailButton
          label={t("shell.rail.library")}
          keyBindId="researchOpenLibrary"
          active={activeTab instanceof LibraryTab}
          onClick={openLibraryTab}
        >
          <Library />
        </RailButton>
        {!docked && (
          <div className="bg-border/80 my-[calc(0.125rem*var(--pg-ui-scale,1))] h-px w-[calc(1.25rem*var(--pg-ui-scale,1))]" />
        )}
        <div className={cn(docked && "mt-auto")}>
          <RailButton
            label={t("shell.rail.settings")}
            keyBindId="clickAppMenuSettingsButton"
            active={false}
            onClick={() => SettingsWindow.open("settings")}
          >
            <SettingsIcon />
          </RailButton>
        </div>
      </TooltipProvider>
    </nav>
  );
}
