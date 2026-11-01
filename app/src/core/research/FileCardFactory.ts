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

/**
 * 卡片里要存的路径：存过盘的工程存相对 .prg 所在文件夹的路径，草稿存绝对路径。
 * 研究文件夹外直接引用的文件一律存绝对路径：研究文件夹整体搬走时，它们的位置不会跟着变。
 */
export function toStoredSourcePath(project: Project, absPath: string): string {
  if (ResearchFolder.getRoot() && !ResearchFolder.isInside(absPath)) return ResearchFolder.toAbsolute(absPath);
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

/**
 * 复制粘贴用：把序列化结果里每张文件卡片的 sourcePath 换掉，包括 Section 里面内联序列化的卡片。
 * 指向已序列化对象的引用（{ $: "/0/children/0" }）没有 `_`，跳过即可，它和被引用的是同一张卡片。
 */
export function rewriteSerializedFileCardPaths(value: unknown, rewrite: (sourcePath: string) => string): void {
  if (Array.isArray(value)) {
    for (const item of value) rewriteSerializedFileCardPaths(item, rewrite);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  const record = value as Record<string, unknown>;
  if (record._ === "FileCardNode" && typeof record.sourcePath === "string") {
    record.sourcePath = rewrite(record.sourcePath);
  }
  for (const child of Object.values(record)) rewriteSerializedFileCardPaths(child, rewrite);
}

const pendingFileCards = new Map<Project, number>();

/** 标记这块白板上还有卡片没放上去（文件还在复制或解析）；返回撤销标记的函数，多次调用只撤销一次 */
export function markFileCardsPending(project: Project): () => void {
  pendingFileCards.set(project, (pendingFileCards.get(project) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const count = (pendingFileCards.get(project) ?? 1) - 1;
    if (count > 0) {
      pendingFileCards.set(project, count);
    } else {
      pendingFileCards.delete(project);
    }
  };
}

/** 这块白板看着是空的，其实卡片马上要放上来；自动关闭空草稿时应该跳过它 */
export function hasPendingFileCards(project: Project): boolean {
  return pendingFileCards.has(project);
}

export interface FileCardTarget {
  project: Project;
  worldPos: Vector;
}

export interface CreateFileCardsOptions {
  /** 解析期间目标白板被关掉时，改放到哪里；返回 null 或不传时提示用户，不建卡片 */
  retarget?: () => FileCardTarget | null;
}

interface ParsedFile {
  absPath: string;
  fileKind: NonNullable<ReturnType<typeof fileKindOf>>;
  content: Awaited<ReturnType<typeof extractFileCardContent>>;
}

async function parseFile(absPath: string): Promise<ParsedFile> {
  const fileKind = fileKindOf(absPath)!;
  const fileName = fileNameOf(absPath);
  const bytes = await readFile(absPath);
  const content = await extractFileCardContent(fileKind, bytes, fileName, Settings.aiPdfTextPages);
  if (content.problem) {
    toast.warning(cardText("readProblem", { name: fileName, problem: content.problem }));
  }
  return { absPath, fileKind, content };
}

function buildFileCard(project: Project, { absPath, fileKind, content }: ParsedFile, location: Vector): FileCardNode {
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
 * 先把所有文件解析完再建卡片：解析要好几秒，期间目标白板可能被关掉（比如打开工作区时自动关掉了空草稿），
 * 这时卡片和缩略图都要放到 options.retarget 给的白板上，不能加到已关闭的工程里。
 */
export async function createFileCards(
  project: Project,
  absPaths: string[],
  worldPos: Vector,
  options: CreateFileCardsOptions = {},
): Promise<FileCardNode[]> {
  const supportedPaths = absPaths.filter((path) => fileKindOf(path) !== null);
  const unsupported = absPaths.filter((path) => fileKindOf(path) === null).map(fileNameOf);
  if (unsupported.length > 0) {
    toast.warning(cardText("unsupported", { names: unsupported.join("、") }));
  }

  const release = markFileCardsPending(project);
  try {
    const parsed: ParsedFile[] = [];
    const failures: string[] = [];
    // 解析 PDF 要一两秒，文件多时更久，给个进度提示
    const slow = supportedPaths.length > 3 || supportedPaths.some((path) => fileKindOf(path) === "pdf");
    const loadingToast = slow ? toast.loading(cardText("creating", { count: supportedPaths.length })) : undefined;
    try {
      for (const absPath of supportedPaths) {
        try {
          parsed.push(await parseFile(absPath));
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
    if (parsed.length === 0) return [];

    const target = project.closing ? (options.retarget?.() ?? null) : { project, worldPos };
    if (!target || target.project.closing) {
      toast.warning(cardText("targetClosed", { count: parsed.length }));
      return [];
    }

    const columns = Math.max(1, Math.ceil(Math.sqrt(parsed.length)));
    const cards = parsed.map((file, index) =>
      buildFileCard(
        target.project,
        file,
        target.worldPos.add(
          new Vector(
            (index % columns) * (FileCardNode.width + GRID_GAP),
            Math.floor(index / columns) * (FileCardNode.height + GRID_GAP),
          ),
        ),
      ),
    );
    const { stageManager, sectionMethods, historyManager } = target.project;
    for (const card of cards) {
      stageManager.add(card, true);
    }
    stageManager.updateReferences();
    for (const card of cards) {
      const section = sectionMethods.getSectionsByInnerLocation(card.geometryCenter)[0];
      if (section) stageManager.goInSection([card], section);
    }
    historyManager.recordStep();
    return cards;
  } finally {
    release();
  }
}
