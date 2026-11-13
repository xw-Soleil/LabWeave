import { fetch } from "@tauri-apps/plugin-http";
import { appDataDir } from "@tauri-apps/api/path";
import { exists, lstat, mkdir, readDir, readFile, remove, rename, writeFile } from "@tauri-apps/plugin-fs";
import { stringify } from "yaml";
import md5 from "md5";
import {
  atomicWrite,
  checkedPath,
  readManifest,
  writeSyncFile,
  placeSyncFile,
  stashSyncFile,
  loadLibrary,
  type LibraryItem,
  type LibrarySnapshot,
} from "./Library";
import { libraryStatuses, parseLibraryYaml, splitLibraryNote } from "./LibraryFormat";
import { documentKey, documentPath } from "./DocumentFile";

export const syncFields = [
  "title",
  "authors",
  "year",
  "venue",
  "volume",
  "issue",
  "pages",
  "doi",
  "url",
  "abstract",
  "tags",
  "status",
  "collections",
] as const;
export type SyncField = (typeof syncFields)[number];
export type SyncValue = string | string[];
export type SyncValues = Record<SyncField, SyncValue>;
export type SyncGroup = "push" | "pull" | "conflict" | "skip" | "attachment";
type Match = "key" | "doi" | "arxiv" | "title";

export interface ZoteroData {
  key: string;
  version: number;
  itemType?: string;
  title?: string;
  parentItem?: string;
  deleted?: boolean | number;
  name?: string;
  parentCollection?: string | false;
  creators?: { creatorType: string; name?: string; firstName?: string; lastName?: string }[];
  tags?: { tag: string; type?: number }[];
  collections?: string[];
  [field: string]: unknown;
}

export interface ZoteroSnapshot {
  serverId: string;
  items: ZoteroData[];
  collections: ZoteroData[];
  libraryVersion?: string;
}

export interface SyncPair {
  path: string;
  local: SyncValues;
  remote: SyncValues;
}

export interface SyncBaseline {
  schema: 1;
  root: string;
  serverId: string;
  pairs: Record<string, { path: string; local: Partial<SyncValues>; remote: Partial<SyncValues> }>;
  collections: Record<string, { local: string; remote: string }>;
  attachments?: Record<string, { parent: string; local: FileStamp; remote: FileStamp }>;
  attachmentHistory?: Record<string, string[]>;
  exports?: Record<string, { source: string; raw: string }>;
  attachmentFiles?: Record<string, FileStamp>;
}

export interface SyncRow {
  group: SyncGroup;
  kind: "field" | "item" | "collection" | "link" | "notice";
  title: string;
  path?: string;
  key?: string;
  field?: SyncField;
  local?: SyncValue;
  remote?: SyncValue;
  reason?: string;
  matchedBy?: Match;
  size?: number;
}

export interface PairingIssue {
  by: Match;
  value: string;
  candidates: { title: string; path?: string; key?: string }[];
}

export interface SyncPreview {
  schema: 1;
  created: string;
  source: { local: LibrarySnapshot; remote: ZoteroSnapshot };
  pairs: Record<string, SyncPair & { matchedBy: Match }>;
  rows: SyncRow[];
  summary: {
    unchanged: number;
    deferred: { total: number; annotations: number; attachments: number; notes: number };
    missingCollections: number;
  };
  pairingIssues: PairingIssue[];
  blocked: boolean;
  baseline?: SyncBaseline;
  files?: Record<string, string>;
  draft?: SyncRun;
  collectionPaths: { local: Record<string, string>; remote: Record<string, string> };
}

export interface SyncProgress {
  phase: "connect" | "items" | "collections" | "pairing" | "attachments" | "authorize" | "apply" | "rollback";
  count: number;
  /** Known for apply and rollback: how many steps in all */
  total?: number;
}

const text = (value: unknown): string => (value == null ? "" : String(value).trim());
const sorted = (values: string[]) => [...new Set(values)].sort();
const equal = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => equal(v, b[i]));
  return (
    isObject(a) &&
    isObject(b) &&
    Object.keys(a).length === Object.keys(b).length &&
    Object.keys(a).every((k) => equal(a[k], b[k]))
  );
};
const fail = (code: string): never => {
  throw new Error(`zoteroSync.${code}`);
};
const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((v) => typeof v === "string");
const doi = (value: unknown) =>
  text(value)
    .replace(/^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)/i, "")
    .trim()
    .toLowerCase();
const arxiv = (value: unknown) =>
  text(value).match(/(?:arxiv[: /]*|arxiv\.org\/(?:abs|pdf)\/)?(\d{4}\.\d{4,5})(?:v\d+)?/i)?.[1] ?? "";
const titleKey = (value: unknown) => text(value).replace(/\s+/gu, " ").toLowerCase();
const child = (item: ZoteroData) => !!item.parentItem || item.itemType === "annotation";
const special = (item: ZoteroData) => item.itemType === "note" || item.itemType === "attachment";

export function mergeField(
  beforeLocal: unknown,
  beforeRemote: unknown,
  local: SyncValue,
  remote: SyncValue,
): SyncGroup | "same" {
  if (equal(local, remote)) return "same";
  const lc = !equal(local, beforeLocal),
    rc = !equal(remote, beforeRemote);
  return lc && rc ? "conflict" : lc ? "push" : rc ? "pull" : "same";
}

export function localValues(item: LibraryItem, pathKeys: Map<string, string>): SyncValues {
  // The library's display normalization (e.g. stripping # from tags) is not the plugin's sync format.
  const fm = item.frontmatter ?? { ...item, status: libraryStatuses[item.status] };
  const array = (value: unknown): string[] =>
    (Array.isArray(value) ? value : value == null || value === "" ? [] : [value]).map(text).filter(Boolean);
  return {
    title: text(fm.title),
    authors: array(fm.authors),
    year: text(fm.year),
    venue: text(fm.venue),
    volume: text(fm.volume),
    issue: text(fm.issue),
    pages: text(fm.pages),
    doi: text(fm.doi),
    url: text(fm.url),
    abstract: text(fm.abstract),
    tags: sorted(array(fm.tags)),
    status: text(fm.status) || libraryStatuses.unread,
    collections: sorted(array(fm.collections).map((path) => pathKeys.get(path) ?? fail("invalidCollections"))),
  };
}

export function remoteValues(item: ZoteroData): SyncValues {
  const tags = (item.tags ?? []).map((t) => t.tag);
  const statuses = sorted(
    tags
      .filter((t) => t.startsWith("阅读/") && Object.values(libraryStatuses).includes(t.slice(3)))
      .map((t) => t.slice(3)),
  );
  return {
    title: text(
      item.title ||
        text(item.note)
          .replace(/<[^>]+>/g, "")
          .slice(0, 150) ||
        item.filename,
    ),
    authors: (item.creators ?? [])
      .filter((c) => c.creatorType === "author")
      .map((c) => c.name || `${c.firstName ?? ""} ${c.lastName ?? ""}`.trim()),
    year: text(item.date).match(/\b(?:19|20)\d{2}\b/)?.[0] ?? "",
    venue: text(item.publicationTitle || item.proceedingsTitle || item.repository),
    volume: text(item.volume),
    issue: text(item.issue),
    pages: text(item.pages),
    doi: text(item.DOI),
    url: text(item.url),
    abstract: text(item.abstractNote),
    tags: sorted(tags.filter((t) => !t.startsWith("阅读/"))),
    status: statuses.length > 1 ? "conflict" : (statuses[0] ?? libraryStatuses.unread),
    collections: sorted(item.collections ?? []),
  };
}

function validatePage(value: unknown, kind: "items" | "collections"): ZoteroData[] {
  if (!Array.isArray(value) || value.length > 100) fail("invalidResponse");
  return (value as unknown[]).map((entry) => {
    if (!isObject(entry) || !isObject(entry.data)) return fail("invalidResponse");
    const d = entry.data;
    if (
      typeof entry.key !== "string" ||
      !/^[A-Z0-9]{8}$/.test(entry.key) ||
      d.key !== entry.key ||
      !Number.isSafeInteger(d.version) ||
      (d.version as number) < 0 ||
      (entry.version !== undefined && entry.version !== d.version)
    )
      fail("invalidResponse");
    if (kind === "collections" ? typeof d.name !== "string" : typeof d.itemType !== "string") fail("invalidResponse");
    for (const field of [
      "title",
      "name",
      "parentItem",
      "date",
      "DOI",
      "url",
      "extra",
      "note",
      "filename",
      "publicationTitle",
      "proceedingsTitle",
      "repository",
      "volume",
      "issue",
      "pages",
      "abstractNote",
      "linkMode",
      "annotationType",
      "annotationText",
      "annotationComment",
      "annotationPosition",
      "annotationSortIndex",
    ]) {
      if (d[field] !== undefined && typeof d[field] !== "string") fail("invalidResponse");
    }
    if (d.parentCollection !== undefined && d.parentCollection !== false && typeof d.parentCollection !== "string")
      fail("invalidResponse");
    if (d.deleted !== undefined && ![true, false, 0, 1].includes(d.deleted as boolean)) fail("invalidResponse");
    if (d.collections !== undefined && !strings(d.collections)) fail("invalidResponse");
    if (
      d.tags !== undefined &&
      (!Array.isArray(d.tags) || !d.tags.every((t) => isObject(t) && typeof t.tag === "string"))
    )
      fail("invalidResponse");
    if (
      d.creators !== undefined &&
      (!Array.isArray(d.creators) ||
        !d.creators.every(
          (c) =>
            isObject(c) &&
            typeof c.creatorType === "string" &&
            ["name", "firstName", "lastName"].every((f) => c[f] === undefined || typeof c[f] === "string"),
        ))
    )
      fail("invalidResponse");
    return d as ZoteroData;
  });
}

