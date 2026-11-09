import type { FileKind } from "@/core/research/ResearchShell";
import i18next from "i18next";
import type { PdfDocument } from "./PdfDocument";

/** PDF 首页缩略图最长边（像素），存进 .prg 的附件不需要更大 */
export const THUMBNAIL_MAX_SIZE = 480;
/** 图片卡片整张显示图片，放大看也要清楚，预览图存大一些 */
export const IMAGE_THUMBNAIL_MAX_SIZE = 1024;
export const MAX_EXCERPT_LENGTH = 4000;

export interface FileCardContent {
  title: string;
  /** Markdown 卡片预览和 AI 用的文字；PDF 摘录只给 AI，不画在卡片上 */
  excerpt: string;
  pageCount: number;
  thumbnail: Blob | null;
  /** 图片的原始宽高，卡片按这个比例定大小；其他类型没有 */
  imageSize?: { width: number; height: number };
  /** 读取时遇到的问题（给用户看的一句话），没有问题时为 "" */
  problem: string;
}

const IMAGE_MIME_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

// 文件名、报错信息里常有 / 和引号，不能被 HTML 转义
export function cardText(key: string, options?: Record<string, unknown>): string {
  return i18next.t(`card.${key}`, { ns: "research", ...options, interpolation: { escapeValue: false } });
}

export function stripExtension(fileName: string): string {
  const dotIndex = fileName.lastIndexOf(".");
  return dotIndex > 0 ? fileName.slice(0, dotIndex) : fileName;
}

function extensionOf(fileName: string): string {
  const dotIndex = fileName.lastIndexOf(".");
  return dotIndex > 0 ? fileName.slice(dotIndex + 1).toLowerCase() : "";
}

/** 合并多余空白（含全角空格），限制长度；保留段落换行，方便卡片分行显示 */
export function normalizeExcerpt(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[^\S\n]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, MAX_EXCERPT_LENGTH);
}

/**
 * 标题取正文里第一个一级标题（`# 标题`），没有就用文件名（去掉扩展名）。
 * 开头的 YAML front matter 不算正文。
 */
export function extractMarkdownContent(text: string, fileName: string): { title: string; excerpt: string } {
  // trimStart 也会去掉 BOM
  let body = text.trimStart();
  const frontMatter = /^---[ \t]*\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(body);
  if (frontMatter) body = body.slice(frontMatter[0].length);
  const heading = /^ {0,3}#[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/m.exec(body);
  const title = heading?.[1].trim() || stripExtension(fileName);
  return { title, excerpt: normalizeExcerpt(body) };
}

/**
 * 很多 PDF 的 Title 元数据是空的，或者是「Microsoft Word - xxx.docx」这类导出工具留下的文件名，
 * 这种情况下文件名更像标题。
 */
export function pickPdfTitle(metadataTitle: unknown, fileName: string): string {
  const fallback = stripExtension(fileName);
  if (typeof metadataTitle !== "string") return fallback;
  const title = metadataTitle.replace(/\s+/g, " ").trim();
  if (title.length < 4) return fallback;
  if (/^microsoft (word|powerpoint) - /i.test(title)) return fallback;
  if (/\.(docx?|pptx?|pdf|tex|dvi|ps|indd|rtf|odt)$/i.test(title)) return fallback;
  if (/^untitled$/i.test(title)) return fallback;
  return title;
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  // 老版本 WebKit 不支持编码 webp 时 toBlob 会退回 PNG，两种都能当附件存
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("thumbnail encoding failed"))), "image/webp", 0.8);
  });
}

function createCanvas(width: number, height: number): { canvas: HTMLCanvasElement; context: CanvasRenderingContext2D } {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas 2D context unavailable");
  return { canvas, context };
}

