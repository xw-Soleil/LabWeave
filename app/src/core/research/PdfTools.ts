import { store, tabsAtom } from "@/state";
import { lstat } from "@tauri-apps/plugin-fs";
import { PdfPermissionFlag, type PdfDocumentObject } from "@embedpdf/models";
import { DocumentTab } from "./DocumentTab";
import { documentKey, documentPath } from "./DocumentFile";
import { ResearchFolder } from "./ResearchFolder";
import {
  activeResearchWorkspace,
  authorizeResearchProject,
  loadResearchWorkspace,
  projectPathKey,
  projectPathSchema,
} from "./ResearchWorkspace";
import { PdfReaderEngine, pdfReaderError, readPdfBuffer } from "./PdfReader";
import { pdfWithTimeout } from "./PdfDocument";

export interface PdfReadResult {
  path: string;
  pageCount: number;
  pages: { page: number; text: string }[];
  truncated: boolean;
  stoppedAt?: { page: number; character: number };
}

export interface PdfSearchResult {
  path: string;
  pageCount: number;
  matches: { page: number; text: string }[];
  truncated: boolean;
}

export async function resolveReadablePdfPath(input: string): Promise<string> {
  if (!projectPathSchema.safeParse(input).success || !/\.pdf$/i.test(input)) throw new Error("pdf.pathNotAllowed");
  const path = documentPath(input);
  const opened = store
    .get(tabsAtom)
    .some(
      (tab) =>
        tab instanceof DocumentTab && !tab.closing && tab.kind === "pdf" && documentKey(tab.path) === documentKey(path),
    );
  if (opened) return path;
  const current = ResearchFolder.getRoot();
  const roots = activeResearchWorkspace(await loadResearchWorkspace()).projects.map((project) => project.path);
  if (current && !roots.includes(current)) roots.push(current);
  const key = projectPathKey(path);
  const root = roots
    .filter((candidate) => {
      const rootKey = projectPathKey(candidate);
      return key.startsWith(rootKey === "/" ? "/" : `${rootKey}/`);
    })
    .sort((a, b) => b.length - a.length)[0];
  if (!root) throw new Error("pdf.pathNotAllowed");
  if (root === current) await ResearchFolder.ensureRootRegistered();
  else await authorizeResearchProject(root);
  // The fs scope also contains files opened for other features; do not let a symlink escape this project's boundary.
  const relative = ResearchFolder.toRelative(path, root);
  let segmentPath = root;
  for (const segment of relative.split("/")) {
    segmentPath = ResearchFolder.toAbsolute(segment, segmentPath);
    if ((await lstat(segmentPath)).isSymlink) throw new Error("pdf.pathNotAllowed");
  }
  return path;
}

function pageRange(value: string): [number, number] {
  const match = /^(\d+)(?:-(\d+))?$/.exec(value.trim());
  if (!match) throw new Error("pdf.invalidPages");
  const start = Number(match[1]);
  const end = Number(match[2] ?? match[1]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start)
    throw new Error("pdf.invalidPages");
  if (end - start >= 10) throw new Error("pdf.tooManyPages");
  return [start, end];
}

function toolError(error: unknown): Error {
  const message = pdfReaderError(error).message;
  if (message.startsWith("pdf.")) return new Error(message);
  const codes: Record<string, string> = {
    pdfLocked: "pdf.locked",
    pdfTooLarge: "pdf.tooLarge",
    pdfTimeout: "pdf.timeout",
  };
  return new Error(codes[message] ?? "pdf.readFailed");
}