export async function readZotero(
  signal: AbortSignal,
  progress: (value: SyncProgress) => void,
): Promise<ZoteroSnapshot> {
  const api = client("", signal);
  let libraryVersion: string | undefined;
  progress({ phase: "connect", count: 0 });
  await api.request("/");
  async function all(kind: "items" | "collections") {
    const result: ZoteroData[] = [],
      seen = new Set<string>();
    progress({ phase: kind, count: 0 });
    for (let start = 0; start < 1000000; start += 100) {
      const response = await api.request(`/users/0/${kind}?start=${start}&limit=100`);
      const version = response.headers.get("Last-Modified-Version");
      if (version) {
        if (libraryVersion !== undefined && version !== libraryVersion) fail("snapshotChanged");
        libraryVersion = version;
      }
      const page = validatePage(await responseJSON(response), kind);
      for (const item of page) {
        if (seen.has(item.key)) fail("snapshotChanged");
        seen.add(item.key);
        result.push(item);
      }
      progress({ phase: kind, count: result.length });
      if (page.length < 100) return result;
    }
    return fail("tooManyItems");
  }
  const items = await all("items"),
    collections = await all("collections");
  return { serverId: api.serverId, items, collections, libraryVersion };
}

function collectionPaths(collections: ZoteroData[]): Map<string, string> {
  const byKey = new Map(collections.map((c) => [c.key, c])),
    paths = new Map<string, string>();
  for (const collection of collections) {
    const chain: ZoteroData[] = [],
      seen = new Set<string>();
    let current: ZoteroData | undefined = collection;
    while (current && !paths.has(current.key)) {
      if (seen.has(current.key) || !current.name?.trim() || current.name.includes("/")) fail("invalidCollections");
      seen.add(current.key);
      chain.push(current);
      const parent: string | false | undefined = current.parentCollection;
      current = parent ? byKey.get(parent) : undefined;
      if (parent && !current) fail("invalidCollections");
    }
    let path = current ? paths.get(current.key)! : "";
    for (const c of chain.reverse()) {
      path = path ? `${path}/${c.name}` : c.name!;
      paths.set(c.key, path);
    }
  }
  if (new Set(paths.values()).size !== paths.size) fail("invalidCollections");
  return paths;
}

export async function planZoteroSync(
  local: LibrarySnapshot,
  remote: ZoteroSnapshot,
  signal: AbortSignal,
  progress: (value: SyncProgress) => void = () => undefined,
  baseline?: SyncBaseline,
): Promise<SyncPreview> {
  signal.throwIfAborted();
  if (
    baseline &&
    (baseline.schema !== 1 ||
      documentKey(baseline.root) !== documentKey(local.root) ||
      baseline.serverId !== remote.serverId)
  )
    fail("baselineMismatch");
  const rows: SyncRow[] = [],
    pairingIssues: PairingIssue[] = [];
  const pairs: SyncPreview["pairs"] = {};
  const summary: SyncPreview["summary"] = {
    unchanged: 0,
    deferred: { total: 0, annotations: 0, attachments: 0, notes: 0 },
    missingCollections: 0,
  };
  const result = (): SyncPreview => ({
    schema: 1,
    created: new Date().toISOString(),
    source: { local, remote },
    pairs,
    rows,
    summary,
    pairingIssues,
    blocked: !!pairingIssues.length || !!local.errors.length,
    baseline,
    collectionPaths: { local: Object.fromEntries(localMap), remote: Object.fromEntries(remotePaths) },
  });
  let count = 0;
  async function tick() {
    signal.throwIfAborted();
    if (count++ % 100 === 0) {
      progress({ phase: "pairing", count });
      await new Promise((resolve) => setTimeout(resolve, 0));
      signal.throwIfAborted();
    }
  }
  rows.push({ group: "skip", kind: "notice", title: "", reason: "preserved" });
  for (const error of local.errors)
    rows.push({ group: "skip", kind: "notice", title: error.key, path: error.notePath, reason: "unreadable" });
  const remotePaths = collectionPaths(remote.collections.filter((c) => !c.deleted));
  const knownCollections = (keys: string[]) => keys.filter((key) => remotePaths.has(key));
  const remoteKeys = new Map([...remotePaths].map(([key, path]) => [path, key]));
  const localPaths = new Set(local.collections);
  const localMap = new Map<string, string>();
  for (const [key, path] of Object.entries(local.zoteroCollections ?? {}))
    if (localPaths.has(path)) localMap.set(key, path);
  for (const [key, b] of Object.entries(baseline?.collections ?? {}))
    if (!localMap.has(key) && localPaths.has(b.local)) localMap.set(key, b.local);
  const mappedPaths = new Set(localMap.values());
  for (const path of localPaths) {
    await tick();
    if (!path || path.split("/").some((p) => !p.trim())) fail("invalidCollections");
    if (!mappedPaths.has(path)) {
      const key = remoteKeys.get(path);
      localMap.set(key && !localMap.has(key) ? key : `local:${path}`, path);
    }
  }
  if (new Set(localMap.values()).size !== localMap.size) fail("invalidCollections");
  const pathKeys = new Map([...localMap].map(([k, p]) => [p, k]));
  for (const key of new Set([...localMap.keys(), ...remotePaths.keys()])) {
    await tick();
    const lp = localMap.get(key),
      rp = remotePaths.get(key),
      b = baseline?.collections[key];
    const known = b || Object.hasOwn(local.zoteroCollections ?? {}, key);
    const group =
      known && (!lp || !rp) ? "skip" : !lp ? "pull" : !rp ? "push" : mergeField(b?.local, b?.remote, lp, rp);
    if (group !== "same")
      rows.push({
        group,
        kind: "collection",
        key,
        title: lp ?? rp!,
        local: lp ?? "",
        remote: rp ?? "",
        reason: group === "skip" ? "deletion" : lp && rp ? "renameCollection" : "newCollection",
      });
  }
  const byKey = new Map(remote.items.map((item) => [item.key, item]));
  const indexes = {
    doi: new Map<string, ZoteroData[]>(),
    arxiv: new Map<string, ZoteroData[]>(),
    title: new Map<string, ZoteroData[]>(),
  };
  for (const item of remote.items) {
    await tick();
    if (item.deleted || child(item) || special(item)) continue;
    if ((item.collections ?? []).some((key) => !remotePaths.has(key))) summary.missingCollections++;
    const identities = {
      doi: doi(item.DOI),
      arxiv: arxiv([item.url, item.extra, item.DOI].map(text).join(" ")),
      title: titleKey(item.title),
    };
    for (const by of ["doi", "arxiv", "title"] as const) {
      const value = identities[by];
      if (value) {
        const entries = indexes[by].get(value) ?? [];
        entries.push(item);
        indexes[by].set(value, entries);
      }
    }
  }
  const reserved = new Map<string, LibraryItem>();
  const matches = new Map<LibraryItem, { item: ZoteroData; by: Match }>();
  const candidate = (item: LibraryItem) => ({ title: item.title, path: item.notePath });
  for (const item of local.items) {
    await tick();
    const key = text(item.extra.zotero_key);
    if (!key) continue;
    if (reserved.has(key))
      pairingIssues.push({ by: "key", value: key, candidates: [candidate(reserved.get(key)!), candidate(item)] });
    reserved.set(key, item);
    const hit = byKey.get(key);
    if (hit) matches.set(item, { item: hit, by: "key" });
  }
  const localIdentifiers = new Map<string, LibraryItem>();
  for (const item of local.items) {
    await tick();
    if (matches.has(item) || item.trashed) continue;
    const fm = item.frontmatter ?? item;
    const identities = { doi: doi(fm.doi), arxiv: arxiv(fm.arxiv), title: titleKey(fm.title) };
    for (const by of ["doi", "arxiv", "title"] as const) {
      const value = identities[by];
      if (!value) continue;
      const hits = indexes[by].get(value) ?? [];
      if (by === "title" && !hits.length) continue;
      const identity = `${by}:${value}`,
        previous = localIdentifiers.get(identity);
      if (previous) pairingIssues.push({ by, value, candidates: [candidate(previous), candidate(item)] });
      localIdentifiers.set(identity, item);
      if (!hits.length) continue;
      if (hits.length > 1 || reserved.has(hits[0].key)) {
        pairingIssues.push({
          by,
          value,
          candidates: [
            candidate(item),
            ...hits.flatMap((hit) => [
              { title: text(hit.title) || hit.key, key: hit.key },
              ...(reserved.has(hit.key) ? [candidate(reserved.get(hit.key)!)] : []),
            ]),
          ],
        });
      } else {
        matches.set(item, { item: hits[0], by });
        reserved.set(hits[0].key, item);
      }
      break;
    }
  }
  // No proposed writes are shown when identity or local input is incomplete.
  if (pairingIssues.length || local.errors.length) {
    rows.splice(0, rows.length, ...rows.filter((r) => r.group === "skip"));
    return result();
  }
  const used = new Set<string>();
  const display = (values: SyncValues, field: SyncField, paths: Map<string, string>): SyncValue =>
    field === "collections" ? (values[field] as string[]).map((k) => paths.get(k) ?? k) : values[field];
  for (const item of local.items) {
    await tick();
    const match = matches.get(item),
      key = match?.item.key,
      d = match?.item;
    if (key) used.add(key);
    const base = { title: item.title, path: item.notePath, key };
    if (item.trashed || d?.deleted || (d && child(d)) || (!d && item.extra.zotero_key)) {
      rows.push({ ...base, group: "skip", kind: "item", reason: "deletion" });
      continue;
    }
    const lv = localValues(item, pathKeys);
    if (!d || !key) {
      rows.push({ ...base, group: "push", kind: "item", reason: "newItem" });
      continue;
    }
    const rv = remoteValues(d),
      b = baseline?.pairs[key];
    rv.collections = knownCollections(rv.collections as string[]);
    pairs[key] = { path: item.notePath, local: lv, remote: rv, matchedBy: match!.by };
    if (match!.by !== "key")
      rows.push({
        ...base,
        group: "pull",
        kind: "link",
        reason: "link",
        local: text(item.extra.zotero_key),
        remote: key,
        matchedBy: match!.by,
      });
    let changed = false;
    for (const field of syncFields) {
      if (special(d) && !["tags", "status", "collections"].includes(field)) continue;
      const beforeRemote = b?.remote[field];
      const group =
        field === "status" && rv.status === "conflict"
          ? "conflict"
          : mergeField(
              b?.local[field],
              field === "collections" && Array.isArray(beforeRemote) ? knownCollections(beforeRemote) : beforeRemote,
              lv[field],
              rv[field],
            );
      if (group !== "same") {
        rows.push({
          ...base,
          group,
          kind: "field",
          field,
          local: display(lv, field, localMap),
          remote:
            field === "status" && rv.status === "conflict"
              ? sorted(
                  (d.tags ?? [])
                    .map((t) => t.tag)
                    .filter((t) => t.startsWith("阅读/"))
                    .map((t) => t.slice(3)),
                )
              : display(rv, field, remotePaths),
        });
        changed = true;
      }
    }
    if (!changed) summary.unchanged++;
  }
  for (const item of remote.items) {
    await tick();
    if (used.has(item.key)) continue;
    const reason =
      item.deleted || baseline?.pairs[item.key]
        ? "deletion"
        : item.itemType === "attachment" && item.linkMode === "linked_url"
          ? "linkedAttachment"
          : child(item)
            ? "deferred"
            : special(item)
              ? "standalone"
              : "newItem";
    if (reason === "deferred") {
      const owner = byKey.get(item.parentItem ?? "");
      const parent = owner?.itemType === "attachment" ? byKey.get(owner.parentItem ?? "") : owner;
      if (
        parent &&
        !parent.deleted &&
        (pairs[parent.key] || (!child(parent) && !special(parent) && !used.has(parent.key)))
      )
        continue;
      summary.deferred.total++;
      if (item.itemType === "annotation") summary.deferred.annotations++;
      if (item.itemType === "attachment") summary.deferred.attachments++;
      if (item.itemType === "note") summary.deferred.notes++;
      continue;
    }
    rows.push({
      group: reason === "newItem" ? "pull" : "skip",
      kind: "item",
      key: item.key,
      title: text(item.title || item.filename) || item.key,
      reason,
    });
    if (reason === "newItem" && remoteValues(item).status === "conflict") {
      rows.push({
        group: "conflict",
        kind: "field",
        key: item.key,
        title: text(item.title) || item.key,
        field: "status",
        local: "",
        remote: sorted(
          (item.tags ?? [])
            .map((t) => t.tag)
            .filter((t) => t.startsWith("阅读/"))
            .map((t) => t.slice(3)),
        ),
      });
    }
  }
  return result();
}

