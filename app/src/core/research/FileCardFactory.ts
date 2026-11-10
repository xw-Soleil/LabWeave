import { Dialog } from "@/components/ui/dialog";
import type { Project } from "@/core/Project";
import { cardText, extractFileCardContent, extractPdfCardContent } from "@/core/research/FileCardContent";
import { ResearchFolder } from "@/core/research/ResearchFolder";
import { isTemporaryWorkspace } from "./TemporaryWorkspace";
import { fileKindOf } from "@/core/research/ResearchShell";
import { Settings } from "@/core/service/Settings";
import { CollisionBox } from "@/core/stage/stageObject/collisionBox/collisionBox";
import { FileCardNode } from "@/core/stage/stageObject/entity/FileCardNode";
import { PathString } from "@/utils/pathString";
import { Vector } from "@graphif/data-structures";
import { Rectangle } from "@graphif/shapes";
import { exists, readFile } from "@tauri-apps/plugin-fs";
import i18next from "i18next";
import { toast } from "sonner";

const GRID_GAP = 40;
/** 原文件是否存在的检查间隔：渲染时到期才重新检查，免得每帧都去问文件系统 */
const MISSING_RECHECK_INTERVAL_MS = 30_000;
/** 提示里最多列出这么多个文件，免得几十个文件把提示撑满屏幕 */
const MAX_LISTED_NAMES = 5;

function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || path.startsWith("\\") || /^[a-zA-Z]:[\\/]/.test(path);
}

export function fileNameOf(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

// 文件名里的 / 不能被 i18next 转义成 &#x2F;
function dropText(key: string, options: Record<string, unknown> = {}): string {
  return i18next.t(`drop.${key}`, { ns: "research", ...options, interpolation: { escapeValue: false } });
}

/** 提示里的文件名列表：最多列 5 个，再多写「等 N 个」 */
export function listFileNames(paths: string[]): string {
  const listed = paths.slice(0, MAX_LISTED_NAMES).map(fileNameOf).join(dropText("separator"));
  if (paths.length <= MAX_LISTED_NAMES) return listed;
  return listed + dropText("andMore", { count: paths.length });
}

/** 一行一个的出错明细：最多列 5 行，再多时最后一行写「等 N 个」 */
export function listFailureLines(lines: string[]): string {
  const listed = lines.slice(0, MAX_LISTED_NAMES).join("\n");
  if (lines.length <= MAX_LISTED_NAMES) return listed;
  return `${listed}\n${dropText("andMore", { count: lines.length }).trim()}`;
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
 * 卡片里要存的路径：普通本地工程存相对 .prg 所在文件夹的路径，草稿和临时白板存绝对路径。
 * 研究文件夹外直接引用的文件一律存绝对路径：研究文件夹整体搬走时，它们的位置不会跟着变。
 */
export function toStoredSourcePath(project: Project, absPath: string): string {
  if (isTemporaryWorkspace(project)) return ResearchFolder.toAbsolute(absPath);
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
  const content =
    fileKind === "pdf"
      ? await extractPdfCardContent(absPath, fileName, Settings.aiPdfTextPages)
      : await extractFileCardContent(fileKind, await readFile(absPath), fileName);
  if (content.problem) {
    toast.warning(cardText("readProblem", { name: fileName, problem: content.problem }));
  }
  return { absPath, fileKind, content };
}

/** PDF 为纵向封面留出空间，旧卡片保持原位置和尺寸。 */
function fileCardSize({ fileKind, content }: ParsedFile): Vector {
  if (fileKind === "image" && content.imageSize) {
    return FileCardNode.imageCardSize(content.imageSize.width, content.imageSize.height);
  }
  if (fileKind === "pdf") return new Vector(FileCardNode.pdfWidth, FileCardNode.pdfHeight);
  return new Vector(FileCardNode.width, FileCardNode.height);
}

const refreshingCards = new Set<FileCardNode>();

export async function refreshFileCard(project: Project, card: FileCardNode): Promise<void> {
  if (refreshingCards.has(card)) return;
  refreshingCards.add(card);
  const release = markFileCardsPending(project);
  const loading = toast.loading(cardText("refreshing"));
  try {
    const { content } = await parseFile(resolveFileCardPath(project, card));
    if (project.closing || !project.stageManager.getFileCardNodes().includes(card)) return;
    // Preserve the old preview if a damaged/missing source could not be parsed.
    if (card.fileKind === "pdf" && (content.pageCount === 0 || content.problem)) return;
    card.title = content.title;
    card.pageCount = content.pageCount;
    if (content.thumbnail) card.attachmentId = project.addAttachment(content.thumbnail);
    card.excerpt = content.excerpt;
    card.missing = false;
    card.missingCheckedAt = performance.now();
    project.historyManager.recordStep();
  } catch (error) {
    toast.error(cardText("readFailed", { details: String(error) }));
  } finally {
    toast.dismiss(loading);
    refreshingCards.delete(card);
    release();
  }
}

function buildFileCard(project: Project, file: ParsedFile, location: Vector): FileCardNode {
  const { absPath, fileKind, content } = file;
  const card = new FileCardNode(project, {
    title: content.title,
    sourcePath: toStoredSourcePath(project, absPath),
    fileKind,
    attachmentId: content.thumbnail ? project.addAttachment(content.thumbnail) : "",
    excerpt: content.excerpt,
    pageCount: content.pageCount,
    collisionBox: new CollisionBox([new Rectangle(location, fileCardSize(file))]),
  });
  card.missingCheckedAt = performance.now();
  return card;
}

/** 右键「图片标题…」：填了就显示在图片左下角，清空就不显示；不改文件名 */
export async function promptImageCaption(project: Project, card: FileCardNode) {
  const input = await Dialog.input(cardText("caption.title"), cardText("caption.description"), {
    defaultValue: card.caption,
    placeholder: cardText("caption.placeholder"),
  });
  if (input === undefined) return;
  const caption = input.trim();
  if (caption === card.caption) return;
  card.caption = caption;
  project.historyManager.recordStep();
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
  const unsupported = absPaths.filter((path) => fileKindOf(path) === null);
  if (unsupported.length > 0) {
    toast.warning(cardText("unsupported", { names: listFileNames(unsupported) }));
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
      toast.error(cardText("readFailed", { details: listFailureLines(failures) }));
    }
    if (parsed.length === 0) return [];

    const target = project.closing ? (options.retarget?.() ?? null) : { project, worldPos };
    if (!target || target.project.closing) {
      toast.warning(cardText("targetClosed", { count: parsed.length }));
      return [];
    }

    const columns = Math.max(1, Math.ceil(Math.sqrt(parsed.length)));
    // 图片卡片大小不一，格子按这批里最大的卡片算，免得叠在一起
    const sizes = parsed.map(fileCardSize);
    const cellWidth = Math.max(...sizes.map((size) => size.x)) + GRID_GAP;
    const cellHeight = Math.max(...sizes.map((size) => size.y)) + GRID_GAP;
    const cards = parsed.map((file, index) =>
      buildFileCard(
        target.project,
        file,
        target.worldPos.add(new Vector((index % columns) * cellWidth, Math.floor(index / columns) * cellHeight)),
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
