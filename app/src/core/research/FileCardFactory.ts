import type { Project } from "@/core/Project";
import { cardText, extractFileCardContent } from "@/core/research/FileCardContent";
import { ResearchFolder } from "@/core/research/ResearchFolder";
import { fileKindOf } from "@/core/research/ResearchShell";
import { Settings } from "@/core/service/Settings";
import { CollisionBox } from "@/core/stage/stageObject/collisionBox/collisionBox";
import { FileCardNode } from "@/core/stage/stageObject/entity/FileCardNode";
import { PathString } from "@/utils/pathString";
import { Vector } from "@graphif/data-structures";
import { Rectangle } from "@graphif/shapes";
import { exists, readFile } from "@tauri-apps/plugin-fs";
import { toast } from "sonner";

const GRID_GAP = 40;
/** 原文件是否存在的检查间隔：渲染时到期才重新检查，免得每帧都去问文件系统 */
const MISSING_RECHECK_INTERVAL_MS = 30_000;

function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || path.startsWith("\\") || /^[a-zA-Z]:[\\/]/.test(path);
}

function fileNameOf(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/** 工程 .prg 所在文件夹；草稿和协作工程没有，返回 null */
function projectFolder(project: Project): string | null {
  if (project.uri.scheme !== "file") return null;
  return PathString.dirPath(PathString.uppercaseAbsolutePathDiskChar(project.uri.fsPath).replaceAll("\\", "/"));
}

/** 把卡片里存的路径（相对 .prg 所在文件夹，或绝对路径）换成绝对路径 */
export function resolveSourcePath(project: Project, sourcePath: string): string {
  if (isAbsolutePath(sourcePath)) return ResearchFolder.toAbsolute(sourcePath);
  // 草稿里本不该出现相对路径；万一出现（比如从别的工程粘贴过来），按研究文件夹解析
  const baseDir = projectFolder(project) ?? ResearchFolder.getRoot();
  return baseDir ? ResearchFolder.toAbsolute(sourcePath, baseDir) : sourcePath;
}

/** 卡片里要存的路径：存过盘的工程存相对 .prg 所在文件夹的路径，草稿存绝对路径 */
export function toStoredSourcePath(project: Project, absPath: string): string {
  const baseDir = projectFolder(project);
  return baseDir ? ResearchFolder.toRelative(absPath, baseDir) : ResearchFolder.toAbsolute(absPath);
}

/** 返回卡片指向文件的绝对路径 */
export function resolveFileCardPath(project: Project, card: FileCardNode): string {
  return resolveSourcePath(project, card.sourcePath);
}

/** 检查原文件还在不在，更新卡片的 missing 标记并返回它 */
export async function refreshFileCardMissing(project: Project, card: FileCardNode): Promise<boolean> {
  card.missingCheckedAt = performance.now();
  card.missing = !(await exists(resolveFileCardPath(project, card)));
  return card.missing;
}

/** 渲染时调用：到期了就在后台重新检查原文件是否存在 */
export function scheduleFileCardMissingCheck(project: Project, card: FileCardNode): void {
  if (performance.now() - card.missingCheckedAt < MISSING_RECHECK_INTERVAL_MS) return;
  refreshFileCardMissing(project, card).catch((error) => {
    // 检查本身出错（比如没有权限）时不再反复检查，也不把卡片标成丢失
    card.missingCheckedAt = Number.POSITIVE_INFINITY;
    window.dispatchEvent(new ErrorEvent("error", { error }));
  });
}

async function createFileCard(project: Project, absPath: string, location: Vector): Promise<FileCardNode> {
  const fileKind = fileKindOf(absPath)!;
  const fileName = fileNameOf(absPath);
  const bytes = await readFile(absPath);
  const content = await extractFileCardContent(fileKind, bytes, fileName, Settings.aiPdfTextPages);
  if (content.problem) {
    toast.warning(cardText("readProblem", { name: fileName, problem: content.problem }));
  }
  const card = new FileCardNode(project, {
    title: content.title,
    sourcePath: toStoredSourcePath(project, absPath),
    fileKind,
    attachmentId: content.thumbnail ? project.addAttachment(content.thumbnail) : "",
    excerpt: content.excerpt,
    pageCount: content.pageCount,
    collisionBox: new CollisionBox([new Rectangle(location, new Vector(FileCardNode.width, FileCardNode.height))]),
  });
  card.missingCheckedAt = performance.now();
  return card;
}

/**
 * 只处理 pdf / image / markdown；从 worldPos（第一张卡片的左上角）起排成网格。
 * 加到舞台后调一次 updateReferences 和一次 historyManager.recordStep()，这样工程才会被标记为未保存。
 * 某个文件读不了时跳过它并提示，其他文件照常建卡片。
 */
export async function createFileCards(project: Project, absPaths: string[], worldPos: Vector): Promise<FileCardNode[]> {
  const supportedPaths = absPaths.filter((path) => fileKindOf(path) !== null);
  const unsupported = absPaths.filter((path) => fileKindOf(path) === null).map(fileNameOf);
  if (unsupported.length > 0) {
    toast.warning(cardText("unsupported", { names: unsupported.join("、") }));
  }

  const columns = Math.max(1, Math.ceil(Math.sqrt(supportedPaths.length)));
  const cards: FileCardNode[] = [];
  const failures: string[] = [];
  // 解析 PDF 要一两秒，文件多时更久，给个进度提示
  const slow = supportedPaths.length > 3 || supportedPaths.some((path) => fileKindOf(path) === "pdf");
  const loadingToast = slow ? toast.loading(cardText("creating", { count: supportedPaths.length })) : undefined;
  try {
    for (const [index, absPath] of supportedPaths.entries()) {
      const location = worldPos.add(
        new Vector(
          (index % columns) * (FileCardNode.width + GRID_GAP),
          Math.floor(index / columns) * (FileCardNode.height + GRID_GAP),
        ),
      );
      try {
        cards.push(await createFileCard(project, absPath, location));
      } catch (error) {
        failures.push(`${fileNameOf(absPath)}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } finally {
    if (loadingToast !== undefined) toast.dismiss(loadingToast);
  }
  if (failures.length > 0) {
    toast.error(cardText("readFailed", { details: failures.join("\n") }));
  }
  if (cards.length === 0) return cards;

  for (const card of cards) {
    project.stageManager.add(card, true);
  }
  project.stageManager.updateReferences();
  for (const card of cards) {
    const section = project.sectionMethods.getSectionsByInnerLocation(card.geometryCenter)[0];
    if (section) project.stageManager.goInSection([card], section);
  }
  project.historyManager.recordStep();
  return cards;
}
