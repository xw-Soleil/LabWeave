import { fetch } from "@tauri-apps/plugin-http";
import type { CreateLibraryItemFields, LibraryItemFields, LibraryItemPatch } from "./LibraryFormat";

/** 一篇论文的编号 */
export interface PaperId {
  doi?: string;
  arxiv?: string;
}

export interface RecognizedPdf {
  fields: CreateLibraryItemFields;
  /** online：联网查到的；pdf：PDF 自带的标题；none：什么都没认出来 */
  source: "online" | "pdf" | "none";
  /** 中途哪一步没成（读不了 PDF、连不上、对不上），界面要告诉用户 */
  problem?: unknown;
}

type Json = Record<string, unknown>;
const record = (value: unknown): Json => (value && typeof value === "object" ? (value as Json) : {});
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const ARXIV_ID = String.raw`(\d{4}\.\d{4,5}|[a-z][a-z-]*(?:\.[a-z]{2})?\/\d{7})`;

/** 从 PDF 开头的文字，或用户贴进来的编号、网址里，找出 DOI 和 arXiv 编号 */
export function findPaperId(text: string): PaperId {
  const arxiv = (new RegExp(String.raw`arxiv(?:\.org\/(?:abs|pdf)\/|\s*:\s*)${ARXIV_ID}`, "i").exec(text) ??
    new RegExp(String.raw`^\s*${ARXIV_ID}(?:v\d+)?\s*$`, "i").exec(text))?.[1];
  const doi = /\b10\.\d{4,9}\/[^\s"'<>]+/
    .exec(text)?.[0]
    .replace(/[.,;:)\]}]+$/, "")
    .toLowerCase();
  // arXiv 自己发的 DOI（10.48550/arXiv.2410.12345）Crossref 不收，当成 arXiv 编号
  const own = doi ? /^10\.48550\/arxiv\.(.+?)(?:v\d+)?$/.exec(doi)?.[1] : undefined;
  return own ? { arxiv: arxiv ?? own } : { doi, arxiv };
}

/** 去掉标签和多余空白：Crossref 的标题、摘要里夹着 <i>、<jats:p> 这类标记 */
function tidy(value: unknown): string {
  const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'" };
  return (typeof value === "string" || typeof value === "number" ? String(value) : "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(amp|lt|gt|quot|apos|#39);/g, (_, name: string) => entities[name])
    .replace(/\s+/g, " ")
    .trim();
}

/** 发一次请求。断网、超时、读到一半断了都是一回事：连不上（library.lookupNetwork）；404 是查不到 */
async function request<T>(url: string, read: (response: Response) => Promise<T>, timeout = 10000): Promise<T> {
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), timeout);
  try {
    const response = await fetch(url, { signal: stop.signal });
    if (response.ok) return await read(response);
    throw new Error(response.status === 404 ? "library.lookupNotFound" : "library.lookupNetwork");
  } catch (error) {
    throw error instanceof Error && error.message === "library.lookupNotFound"
      ? error
      : new Error("library.lookupNetwork");
  } finally {
    clearTimeout(timer);
  }
}

const get = (url: string) => request(url, (response) => response.text());

const crossrefTypes: Record<string, string> = {
  "journal-article": "期刊文章",
  "proceedings-article": "会议论文",
  "posted-content": "预印本",
  book: "书籍",
  monograph: "书籍",
  "edited-book": "书籍",
  dissertation: "学位论文",
};

async function fromCrossref(doi: string): Promise<CreateLibraryItemFields> {
  const work = record(
    record(JSON.parse(await get(`https://api.crossref.org/works/${encodeURIComponent(doi)}`))).message,
  );
  const first = (value: unknown) => tidy(list(value)[0]);
  const title = first(work.title);
  if (!title) throw new Error("library.lookupNotFound");
  const date = record(work.issued ?? work.published ?? work.created)["date-parts"];
  return {
    title,
    authors: list(work.author)
      .map(record)
      .map((author) => tidy([author.given, author.family].filter(Boolean).join(" ")) || tidy(author.name))
      .filter(Boolean),
    year: tidy(list(list(date)[0])[0]),
    venue: first(work["container-title"]) || tidy(record(work.event).name),
    itemType: crossrefTypes[tidy(work.type)] ?? "其他",
    volume: tidy(work.volume),
    issue: tidy(work.issue),
    pages: tidy(work.page),
    doi,
    url: tidy(work.URL) || `https://doi.org/${doi}`,
    abstract: tidy(work.abstract).replace(/^abstract\s*/i, ""),
  };
}