async function withPdf<T>(
  input: string,
  signal: AbortSignal | undefined,
  action: (engine: PdfReaderEngine, pdf: PdfDocumentObject, path: string) => Promise<T>,
  /** 用户在系统窗口里亲手选的文件（导入文献库时）：不要求它在研究文件夹里 */
  picked = false,
): Promise<T> {
  const lifetime = new AbortController();
  let engine: PdfReaderEngine | undefined;
  let failure: unknown;
  let finished = false;
  const stop = () => {
    lifetime.abort();
    engine?.destroy(true);
  };
  const report = (error: unknown) => {
    if (finished) {
      window.dispatchEvent(new ErrorEvent("error", { error: toolError(error) }));
      return;
    }
    failure ??= error;
    stop();
  };
  const timeout = setTimeout(() => report(new Error("pdfTimeout")), 60000);
  signal?.addEventListener("abort", stop, { once: true });
  try {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const path = picked
      ? documentPath(input)
      : await pdfWithTimeout(resolveReadablePdfPath(input), 25000, lifetime.signal);
    if (lifetime.signal.aborted) throw new Error("fileClosed");
    engine = new PdfReaderEngine(
      new Worker(new URL("./PdfReaderWorker.ts", import.meta.url), { type: "module" }),
      report,
    );
    const buffer = await readPdfBuffer(path, lifetime.signal, report);
    if (lifetime.signal.aborted) throw new Error("fileClosed");
    const pdf = await engine.openDocumentBuffer({ id: crypto.randomUUID(), content: buffer }).toPromise();
    if (pdf.isEncrypted && !pdf.isOwnerUnlocked && !(pdf.permissions & PdfPermissionFlag.CopyContents))
      throw new Error("pdf.copyNotAllowed");
    const result = await action(engine, pdf, path);
    if (failure) throw failure;
    if (lifetime.signal.aborted) throw new Error("fileClosed");
    return result;
  } catch (error) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    throw toolError(failure ?? error);
  } finally {
    finished = true;
    clearTimeout(timeout);
    signal?.removeEventListener("abort", stop);
    stop();
  }
}

export async function readPdfText(
  input: { path: string; pages: string },
  options: { signal?: AbortSignal } = {},
): Promise<PdfReadResult> {
  const [start, end] = pageRange(input.pages);
  return withPdf(input.path, options.signal, async (engine, pdf, path) => {
    if (end > pdf.pageCount) throw new Error("pdf.invalidPages");
    const result: PdfReadResult = { path, pageCount: pdf.pageCount, pages: [], truncated: false };
    let remaining = 20000;
    for (let page = start; page <= end; page++) {
      const text = await engine.extractText(pdf, [page - 1]).toPromise();
      const kept = text.slice(0, remaining).replace(/[\uD800-\uDBFF]$/, "");
      result.pages.push({ page, text: kept });
      remaining -= kept.length;
      if (kept.length < text.length || (!remaining && page < end)) {
        result.truncated = true;
        result.stoppedAt = { page, character: kept.length };
        break;
      }
    }
    return result;
  });
}

/** 导入文献库时认这篇 PDF 用：开头两页的文字，加上文件自带的标题、作者等信息 */
export function readPdfHead(path: string): Promise<{ text: string; title: string; author: string }> {
  return withPdf(
    path,
    undefined,
    async (engine, pdf) => {
      const pages = Array.from({ length: Math.min(2, pdf.pageCount) }, (_, index) => index);
      const [text, info] = await Promise.all([
        engine.extractText(pdf, pages).toPromise(),
        engine.getMetadata(pdf).toPromise(),
      ]);
      return {
        text: [text.slice(0, 20000), info.subject, info.keywords].filter(Boolean).join("\n"),
        title: info.title ?? "",
        author: info.author ?? "",
      };
    },
    true,
  );
}

export async function searchPdf(
  input: { path: string; query: string },
  options: { signal?: AbortSignal } = {},
): Promise<PdfSearchResult> {
  const query = input.query.trim();
  if (!query || query.length > 200) throw new Error("pdf.invalidQuery");
  return withPdf(input.path, options.signal, async (engine, pdf, path) => {
    const found = await engine.searchAllPages(pdf, query).toPromise();
    const matches = found.results.slice(0, 50);
    const snippets = matches.length
      ? await engine
          .getTextSlices(
            pdf,
            matches.map((match) => {
              const start = Math.max(0, match.charIndex - 80);
              return {
                pageIndex: match.pageIndex,
                charIndex: start,
                charCount: match.charIndex - start + match.charCount + 80,
              };
            }),
          )
          .toPromise()
      : [];
    return {
      path,
      pageCount: pdf.pageCount,
      matches: matches.map((match, index) => ({
        page: match.pageIndex + 1,
        text: (snippets[index] ?? "").slice(0, 400),
      })),
      truncated: found.total > matches.length,
    };
  });
}
