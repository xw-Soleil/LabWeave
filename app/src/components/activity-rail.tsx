import { Button } from "@/components/ui/button";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
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
import { Settings } from "@/core/service/Settings";
import { activeTabAtom, tabsAtom } from "@/state";
import SettingsWindow from "@/sub/SettingsWindow";
import { cn } from "@/utils/cn";
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

function RailButton({
  label,
  active,
  onClick,
  children,
  buttonRef,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  buttonRef?: React.Ref<HTMLButtonElement>;
}) {
  return (
    <Tooltip>
      <TooltipTrigger>
        <Button
          ref={buttonRef}
          variant="ghost"
          aria-label={label}
          aria-pressed={active}
          className={cn(
            "relative size-[calc(2.25rem*var(--pg-ui-scale,1))] rounded-lg p-0 [&_svg:not([class*='size-'])]:size-[calc(1.25rem*var(--pg-ui-scale,1))]",
            active ? "bg-primary/15 text-foreground hover:bg-primary/20" : "text-muted-foreground",
          )}
          onClick={onClick}
        >
          {active && (
            <span className="bg-primary absolute top-1/4 -left-[calc(0.375rem*var(--pg-ui-scale,1))] h-1/2 w-0.5 rounded-full" />
          )}
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
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

  return (
    <div className="flex flex-col gap-2 text-sm">
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-medium">{t("workspace.title")}</span>
        <span className="text-muted-foreground truncate text-xs" title={root}>
          {root ? root.split(/[\\/]/).pop() : t("workspace.noFolder")}
        </span>
      </div>
      <div className="flex max-h-72 flex-col overflow-y-auto">
        {error ? (
          <span className="text-destructive text-xs">{t("workspace.listFailed", { message: error })}</span>
        ) : items === null ? (
          <LoaderCircle className="text-muted-foreground m-2 size-4 animate-spin" />
        ) : items.length === 0 ? (
          <span className="text-muted-foreground text-xs">{root ? t("workspace.empty") : t("workspace.noFolder")}</span>
        ) : (
          items.map((item) => (
            <button
              key={item.absPath}
              type="button"
              className="hover:bg-accent flex cursor-pointer flex-col items-start rounded-md px-2 py-1.5 text-left"
              onClick={() => {
                onOpened();
                openResearchWorkspace(item.absPath).catch((reason: unknown) =>
                  toast.error(t("workspace.failed", { message: String(reason) })),
                );
              }}
            >
              <span className="flex w-full items-center gap-2">
                <span className="truncate">{item.name}</span>
                {item.open && <span className="text-primary shrink-0 text-xs">{t("workspace.opened")}</span>}
              </span>
              <span className="text-muted-foreground w-full truncate text-xs">{item.relPath}</span>
            </button>
          ))
        )}
      </div>
      <div className="flex gap-2 border-t pt-2">
        <Button
          size="sm"
          className="flex-1"
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
          variant="outline"
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
  const activeTab = useAtomValue(activeTabAtom);
  const [popoverOpen, setPopoverOpen] = useAtom(workspacePopoverOpenAtom);
  const workspaceButtonRef = useRef<HTMLButtonElement>(null);

  const filesOpen = findResearchPanelTab("files", tabs) !== undefined;
  const aiOpen = findResearchPanelTab("ai", tabs) !== undefined;

  return (
    <nav
      aria-label={t("shell.title")}
      className={cn(
        "bg-background border-border absolute bottom-0 left-0 z-20 flex flex-col items-center gap-[calc(0.5rem*var(--pg-ui-scale,1))] border-r py-[calc(0.5rem*var(--pg-ui-scale,1))]",
        "top-[calc(2rem*var(--pg-ui-scale,1))] sm:top-[calc(3.5rem*var(--pg-ui-scale,1))]",
        "transition-opacity hover:opacity-100",
        isClassroomMode && "opacity-0",
      )}
      style={{ width: ACTIVITY_RAIL_WIDTH }}
    >
      <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
        <PopoverAnchor asChild>
          <div>
            <RailButton
              label={t("shell.rail.workspace")}
              active={popoverOpen || activeTab instanceof Project}
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
          className="w-80 p-3"
          onInteractOutside={(event) => {
            // 点竖栏按钮本身由按钮自己切换，避免先被关掉又立刻打开
            if (workspaceButtonRef.current?.contains(event.target as Node)) event.preventDefault();
          }}
        >
          <WorkspaceList onOpened={() => setPopoverOpen(false)} />
        </PopoverContent>
      </Popover>
      <RailButton label={t("shell.rail.ai")} active={aiOpen} onClick={() => emitResearchEvent("toggleAI")}>
        <MessageSquareText />
      </RailButton>
      <RailButton label={t("shell.rail.files")} active={filesOpen} onClick={() => emitResearchEvent("toggleFiles")}>
        <FolderOpen />
      </RailButton>
      <div className="mt-auto">
        <RailButton label={t("shell.rail.settings")} active={false} onClick={() => SettingsWindow.open("settings")}>
          <SettingsIcon />
        </RailButton>
      </div>
    </nav>
  );
}