export type SyncChoice = "local" | "remote" | "skip";
/** Stable id of a preview row; ticks and conflict choices are keyed by it. New local papers have no key yet. */
export const rowId = (row: SyncRow) =>
  [row.kind, row.key ?? "", row.path ?? "", row.field ?? "", row.reason ?? ""].join("|");
type FileStamp = { path: string; hash: string; size: number; mtime: number | null };
/**
 * In memory `before`/`after` hold the file text (`after` is the source hash for downloads). On disk the journal
 * only keeps hashes; an overwritten file's old text is stored once in before/<index> (older journals kept both inline).
 */
type FileAction = {
  kind: "file";
  path: string;
  before: string | null;
  after: string;
  beforeHash?: string | null;
  afterHash?: string;
  download?: FileStamp;
  /** Size and time of the downloaded copy, to recognise it later without reading it again */
  placed?: { size: number; mtime: number | null };
  media?: boolean;
};
type APIAction = {
  kind: "api";
  resource: "items" | "collections";
  key: string;
  fields: Record<string, unknown>;
  before: Record<string, unknown> | null;
  version: number;
  after?: ZoteroData;
  upload?: FileStamp;
};
type SyncAction = (FileAction | APIAction) & { status?: "pending" | "done" | "restored" };
export interface SyncRun {
  schema: 1;
  root: string;
  serverId: string;
  status: "applying" | "complete" | "rolling-back" | "rolled-back";
  before: SyncBaseline | null;
  next: SyncBaseline;
  actions: SyncAction[];
  skipped: number;
}
export interface SyncHistory {
  directory: string;
  baseline?: SyncBaseline;
  run?: SyncRun;
  runPath?: string;
}
const encode = (value: string) => new TextEncoder().encode(value);
const decode = (value: Uint8Array) => new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(value);
const digest = async (value: string | Uint8Array) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", typeof value === "string" ? encode(value) : new Uint8Array(value)),
    ),
    (n) => n.toString(16).padStart(2, "0"),
  ).join("");
const json = (value: unknown) => JSON.stringify(value, null, 2);
const active = new Set<string>();
export const pendingSync = (run?: SyncRun) => !!run && ["applying", "rolling-back"].includes(run.status);

async function optionalText(root: string, path: string): Promise<string | null> {
  if (!(await exists(path))) return null;
  return decode(await readFile(await checkedPath(root, path)));
}
async function privateDirectory(root: string, path: string) {
  for (const part of documentPath(path)
    .slice(documentPath(root).replace(/\/$/, "").length + 1)
    .split("/")) {
    path = `${root.replace(/\/$/, "")}/${part}`;
    await checkedPath(root, path, true);
    if (!(await exists(path))) await mkdir(path, { mode: 0o700 });
    const info = await lstat(path);
    if (!info.isDirectory || info.isSymlink) fail("storageFailed");
    root = path;
  }
}
/**
 * The journal is rewritten after every step, so it must stay small and cheap: hashes instead of file text
 * (old text lives once in before/), compact JSON, written to a temporary file in the private run folder and renamed.
 */
