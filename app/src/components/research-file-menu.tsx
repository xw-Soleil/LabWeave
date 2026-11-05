import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import type { ResearchFileEntry } from "@/core/research/ResearchFolder";
import { promptResearchRename } from "@/core/research/ResearchRename";
import { promptTrashResearchFile } from "@/core/research/ResearchTrash";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { open } from "@tauri-apps/plugin-shell";
import { Copy, FolderOpen, Pencil, Trash2, File } from "lucide-react";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { URI, Utils } from "vscode-uri";

export default function ResearchFileMenu({
  entry,
  onOpen,
  children,
}: {
  entry: ResearchFileEntry;
  onOpen: () => void;
  children: ReactElement;
}) {
  const { t } = useTranslation("research");
  const run = (action: () => Promise<unknown>) => {
    void action().catch((error) => toast.error(String(error)));
  };
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={onOpen}>
          <File />
          {t("fileMenu.open")}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => run(() => open(Utils.dirname(URI.file(entry.absPath)).fsPath))}>
          <FolderOpen />
          {t("fileMenu.reveal")}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => run(() => writeText(entry.absPath))}>
          <Copy />
          {t("fileMenu.copyPath")}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => run(() => writeText(entry.relPath))}>
          <Copy />
          {t("fileMenu.copyRelativePath")}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => run(() => promptResearchRename(entry.absPath))}>
          <Pencil />
          {t("rename.title")} <span className="ml-auto text-xs">F2</span>
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive" onSelect={() => run(() => promptTrashResearchFile(entry.absPath))}>
          <Trash2 />
          {t("fileMenu.delete")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
