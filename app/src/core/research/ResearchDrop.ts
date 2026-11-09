import { Dialog } from "@/components/ui/dialog";
import { Project } from "@/core/Project";
import {
  createFileCards,
  listFailureLines,
  listFileNames,
  markFileCardsPending,
} from "@/core/research/FileCardFactory";
import { notifyResearchFilesChanged, ResearchFolder } from "@/core/research/ResearchFolder";
import { fileKindOf } from "@/core/research/ResearchShell";
import type { WorkspaceOpenOrigin } from "./TemporaryWorkspace";
import { onOpenFile } from "@/core/service/GlobalMenu";
import { Settings } from "@/core/service/Settings";
import { CollisionBox } from "@/core/stage/stageObject/collisionBox/collisionBox";
import { TextNode } from "@/core/stage/stageObject/entity/TextNode";
import { findTabGroup } from "@/core/TabGroup";
import { TabWorkspace } from "@/core/TabWorkspace";
import { activeResourceTabAtom, activeTabAtom, store, tabGroupRootAtom, tabsAtom } from "@/state";
import { Vector } from "@graphif/data-structures";
import { Rectangle } from "@graphif/shapes";
import { invoke } from "@tauri-apps/api/core";
import { copyFile, exists, mkdir } from "@tauri-apps/plugin-fs";
import i18next from "i18next";
import { toast } from "sonner";
import { URI } from "vscode-uri";

/** 研究文件夹外的文件复制到研究文件夹的这个子文件夹里 */
export const IMPORT_DIR_NAME = "导入";

// 文件名和路径里的 / 不能被 i18next 转义成 &#x2F;
function t(key: string, options: Record<string, unknown> = {}): string {
  return i18next.t(key, { ns: "research", ...options, interpolation: { escapeValue: false } });
}

export interface DroppedPaths {
  /** .prg，作为工作区打开 */
  workspaces: string[];
  /** pdf / 图片 / markdown，做成文件卡片 */
  cards: string[];
  unsupported: string[];
}

export function splitDroppedPaths(absPaths: string[]): DroppedPaths {
  const result: DroppedPaths = { workspaces: [], cards: [], unsupported: [] };
  for (const path of absPaths) {
    if (/\.prg$/i.test(path)) {
      result.workspaces.push(path);
    } else if (fileKindOf(path)) {
      result.cards.push(path);
    } else {
      result.unsupported.push(path);
    }
  }
  return result;
}

export interface ClientPoint {
  x: number;
  y: number;
}

/** 窗口客户区左上角的屏幕坐标（物理像素）和缩放比 */
export interface ScreenOrigin {
  x: number;
  y: number;
  scaleFactor: number;
}

/** Windows 的 pg-drag-drop 来自 IDropTarget，坐标是屏幕上的物理像素 */
export function screenToClientPoint(screen: ClientPoint, origin: ScreenOrigin): ClientPoint {
  const scale = origin.scaleFactor > 0 ? origin.scaleFactor : 1;
  return { x: (screen.x - origin.x) / scale, y: (screen.y - origin.y) / scale };
}

/**
 * Tauri 文档把 onDragDropEvent 的坐标标成相对 webview 的物理像素，但 wry 在 macOS（AppKit 的 draggingLocation）
 * 和 Linux（GTK 控件坐标）上传过来的其实已经是 CSS 像素，只有 Windows 是物理像素。
 * 在 macOS 上照文档除以 devicePixelRatio，Retina 屏上的落点会缩到一半。
 */
export function webviewDropPositionToClient(
  position: ClientPoint,
  positionIsPhysical: boolean,
  devicePixelRatio: number,
): ClientPoint {
  if (!positionIsPhysical || devicePixelRatio <= 0) return { x: position.x, y: position.y };
  return { x: position.x / devicePixelRatio, y: position.y / devicePixelRatio };
}

