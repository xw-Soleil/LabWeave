import { OverlayHost } from "@/components/overlay-host";
import { CommandDialog, CommandEmpty, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { displayWorkspaceName } from "@/components/ui/file-name";
import { Project } from "@/core/Project";
import { store, tabsAtom } from "@/state";
import i18next from "i18next";
import { LayoutDashboard } from "lucide-react";
import { useState } from "react";
import { ResearchFolder } from "./ResearchFolder";
import { findMainProject } from "./ResearchSession";

const t = (key: string, options?: Record<string, unknown>) => i18next.t(key, { ns: "research", ...options });

/** 白板给人看的名字，和标签上写的一样 */
export function boardName(board: Project): string {
  if (board.isDraft) return t("tabs.untitled", { n: board.uri.path });
  return board.uri.scheme === "file" ? displayWorkspaceName(board.title) : board.title;
}

let lastPicked: string | undefined;

/** 开着的白板。上次选的排最前，其次是主编辑区正显示的那块 */
export function openBoards(): Project[] {
  const boards = store.get(tabsAtom).filter((tab): tab is Project => tab instanceof Project && !tab.closing);
  const main = findMainProject();
  const rank = (board: Project) => (board.id === lastPicked ? 0 : board === main ? 1 : 2);
  return boards.sort((a, b) => rank(a) - rank(b));
}

/**
 * 要往白板上放东西时定下放到哪一块：只开着一块就是它，开着几块就列出来让用户选（照「移动到哪个文件夹」的样子）。
 * 没有开着的白板、或者用户关掉了列表，返回 undefined。
 */
export function chooseBoard(): Promise<Project | undefined> {
  const boards = openBoards();
  if (boards.length < 2) return Promise.resolve(boards[0]);
  return new Promise((resolve) => {
    function Picker({ overlayId }: { overlayId?: string }) {
      const [open, setOpen] = useState(true);
      const finish = (board?: Project) => {
        if (board) lastPicked = board.id;
        resolve(board);
        setOpen(false);
        // 等关闭动画放完再卸载
        setTimeout(() => OverlayHost.close(overlayId!), 300);
      };
      return (
        <CommandDialog
          open={open}
          onOpenChange={(next) => !next && finish()}
          title={t("boardPicker.title")}
          description={t("boardPicker.hint")}
        >
          <CommandInput placeholder={t("boardPicker.placeholder")} />
          <CommandList>
            <CommandEmpty>{t("boardPicker.empty")}</CommandEmpty>
            {boards.map((board) => {
              const name = boardName(board);
              const file = board.uri.scheme === "file" && !board.isDraft ? board.uri.fsPath : "";
              const path = file && ResearchFolder.isInside(file) ? ResearchFolder.toRelative(file) : file;
              return (
                // value 带上 id：两块白板重名时也各是各的一项
                <CommandItem key={board.id} value={`${name} ${path} ${board.id}`} onSelect={() => finish(board)}>
                  <LayoutDashboard />
                  <span className="min-w-0 truncate">{name}</span>
                  {path && <span className="text-muted-foreground ml-auto min-w-0 truncate text-xs">{path}</span>}
                </CommandItem>
              );
            })}
          </CommandList>
        </CommandDialog>
      );
    }
    OverlayHost.open(<Picker />);
  });
}