async function writeJournal(runPath: string, run: SyncRun) {
  const actions = run.actions.map((op) =>
    op.kind === "file" ? { ...op, before: op.before === null ? null : undefined, after: undefined } : op,
  );
  const temporary = `${runPath}/.journal-${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, encode(JSON.stringify({ ...run, actions })), { mode: 0o600 });
  await rename(temporary, `${runPath}/journal.json`);
}
const afterHash = async (op: FileAction) => op.afterHash ?? (op.download ? op.after : await digest(op.after));
const beforeHash = async (op: FileAction) => (op.before === null ? null : (op.beforeHash ?? (await digest(op.before))));
/** Hash of the file as it is now, null when missing; a downloaded copy with its recorded size and time is taken as is */
async function fileHash(root: string, op: FileAction): Promise<string | null> {
  if (!(await exists(op.path))) return null;
  const path = await checkedPath(root, op.path);
  if (op.download && op.placed) {
    const info = await lstat(path);
    if (info.size === op.placed.size && (info.mtime?.getTime() ?? null) === op.placed.mtime) return op.download.hash;
  }
  return digest(await readFile(path));
}
async function storeJSON(root: string, path: string, value: unknown) {
  const before = await optionalText(root, path);
  await atomicWrite(root, path, encode(json(value)), before === null ? null : encode(before), 0o600);
}
export async function readSyncHistory(root: string): Promise<SyncHistory> {
  const directory = `${documentPath(await appDataDir()).replace(/\/$/, "")}/zotero-sync/${await digest(documentKey(root))}`;
  if (!(await exists(directory))) return { directory };
  const state = await optionalText(directory, `${directory}/state.json`);
  const entries = (await readDir(directory))
    .filter((e) => e.isDirectory && !e.isSymlink && /^run-[\dT-]+-[\da-f-]+$/.test(e.name))
    .sort((a, b) => b.name.localeCompare(a.name));
  for (const entry of entries) {
    const runPath = `${directory}/${entry.name}`;
    const raw = await optionalText(directory, `${runPath}/journal.json`);
    if (!raw) continue;
    const run = JSON.parse(raw) as SyncRun;
    if (run.schema !== 1 || documentKey(run.root) !== documentKey(root)) fail("baselineMismatch");
    return { directory, baseline: state ? (JSON.parse(state) ?? undefined) : undefined, run, runPath };
  }
  return { directory, baseline: state ? (JSON.parse(state) ?? undefined) : undefined };
}

export async function captureSyncFiles(
  preview: SyncPreview,
  signal = new AbortController().signal,
  progress: (p: SyncProgress) => void = () => undefined,
) {
  if (preview.blocked) return;
  const local = preview.source.local;
  const manifest = await readManifest(local.root);
  if (
    local.manifest &&
    (manifest.path !== local.manifest.path || decode(manifest.bytes) !== decode(local.manifest.bytes))
  )
    fail("snapshotChanged");
  if (!equal(manifest.data.zoteroCollections, local.zoteroCollections)) fail("snapshotChanged");
  const files: Record<string, string> = { [manifest.path]: decode(manifest.bytes) };
  for (const item of local.items) {
    const raw = await optionalText(local.root, item.notePath);
    if (raw === null || !equal(parseLibraryYaml(splitLibraryNote(encode(raw)).yaml).values, item.frontmatter))
      return fail("snapshotChanged");
    files[item.notePath] = raw;
  }
  preview.files = files;
  preview.draft = await resolveZoteroSync(preview, {}, signal, progress);
}

async function responseJSON(response: Response) {
  try {
    return await response.json();
  } catch {
    return fail("invalidResponse");
  }
}
function client(serverId: string, signal: AbortSignal) {
  let secret = "",
    authPath = "",
    authRoot = "";
  async function request(
    path: string,
    method = "GET",
    body?: unknown,
    headers: Record<string, string> = {},
    file = false,
  ): Promise<Response> {
    signal.throwIfAborted();
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, path === "/local/authorize" ? 180000 : file ? 90000 : 15000);
    try {
      const response = await fetch(`http://localhost:23119/api${path}`, {
        method,
        signal: controller.signal,
        connectTimeout: 3000,
        maxRedirections: 0,
        headers: {
          // The HTTP plugin adds the webview's Origin by default; Zotero drops any request carrying one
          // (its guard against web pages). An empty value makes the plugin omit the header.
          Origin: "",
          "Zotero-API-Version": "3",
          "Zotero-Server-ID": serverId,
          ...(secret ? { "Zotero-API-Key": secret } : {}),
          ...(body ? { "Content-Type": "application/json" } : {}),
          ...headers,
        },
        body:
          body === undefined
            ? undefined
            : body instanceof URLSearchParams
              ? body.toString()
              : body instanceof Uint8Array
                ? new Uint8Array(body)
                : JSON.stringify(body),
      });
      if (response.status === 401 && method !== "GET" && authPath && (await exists(authPath)))
        await remove(await checkedPath(authRoot, authPath));
      if (response.status === 403)
        fail(
          (await response.text()).includes("Local API is not enabled")
            ? "communicationDisabled"
            : "authorizationDenied",
        );
      if (response.status === 401) fail("authorizationDenied");
      if (response.status === 412) fail("snapshotChanged");
      if (response.status >= 300 && response.status < 400 && !(file && method === "GET" && response.status === 302))
        fail("redirectRefused");
      if (!serverId && response.status === 404) fail("oldVersion");
      if (!response.ok && !(file && method === "GET" && [302, 404].includes(response.status))) fail("requestFailed");
      const id = response.headers.get("Zotero-Server-ID");
      if (!id) fail("oldVersion");
      if (serverId && id !== serverId) fail("snapshotChanged");
      serverId = id!;
      const content = await response.text();
      return new Response([204, 205, 304].includes(response.status) ? null : content, response);
    } catch (error) {
      signal.throwIfAborted();
      // Transport errors may include request headers. Never expose or persist their text or cause.
      if (error instanceof Error && /^zoteroSync\.[a-zA-Z]+$/.test(error.message)) throw error;
      return fail(controller.signal.aborted ? "timeout" : method === "GET" ? "notRunning" : "requestFailed");
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    }
  }
  const data = async (path: string) => responseJSON(await request(path));
  async function attachment(key: string): Promise<string | null> {
    const response = await request(`/users/0/items/${key}/file`, "GET", undefined, {}, true);
    if (response.status === 404) return null;
    if (response.status !== 302) return fail("invalidResponse");
    const location = response.headers.get("Location") ?? "";
    if (!/^file:\/\/(?:localhost)?\//i.test(location)) fail("attachmentAddress");
    const url = new URL(location),
      path = decodeURIComponent(url.pathname).replace(/^\/(?=[a-z]:\/)/i, "");
    if (
      (url.host && url.host !== "localhost") ||
      url.search ||
      url.hash ||
      path.startsWith("//") ||
      path.includes("\\") ||
      path.includes("\0")
    )
      fail("attachmentAddress");
    if (!(await exists(path))) return null;
    if (!(await lstat(path)).isFile) return fail("attachmentAddress");
    return path;
  }
  return {
    request,
    attachment,
    async upload(key: string, source: FileStamp) {
      const bytes = await checkedBytes(source),
        current = await data(`/users/0/items/${key}`);
      const headers: Record<string, string> = current.data.md5
        ? { "If-Match": String(current.data.md5) }
        : { "If-None-Match": "*" };
      const endpoint = `/users/0/items/${key}/file`;
      const form = (body: Record<string, string>) =>
        request(
          endpoint,
          "POST",
          new URLSearchParams(body),
          { ...headers, "Content-Type": "application/x-www-form-urlencoded" },
          true,
        );
      const upload = await responseJSON(
        await form({
          md5: md5(bytes),
          filename: source.path.split("/").at(-1)!,
          filesize: String(source.size),
          mtime: String(Math.trunc(source.mtime ?? 0)),
        }),
      );
      if (!upload.exists) {
        if (typeof upload.url !== "string" || !URL.canParse(upload.url)) fail("uploadAddress");
        const url = new URL(upload.url);
        if (
          url.origin !== "http://localhost:23119" ||
          url.username ||
          url.password ||
          !url.pathname.startsWith("/api/local/uploads/")
        )
          fail("uploadAddress");
        if (upload.prefix || upload.suffix) fail("uploadFormat");
        if (typeof upload.uploadKey !== "string" || !upload.uploadKey) fail("invalidResponse");
        await request(
          url.pathname.slice(4) + url.search,
          "POST",
          bytes,
          { "Content-Type": upload.contentType || "application/octet-stream", "Content-Length": String(bytes.length) },
          true,
        );
        await form({ upload: upload.uploadKey });
      }
      const path = await attachment(key);
      if (!path || (await fileStamp(path)).hash !== source.hash) fail("writeMismatch");
      return validatePage([await data(`/users/0/items/${key}`)], "items")[0];
    },
    get serverId() {
      return serverId;
    },
    async authorize() {
      try {
        const home = documentPath(await appDataDir()).replace(/\/$/, "");
        authRoot = `${home}/zotero-sync/auth`;
        await privateDirectory(home, authRoot);
        const mode = (await lstat(authRoot)).mode;
        if (mode !== null && mode & 0o077) fail("storageFailed");
        authPath = `${authRoot}/${await digest(serverId)}.json`;
        const saved = await optionalText(authRoot, authPath);
        if (saved) {
          let auth;
          try {
            auth = JSON.parse(saved);
          } catch {
            return fail("storageFailed");
          }
          const mode = (await lstat(authPath)).mode;
          if (mode !== null && mode & 0o077) fail("storageFailed");
          if (auth.serverId !== serverId || typeof auth.key !== "string" || !auth.key) fail("storageFailed");
          secret = auth.key;
          return;
        }
        let auth;
        try {
          auth = await (await request("/local/authorize", "POST", { appName: "LabWeave" })).json();
        } catch (error) {
          if (error instanceof Error && error.message.startsWith("zoteroSync.")) throw error;
          return fail("authorizationDenied");
        }
        if (!auth.remember || typeof auth.key !== "string" || !auth.key) fail("persistentAuthorization");
        await storeJSON(authRoot, authPath, { serverId, key: auth.key });
        secret = auth.key;
      } catch (error) {
        if (error instanceof Error && /^zoteroSync\.[a-zA-Z]+$/.test(error.message)) throw error;
        fail("storageFailed");
      }
    },
    async template(itemType: string): Promise<Record<string, unknown>> {
      const fields = await data(`/itemTypeFields?itemType=${encodeURIComponent(itemType)}`);
      if (!Array.isArray(fields) || !fields.every((f) => isObject(f) && typeof f.field === "string"))
        fail("invalidResponse");
      return {
        itemType,
        ...Object.fromEntries(fields.map((f: { field: string }) => [f.field, ""])),
        creators: [],
        tags: [],
        collections: [],
        relations: {},
      };
    },
    async write(op: APIAction, fields = op.fields, version = op.version, create = op.before === null) {
      const path = `/users/0/${op.resource}`;
      const response = await request(
        create ? path : `${path}/${op.key}`,
        create ? "POST" : "PATCH",
        create ? [{ ...fields, key: op.key, version: 0 }] : { ...fields, version },
      );
      if (create) {
        let result;
        try {
          result = await response.json();
        } catch {
          return fail("invalidResponse");
        }
        if (Object.keys(result.failed ?? {}).length)
          fail(
            Object.values(result.failed).some((v) => isObject(v) && v.code === 412)
              ? "snapshotChanged"
              : "requestFailed",
          );
      }
      const result = validatePage([await data(`${path}/${op.key}`)], op.resource)[0];
      if (result.version <= version) fail("snapshotChanged");
      if (!Object.entries(fields).every(([f, value]) => equal(result[f], value))) fail("writeMismatch");
      return result;
    },
  };
}

const types: Record<string, string> = {
  journalArticle: "期刊文章",
  conferencePaper: "会议论文",
  preprint: "预印本",
  book: "书籍",
  thesis: "学位论文",
  webpage: "网页",
  document: "其他",
};
function remoteField(d: ZoteroData, field: SyncField, value: SyncValue, values: SyncValues): Record<string, unknown> {
  if (field === "status" || field === "tags") {
    if (!Object.values(libraryStatuses).includes(text(values.status))) fail("invalidStatus");
    return {
      tags: sorted([...(values.tags as string[]), `阅读/${values.status}`]).map(
        (tag) => d.tags?.find((t) => t.tag === tag) ?? { tag },
      ),
    };
  }
  if (field === "authors")
    return {
      creators: [
        ...(value as string[]).map((name) => {
          const old = d.creators?.find(
            (c) => c.creatorType === "author" && (c.name || `${c.firstName ?? ""} ${c.lastName ?? ""}`.trim()) === name,
          );
          const space = name.lastIndexOf(" ");
          return (
            old ?? {
              creatorType: "author",
              ...(space < 0 ? { name } : { firstName: name.slice(0, space), lastName: name.slice(space + 1) }),
            }
          );
        }),
        ...(d.creators ?? []).filter((c) => c.creatorType !== "author"),
      ],
    };
  if (field === "year")
    return {
      date:
        value && /\b(?:19|20)\d{2}\b/.test(text(d.date))
          ? text(d.date).replace(/\b(?:19|20)\d{2}\b/, text(value))
          : value,
    };
  const name =
    field === "venue"
      ? ({ journalArticle: "publicationTitle", conferencePaper: "proceedingsTitle", preprint: "repository" }[
          d.itemType ?? ""
        ] ?? "")
      : (({ doi: "DOI", abstract: "abstractNote" } as Partial<Record<SyncField, string>>)[field] ?? field);
  if (!name) fail("unsupportedField");
  return { [name]: value };
}

