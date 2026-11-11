import { isMap, isNode, isScalar, parseDocument } from "yaml";

export type ReadStatus = "unread" | "toRead" | "reading" | "read";

export interface LibraryItemFields {
  title: string;
  authors: string[];
  year?: string;
  venue?: string;
  itemType?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  doi?: string;
  arxiv?: string;
  url?: string;
  abstract?: string;
  added?: string;
  status: ReadStatus;
  collections: string[];
  tags: string[];
  trashed: boolean;
}

export type LibraryItemPatch = Partial<LibraryItemFields>;
export type CreateLibraryItemFields = Omit<LibraryItemPatch, "trashed">;

export const libraryStatuses: Record<ReadStatus, string> = {
  unread: "未读",
  toRead: "待读",
  reading: "阅读中",
  read: "已读",
};

const fieldOrder = [
  "type",
  "itemType",
  "title",
  "authors",
  "year",
  "venue",
  "volume",
  "issue",
  "pages",
  "doi",
  "arxiv",
  "url",
  "status",
  "collections",
  "tags",
  "added",
  "pdf",
  "abstract",
  "deleted",
];
const stringFields = [
  "title",
  "itemType",
  "year",
  "venue",
  "volume",
  "issue",
  "pages",
  "doi",
  "arxiv",
  "url",
  "abstract",
  "added",
];
const listFields = ["authors", "collections", "tags"];
const maxHeaderLength = 1024 * 1024;

const text = (value: unknown): string => (value == null ? "" : String(value).trim());
const list = (value: unknown, separator?: RegExp): string[] =>
  (Array.isArray(value) ? value : value == null ? [] : separator ? String(value).split(separator) : [value])
    .map(text)
    .filter(Boolean);

export function parseLibraryYaml(source: string) {
  try {
    const document = parseDocument(source, { stringKeys: true, prettyErrors: false });
    if (document.errors.length || !isMap(document.contents) || document.contents.flow) {
      throw new Error("library.invalidFrontmatter");
    }
    const values = document.toJS({ maxAliasCount: 50 }) as Record<string, unknown>;
    if (values.type !== "文献") throw new Error("library.invalidFrontmatter");
    return { document, values };
  } catch (cause) {
    throw new Error("library.invalidFrontmatter", { cause });
  }
}

export function libraryMetadata(values: Record<string, unknown>, key: string): LibraryItemFields {
  const status = Object.entries(libraryStatuses).find(([, value]) => value === text(values.status))?.[0] as
    | ReadStatus
    | undefined;
  return {
    title: text(values.title) || key,
    authors: list(values.authors, /;|；/),
    year: text(values.year),
    venue: text(values.venue),
    itemType: text(values.itemType) || "其他",
    volume: text(values.volume),
    issue: text(values.issue),
    pages: text(values.pages),
    doi: text(values.doi),
    arxiv: text(values.arxiv),
    url: text(values.url),
    abstract: text(values.abstract),
    added: text(values.added),
    status: status ?? "unread",
    collections: list(values.collections),
    tags: list(values.tags, /[,\s，]+/).map((tag) => tag.replace(/^#/, "")),
    trashed: values.deleted === true || values.deleted === "true",
  };
}

export function libraryExtra(values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(values).filter(([key]) => !fieldOrder.includes(key)));
}

export function validateLibraryPatch(patch: LibraryItemPatch): void {
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const valid = stringFields.includes(key)
      ? typeof value === "string"
      : listFields.includes(key)
        ? Array.isArray(value) && value.every((entry) => typeof entry === "string")
        : key === "trashed"
          ? typeof value === "boolean"
          : key === "status"
            ? typeof value === "string" && Object.hasOwn(libraryStatuses, value)
            : false;
    if (!valid) throw new Error("library.invalidFields");
  }
}

function diskValue(key: string, value: unknown): unknown {
  if (key === "status") return libraryStatuses[value as ReadStatus];
  if (key === "trashed") return value ? true : undefined;
  if (key === "year" && /^\d+$/.test(String(value))) return Number(value);
  return value === "" ? null : value;
}

function yamlField(key: string, value: unknown, newline: string): string {
  const formatted = Array.isArray(value)
    ? value.length
      ? newline + value.map((entry) => `  - ${JSON.stringify(String(entry))}`).join(newline)
      : " []"
    : value == null || value === ""
      ? ""
      : typeof value === "boolean" || typeof value === "number"
        ? ` ${value}`
        : ` ${JSON.stringify(String(value))}`;
  return `${key}:${formatted}${newline}`;
}

