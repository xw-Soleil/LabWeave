import { fetch } from "@tauri-apps/plugin-http";
import type { LibraryItem, LibrarySnapshot } from "./Library";
import { libraryStatuses } from "./LibraryFormat";
import { documentKey } from "./DocumentFile";

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
export type SyncGroup = "push" | "pull" | "conflict" | "skip";
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
  pairs: Record<string, SyncPair>;
  collections: Record<string, { local: string; remote: string }>;
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
}

export interface SyncProgress {
  phase: "connect" | "items" | "collections" | "pairing";
  count: number;
}

const text = (value: unknown): string => (value == null ? "" : String(value).trim());
const sorted = (values: string[]) => [...new Set(values)].sort();
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
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
  let serverId = "",
    libraryVersion: string | undefined;
  async function get(path: string, read: boolean): Promise<unknown> {
    signal.throwIfAborted();
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, 15000);
    try {
      const response = await fetch(`http://localhost:23119/api${path}`, {
        method: "GET",
        signal: controller.signal,
        connectTimeout: 3000,
        maxRedirections: 0,
        // The first request discovers the ID; subsequent requests pin that instance.
        headers: { "Zotero-API-Version": "3", "Zotero-Server-ID": serverId },
      });
      if (response.status === 403) {
        const body = await response.text();
        fail(body.includes("Local API is not enabled") ? "communicationDisabled" : "authorizationDenied");
      }
      if (response.status === 401) fail("authorizationDenied");
      if (response.status === 412) fail("snapshotChanged");
      if (response.status >= 300 && response.status < 400) fail("redirectRefused");
      if (!serverId && response.status === 404) fail("oldVersion");
      if (!response.ok) fail("requestFailed");
      const id = response.headers.get("Zotero-Server-ID");
      if (!id) fail("oldVersion");
      if (serverId && id !== serverId) fail("snapshotChanged");
      serverId = id!;
      if (!read) return await response.text();
      const version = response.headers.get("Last-Modified-Version");
      if (version) {
        if (libraryVersion !== undefined && version !== libraryVersion) fail("snapshotChanged");
        libraryVersion = version;
      }
      try {
        return await response.json();
      } catch {
        return fail(controller.signal.aborted ? "timeout" : "invalidResponse");
      }
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof Error && error.message.startsWith("zoteroSync.")) throw error;
      return fail(controller.signal.aborted ? "timeout" : "notRunning");
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    }
  }
  progress({ phase: "connect", count: 0 });
  await get("/", false);
  async function all(kind: "items" | "collections") {
    const result: ZoteroData[] = [],
      seen = new Set<string>();
    progress({ phase: kind, count: 0 });
    for (let start = 0; start < 1000000; start += 100) {
      const page = validatePage(await get(`/users/0/${kind}?start=${start}&limit=100`, true), kind);
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
  return { serverId, items, collections, libraryVersion };
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
  const remotePaths = collectionPaths(remote.collections);
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