async function fromArxiv(id: string): Promise<CreateLibraryItemFields> {
  const feed = await get(`https://export.arxiv.org/api/query?id_list=${encodeURIComponent(id)}`);
  const entry = new DOMParser().parseFromString(feed, "application/xml").getElementsByTagName("entry")[0];
  const field = (name: string) => tidy(entry?.getElementsByTagName(name)[0]?.textContent);
  // 编号不存在时，arXiv 回的是没有条目、或者一条没有发表日期的「Error」
  if (!field("title") || !field("published")) throw new Error("library.lookupNotFound");
  return {
    title: field("title"),
    authors: [...entry.getElementsByTagName("author")]
      .map((author) => tidy(author.getElementsByTagName("name")[0]?.textContent))
      .filter(Boolean),
    year: field("published").slice(0, 4),
    venue: field("arxiv:journal_ref") || "arXiv",
    itemType: "预印本",
    doi: field("arxiv:doi").toLowerCase(),
    arxiv: id,
    url: `https://arxiv.org/abs/${id}`,
    abstract: field("summary"),
  };
}

/** 按编号联网查这篇文献。只发出编号本身。查不到抛 library.lookupNotFound，连不上抛 library.lookupNetwork */
export function lookupPaper(id: PaperId): Promise<CreateLibraryItemFields> {
  if (id.arxiv) return fromArxiv(id.arxiv);
  if (id.doi) return fromCrossref(id.doi);
  return Promise.reject(new Error("library.lookupNoId"));
}

/** 只留字母和数字再比：PDF 里的标题会断行、带连字符、用连字（ﬁ） */
const plain = (value: string) =>
  value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");

/** PDF 自带的「标题」常常是排版软件留下的文件名，这种不能用 */
const usableTitle = (title: string) =>
  title.trim().length < 4 || /\.(pdf|docx?|dvi|tex|indd)$|^microsoft word|^untitled/i.test(title.trim())
    ? ""
    : title.trim();

/**
 * 导入 PDF 时认出它是哪篇，和 Zotero 的「抓取元数据」一个意思：
 * 在本机读开头两页找 DOI 或 arXiv 编号，拿编号联网查（PDF 内容不上传）；
 * 没有编号、查不到或对不上时，退回 PDF 自带的标题和作者。
 */
export async function recognizePdf(path: string): Promise<RecognizedPdf> {
  let head = { text: "", title: "", author: "" };
  let problem: unknown;
  try {
    head = await (await import("./PdfTools")).readPdfHead(path);
  } catch (error) {
    // 加密、损坏的 PDF 读不出文字，但照样可以导入，原因交给界面提示
    problem = error;
  }
  const id = findPaperId(head.text);
  if (id.arxiv || id.doi) {
    try {
      const fields = await lookupPaper(id);
      // 第一页偶尔会出现别的文献的 DOI：标题在这篇 PDF 开头找不到，就不采用
      if (id.arxiv || plain(head.text).includes(plain(fields.title ?? "").slice(0, 30)))
        return { fields, source: "online" };
      problem = new Error("library.lookupMismatch");
    } catch (error) {
      problem = error;
    }
  }
  const title = usableTitle(head.title);
  return {
    fields: {
      title,
      authors: title
        ? head.author
            .split(/\s*(?:;|,|\band\b)\s*/)
            .map((name) => name.trim())
            .filter(Boolean)
        : [],
      // 编号只在联网时没连上的情况下留着；对不上的 DOI 不是这篇的
      ...(problem instanceof Error && problem.message === "library.lookupMismatch" ? {} : id),
    },
    source: title ? "pdf" : "none",
    problem,
  };
}

