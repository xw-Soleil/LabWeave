import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Tab } from "@/core/Tab";
import { Project } from "@/core/Project";
import { DocumentTab, documentError } from "@/core/research/DocumentTab";
import { promptResearchRename } from "@/core/research/ResearchRename";
import { isMac } from "@/utils/platform";
import { open } from "@tauri-apps/plugin-shell";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { TabWorkspace } from "@/core/TabWorkspace";
import { AppWindowMac, Columns2, Dock, ExternalLink, Rows2, Save, X } from "lucide-react";
import React from "react";

export default function TabContextMenu({
  tab,
  children,
  onClose,
}: {
  tab: Tab;
  children: React.ReactElement;
  onClose?: (tab: Tab) => void | Promise<void>;
}) {
  const { t } = useTranslation("research");
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        {tab instanceof Project && (
          <ContextMenuItem
            onSelect={() => {
              if (tab.isDraft) void tab.save().catch((error) => toast.error(String(error)));
              else void promptResearchRename(tab.uri.fsPath);
            }}
          >
            {t("rename.title")}
          </ContextMenuItem>
        )}
        {tab instanceof DocumentTab && (
          <>
            {tab.kind === "markdown" && (
              <ContextMenuItem disabled={!tab.markdown || tab.saving} onSelect={() => void tab.save()}>
                <Save />
                {t("document.save")}
                <ContextMenuShortcut>{isMac ? "⌘S" : "Ctrl+S"}</ContextMenuShortcut>
              </ContextMenuItem>
            )}
            <ContextMenuItem onSelect={() => void open(tab.path).catch((error) => toast.error(documentError(error)))}>
              <ExternalLink />
              {t("document.openSystem")}
            </ContextMenuItem>
            <ContextMenuSeparator />
          </>
        )}
        {tab.layout === "docked" ? (
          <>
            <ContextMenuItem onSelect={() => TabWorkspace.split(tab.id, "right")}>
              <Columns2 />
              向右拆分
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => TabWorkspace.split(tab.id, "bottom")}>
              <Rows2 />
              向下拆分
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={() => TabWorkspace.float(tab.id)}>
              <AppWindowMac />
              浮动
            </ContextMenuItem>
          </>
        ) : (
          <ContextMenuItem disabled={!tab.canDock} onSelect={() => TabWorkspace.dock(tab.id)}>
            <Dock />
            停靠
          </ContextMenuItem>
        )}
        {tab.closable && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem variant="destructive" onSelect={() => void (onClose?.(tab) ?? TabWorkspace.close(tab.id))}>
              <X />
              关闭
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}