function newKey(used: Set<string>) {
  const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  let key;
  do {
    key = Array.from(crypto.getRandomValues(new Uint8Array(8)), (v) => alphabet[v % alphabet.length]).join("");
  } while (used.has(key));
  used.add(key);
  return key;
}
export async function resolveZoteroSync(
  preview: SyncPreview,
  choices: Record<string, SyncChoice>,
  signal: AbortSignal,
  progress: (p: SyncProgress) => void = () => undefined,
): Promise<SyncRun> {
  if (preview.blocked || !preview.files) return fail("snapshotChanged");
  const { local, remote } = preview.source,
    api = client(remote.serverId, signal);
  const actions: SyncAction[] = [],
    templates = new Map<string, Record<string, unknown>>();
  const next: SyncBaseline = structuredClone(
    preview.baseline ?? { schema: 1, root: local.root, serverId: remote.serverId, pairs: {}, collections: {} },
  );
  // Conflicts default to skip; every other row runs unless the user unticked it.
  const direction = (row: SyncRow) =>
    row.group === "conflict"
      ? { local: "push", remote: "pull", skip: "skip" }[choices[rowId(row)] ?? "skip"]
      : choices[rowId(row)] === "skip"
        ? "skip"
        : row.group;
  const used = new Set([...remote.items, ...remote.collections].map((d) => d.key));
  const aliases = new Map(
    Object.keys(preview.collectionPaths.local)
      .filter((k) => k.startsWith("local:"))
      .map((k) => [k, newKey(used)]),
  );
  const keyOf = (key: string) => aliases.get(key) ?? key;
  const lp = new Map(Object.entries(preview.collectionPaths.local).map(([k, p]) => [keyOf(k), p]));
  const rp = new Map(Object.entries(preview.collectionPaths.remote));
  for (const row of preview.rows.filter((r) => r.kind === "collection")) {
    const k = keyOf(row.key!);
    if (direction(row) === "push") rp.set(k, text(row.local));
    if (direction(row) === "pull") lp.set(k, text(row.remote));
  }
  for (const paths of [lp, rp]) {
    if (new Set(paths.values()).size !== paths.size) fail("invalidCollections");
    for (const path of paths.values())
      if (path.includes("/") && ![...paths.values()].includes(path.slice(0, path.lastIndexOf("/"))))
        fail("invalidCollections");
  }
  // The baseline only records memberships of collections present on both sides, so a membership in an
  // unticked collection shows up again next time instead of looking settled (or later reading as a removal).
  const synced = (keys: string[]) => sorted(keys.filter((k) => lp.has(k) && rp.has(k)));
  function apiAction(
    resource: APIAction["resource"],
    key: string,
    fields: Record<string, unknown>,
    before?: ZoteroData,
  ) {
    delete fields.version;
    if (!Object.keys(fields).length) return;
    actions.push({
      kind: "api",
      resource,
      key,
      fields,
      version: before?.version ?? 0,
      before: before
        ? Object.fromEntries(
            Object.keys(fields).map((f) => [
              f,
              before[f] ?? (["tags", "collections", "creators"].includes(f) ? [] : ""),
            ]),
          )
        : null,
    });
  }
  for (const [key, path] of [...rp].sort((a, b) => a[1].split("/").length - b[1].split("/").length)) {
    const before = remote.collections.find((c) => c.key === key);
    const parent = path.includes("/") ? [...rp].find(([, p]) => p === path.slice(0, path.lastIndexOf("/")))![0] : false;
    const fields = { name: path.split("/").at(-1)!, parentCollection: parent };
    if (
      !before ||
      !equal(fields.name, before.name) ||
      !equal(fields.parentCollection, before.parentCollection ?? false)
    )
      apiAction("collections", key, fields, before);
  }
  for (const key of new Set([...lp.keys(), ...rp.keys()])) {
    const row = preview.rows.find((r) => r.kind === "collection" && keyOf(r.key!) === key);
    if (row && direction(row) === "skip") continue;
    if (lp.has(key) && rp.has(key)) next.collections[key] = { local: lp.get(key)!, remote: rp.get(key)! };
  }
  const originalKeys = new Map(Object.entries(preview.collectionPaths.local).map(([k, p]) => [p, keyOf(k)]));
  const pairMap = new Map(Object.entries(preview.pairs).map(([k, p]) => [p.path, k]));
  const notes = new Map<
    string,
    { before: string | null; fm: Record<string, unknown>; body: string; opening: string; closing: string; yaml: string }
  >();
  const readNote = (path: string) => {
    const existing = notes.get(path);
    if (existing) return existing;
    const before = preview.files![path],
      parts = splitLibraryNote(encode(before));
    const note = { before, fm: parseLibraryYaml(parts.yaml).values, ...parts };
    const parsed = { ...note, body: decode(parts.body) };
    notes.set(path, parsed);
    return parsed;
  };
  const template = async (type: string) => {
    if (!templates.has(type)) templates.set(type, await api.template(type));
    return templates.get(type)!;
  };
  async function fieldsFor(d: ZoteroData, desired: SyncValues, fields: readonly SyncField[]) {
    const result: Record<string, unknown> = {};
    for (const field of fields) {
      if (equal(desired[field], remoteValues(d)[field])) continue;
      const patch = remoteField(d, field, desired[field], desired);
      for (const name of Object.keys(patch))
        if (
          !(name in d) &&
          !["tags", "collections", "creators"].includes(name) &&
          !(name in (await template(d.itemType!)))
        )
          fail("unsupportedField");
      Object.assign(result, patch);
    }
    return result;
  }
  for (const item of local.items) {
    signal.throwIfAborted();
    const rows = preview.rows.filter((r) => r.path === item.notePath);
    const creating = rows.some((r) => r.kind === "item" && direction(r) === "push");
    // Unticking a DOI/arXiv/title match leaves the paper unlinked, together with its field changes.
    const unlinked = rows.some((r) => r.kind === "link" && direction(r) === "skip");
    const key = unlinked
      ? undefined
      : (pairMap.get(item.notePath) ??
        (creating
          ? (Object.entries(preview.draft?.next.pairs ?? {}).find(([, p]) => p.path === item.notePath)?.[0] ??
            newKey(used))
          : undefined));
    const note = readNote(item.notePath);
    if (key) {
      const pair = preview.pairs[key];
      const lv = pair ? structuredClone(pair.local) : localValues(item, originalKeys);
      lv.collections = sorted((lv.collections as string[]).map(keyOf));
      const type = Object.entries(types).find(([, label]) => label === item.itemType)?.[0] ?? "document";
      const d = creating
        ? ({ ...(await template(type)), key, version: 0 } as ZoteroData)
        : remote.items.find((d) => d.key === key)!;
      const desired = creating ? structuredClone(lv) : structuredClone(pair.remote);
      const localDesired = structuredClone(lv);
      const pushed: SyncField[] = [];
      for (const row of rows.filter((r) => r.kind === "field")) {
        if (direction(row) === "push") {
          desired[row.field!] = lv[row.field!];
          pushed.push(row.field!);
        }
        if (direction(row) === "pull") localDesired[row.field!] = pair.remote[row.field!];
      }
      // A paper can only join collections that exist on that side after this run (an unticked new one does not).
      desired.collections = sorted((desired.collections as string[]).filter((k) => rp.has(k)));
      localDesired.collections = sorted((localDesired.collections as string[]).filter((k) => lp.has(k)));
      const patch = await fieldsFor(d, desired, creating ? syncFields : pushed);
      apiAction("items", key, creating ? { ...d, ...patch, key, version: 0 } : patch, creating ? undefined : d);
      if (creating || rows.some((r) => r.kind === "link"))
        Object.assign(note.fm, {
          zotero_key: key,
          zotero_uri: `zotero://select/library/items/${key}`,
          zotero_item_type: d.itemType,
        });
      for (const row of rows.filter((r) => r.kind === "field" && direction(r) === "pull"))
        note.fm[row.field!] = localDesired[row.field!];
      if (localDesired.status === "conflict") fail("invalidStatus");
      const paths = (localDesired.collections as string[]).map((k) => lp.get(k)!);
      // Keep the note's own order when the set is unchanged, so an untouched note is not rewritten.
      if (!equal(sorted(paths), sorted(Array.isArray(note.fm.collections) ? note.fm.collections.map(text) : [])))
        note.fm.collections = paths;
      const baseline: { path: string; local: SyncValues; remote: SyncValues } = {
        path: item.notePath,
        local: { ...localDesired, collections: synced(localDesired.collections as string[]) },
        remote: { ...desired, collections: synced(desired.collections as string[]) },
      };
      for (const row of rows.filter((r) => r.kind === "field" && direction(r) === "skip")) {
        for (const side of ["local", "remote"] as const) {
          const previous = preview.baseline?.pairs[key]?.[side][row.field!];
          if (previous === undefined) delete (baseline[side] as Partial<SyncValues>)[row.field!];
          else baseline[side][row.field!] = previous;
        }
      }
      next.pairs[key] = baseline;
    } else if (Array.isArray(note.fm.collections))
      note.fm.collections = note.fm.collections.map((p) => lp.get(originalKeys.get(text(p)) ?? "") ?? p);
  }
  const itemsDir = await checkedPath(local.root, `${local.root}/条目`, true);
  const occupied = new Set(((await exists(itemsDir)) ? await readDir(itemsDir) : []).map((e) => e.name.toLowerCase()));
  for (const row of preview.rows.filter((r) => r.kind === "item" && direction(r) === "pull")) {
    const d = remote.items.find((d) => d.key === row.key)!,
      values = remoteValues(d);
    if (values.status === "conflict") {
      if (preview.rows.some((r) => r.key === row.key && r.group === "conflict" && direction(r) !== "skip"))
        fail("invalidStatus");
      continue;
    }
    values.collections = (values.collections as string[]).filter((k) => rp.has(k));
    const clean = (s: string) => s.replace(/[^\p{L}\p{N}]/gu, "");
    const words = text(values.title)
      .split(/[^\p{L}\p{N}_]+/u)
      .filter((w) => !["a", "an", "the", "on", "of", "for"].includes(w.toLowerCase()));
    const base =
      Array.from(
        ((values.authors as string[]).length ? clean((values.authors as string[])[0].split(/\s+/).at(-1)!) : "Anon") +
          values.year +
          clean(words[0] || "Untitled"),
      )
        .slice(0, 65)
        .join("") || d.key;
    let name = base,
      n = 1;
    while (occupied.has(name.toLowerCase())) name = `${base}${++n}`;
    occupied.add(name.toLowerCase());
    const path = preview.draft?.next.pairs[d.key]?.path ?? `${local.root}/条目/${name}/${name}.md`;
    notes.set(path, {
      before: null,
      fm: {
        type: "文献",
        itemType: types[d.itemType!] ?? "其他",
        ...values,
        collections: (values.collections as string[]).flatMap((k) => (lp.has(k) ? [lp.get(k)!] : [])),
        added: text(d.dateAdded).slice(0, 10),
        pdf: "",
        arxiv: "",
        zotero_key: d.key,
        zotero_uri: `zotero://select/library/items/${d.key}`,
        zotero_item_type: d.itemType,
      },
      opening: "---\n",
      closing: "---\n",
      yaml: "",
      body: "\n\n# 研究笔记\n",
    });
    next.pairs[d.key] = {
      path,
      local: { ...values, collections: synced(values.collections as string[]) },
      remote: { ...values, collections: synced(values.collections as string[]) },
    };
  }
  if (preview.draft) {
    // The draft planned media for every paper with nothing unticked. Keep what still belongs to a paper
    // in this run and was not unticked; the rest falls back to the previous baseline and comes up again.
    const draft = structuredClone(preview.draft.next),
      old = preview.baseline;
    // Attachment rows carry the attachment key, the notes export row its .md path.
    const unticked = new Set(
      preview.rows.filter((r) => r.group !== "skip" && direction(r) === "skip").map((r) => r.key ?? r.path),
    );
    const folder = (parent: string) => next.pairs[parent]?.path.replace(/[^/]*$/, "");
    const exportKept = (parent: string) =>
      !!folder(parent) && !unticked.has(`${folder(parent)}zotero/同步批注与笔记.md`);
    next.attachments = Object.fromEntries(
      Object.entries(draft.attachments ?? {}).filter(([k, a]) => folder(a.parent) && !unticked.has(k)),
    );
    const dropped = new Set(
      Object.entries(draft.attachments ?? {})
        .filter(([k]) => !next.attachments![k])
        .map(([, a]) => a.local.hash),
    );
    next.attachmentHistory = Object.fromEntries(
      Object.entries(draft.attachmentHistory ?? {}).map(([parent, hashes]) => [
        parent,
        folder(parent)
          ? hashes.filter((h) => !dropped.has(h) || old?.attachmentHistory?.[parent]?.includes(h))
          : (old?.attachmentHistory?.[parent] ?? []),
      ]),
    );
    next.exports = Object.fromEntries(
      Object.entries(draft.exports ?? {}).flatMap(([parent, value]) => {
        const kept = exportKept(parent) ? value : old?.exports?.[parent];
        return kept ? [[parent, kept]] : [];
      }),
    );
    next.attachmentFiles = draft.attachmentFiles;
    const keptFiles = new Set(Object.values(next.attachments).map((a) => a.local.path));
    for (const a of structuredClone(preview.draft.actions)) {
      if (a.kind === "api" ? a.upload && next.attachments[a.key] : a.download && keptFiles.has(a.path)) actions.push(a);
      else if (a.kind === "file" && a.media && !a.download) {
        const parent = Object.keys(next.pairs).find((k) => a.path.startsWith(`${folder(k)}zotero/`));
        if (parent && exportKept(parent)) actions.push(a);
      }
    }
  } else await planMedia(preview, next, actions, signal, progress);
  for (const a of Object.values(next.attachments ?? {})) {
    const note = notes.get(next.pairs[a.parent]?.path);
    if (note && !note.fm.pdf && /\.pdf$/i.test(a.local.path)) note.fm.pdf = a.local.path.split("/").at(-1);
  }
  for (const [path, note] of notes) {
    const original = note.before === null ? undefined : parseLibraryYaml(note.yaml);
    if (original && equal(original.values, note.fm)) continue;
    if (note.fm.year && /^\d+$/.test(text(note.fm.year))) note.fm.year = Number(note.fm.year);
    const doc = original?.document;
    if (doc)
      for (const [field, value] of Object.entries(note.fm))
        if (!equal(original!.values[field], value)) doc.set(field, value);
    const after = note.opening + (doc ? doc.toString() : stringify(note.fm)) + note.closing + note.body;
    actions.push({ kind: "file", path, before: note.before, after });
  }
  const manifestPath = Object.keys(preview.files).find((p) => /\.litlib$/i.test(p))!;
  const manifest = JSON.parse(preview.files[manifestPath]);
  const desiredPaths = new Set(lp.values());
  // Map only collections that exist in Zotero after this run (or were already mapped); an unticked new local
  // collection must stay unmapped, or the next preview would read it as deleted in Zotero.
  const mapped = new Set(Object.keys(manifest.zoteroCollections ?? {}));
  const updated = {
    ...manifest,
    collections: [...manifest.collections.filter((p: string) => desiredPaths.delete(p)), ...sorted([...desiredPaths])],
    zoteroCollections: Object.fromEntries([...lp].filter(([k]) => rp.has(k) || mapped.has(k))),
  };
  if (!equal(manifest, updated))
    actions.push({ kind: "file", path: manifestPath, before: preview.files[manifestPath], after: json(updated) });
  return {
    schema: 1,
    root: local.root,
    serverId: remote.serverId,
    status: "applying",
    before: preview.baseline ?? null,
    next,
    actions,
    skipped: preview.rows.filter((r) => r.group !== "skip" && direction(r) === "skip").length,
  };
}

