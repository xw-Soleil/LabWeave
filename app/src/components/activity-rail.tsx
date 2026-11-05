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
  researchFilesVersionAtom,
  workspacePopoverOpenAtom,
  type ResearchWorkspaceItem,
} from "@/core/research/ResearchSession";
import { emitResearchEvent } from "@/core/research/ResearchShell";
import { KeyBindsUI } from "@/core/service/controlService/shortcutKeysEngine/KeyBindsUI";
import { Settings } from "@/core/service/Settings";
import { tabsAtom } from "@/state";
import SettingsWindow from "@/sub/SettingsWindow";
import { cn } from "@/utils/cn";
import { formatKeyBindSequenceToString } from "@/utils/keyDisplay";
import { isMac } from "@/utils/platform";
import { useAtom, useAtomValue } from "jotai";
import {
  FolderOpen,
  FolderSearch,
  LayoutDashboard,
  LoaderCircle,
  MessageSquareText,
  Plus,
  Settings as SettingsIcon,
} from "lucide-react";
import React, { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

/** 竖栏宽度，DockedArea 按这个值往右让出位置；不在缩放层里，所以手动乘 UI 缩放 */
export const ACTIVITY_RAIL_WIDTH = "calc(3rem * var(--pg-ui-scale, 1))";
/** 科研模式标题栏高度（36px，在缩放层里随 UI 缩放）；竖栏和 DockedArea 从它下面开始 */
export const RESEARCH_TITLE_BAR_HEIGHT = "calc(2.25rem * var(--pg-ui-scale, 1))";

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
}: {
  label: string;
  keyBindId: string;
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  buttonRef?: React.Ref<HTMLButtonElement>;
  /** 有值时按钮变灰、点了没反应，提示框改显示这句说明；不用 disabled，否则悬停时不出提示框 */
  unavailableHint?: string;
}) {
  const shortcut = useShortcutText(keyBindId);
  const unavailable = unavailableHint !== undefined;
  return (
    <Tooltip>
      <TooltipTrigger>
        <Button
          ref={buttonRef}
          variant="ghost"
          aria-label={label}
          aria-pressed={unavailable ? undefined : active}
          aria-disabled={unavailable || undefined}
          className={cn(
            "size-[calc(2.5rem*var(--pg-ui-scale,1))] rounded-[6px] p-0 [&_svg:not([class*='size-'])]:size-[calc(1rem*var(--pg-ui-scale,1))]",
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
  const [popoverOpen, setPopoverOpen] = useAtom(workspacePopoverOpenAtom);
  const workspaceButtonRef = useRef<HTMLButtonElement>(null);

  const filesOpen = findResearchPanelTab("files", tabs) !== undefined;
  const aiOpen = findResearchPanelTab("ai", tabs) !== undefined;
  // 没打开工作区时 AI 对话收起（见 DockedArea），按钮也变灰
  const hasWorkspace = tabs.some((tab) => tab instanceof Project && !tab.closing);

  return (
    <nav
      aria-label={t("shell.title")}
      className={cn(
        "bg-background border-border absolute bottom-0 left-0 z-20 flex flex-col items-center gap-[calc(0.25rem*var(--pg-ui-scale,1))] border-r py-[calc(0.25rem*var(--pg-ui-scale,1))]",
        "transition-opacity hover:opacity-100",
        isClassroomMode && "opacity-0",
      )}
      style={{ width: ACTIVITY_RAIL_WIDTH, top: RESEARCH_TITLE_BAR_HEIGHT }}
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
          active={aiOpen}
          unavailableHint={hasWorkspace ? undefined : t("shell.rail.aiNeedsWorkspace")}
          onClick={() => emitResearchEvent("toggleAI")}
        >
          <MessageSquareText />
        </RailButton>
        <RailButton
          label={t("shell.rail.files")}
          keyBindId="researchToggleFileManager"
          active={filesOpen}
          onClick={() => emitResearchEvent("toggleFiles")}
        >
          <FolderOpen />
        </RailButton>
        <div className="mt-auto">
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