export function fileNameOf(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/** 第 n 个候选名：n<=1 是原名，之后是「名字 (n).扩展名」 */
export function numberedFileName(fileName: string, n: number): string {
  if (n <= 1) return fileName;
  const dotIndex = fileName.lastIndexOf(".");
  if (dotIndex <= 0) return `${fileName} (${n})`;
  return `${fileName.slice(0, dotIndex)} (${n})${fileName.slice(dotIndex)}`;
}

/** 从原名开始依次试「 (2)」「 (3)」……，返回第一个没被占用的名字 */
export async function findFreeFileName(fileName: string, isTaken: (name: string) => Promise<boolean>): Promise<string> {
  for (let n = 1; ; n++) {
    const candidate = numberedFileName(fileName, n);
    if (!(await isTaken(candidate))) return candidate;
  }
}

/**
 * 找鼠标下面的白板：取包含这个点的最小标签组，看它当前显示的是不是工程。
 * 和 docked-area 一样，组里没有记录 activeTabId 时取最后一个停靠的标签。
 */
export function findBoardAtClientPoint(clientX: number, clientY: number): Project | undefined {
  const target = TabWorkspace.getDropTarget(clientX, clientY);
  if (!target) return undefined;
  const group = findTabGroup(store.get(tabGroupRootAtom), target.groupId);
  if (!group) return undefined;
  const groupTabs = store.get(tabsAtom).filter((tab) => tab.layout === "docked" && group.tabIds.includes(tab.id));
  const shownTab = groupTabs.find((tab) => tab.id === group.activeTabId) ?? groupTabs.at(-1);
  return shownTab instanceof Project ? shownTab : undefined;
}

/** 点不在这块白板的画布上时返回 null */
export function clientPointToWorld(project: Project, clientX: number, clientY: number): Vector | null {
  const rect = project.canvas.element.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return null;
  if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) return null;
  return project.renderer.transformView2World(project.canvas.clientToView(clientX, clientY));
}

export interface DropTarget {
  project: Project;
  worldPos: Vector;
}

/**
 * 鼠标下面有白板就放在鼠标位置；否则（比如松手在文件面板上）放到当前白板的视野中心。
 * 一块白板都没打开时返回 null。
 */
export function resolveDropTarget(clientX: number, clientY: number): DropTarget | null {
  const board = findBoardAtClientPoint(clientX, clientY);
  if (board) {
    return { project: board, worldPos: clientPointToWorld(board, clientX, clientY) ?? board.camera.location.clone() };
  }
  const active = store.get(activeResourceTabAtom);
  if (active instanceof Project) return { project: active, worldPos: active.camera.location.clone() };
  return null;
}

function focusBoard(project: Project) {
  if (store.get(activeTabAtom) !== project) TabWorkspace.focus(project.id);
}

/**
 * 研究文件夹外的文件复制到 <研究文件夹>/导入/，重名时加「 (2)」；返回放上白板要用的路径，顺序不变。
 * 某个文件复制失败时跳过它，其余照常复制、放上白板，最后一起提示哪些没复制成。
 */