// Match markdownify 1.2.3 defaults used by the plugin; parse in an inert template (no image/network loads).
function noteMarkdown(html: string): string {
  const template = document.createElement("template");
  template.innerHTML = html;
  const tag = (n: Node | null) => (n instanceof Element ? n.tagName.toLowerCase() : "");
  const block = (n: Node | null) =>
    /^(h[1-6]|p|blockquote|article|div|section|[ou]l|li|d[ldt]|table|thead|tbody|tfoot|tr|td|th)$/.test(tag(n));
  const outside = (n: Node | null) => block(n) || tag(n) === "pre";
  function convert(n: Node, parents: string[] = []): string {
    const t = tag(n),
      pre = parents.includes("pre"),
      noformat = parents.some((p) => /^(pre|code|kbd|samp)$/.test(p));
    const inline = parents.some((p) => /^(h[1-6]|td|th)$/.test(p));
    if (n.nodeType === 3) {
      let s = n.textContent ?? "";
      if (!pre) s = s.replace(/[\t \r\n]*[\r\n][\t \r\n]*/g, "\n").replace(/[\t ]+/g, " ");
      if (!noformat) s = s.replace(/[*_]/g, "\\$&");
      if (outside(n.previousSibling) || (block(n.parentNode) && !n.previousSibling)) s = s.replace(/^[ \t\r\n]+/, "");
      if (outside(n.nextSibling) || (block(n.parentNode) && !n.nextSibling)) s = s.trimEnd();
      return s;
    }
    if (n.nodeType === 8 || ["script", "style"].includes(t)) return "";
    const children = [...n.childNodes].filter(
      (c) =>
        !(
          c.nodeType === 3 &&
          !c.textContent?.trim() &&
          ((block(n) && (!c.previousSibling || !c.nextSibling)) || outside(c.previousSibling) || outside(c.nextSibling))
        ),
    );
    const s = children
      .map((c) => convert(c, [...parents, t]))
      .reduce((a, b) => {
        const left = a.match(/\n+$/)?.[0].length ?? 0,
          right = b.match(/^\n+/)?.[0].length ?? 0;
        return !pre && t !== "pre" && left && right
          ? a.slice(0, -left) + "\n".repeat(Math.min(2, Math.max(left, right))) + b.slice(right)
          : a + b;
      }, "");
    const value = ["p", "blockquote"].includes(t) ? s.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "") : s.trim(),
      attr = (name: string) => (n as Element).getAttribute(name) ?? "";
    const wrapped = (start: string, end = start) =>
      value ? `${s.startsWith(" ") ? " " : ""}${start}${value}${end}${s.endsWith(" ") ? " " : ""}` : "";
    const markers: Record<string, string> = {
      b: "**",
      strong: "**",
      i: "*",
      em: "*",
      del: "~~",
      s: "~~",
      sub: "",
      sup: "",
    };
    if (t in markers) return noformat ? s : wrapped(markers[t]);
    if (["code", "kbd", "samp"].includes(t)) {
      const count = Math.max(0, ...[...value.matchAll(/`+/g)].map((m) => m[0].length));
      return noformat
        ? s
        : wrapped("`".repeat(count + 1) + (count ? " " : ""), (count ? " " : "") + "`".repeat(count + 1));
    }
    if (t === "a")
      return noformat || !attr("href")
        ? noformat
          ? s
          : value
        : value.replace(/\\_/g, "_") === attr("href") && !attr("title")
          ? `<${attr("href")}>`
          : wrapped("[", `](${attr("href")}${attr("title") ? ` "${attr("title").replace(/"/g, '\\"')}"` : ""})`);
    if (t === "img")
      return inline
        ? attr("alt")
        : `![${attr("alt")}](${attr("src")}${attr("title") ? ` "${attr("title").replace(/"/g, '\\"')}"` : ""})`;
    if (t === "video") {
      const src = attr("src") || (n as Element).querySelector("source[src]")?.getAttribute("src"),
        poster = attr("poster");
      return inline
        ? s
        : src
          ? poster
            ? `[![${s}](${poster})](${src})`
            : `[${s}](${src})`
          : poster
            ? `![${s}](${poster})`
            : s;
    }
    if (t === "br") return inline ? " " : "  \n";
    if (t === "hr") return "\n\n---\n\n";
    if (t === "q") return `"${s}"`;
    if (t === "pre") return s ? `\n\n\`\`\`\n${s.replace(/^[ \n]*\n|[ \n]*$/g, "")}\n\`\`\`\n\n` : "";
    if (/^h[1-6]$/.test(t))
      return inline
        ? s
        : Number(t[1]) <= 2
          ? value
            ? `\n\n${value}\n${(t === "h1" ? "=" : "-").repeat([...value].length)}\n\n`
            : ""
          : `\n\n${"#".repeat(Number(t[1]))} ${value.replace(/[\t \r\n]+/g, " ")}\n\n`;
    if (t === "blockquote")
      return inline
        ? ` ${value} `
        : value
          ? `\n${value
              .split("\n")
              .map((l) => (l ? `> ${l}` : ">"))
              .join("\n")}\n\n`
          : "\n";
    if (t === "li") {
      const parent = n.parentElement!;
      const bullet =
        tag(parent) === "ol"
          ? `${Number(parent.getAttribute("start") || 1) + [...parent.children].filter((c) => tag(c) === "li").indexOf(n as Element)}.`
          : "*+-"[(parents.filter((p) => p === "ul").length - 1) % 3];
      return value
        ? `${bullet} ${value
            .split("\n")
            .map((l, i) => (i && l ? " ".repeat(bullet.length + 1) + l : l))
            .join("\n")}\n`
        : "\n";
    }
    if (["ul", "ol"].includes(t))
      return parents.includes("li")
        ? "\n" + s.trimEnd()
        : "\n\n" +
            s +
            ((n as Element).nextElementSibling && !["ul", "ol"].includes(tag((n as Element).nextElementSibling))
              ? "\n"
              : "");
    const colspan = (e: Element) =>
      /^\d+$/.test(e.getAttribute("colspan") ?? "")
        ? Math.max(1, Math.min(1000, Number(e.getAttribute("colspan"))))
        : 1;
    if (["td", "th"].includes(t)) return ` ${value.replace(/\n/g, " ")}` + " |".repeat(colspan(n as Element));
    if (t === "tr") {
      const rows = [...(n as Element).closest("table")!.querySelectorAll("tr")],
        cells = [...(n as Element).children];
      const count = cells.reduce((sum, c) => sum + colspan(c), 0),
        header =
          cells.every((c) => tag(c) === "th") ||
          (tag(n.parentNode) === "thead" && n.parentElement!.querySelectorAll("tr").length === 1);
      const separator = "|" + " --- |".repeat(count) + "\n";
      return (
        (rows[0] === n && !header ? "|" + "  |".repeat(count) + "\n" + separator : "") +
        "|" +
        s +
        "\n" +
        (rows[0] === n && header ? separator : "")
      );
    }
    if (t === "dt") return inline ? ` ${value} ` : `\n\n${value.replace(/[\t \r\n]+/g, " ")}\n`;
    if (t === "dd") return inline ? ` ${value} ` : value ? `:   ${value.replace(/\n(?=.)/g, "\n    ")}\n` : "\n";
    if (["p", "div", "article", "section", "dl", "table", "figcaption"].includes(t))
      return inline ? ` ${value} ` : value ? `\n\n${value}\n\n` : "";
    if (t === "caption") return value + "\n\n";
    return s;
  }
  return convert(template.content).replace(/^\n+|\n+$/g, "");
}

async function fileStamp(path: string, cached?: FileStamp): Promise<FileStamp> {
  const info = await lstat(path),
    mtime = info.mtime?.getTime() ?? null;
  if (!info.isFile || info.isSymlink) return fail("attachmentAddress");
  if (cached?.path === path && mtime !== null && cached.size === info.size && cached.mtime === mtime) return cached;
  const hash = await digest(await readFile(path)),
    after = await lstat(path);
  if (after.size !== info.size || after.mtime?.getTime() !== info.mtime?.getTime()) fail("snapshotChanged");
  return { path, hash, size: info.size, mtime };
}
async function checkedBytes(source: FileStamp) {
  const bytes = await readFile(source.path);
  if (bytes.length !== source.size || (await digest(bytes)) !== source.hash) fail("snapshotChanged");
  return bytes;
}
async function planMedia(
  preview: SyncPreview,
  next: SyncBaseline,
  actions: SyncAction[],
  signal: AbortSignal,
  progress: (p: SyncProgress) => void,
) {
  const api = client(next.serverId, signal),
    remote = preview.source.remote.items;
  const before = preview.baseline?.attachments ?? {};
  const used = new Set(
    [...remote, ...preview.source.remote.collections, ...actions.filter((a) => a.kind === "api")].map((d) => d.key),
  );
  next.attachments ??= {};
  next.attachmentHistory ??= {};
  next.exports ??= {};
  next.attachmentFiles ??= {};
  for (const [parent, pair] of Object.entries(next.pairs)) {
    if (
      !preview.pairs[parent] &&
      !preview.rows.some((r) => r.kind === "item" && r.group !== "skip" && (r.key === parent || r.path === pair.path))
    )
      continue;
    signal.throwIfAborted();
    progress({ phase: "attachments", count: Object.keys(next.attachments).length });
    const folder = pair.path.slice(0, pair.path.lastIndexOf("/")),
      local: FileStamp[] = [];
    async function scan(dir: string) {
      for (const entry of await readDir(await checkedPath(next.root, dir))) {
        signal.throwIfAborted();
        if (entry.isSymlink) continue;
        const path = `${dir}/${entry.name}`;
        if (entry.isDirectory) await scan(path);
        else if (entry.isFile) {
          const stamp = await fileStamp(await checkedPath(next.root, path), next.attachmentFiles![path]);
          next.attachmentFiles![path] = stamp;
          local.push(stamp);
        }
      }
    }
    if (await exists(folder)) await scan(folder);
    const known = new Set(next.attachmentHistory[parent] ?? []),
      hashes = new Set<string>();
    Object.values(before)
      .filter((a) => a.parent === parent)
      .forEach((a) => known.add(a.local.hash));
    const children = remote.filter((d) => d.parentItem === parent),
      occupied = new Set(local.map((s) => s.path));
    for (const d of remote.filter(
      (d) =>
        (d.parentItem || d.key) === parent && d.itemType === "attachment" && !d.deleted && d.linkMode !== "linked_url",
    )) {
      const path = await api.attachment(d.key);
      if (!path) {
        preview.rows.push({
          group: "skip",
          kind: "notice",
          key: d.key,
          title: text(d.title),
          reason: "attachmentMissing",
        });
        continue;
      }
      const source = await fileStamp(path, before[d.key]?.remote);
      hashes.add(source.hash);
      if (before[d.key]?.remote.hash === source.hash) {
        next.attachments[d.key].remote = source;
        continue;
      }
      let target = local.find((s) => s.hash === source.hash);
      if (!target) {
        const name = (text(d.filename) || path.split("/").at(-1)!)
          .split(/[\\/]/)
          .at(-1)!
          .replace(/[<>:"|?*]/g, "_")
          .split("")
          .map((c) => (c.charCodeAt(0) < 32 ? "_" : c))
          .join("");
        if (!name || /^\.+$/.test(name)) fail("attachmentAddress");
        let dest = `${folder}/${name}`,
          counter = 1;
        while (occupied.has(dest) || (await exists(dest)))
          dest = `${folder}/${name.replace(/(\.[^.]*)?$/, `.zotero-${++counter}$1`)}`;
        occupied.add(dest);
        target = { ...source, path: dest, mtime: null };
        local.push(target);
        actions.push({ kind: "file", path: dest, before: null, after: source.hash, download: source, media: true });
        preview.rows.push({
          group: "attachment",
          kind: "notice",
          key: d.key,
          path: dest,
          title: dest.split("/").at(-1)!,
          size: source.size,
          reason: before[d.key] ? "downloadVersion" : "download",
        });
      }
      next.attachments[d.key] = { parent, local: target, remote: source };
    }
    if (!special(remote.find((d) => d.key === parent) ?? { key: parent, version: 0 }))
      for (const source of local) {
        if (source.path.slice(0, source.path.lastIndexOf("/")) !== folder || !/\.(pdf|csv)$/i.test(source.path))
          continue;
        if (hashes.has(source.hash) || known.has(source.hash)) continue;
        const key = newKey(used);
        const name = source.path.split("/").at(-1)!;
        actions.push({
          kind: "api",
          resource: "items",
          key,
          version: 0,
          before: null,
          upload: source,
          fields: {
            key,
            itemType: "attachment",
            linkMode: "imported_file",
            parentItem: parent,
            title: name,
            filename: name,
            contentType: /\.pdf$/i.test(name) ? "application/pdf" : "text/csv",
            tags: [],
            relations: {},
          },
        });
        next.attachments[key] = { parent, local: source, remote: { ...source, path: "", mtime: null } };
        hashes.add(source.hash);
        preview.rows.push({
          group: "attachment",
          kind: "notice",
          key,
          path: source.path,
          title: name,
          size: source.size,
          reason: Object.values(before).some((a) => a.parent === parent && a.local.path === source.path)
            ? "uploadVersion"
            : "upload",
        });
      }
    next.attachmentHistory[parent] = sorted([...known, ...hashes]);
    const records = [...children, ...children.flatMap((d) => remote.filter((c) => c.parentItem === d.key))].filter(
      (d) => ["annotation", "note"].includes(d.itemType!) && !d.deleted,
    );
    if (!records.length && !next.exports[parent]) continue;
    const sourceHash = await digest(
      json(
        records
          .toSorted((a, b) => (a.key < b.key ? -1 : 1))
          .map((d) =>
            Object.fromEntries(
              Object.entries(d).filter(
                ([f]) => !["version", "dateModified", "dateAdded", "lastRead", "charset"].includes(f),
              ),
            ),
          ),
      ),
    );
    const lines = ["# Zotero 批注与笔记", "", "此文件由同步更新；研究笔记请写在文献条目的正文中。", ""];
    for (const d of records.toSorted((a, b) => {
      const x = [a.parentItem, a.annotationSortIndex ?? "", a.key].join("\0"),
        y = [b.parentItem, b.annotationSortIndex ?? "", b.key].join("\0");
      return x < y ? -1 : x > y ? 1 : 0;
    })) {
      if (d.itemType === "note") lines.push("## Zotero 笔记", "", noteMarkdown(String(d.note ?? "")), "");
      else {
        const page = (JSON.parse(String(d.annotationPosition || "{}")).pageIndex ?? 0) + 1;
        lines.push(
          `## p.${page} · ${d.annotationType ?? ""}`,
          "",
          String(d.annotationText ?? ""),
          String(d.annotationComment ?? ""),
          `[在 Zotero 中打开](zotero://open-pdf/library/items/${d.parentItem}?page=${page}&annotation=${d.key})`,
          "",
        );
      }
    }
    let rawHash = "",
      exported = false;
    for (const [ext, after] of [
      ["json", json(records) + "\n"],
      ["md", lines.join("\n")],
    ]) {
      const path = `${folder}/zotero/同步批注与笔记.${ext}`,
        before = await optionalText(next.root, path);
      if (before !== null) preview.files![path] = before;
      const unchangedRaw =
        ext === "json" &&
        next.exports[parent]?.source === sourceHash &&
        before !== null &&
        (await digest(before)) === next.exports[parent]?.raw;
      if (ext === "json") rawHash = await digest(unchangedRaw ? before! : after);
      if (before === after || unchangedRaw) continue;
      actions.push({ kind: "file", path, before, after, media: true });
      exported = true;
    }
    // One row for the .md and .json pair; they are ticked together.
    if (exported)
      preview.rows.push({
        group: "pull",
        kind: "notice",
        path: `${folder}/zotero/同步批注与笔记.md`,
        title: text(pair.remote.title),
        reason: "exportNotes",
      });
    next.exports[parent] = { source: sourceHash, raw: rawHash };
  }
}

async function exclusive<T>(root: string, action: () => Promise<T>): Promise<T> {
  const key = documentKey(root);
  if (active.has(key)) fail("busy");
  active.add(key);
  try {
    return await action();
  } finally {
    active.delete(key);
  }
}
const versions = (data: ZoteroData[]) => Object.fromEntries(data.map((d) => [d.key, d.version]));
export async function applyZoteroSync(
  preview: SyncPreview,
  run: SyncRun,
  signal: AbortSignal,
  progress: (p: SyncProgress) => void,
): Promise<string> {
  return exclusive(run.root, async () => {
    const history = await readSyncHistory(run.root);
    if (pendingSync(history.run)) fail("unfinished");
    if (!equal(history.baseline ?? null, run.before) || !preview.files) fail("snapshotChanged");
    const api = client(run.serverId, signal);
    if (run.actions.some((a) => a.kind === "api")) {
      progress({ phase: "authorize", count: 0 });
      await api.authorize();
    }
    const current = await readZotero(signal, progress),
      source = preview.source.remote;
    if (
      current.serverId !== source.serverId ||
      current.libraryVersion !== source.libraryVersion ||
      !equal(versions(current.items), versions(source.items)) ||
      !equal(versions(current.collections), versions(source.collections))
    )
      fail("snapshotChanged");
    const local = await loadLibrary(run.root);
    if (
      local.errors.length ||
      !equal(sorted(local.items.map((i) => i.notePath)), sorted(preview.source.local.items.map((i) => i.notePath)))
    )
      fail("snapshotChanged");
    for (const [path, before] of Object.entries(preview.files!))
      if ((await optionalText(run.root, path)) !== before) fail("snapshotChanged");
    for (const op of run.actions)
      if (
        op.kind === "file" &&
        op.before === null &&
        (await exists(op.media ? op.path : op.path.slice(0, op.path.lastIndexOf("/"))))
      )
        fail("snapshotChanged");
    for (const op of run.actions) {
      const source = op.kind === "file" ? op.download : op.upload;
      if (source && (await fileStamp(source.path, source)).hash !== source.hash) fail("snapshotChanged");
    }
    const home = documentPath(await appDataDir());
    await privateDirectory(home, history.directory);
    const timestamp = Math.max(Date.now(), Number(history.runPath?.match(/\/run-(\d+)-/)?.[1] ?? 0) + 1);
    const runPath = `${history.directory}/run-${timestamp}-${crypto.randomUUID()}`;
    await privateDirectory(home, runPath);
    // Undo needs the old text of files this run overwrites; it is written once here, the journal keeps hashes.
    for (const [index, op] of run.actions.entries()) {
      if (op.kind !== "file") continue;
      op.afterHash = await afterHash(op);
      op.beforeHash = await beforeHash(op);
      if (op.before === null) continue;
      await privateDirectory(runPath, `${runPath}/before`);
      await writeFile(`${runPath}/before/${index}`, encode(op.before), { mode: 0o600 });
    }
    const save = () => writeJournal(runPath, run);
    // "pending" is durable before each side effect, so an interrupted step is undone too.
    await save();
    const old = (await readDir(history.directory))
      .filter((e) => e.isDirectory && !e.isSymlink && /^run-[\dT-]+-[\da-f-]+$/.test(e.name))
      .sort((a, b) => b.name.localeCompare(a.name));
    for (const entry of old.slice(10))
      await remove(await checkedPath(history.directory, `${history.directory}/${entry.name}`), { recursive: true });
    for (const [index, op] of run.actions.entries()) {
      signal.throwIfAborted();
      progress({ phase: "apply", count: index, total: run.actions.length });
      op.status = "pending";
      await save();
      if (op.kind === "file" && op.download) op.placed = await placeSyncFile(run.root, op.download.path, op.path);
      else if (op.kind === "file")
        await writeSyncFile(run.root, op.path, encode(op.after), op.before === null ? null : encode(op.before));
      else {
        const after = await api.write(op);
        if (op.before === null) op.after = after;
        if (op.upload) {
          await save();
          op.after = await api.upload(op.key, op.upload);
          run.next.attachments![op.key].remote = await fileStamp((await api.attachment(op.key))!);
        }
      }
      op.status = "done";
      await save();
    }
    for (const [path, before] of Object.entries(preview.files!)) {
      const op = run.actions.find((a): a is FileAction => a.kind === "file" && a.path === path);
      if ((await optionalText(run.root, path)) !== (op?.after ?? before)) fail("snapshotChanged");
    }
    for (const op of run.actions)
      if (op.kind === "file" && (await fileHash(run.root, op)) !== op.afterHash) fail("snapshotChanged");
    for (const a of Object.values(run.next.attachments ?? {}))
      if (a.local.mtime === null && (await exists(a.local.path))) {
        // A downloaded copy has the source's hash; take size and time from the copy instead of reading it again
        const placed = run.actions.find((op) => op.kind === "file" && op.path === a.local.path && op.placed);
        a.local =
          placed?.kind === "file" && placed.placed ? { ...a.local, ...placed.placed } : await fileStamp(a.local.path);
        run.next.attachmentFiles![a.local.path] = a.local;
      }
    await storeJSON(history.directory, `${history.directory}/state.json`, run.next);
    run.status = "complete";
    await save();
    return runPath;
  });
}

export class SyncRollbackError extends Error {
  constructor(readonly changes: string[]) {
    super("zoteroSync.rollbackChanged");
  }
}
export async function rollbackZoteroSync(
  root: string,
  signal: AbortSignal,
  progress: (p: SyncProgress) => void,
): Promise<void> {
  return exclusive(root, async () => {
    const history = await readSyncHistory(root),
      run = history.run,
      runPath = history.runPath;
    if (!run || !runPath) return fail("noBackup");
    if (run.status === "rolled-back") return;
    // Journals since 11-13 keep an overwritten file's old text in before/<index> instead of inline.
    for (const [index, op] of run.actions.entries())
      if (op.kind === "file" && op.before === undefined)
        op.before = decode(await readFile(await checkedPath(runPath, `${runPath}/before/${index}`)));
    if (!equal(history.baseline ?? null, run.before) && !equal(history.baseline, run.next)) fail("snapshotChanged");
    const current = await readZotero(signal, progress);
    if (current.serverId !== run.serverId) fail("baselineMismatch");
    const maps = {
      items: new Map(current.items.map((d) => [d.key, d])),
      collections: new Map(current.collections.map((d) => [d.key, d])),
    };
    const operations = run.actions
      .filter((a) => a.status)
      .toReversed()
      .sort(
        (a, b) =>
          Number(a.kind === "file" && /\.litlib$/i.test(a.path)) -
          Number(a.kind === "file" && !!a.media) -
          Number(b.kind === "file" && /\.litlib$/i.test(b.path)) +
          Number(b.kind === "file" && !!b.media),
      );
    const changes: string[] = [];
    const api = client(run.serverId, signal);
    const clean = (d: Record<string, unknown>) =>
      Object.fromEntries(
        Object.entries(d).filter(([f]) => !["version", "dateModified", "dateAdded", "lastRead", "charset"].includes(f)),
      );
    for (const op of operations) {
      if (op.kind === "file") {
        const value = await fileHash(root, op);
        if (value !== (await beforeHash(op)) && (op.status === "restored" || value !== (await afterHash(op))))
          changes.push(op.path);
      } else {
        const value = maps[op.resource].get(op.key);
        if (op.before === null) {
          const uploaded = op.upload && value && !value.deleted ? await api.attachment(op.key) : null;
          if (uploaded && (await fileStamp(uploaded)).hash !== op.upload!.hash) changes.push(op.key);
          const comparable = (d: ZoteroData) =>
            clean(op.upload ? Object.fromEntries(Object.entries(d).filter(([f]) => !["md5", "mtime"].includes(f))) : d);
          if (
            value &&
            !value.deleted &&
            (op.status === "restored" ||
              (op.after
                ? !equal(comparable(value), comparable(op.after))
                : !Object.entries(op.fields).every(([f, v]) => equal(value[f], v))))
          )
            changes.push(op.key);
          const children = [...current.items, ...current.collections].filter((d) => {
            if (d.deleted) return false;
            const undo = operations.find((a): a is APIAction => a.kind === "api" && a.key === d.key);
            const restores = (field: string) => undo && (undo.before === null || Object.hasOwn(undo.before, field));
            return (
              (d.parentItem === op.key && !restores("parentItem")) ||
              (d.parentCollection === op.key && !restores("parentCollection")) ||
              (op.resource === "collections" && d.collections?.includes(op.key) && !restores("collections"))
            );
          });
          changes.push(...children.map((d) => d.key));
        } else if (!value) changes.push(op.key);
        else
          for (const [f, before] of Object.entries(op.before))
            if (
              !equal(value[f] ?? (Array.isArray(before) ? [] : ""), before) &&
              (op.status === "restored" || !equal(value[f], op.fields[f]))
            )
              changes.push(`${op.key}/${f}`);
      }
    }
    if (changes.length) throw new SyncRollbackError(sorted(changes));
    if (operations.some((a) => a.kind === "api" && a.status !== "restored")) {
      progress({ phase: "authorize", count: 0 });
      await api.authorize();
    }
    run.status = "rolling-back";
    const save = () => writeJournal(runPath, run);
    await save();
    await privateDirectory(runPath, `${runPath}/removed`);
    for (const [index, op] of operations.entries()) {
      signal.throwIfAborted();
      progress({ phase: "rollback", count: index, total: operations.length });
      if (op.status === "restored") continue;
      if (op.kind === "file") {
        const value = await fileHash(root, op),
          before = await beforeHash(op);
        if (value !== before && value !== (await afterHash(op))) throw new SyncRollbackError([op.path]);
        if (op.before === null) {
          const relative = documentPath(op.path).slice(documentPath(root).replace(/\/$/, "").length + 1);
          const target = `${runPath}/removed/${relative}`;
          await privateDirectory(runPath, target.slice(0, target.lastIndexOf("/")));
          await stashSyncFile(root, op.path, runPath, target);
        } else if (value !== before)
          await writeSyncFile(root, op.path, encode(op.before), await readFile(await checkedPath(root, op.path)));
      } else {
        const value = maps[op.resource].get(op.key);
        if (
          value &&
          (op.before === null
            ? !value.deleted
            : Object.entries(op.before).some(([f, v]) => !equal(value[f] ?? (Array.isArray(v) ? [] : ""), v)))
        ) {
          const after = await api.write(op, op.before ?? { deleted: true }, value.version, false);
          maps[op.resource].set(op.key, after);
        }
      }
      op.status = "restored";
      await save();
    }
    await storeJSON(history.directory, `${history.directory}/state.json`, run.before);
    run.status = "rolled-back";
    await save();
  });
}
