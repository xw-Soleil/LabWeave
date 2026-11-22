import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { LayoutDashboard } from "lucide-react";
import { Fragment, useCallback, useEffect, useState, type ReactElement } from "react";
import { toast } from "sonner";
import type { BoardChoice } from "./BoardPicker";
import { documentError, documentText as t } from "./DocumentTab";

// 白板那一套（工程、标签页）用到才加载，阅读器本身保持轻。
// 鼠标移上去找一次、点开再找一次，挨得很近，两秒内的算同一次（找白板要把研究文件夹扫一遍）
let recent: { at: number; boards: Promise<BoardChoice[]> } | undefined;
function listBoards(): Promise<BoardChoice[]> {
  if (!recent || Date.now() - recent.at > 2000) {
    const boards = import("./BoardPicker").then((module) => module.listBoards());
    recent = { at: Date.now(), boards };
    // 没找成的不留着，下次重新找
    boards.catch(() => {
      if (recent?.boards === boards) recent = undefined;
    });
  }
  return recent.boards;
}

function useBoardChoices(open?: boolean) {
  const [boards, setBoards] = useState<BoardChoice[]>();
  const load = useCallback(
    () =>
      void listBoards().then(setBoards, (error) => {
        setBoards([]);
        toast.error(documentError(error));
      }),
    [],
  );
  useEffect(() => {
    if (open) load();
  }, [open, load]);
  return { boards, load };
}

function BoardMenuList({
  boards,
  onPick,
}: {
  boards: BoardChoice[] | undefined;
  onPick: (board: BoardChoice) => void;
}) {
  return (
    <>
      <DropdownMenuLabel className="text-muted-foreground text-xs font-normal">{t("toBoard.choose")}</DropdownMenuLabel>
      {!boards?.length ? (
        <DropdownMenuItem disabled>{t(boards ? "toBoard.noBoard" : "toBoard.loading")}</DropdownMenuItem>
      ) : (
        boards.map((board, index) => (
          <Fragment key={board.key}>
            {!board.open && boards[index - 1]?.open && <DropdownMenuSeparator />}
            <DropdownMenuItem onSelect={() => onPick(board)}>
              <LayoutDashboard />
              <span className="min-w-0 truncate">{board.name}</span>
              <span className="text-muted-foreground ml-auto max-w-32 shrink-0 truncate pl-3 text-xs">
                {board.open ? t("toBoard.opened") : board.folder}
              </span>
            </DropdownMenuItem>
          </Fragment>
        ))
      )}
    </>
  );
}

/**
 * 「发到白板」：点按钮，在它旁边弹出这个项目里的白板，点哪块发到哪块。
 * 开着的排在前面，没打开的在分隔线下面（选了会在后台打开）。
 * 鼠标一移到按钮上就先去找白板，点开时列表多半已经在了。
 */
export function BoardMenu({
  onPick,
  open,
  onOpenChange,
  children,
}: {
  onPick: (board: BoardChoice) => void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: ReactElement;
}) {
  const { boards, load } = useBoardChoices(open);
  return (
    <DropdownMenu
      open={open}
      onOpenChange={(next) => {
        if (next) load();
        onOpenChange?.(next);
      }}
    >
      <DropdownMenuTrigger asChild onPointerEnter={load} onFocus={load}>
        {children}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-w-80 min-w-48">
        <BoardMenuList boards={boards} onPick={onPick} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** 用在已有下拉菜单 / 右键菜单里的「放到白板」子菜单 */
export function BoardSubMenu({ label, onPick }: { label: string; onPick: (board: BoardChoice) => void }) {
  const { boards, load } = useBoardChoices();
  return (
    <DropdownMenuSub onOpenChange={(open) => open && load()}>
      <DropdownMenuSubTrigger onPointerEnter={load} onFocus={load}>
        <LayoutDashboard />
        {label}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="max-w-80 min-w-48">
        <BoardMenuList boards={boards} onPick={onPick} />
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}