/** Only replace the edited entries; YAML's serializer would rewrite unknown fields and comments. */
function patchYaml(source: string, patch: LibraryItemPatch): string {
  const { document, values } = parseLibraryYaml(source);
  if (!isMap(document.contents)) throw new Error("library.invalidFrontmatter");
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const edits: { start: number; end: number; text: string; order: number }[] = [];
  for (const [field, input] of Object.entries(patch)) {
    if (input === undefined) continue;
    const key = field === "trashed" ? "deleted" : field;
    const value = diskValue(field, input);
    if (
      value === undefined
        ? !Object.hasOwn(values, key)
        : JSON.stringify(values[key] ?? null) === JSON.stringify(value ?? null)
    )
      continue;
    const pair = document.contents.items.find((entry) => isScalar(entry.key) && entry.key.value === key);
    const replacement = value === undefined ? "" : yamlField(key, value, newline);
    if (pair && isScalar(pair.key) && pair.key.range) {
      const start = pair.key.range[0];
      let end = isNode(pair.value) && pair.value.range ? pair.value.range[2] : pair.key.range[2];
      if (end > 0 && source[end - 1] !== "\n") {
        const lineEnd = source.indexOf("\n", end);
        end = lineEnd < 0 ? source.length : lineEnd + 1;
      }
      edits.push({ start, end, text: replacement, order: fieldOrder.indexOf(key) });
    } else if (replacement) {
      const next = document.contents.items.find(
        (entry) => isScalar(entry.key) && fieldOrder.indexOf(String(entry.key.value)) > fieldOrder.indexOf(key),
      );
      const start = next && isScalar(next.key) && next.key.range ? next.key.range[0] : source.length;
      edits.push({ start, end: start, text: replacement, order: fieldOrder.indexOf(key) });
    }
  }
  let result = source;
  for (const edit of edits.sort((a, b) => b.start - a.start || b.order - a.order)) {
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  }
  // Editing an anchor must not leave an unknown field with a dangling alias.
  parseLibraryYaml(result);
  return result;
}

export function splitLibraryNote(bytes: Uint8Array): {
  opening: string;
  yaml: string;
  closing: string;
  body: Uint8Array;
} {
  let lineStart = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  let openingEnd: number | undefined;
  for (let index = lineStart; index <= bytes.length && index <= maxHeaderLength; index++) {
    if (index !== bytes.length && bytes[index] !== 10) continue;
    const line = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(lineStart, index)).replace(/\r$/, "");
    const end = index < bytes.length ? index + 1 : index;
    if (openingEnd === undefined) {
      if (!/^---[\t ]*$/.test(line) || end === index) break;
      openingEnd = end;
    } else if (/^---[\t ]*$/.test(line)) {
      const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
      return {
        opening: decoder.decode(bytes.subarray(0, openingEnd)),
        yaml: decoder.decode(bytes.subarray(openingEnd, lineStart)),
        closing: decoder.decode(bytes.subarray(lineStart, end)),
        body: bytes.subarray(end),
      };
    }
    lineStart = end;
  }
  throw new Error("library.invalidFrontmatter");
}

export function updateLibraryNote(bytes: Uint8Array, patch: LibraryItemPatch): Uint8Array {
  validateLibraryPatch(patch);
  const { opening, yaml, closing, body } = splitLibraryNote(bytes);
  const header = new TextEncoder().encode(opening + patchYaml(yaml, patch) + closing);
  const result = new Uint8Array(header.length + body.length);
  result.set(header);
  result.set(body, header.length);
  splitLibraryNote(result);
  return result;
}

export function createLibraryNote(fields: CreateLibraryItemFields, pdf: string, body: string): Uint8Array {
  validateLibraryPatch(fields);
  const now = new Date();
  const added = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const values: Record<string, unknown> = {
    type: "文献",
    itemType: fields.itemType || "其他",
    title: fields.title,
    authors: fields.authors ?? [],
    year: fields.year,
    venue: fields.venue,
    volume: fields.volume,
    issue: fields.issue,
    pages: fields.pages,
    doi: fields.doi,
    arxiv: fields.arxiv,
    url: fields.url,
    status: fields.status ?? "unread",
    collections: fields.collections ?? [],
    tags: fields.tags ?? [],
    added: fields.added ?? added,
    pdf,
    abstract: fields.abstract,
  };
  const yaml = Object.entries(values)
    .map(([key, value]) => yamlField(key, diskValue(key, value), "\n"))
    .join("");
  parseLibraryYaml(yaml);
  const bytes = new TextEncoder().encode(`---\n${yaml}---\n${body}`);
  splitLibraryNote(bytes);
  return bytes;
}

export function makeLibraryKey(fields: CreateLibraryItemFields): string {
  const clean = (value: string) => value.replace(/[^\p{L}\p{N}]/gu, "");
  const capitalize = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);
  const surname = clean(fields.authors?.[0]?.trim().split(/\s+/).at(-1) ?? "") || "Anon";
  const stopWords = new Set(
    "a an the on of for in and to with towards toward via is are from by at as using".split(" "),
  );
  let word =
    text(fields.title)
      .split(/[\s\-:：，,]+/)
      .map(clean)
      .find((part) => part && !stopWords.has(part.toLowerCase())) || "Untitled";
  if (/[一-鿿]/.test(word)) word = word.slice(0, 8);
  return `${capitalize(surname)}${fields.year || ""}${capitalize(word)}`.slice(0, 48);
}
