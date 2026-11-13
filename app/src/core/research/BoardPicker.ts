import { displayWorkspaceName } from "@/components/ui/file-name";
import { Project } from "@/core/Project";
import { onOpenFile } from "@/core/service/GlobalMenu";
import { getTabGroups, isFixedSideGroupId, updateTabGroup } from "@/core/TabGroup";
import { store, tabGroupRootAtom, tabsAtom } from "@/state";
import i18next from "i18next";
import { URI } from "vscode-uri";
import { ResearchFolder } from "./ResearchFolder";
import { findMainProject, listResearchWorkspaces } from "./ResearchSession";
import { projectPathKey } from "./ResearchWorkspace";

/** 「发到白板」菜单里的一项 */
export interface BoardChoice {
  /** 开着的白板是它的标签 id，没打开的是文件的绝对路径 */
  key: string;
  name: string;
  /** 所在的文件夹（相对研究文件夹）；就在最外层时为空 */
  folder: string;
  open: boolean;
}

/** 白板给人看的名字，和标签上写的一样 */
export function boardName(board: Project): string {
  if (board.isDraft) return i18next.t("tabs.untitled", { ns: "research", n: board.uri.path });
  return board.uri.scheme === "file" ? displayWorkspaceName(board.title) : board.title;
}

let lastPicked: string | undefined;

/** 开着的白板。上次发过去的排最前，其次是主编辑区正显示的那块 */
export function openBoards(): Project[] {
  const boards = store.get(tabsAtom).filter((tab): tab is Project => tab instanceof Project && !tab.closing);
  const main = findMainProject();
  const rank = (board: Project) => (board.id === lastPicked ? 0 : board === main ? 1 : 2);
  return boards.sort((a, b) => rank(a) - rank(b));
}

function folderOf(path: string): string {
  const shown = ResearchFolder.isInside(path) ? ResearchFolder.toRelative(path) : path;
  return shown.slice(0, Math.max(shown.lastIndexOf("/"), shown.lastIndexOf("\\"), 0));
}

/** 能发过去的白板：开着的在前，后面是这个项目里还没打开的（最近改过的在前） */
export async function listBoards(): Promise<BoardChoice[]> {
  const choices: BoardChoice[] = openBoards().map((board) => ({
    key: board.id,
    name: boardName(board),
    folder: board.uri.scheme === "file" && !board.isDraft ? folderOf(board.uri.fsPath) : "",
    open: true,
  }));
  const closed = (await listResearchWorkspaces()).filter((item) => !item.open);
  closed.sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0));
  for (const item of closed)
    choices.push({ key: item.absPath, name: item.name, folder: folderOf(item.absPath), open: false });
  return choices;
}

/**
 * 在后台打开一块白板：标签加进主编辑区，但不切过去，用户正看着的那一页不动。
 * 照常加标签会把它设成那一组正显示的标签（见 insertTabIntoGroup），所以这里自己把它排进组里。
 */
async function openInBackground(path: string): Promise<Project | undefined> {
  const board = await onOpenFile(URI.file(path), "发到白板", undefined, {
    projectSelected: true,
    deferActivation: true,
  });
  if (!board || store.get(tabsAtom).includes(board)) return board;
  const root = store.get(tabGroupRootAtom);
  const main = getTabGroups(root).find((group) => !isFixedSideGroupId(group.id));
  // 主编辑区一个标签都没有时不用管：加进去以后它自然就是显示的那一个
  if (main)
    store.set(
      tabGroupRootAtom,
      updateTabGroup(root, main.id, (group) => ({ ...group, tabIds: [...group.tabIds, board.id] })),
    );
  store.set(tabsAtom, [...store.get(tabsAtom), board]);
  return board;
}

/** 把菜单里选的那一项变成能往上放东西的白板；没打开的先在后台打开。打不开或者已经关了，返回 undefined */
export async function resolveBoard(choice: BoardChoice): Promise<Project | undefined> {
  const boards = store.get(tabsAtom).filter((tab): tab is Project => tab instanceof Project && !tab.closing);
  const board = choice.open
    ? boards.find((tab) => tab.id === choice.key)
    : (boards.find(
        (tab) => tab.uri.scheme === "file" && projectPathKey(tab.uri.fsPath) === projectPathKey(choice.key),
      ) ?? (await openInBackground(choice.key)));
  if (board) lastPicked = board.id;
  return board;
}
