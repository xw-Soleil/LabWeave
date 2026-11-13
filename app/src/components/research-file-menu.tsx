import { CommandDialog, CommandEmpty, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { documentError, openDocumentFile } from "@/core/research/DocumentTab";
import { ResearchFolder, type ResearchFileEntry } from "@/core/research/ResearchFolder";
import { moveResearchFile } from "@/core/research/ResearchRename";
import { promptTrashResearchFile } from "@/core/research/ResearchTrash";
import { findTabGroupByTabId } from "@/core/TabGroup";
import { TabWorkspace } from "@/core/TabWorkspace";
import { store, tabGroupRootAtom } from "@/state";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { open } from "@tauri-apps/plugin-shell";
import {
  Columns2,
  Copy,
  CopyPlus,
  ExternalLink,
  File,
  Folder,
  FolderInput,
  FolderOpen,
  Pencil,
  Trash2,
} from "lucide-react";
import { isMac } from "@/utils/platform";
import { useEffect, useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { URI, Utils } from "vscode-uri";

const folderOf = (path: string) => path.slice(0, Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")));
const revealInPanel = (path: string) =>
  import("@/sub/FileManagerWindow").then(({ default: panel }) => panel.reveal(path));

/** 照 Obsidian 的「将文件移动到…」：列出研究文件夹里的文件夹，打字筛选，选一个就挪过去 */
function MoveDialog({ path, onClose }: { path: string; onClose: () => void }) {
  const { t } = useTranslation("research");
  const [folders, setFolders] = useState<string[]>();
  useEffect(() => {
    ResearchFolder.listFolders()
      .then(setFolders)
      .catch((error) => {
        setFolders([]);
        toast.error(documentError(error));
      });
  }, []);
  const label = (folder: string) => ResearchFolder.toRelative(folder) || "/";
  const current = folderOf(path);
  return (
    <CommandDialog
      open
      onOpenChange={(value) => !value && onClose()}
      title={t("fileMenu.moveTitle")}
      description={Utils.basename(URI.file(path))}
    >
      <CommandInput placeholder={t("fileMenu.movePlaceholder")} />
      <CommandList>
        <CommandEmpty>{folders ? t("fileMenu.moveEmpty") : t("files.loading")}</CommandEmpty>
        {folders
          ?.filter((folder) => folder !== current)
          .map((folder) => (
            <CommandItem
              key={folder}
              value={label(folder)}
              onSelect={() => {
                onClose();
                moveResearchFile(path, folder)
                  .then((moved) => {
                    toast.success(t("fileMenu.moved", { name: label(folder) }));
                    return revealInPanel(moved);
                  })
                  .catch((error) => toast.error(documentError(error)));
              }}
            >
              <Folder />
              {label(folder)}
            </CommandItem>
          ))}
      </CommandList>
    </CommandDialog>
  );
}

/** 文件栏里文件的右键菜单，照 Obsidian 排：打开 → 副本、移动 → 复制路径 → 系统 → 改名、删除 */
export default function ResearchFileMenu({
  entry,
  onOpen,
  onRename,
  beforeModify,
  children,
}: {
  entry: ResearchFileEntry;
  onOpen: () => void;
  /** 在文件栏那一行上原位改名（由文件栏自己做，包括先切到文件所在的项目） */
  onRename: () => void;
  beforeModify?: () => Promise<boolean>;
  children: ReactElement;
}) {
  const { t } = useTranslation("research");
  const [moving, setMoving] = useState(false);
  const renameOnClose = useRef(false);
  const run = (action: () => Promise<unknown>) => {
    void action().catch((error) => toast.error(documentError(error)));
  };
  const modify = (action: () => Promise<unknown>) =>
    run(async () => {
      if (!beforeModify || (await beforeModify())) await action();
    });
  const kind = entry.kind;
  const isDocument = kind === "markdown" || kind === "pdf" || kind === "image";
  const board = kind === "workspace";
  const name = Utils.basename(URI.file(entry.absPath));
  // 在右侧分屏打开：先照常打开，再把它的标签挪到所在标签组的右边（组里只有它一个时就不用分了）
  const openRight = async () => {
    const tab = await openDocumentFile(entry.absPath);
    if (!tab) return;
    const group = findTabGroupByTabId(store.get(tabGroupRootAtom), tab.id);
    if (group && group.tabIds.length > 1) TabWorkspace.moveTab(tab.id, { groupId: group.id, edge: "right" });
  };
  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
        <ContextMenuContent
          // 菜单关掉时会把焦点还给那一行。改名的输入框要是先出来，焦点一被拿走就等于立刻确认了，
          // 所以等菜单关完、并且不让它还焦点，再开始改名
          onCloseAutoFocus={(event) => {
            if (!renameOnClose.current) return;
            renameOnClose.current = false;
            event.preventDefault();
            onRename();
          }}
        >
          <ContextMenuItem onSelect={onOpen}>
            <File />
            {t("fileMenu.open")}
          </ContextMenuItem>
          {isDocument && (
            <ContextMenuItem onSelect={() => run(openRight)}>
              <Columns2 />
              {t("fileMenu.openRight")}
            </ContextMenuItem>
          )}
          <ContextMenuSeparator />
          <ContextMenuItem
            disabled={board}
            onSelect={() => run(() => ResearchFolder.duplicateFile(entry.absPath).then(revealInPanel))}
          >
            <CopyPlus />
            {t("fileMenu.duplicate")}
          </ContextMenuItem>
          <ContextMenuItem disabled={board} onSelect={() => modify(async () => setMoving(true))}>
            <FolderInput />
            {t("fileMenu.moveTo")}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuSub>
            <ContextMenuSubTrigger>
              <Copy />
              {t("fileMenu.copyPathMenu")}
            </ContextMenuSubTrigger>
            <ContextMenuSubContent>
              <ContextMenuItem onSelect={() => run(() => writeText(entry.absPath))}>
                {t("fileMenu.copyAbsolute")}
              </ContextMenuItem>
              <ContextMenuItem onSelect={() => run(() => writeText(entry.relPath))}>
                {t("fileMenu.copyRelative")}
              </ContextMenuItem>
              {isDocument && (
                <ContextMenuItem
                  onSelect={() =>
                    run(() => writeText(`[[${kind === "markdown" ? name.replace(/\.md$/i, "") : name}]]`))
                  }
                >
                  {t("fileMenu.copyWikilink")}
                </ContextMenuItem>
              )}
            </ContextMenuSubContent>
          </ContextMenuSub>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => run(() => open(entry.absPath))}>
            <ExternalLink />
            {t("document.openSystem")}
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => run(() => open(Utils.dirname(URI.file(entry.absPath)).fsPath))}>
            <FolderOpen />
            {t("fileMenu.reveal")}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            onSelect={() => {
              renameOnClose.current = true;
            }}
          >
            <Pencil />
            {t("rename.title")} <span className="ml-auto text-xs">{isMac ? "↩" : "F2"}</span>
          </ContextMenuItem>
          <ContextMenuItem variant="destructive" onSelect={() => modify(() => promptTrashResearchFile(entry.absPath))}>
            <Trash2 />
            {t("fileMenu.delete")}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {moving && <MoveDialog path={entry.absPath} onClose={() => setMoving(false)} />}
    </>
  );
}