/**
 * 给库里已有的一篇联网查信息。先用它自己登记的编号：有 DOI 用 DOI（正式发表的版本信息更全），
 * Crossref 不收这个 DOI 时再用 arXiv 编号；两个都没登记，就读它的 PDF 找编号。
 */
export async function lookupItem(item: {
  doi?: string;
  arxiv?: string;
  pdfPath?: string;
}): Promise<CreateLibraryItemFields> {
  const id = findPaperId(`${item.doi ?? ""} ${item.arxiv ? `arXiv:${item.arxiv}` : ""}`);
  if (id.doi) {
    const found = await fromCrossref(id.doi).catch((error: unknown) => {
      if (id.arxiv && error instanceof Error && error.message === "library.lookupNotFound") return undefined;
      throw error;
    });
    if (found) return found;
  }
  if (id.arxiv) return fromArxiv(id.arxiv);
  if (!item.pdfPath) throw new Error("library.lookupNoIdItem");
  const found = await recognizePdf(item.pdfPath);
  if (found.source !== "online") throw found.problem ?? new Error("library.lookupNoIdItem");
  return found.fields;
}

const REPLACEABLE = ["title", "authors", "year", "venue", "itemType", "volume", "issue", "pages"] as const;
const FILL_ONLY = ["doi", "arxiv", "url", "abstract"] as const;

/**
 * 查回来的信息和这篇现有的比一遍，分成两堆：
 * fill 是现在空着、可以直接补上的；replace 是两边都有但不一样的，要问过用户才改。
 * 查回来是空的不算，补全不会清掉已有的内容。编号、网址、摘要只补不改。
 */
export function lookupChanges(
  item: LibraryItemFields,
  found: CreateLibraryItemFields,
): { fill: LibraryItemPatch; replace: LibraryItemPatch } {
  const fill: Record<string, unknown> = {};
  const replace: Record<string, unknown> = {};
  // 「其他」是建条目时的默认类型，等于没填
  const blank = (field: string, value: unknown) =>
    !(Array.isArray(value) ? value.length : value) || (field === "itemType" && value === "其他");
  // arXiv 查回来的「预印本 / arXiv」只用来补空：已经登记了发表在哪的，不退回成预印本
  const weak = (field: string, value: unknown) =>
    (field === "itemType" && value === "预印本") || (field === "venue" && value === "arXiv");
  // 只差大小写、空格、标点的不算不一样
  const same = (a: unknown, b: unknown) => plain([a].flat().join(" ")) === plain([b].flat().join(" "));
  for (const field of [...REPLACEABLE, ...FILL_ONLY]) {
    const next = found[field];
    if (blank(field, next)) continue;
    if (blank(field, item[field])) fill[field] = next;
    else if ((REPLACEABLE as readonly string[]).includes(field) && !weak(field, next) && !same(item[field], next))
      replace[field] = next;
  }
  return { fill, replace };
}

/** 把 arXiv 上这篇的 PDF 下回来。公开文件，只发出编号；拿到的不是 PDF 就抛 library.lookupNoPdf */
export async function downloadArxivPdf(id: string): Promise<Uint8Array> {
  // 地址是拿编号拼的，编号必须就是编号
  if (!new RegExp(`^${ARXIV_ID}$`, "i").test(id)) throw new Error("library.lookupNoId");
  const bytes = await request(
    `https://arxiv.org/pdf/${id}`,
    async (response) => new Uint8Array(await response.arrayBuffer()),
    60000,
  ).catch((error: unknown) => {
    throw error instanceof Error && error.message === "library.lookupNotFound"
      ? new Error("library.lookupNoPdf")
      : error;
  });
  // 撤稿或只交了源码的，arXiv 回的是一张网页
  if (new TextDecoder().decode(bytes.subarray(0, 5)) !== "%PDF-") throw new Error("library.lookupNoPdf");
  return bytes;
}
