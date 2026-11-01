import type { FileKind } from "@/core/research/ResearchShell";
import i18next from "i18next";

/** 缩略图最长边（像素），存进 .prg 的附件不需要更大 */
export const THUMBNAIL_MAX_SIZE = 480;
export const MAX_EXCERPT_LENGTH = 4000;

export interface FileCardContent {
  title: string;
  /** 给卡片预览和 AI 看的文字；读不出内容时是一句说明 */
  excerpt: string;
  pageCount: number;
  thumbnail: Blob | null;
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
async function makeImageThumbnail(blob: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(blob);
  try {
    const scale = Math.min(1, THUMBNAIL_MAX_SIZE / Math.max(bitmap.width, bitmap.height));
    const { canvas, context } = createCanvas(bitmap.width * scale, bitmap.height * scale);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return await canvasToBlob(canvas);
  } finally {
    bitmap.close();
  }
}

type PdfJs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
type PdfDocument = Awaited<ReturnType<PdfJs["getDocument"]>["promise"]>;

let pdfJsPromise: Promise<PdfJs> | null = null;

/**
 * pdf.js 只在这里动态加载，命令行版和 FileCardNode 都不会把它打包进去。
 * 用 legacy 版本：最低支持的 macOS 11 自带的 WebKit 太旧，跑不了 pdf.js 的现代版本。
 */
function loadPdfJs(): Promise<PdfJs> {
  pdfJsPromise ??= Promise.all([
    import("pdfjs-dist/legacy/build/pdf.mjs"),
    import("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url"),
  ]).then(
    ([pdfjs, worker]) => {
      pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
      return pdfjs;
    },
    (error) => {
      pdfJsPromise = null;
      throw error;
    },
  );
  return pdfJsPromise;
}

/**
 * pdf.js 的数据文件由 vite-plugins/pdfjs-assets.ts 放在 <BASE_URL>pdfjs/ 下。
 * 没有它们时，没嵌字体的中文 PDF 抽不出字，JPX 图片也画不出缩略图。
 */
function pdfJsAssetUrls() {
  const base = new URL(`${import.meta.env.BASE_URL}pdfjs/`, window.location.href).href;
  return {
    cMapUrl: `${base}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${base}standard_fonts/`,
    wasmUrl: `${base}wasm/`,
    iccUrl: `${base}iccs/`,
  };
}

// 不在这里调 page.cleanup(),整个文档最后由 loadingTask.destroy() 统一释放。
async function renderPdfFirstPage(document: PdfDocument): Promise<Blob> {
  const page = await document.getPage(1);
  const baseViewport = page.getViewport({ scale: 1 });
  const scale = Math.min(THUMBNAIL_MAX_SIZE / baseViewport.width, (THUMBNAIL_MAX_SIZE * 2) / baseViewport.height);
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
async function extractPdfText(document: PdfDocument, pageLimit: number): Promise<string> {
  let text = "";
  for (let pageNumber = 1; pageNumber <= pageLimit && text.length < MAX_EXCERPT_LENGTH; pageNumber++) {
    const page = await document.getPage(pageNumber);
    const reader = page.streamTextContent().getReader();
    try {
      let gotChunk = false;
      while (text.length < MAX_EXCERPT_LENGTH) {
        const chunk = await readWithTimeout(
          reader,
          gotChunk ? NEXT_TEXT_CHUNK_TIMEOUT_MS : FIRST_TEXT_CHUNK_TIMEOUT_MS,
        );
        gotChunk = true;
        if (!chunk || chunk.done || !chunk.value) break;
        for (const item of chunk.value.items) {
          if (typeof item.str !== "string") continue;
          text += item.str;
          if (item.hasEOL) text += "\n";
        }
      }
    } finally {
      // 取消可能已经结束的流会被拒绝,这里只是释放读取器,结果不需要
      reader.cancel().catch(() => undefined);
    }
    text += "\n\n";
  }
  return normalizeExcerpt(text);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function extractPdfContent(
  bytes: Uint8Array<ArrayBuffer>,
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
  const pdfjs = await loadPdfJs();
  const loadingTask = pdfjs.getDocument({
    data: bytes,
    ...pdfJsAssetUrls(),
    // WKWebView 的 worker 里 ImageDecoder / OffscreenCanvas 不可靠:实测带 JPEG 插图的论文(如 ScienceDirect 导出的)
    // 第一页一直画不完,卡片永远停在「正在读取」。关掉后 pdf.js 用自己的 JS 解码,慢一点但稳定。
    isImageDecoderSupported: false,
    isOffscreenCanvasSupported: false,
  });
  try {
    let document: PdfDocument;
    try {
      document = await loadingTask.promise;
    } catch (error) {
      const locked = error instanceof Error && error.name === "PasswordException";
      result.problem = locked ? cardText("pdfLocked") : cardText("pdfBroken", { error: errorMessage(error) });
      result.excerpt = `（${result.problem}）`;
      return result;
    }
    result.pageCount = document.numPages;
    const problems: string[] = [];
    try {
      const { info } = await document.getMetadata();
      result.title = pickPdfTitle((info as { Title?: unknown } | null)?.Title, fileName);
    } catch (error) {
      problems.push(cardText("pdfBroken", { error: errorMessage(error) }));
    }
    // 先抽文字再渲染缩略图:渲染失败不影响 AI 读到正文
    if (textPages > 0) {
      try {
        result.excerpt = await extractPdfText(document, Math.min(textPages, document.numPages));
        if (!result.excerpt) result.excerpt = `（${cardText("pdfNoText")}）`;
      } catch (error) {
        problems.push(cardText("pdfBroken", { error: errorMessage(error) }));
      }
    }
    try {
      result.thumbnail = await renderPdfFirstPage(document);
    } catch (error) {
      problems.push(cardText("thumbnailFailed", { error: errorMessage(error) }));
    }
    result.problem = problems.join("；");
    return result;
  } finally {
    await releasePdf(loadingTask);
  }
}

/** 释放 pdf.js 文档最多等这么久 */
const DESTROY_TIMEOUT_MS = 1000;

/**
 * 实测在 WKWebView 里,内容都抽完以后 loadingTask.destroy() 有时永远不返回(worker 不回结束确认),
 * 直接 await 会让卡片一直停在「正在读取」。这里最多等 1 秒,超时就不等了;
 * 释放本身还在后台进行,出错只记到控制台(内容已经拿到,用户不需要处理)。
 */
async function releasePdf(loadingTask: { destroy(): Promise<void> }): Promise<void> {
  const destroying = loadingTask.destroy().catch((error: unknown) => {
    console.warn("释放 PDF 文档失败", error);
  });
  await Promise.race([destroying, new Promise((resolve) => setTimeout(resolve, DESTROY_TIMEOUT_MS))]);
}

/**
 * 从文件内容抽出卡片要显示的东西。文件本身读不出内容（PDF 有密码、损坏等）不会抛错，
 * 而是返回只有标题和一句说明的结果，problem 里写原因。
 * @param bytes 文件内容；PDF 会把它交给 pdf.js 的 worker，调用后不要再用
 * @param pdfTextPages PDF 抽前几页的文字，0 表示不抽
 */
export async function extractFileCardContent(
  kind: FileKind,
  bytes: Uint8Array<ArrayBuffer>,
  fileName: string,
  pdfTextPages: number,
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
      result.thumbnail = await makeImageThumbnail(new Blob([bytes], { type }));
    } catch (error) {
      result.problem = cardText("thumbnailFailed", { error: errorMessage(error) });
    }
    return result;
  }
  return extractPdfContent(bytes, fileName, pdfTextPages);
}