async function copyOutsideFilesIntoFolder(paths: string[], root: string): Promise<string[]> {
  const importDir = ResearchFolder.toAbsolute(IMPORT_DIR_NAME, root);
  const result: string[] = [];
  const failures: string[] = [];
  let copiedCount = 0;
  let importDirReady: Promise<void> | undefined;
  for (const path of paths) {
    if (ResearchFolder.isInside(path)) {
      result.push(path);
      continue;
    }
    try {
      // 只建「导入」这一层，不递归：研究文件夹本身不在了就该报错，不能悄悄重建一个空壳文件夹
      importDirReady ??= exists(importDir).then((found) => (found ? undefined : mkdir(importDir)));
      await importDirReady;
      const name = await findFreeFileName(fileNameOf(path), (candidate) =>
        exists(ResearchFolder.toAbsolute(candidate, importDir)),
      );
      const destination = ResearchFolder.toAbsolute(name, importDir);
      await copyFile(path, destination);
      result.push(destination);
      copiedCount++;
    } catch (error) {
      failures.push(`${fileNameOf(path)}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (copiedCount > 0) {
    // 只写研究文件夹里的相对位置：完整路径太长，提示框里放不下
    toast.success(t("drop.copied", { count: copiedCount, folder: `${IMPORT_DIR_NAME}/` }));
    notifyResearchFilesChanged();
  }
  if (failures.length > 0) {
    toast.error(t("drop.copyFailed", { details: listFailureLines(failures) }));
  }
  return result;
}

/**
 * 研究文件夹路径在设置里是自由文本，可能已经被改名、移走或者打错了。
 * 能用时返回 null，否则返回给用户看的原因。
 */
async function researchRootProblem(): Promise<string | null> {
  try {
    await ResearchFolder.ensureRootRegistered();
    // 本次运行里登记过的路径不会再交给 Rust 检查，之后才被改名或移走的要靠 exists 发现
    if (await exists(ResearchFolder.getRoot())) return null;
    return t("drop.missingFolder.notFound");
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** 没有能用的研究文件夹：让用户当场选一个（选完接着放，不用再拖一次），或者先直接引用原文件 */
async function pathsWithoutFolder(paths: string[], title: string, description: string): Promise<string[] | null> {
  const choice = await Dialog.buttons(title, description, [
    { id: "cancel", label: t("drop.cancel"), variant: "ghost" },
    { id: "original", label: t("drop.noFolder.useOriginal"), variant: "outline" },
    { id: "choose", label: t("drop.noFolder.choose") },
  ] as const);
  if (choice === "cancel") return null;
  if (choice === "original") return paths;
  const chosenRoot = await ResearchFolder.chooseRoot();
  if (!chosenRoot) return null;
  // 对话框里已经说过会复制，这里不再问第二次
  return copyOutsideFilesIntoFolder(paths, chosenRoot);
}

/**
 * 决定卡片用哪些路径。用户取消时返回 null。
 * 没选研究文件夹、或者选过的文件夹已经不在了时不直接拒绝，免得一次拖放白做。
 */
async function pathsForCards(paths: string[]): Promise<string[] | null> {
  if (!ResearchFolder.getRoot()) {
    return pathsWithoutFolder(paths, t("drop.noFolder.title"), t("drop.noFolder.description"));
  }

  const outside = paths.filter((path) => !ResearchFolder.isInside(path));
  if (outside.length === 0) return paths;
  // 设置里选了「总是直接引用」：不问、不复制，卡片指向原文件
  if (Settings.researchOutsideFileMode === "reference") return paths;
  const problem = await researchRootProblem();
  if (problem !== null) {
    return pathsWithoutFolder(
      paths,
      t("drop.missingFolder.title"),
      t("drop.missingFolder.description", { folder: ResearchFolder.getRoot(), error: problem }),
    );
  }
  // 登记时可能换成了规范路径
  const root = ResearchFolder.getRoot();
  if (Settings.researchOutsideFileMode === "copy") return copyOutsideFilesIntoFolder(paths, root);
  const importDir = ResearchFolder.toAbsolute(IMPORT_DIR_NAME, root);
  const choice = await Dialog.buttons(
    t("drop.copy.title"),
    t("drop.copy.description", { folder: `${importDir}/`, names: outside.map(fileNameOf).join("\n") }),
    [
      { id: "cancel", label: t("drop.cancel"), variant: "ghost" },
      { id: "reference", label: t("drop.copy.reference"), variant: "outline" },
      { id: "copy", label: t("drop.copy.confirm") },
    ] as const,
  );
  if (choice === "reference") return paths;
  if (choice !== "copy") return null;
  return copyOutsideFilesIntoFolder(paths, root);
}

function isOpenBoard(project: Project): boolean {
  return !project.closing && store.get(tabsAtom).includes(project);
}

/** 目标白板还开着就用它；已经关掉了（比如空草稿被自动关闭）就改放到当前白板的视野中心 */
function liveDropTarget(target: DropTarget | null): DropTarget | null {
  if (target && isOpenBoard(target.project)) return target;
  const active = store.get(activeResourceTabAtom);
  if (active instanceof Project && isOpenBoard(active)) {
    return { project: active, worldPos: active.camera.location.clone() };
  }
  return null;
}

async function dropCards(paths: string[], target: DropTarget | null) {
  if (!target) {
    toast.warning(t("drop.noBoard"));
    return;
  }
  // 复制和解析要等一会儿，这期间目标往往还是空草稿，标记一下，免得被当成没用的空草稿关掉
  const release = markFileCardsPending(target.project);
  try {
    const cardPaths = await pathsForCards(paths);
    if (!cardPaths || cardPaths.length === 0) return;
    const live = liveDropTarget(target);
    if (!live) {
      toast.warning(t("card.targetClosed", { count: cardPaths.length }));
      return;
    }
    focusBoard(live.project);
    await createFileCards(live.project, cardPaths, live.worldPos, {
      retarget: () => {
        const next = liveDropTarget(null);
        if (next) focusBoard(next.project);
        return next;
      },
    });
  } finally {
    release();
  }
}

/**
 * 把文件放到鼠标下面的白板上。文件面板拖拽松手和 Finder 拖入都走这里。
 * - pdf / 图片 / markdown 做成文件卡片；研究文件夹外的先问要不要复制到研究文件夹的「导入/」子文件夹
 * - .prg 走 onOpenFile 打开（放在卡片之后，否则新标签页会盖住目标白板）
 * - 其他类型提示暂不支持
 */
export async function dropFilesAtClientPoint(absPaths: string[], clientX: number, clientY: number): Promise<void> {
  // 先定下目标白板：后面的对话框不会切换标签页，但打开 .prg 会
  await placeFiles(absPaths, resolveDropTarget(clientX, clientY), "file-drop");
}

/**
 * Cmd+V 时剪贴板里是在访达 / 资源管理器里复制的文件，就和拖进来一样处理，放在 worldPos。
 * 剪贴板里没有文件时返回 false，由调用方照常贴文字或图片（访达复制文件时剪贴板里还有文件名文字和图标）。
 */
export async function pasteClipboardFiles(project: Project, worldPos: Vector): Promise<boolean> {
  const paths = await invoke<string[]>("read_clipboard_file_paths");
  if (paths.length === 0) return false;
  await placeFiles(paths, { project, worldPos }, "file-paste");
  return true;
}

async function placeFiles(absPaths: string[], target: DropTarget | null, origin: WorkspaceOpenOrigin): Promise<void> {
  const { workspaces, cards, unsupported } = splitDroppedPaths(absPaths);
  if (unsupported.length > 0) toast.warning(t("drop.unsupported", { names: listFileNames(unsupported) }));
  let cardFailure: { error: unknown } | null = null;
  if (cards.length > 0) {
    try {
      await dropCards(cards, target);
    } catch (error) {
      cardFailure = { error };
    }
  }
  for (const path of workspaces) {
    await onOpenFile(URI.file(path), "拖拽或粘贴prg文件到舞台", origin);
  }
  // 卡片出错不挡住同一次拖进来的 .prg；错误照样抛给调用方提示用户
  if (cardFailure) throw cardFailure.error;
}

/** 从别的程序拖进来的一段文字，在鼠标位置生成文本节点 */
export function dropTextAtClientPoint(text: string, clientX: number, clientY: number): void {
  const trimmed = text.trim();
  if (!trimmed) return;
  const target = resolveDropTarget(clientX, clientY);
  if (!target) {
    toast.warning(t("drop.noBoard"));
    return;
  }
  const { project, worldPos } = target;
  focusBoard(project);
  project.stageManager.add(
    new TextNode(project, {
      text: trimmed,
      collisionBox: new CollisionBox([new Rectangle(worldPos, new Vector(300, 150))]),
      sizeAdjust: "manual",
    }),
  );
  // 只有 recordStep 会把工程标成未保存，自动保存才会存它
  project.historyManager.recordStep();
}