// 用 DOM canvas 而不是 OffscreenCanvas：最低支持的 macOS 11 自带的 WebKit 没有 OffscreenCanvas 2D
async function makeImageThumbnail(blob: Blob): Promise<{ thumbnail: Blob; width: number; height: number }> {
  const bitmap = await createImageBitmap(blob);
  try {
    const scale = Math.min(1, IMAGE_THUMBNAIL_MAX_SIZE / Math.max(bitmap.width, bitmap.height));
    const { canvas, context } = createCanvas(bitmap.width * scale, bitmap.height * scale);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return { thumbnail: await canvasToBlob(canvas), width: bitmap.width, height: bitmap.height };
  } finally {
    bitmap.close();
  }
}

async function renderPdfFirstPage(document: PdfDocument): Promise<Blob> {
  const page = await document.getPage(1);
  const baseViewport = page.getViewport({ scale: 1 });
  const scale = THUMBNAIL_MAX_SIZE / Math.max(baseViewport.width, baseViewport.height);
  const viewport = page.getViewport({ scale });
  const { canvas, context } = createCanvas(viewport.width, viewport.height);
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  const task = page.render({ canvas, viewport });
  // 渲染一直不结束时取消掉,卡片照样建,只是没有缩略图(调用方会记下原因)
  const timer = setTimeout(() => task.cancel(), RENDER_TIMEOUT_MS);
  try {
    await task.promise;
  } finally {
    clearTimeout(timer);
  }
  return await canvasToBlob(canvas);
}

/** 第一页缩略图最多画这么久 */
const RENDER_TIMEOUT_MS = 15000;

/** 一页的第一块文字最多等这么久(大页面解析要时间) */
const FIRST_TEXT_CHUNK_TIMEOUT_MS = 5000;
/**
 * 收到过文字之后,再等这么久没有新块就当这一页读完了。
 * 结束信号在 WKWebView 里永远不来,这个值直接决定每页要白等多久:原来用 3 秒,三页就白等 9 秒。
 * pdf.js 一页的文字块是连续发过来的,块之间的间隔是毫秒级,300 毫秒足够。
 */
const NEXT_TEXT_CHUNK_TIMEOUT_MS = 300;

type TextChunk = { done: boolean; value?: { items: Array<{ str?: string; hasEOL?: boolean }> } };

function readWithTimeout(reader: ReadableStreamDefaultReader<unknown>, ms: number): Promise<TextChunk | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(null), ms);
    reader.read().then(
      (chunk) => {
        clearTimeout(timer);
        resolve(chunk as TextChunk);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * 不用 page.getTextContent():实测在 Tauri 的 WebView(WKWebView)里,文字块都能收到,
 * 但流的结束信号一直不来,getTextContent 会永远等下去。这里自己读流,
 * 收到结束信号、字数够了、或者一段时间没有新内容,就停下读下一页。
 */
export async function extractPdfText(
  document: PdfDocument,
  pageLimit: number,
  onProblem: (error: unknown) => void,
  signal?: AbortSignal,
): Promise<string> {
  const { pdfWithTimeout } = await import("./PdfDocument");
  let text = "";
  for (let pageNumber = 1; pageNumber <= pageLimit && text.length < MAX_EXCERPT_LENGTH; pageNumber++) {
    if (signal?.aborted) break;
    const page = await pdfWithTimeout(document.getPage(pageNumber), 5000);
    const reader = page.streamTextContent().getReader();
    try {
      let gotChunk = false;
      while (text.length < MAX_EXCERPT_LENGTH) {
        const chunk = await readWithTimeout(
          reader,
          gotChunk ? NEXT_TEXT_CHUNK_TIMEOUT_MS : FIRST_TEXT_CHUNK_TIMEOUT_MS,
        );
        if (!chunk && !gotChunk) {
          onProblem(new Error("pdfTextTimeout"));
          return normalizeExcerpt(text);
        }
        gotChunk = true;
        if (!chunk || chunk.done || !chunk.value) break;
        for (const item of chunk.value.items) {
          if (typeof item.str !== "string") continue;
          text += item.str.slice(0, Math.max(0, MAX_EXCERPT_LENGTH - text.length));
          if (item.hasEOL) text += "\n";
          if (text.length >= MAX_EXCERPT_LENGTH) break;
        }
      }
    } finally {
      try {
        await pdfWithTimeout(reader.cancel(), 1000);
      } catch (error) {
        onProblem(error);
      }
    }
    text += "\n\n";
  }
  return normalizeExcerpt(text);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && ["pdfTimeout", "pdfTextTimeout", "pdfWorkerFailed"].includes(error.message)) {
    return cardText(error.message);
  }
  return error instanceof Error ? error.message : String(error);
}

export async function extractPdfCardContent(
  path: string,
  fileName: string,
  textPages: number,
): Promise<FileCardContent> {
  const result: FileCardContent = {
    title: stripExtension(fileName),
    excerpt: "",
    pageCount: 0,
    thumbnail: null,
    problem: "",
  };
  const { openPdfDocument, pdfWithTimeout } = await import("./PdfDocument");
  const problems: string[] = [];
  const report = (error: unknown) => problems.push(cardText("pdfBroken", { error: errorMessage(error) }));
  const controller = new AbortController();
  let session: Awaited<ReturnType<typeof openPdfDocument>> | undefined;
  try {
    session = await pdfWithTimeout(openPdfDocument(path, report, controller.signal));
    const { document } = session;
    result.pageCount = document.numPages;
    await session.run(
      (async () => {
        try {
          const { info } = await session!.run(document.getMetadata(), 5000);
          result.title = pickPdfTitle((info as { Title?: unknown } | null)?.Title, fileName);
        } catch (error) {
          report(error);
        }
        if (controller.signal.aborted) return;
        try {
          result.thumbnail = await session!.run(renderPdfFirstPage(document), RENDER_TIMEOUT_MS);
        } catch (error) {
          problems.push(cardText("thumbnailFailed", { error: errorMessage(error) }));
        }
        if (controller.signal.aborted) return;
        if (textPages > 0) {
          try {
            result.excerpt = await extractPdfText(
              document,
              Math.min(textPages, document.numPages),
              report,
              controller.signal,
            );
            if (!result.excerpt) result.excerpt = `（${cardText("pdfNoText")}）`;
          } catch (error) {
            report(error);
          }
        }
      })(),
      25000,
    );
  } catch (error) {
    const locked = error instanceof Error && error.name === "PasswordException";
    problems.push(locked ? cardText("pdfLocked") : cardText("pdfBroken", { error: errorMessage(error) }));
  } finally {
    controller.abort();
    await session?.destroy();
  }
  result.problem = [...new Set(problems)].join("；");
  if (!result.excerpt && result.problem) result.excerpt = `（${result.problem}）`;
  return result;
}

/**
 * 图片和 Markdown 的卡片内容；PDF 单独从受限文件句柄按范围读取。
 */
export async function extractFileCardContent(
  kind: Exclude<FileKind, "pdf">,
  bytes: Uint8Array<ArrayBuffer>,
  fileName: string,
): Promise<FileCardContent> {
  if (kind === "markdown") {
    const { title, excerpt } = extractMarkdownContent(new TextDecoder().decode(bytes), fileName);
    return { title, excerpt, pageCount: 0, thumbnail: null, problem: "" };
  }
  if (kind === "image") {
    const result: FileCardContent = {
      title: stripExtension(fileName),
      excerpt: "",
      pageCount: 0,
      thumbnail: null,
      problem: "",
    };
    try {
      const type = IMAGE_MIME_TYPES[extensionOf(fileName)] ?? "";
      const { thumbnail, width, height } = await makeImageThumbnail(new Blob([bytes], { type }));
      result.thumbnail = thumbnail;
      result.imageSize = { width, height };
    } catch (error) {
      result.problem = cardText("thumbnailFailed", { error: errorMessage(error) });
    }
    return result;
  }
  throw new Error("unsupportedFileKind");
}
