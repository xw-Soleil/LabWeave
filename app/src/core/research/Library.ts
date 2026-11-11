import { Settings } from "@/core/service/Settings";
import { invoke } from "@tauri-apps/api/core";
import {
  copyFile,
  exists,
  lstat,
  mkdir,
  open,
  readDir,
  readFile,
  readTextFileLines,
  remove,
  rename,
} from "@tauri-apps/plugin-fs";
import i18next from "i18next";
import { useCallback, useEffect, useRef, useState } from "react";
import { documentKey, documentPath } from "./DocumentFile";
import {
  createLibraryNote,
  libraryExtra,
  libraryMetadata,
  libraryStatuses,
  makeLibraryKey,
  parseLibraryYaml,
  splitLibraryNote,
  updateLibraryNote,
  validateLibraryPatch,
  type CreateLibraryItemFields,
  type LibraryItemFields,
  type LibraryItemPatch,
  type ReadStatus,
} from "./LibraryFormat";

export type { CreateLibraryItemFields, LibraryItemFields, LibraryItemPatch, ReadStatus } from "./LibraryFormat";

export interface LibraryItem extends LibraryItemFields {
  key: string;
  dir: string;
  notePath: string;
  pdfPath?: string;
  translations: { dual?: string; mono?: string };
  annotationsPath?: string;
  extra: Record<string, unknown>;
}

export interface LibraryItemError {
  key: string;
  notePath: string;
  code: string;
}

export interface LibrarySnapshot {
  root: string;
  collections: string[];
  items: LibraryItem[];
  errors: LibraryItemError[];
}

export interface LibraryFilter {
  search?: string;
  collection?: string;
  tags?: string[];
  status?: ReadStatus;
  unfiled?: boolean;
  /** Defaults to false; "all" includes both active and trashed items. */
  trashed?: boolean | "all";
}

export interface LibrarySort {
  key: "title" | "authors" | "year" | "status" | "added";
  direction: "asc" | "desc";
}

export interface LibraryCounts {
  byStatus: Record<ReadStatus, number>;
  byCollection: Record<string, number>;
  byTag: Record<string, number>;
  unfiled: number;
  trashed: number;
  /** Active items only, matching the plugin's "all" view. */
  total: number;
}

export interface LibraryState {
  snapshot: LibrarySnapshot | null;
  loading: boolean;
  error: Error | null;
  /** 只重读修改时间变了的条目：切回窗口、鼠标移进文献库、自己改完之后都用这个 */
  refresh: () => Promise<void>;
  /** 整个重读一遍，给「刷新」按钮用 */
  reloadAll: () => Promise<void>;
}

const itemsName = "条目";
const concurrency = 8;
let authorization: { setting: string; canonical?: string; task: Promise<string> } | undefined;
const writes = new Map<string, Promise<unknown>>();

function errorCode(error: unknown, fallback: string): Error {
  return error instanceof Error && error.message.startsWith("library.") ? error : new Error(fallback, { cause: error });
}

function absolutePath(path: string): string {
  if (path.includes("\0") || !/^(?:\/|[a-z]:[\\/]|\\\\[^\\]+\\[^\\]+)/i.test(path)) {
    throw new Error("library.pathNotAllowed");
  }
  return documentPath(path);
}

function safeName(name: string): string {
  if (
    !name ||
    name === "." ||
    name === ".." ||
    name.length > 200 ||
    /[. ]$/.test(name) ||
    // eslint-disable-next-line no-control-regex -- Reject path separators, device names and alternate streams on both OSes.
    /[\\/:*?"<>|\u0000-\u001f\u007f]/.test(name) ||
    /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$)(?:\.|$)/i.test(name)
  ) {
    throw new Error("library.pathNotAllowed");
  }
  return name;
}

function itemPaths(root: string, key: string) {
  safeName(key);
  if (key.startsWith(".")) throw new Error("library.pathNotAllowed");
  const dir = `${root.replace(/\/$/, "")}/${itemsName}/${key}`;
  return { dir, notePath: `${dir}/${key}.md` };
}

async function authorizeLibrary(root: string): Promise<string> {
  const setting = Settings.literatureLibraryPath;
  if (!setting) throw new Error("library.notConfigured");
  const input = absolutePath(root);
  const configured = absolutePath(setting);
  const current = authorization?.setting === setting ? authorization : undefined;
  if (
    documentKey(input) !== documentKey(configured) &&
    (!current?.canonical || documentKey(input) !== documentKey(current.canonical))
  ) {
    throw new Error("library.pathNotAllowed");
  }
  if (!current) {
    const next = { setting, canonical: undefined as string | undefined, task: Promise.resolve("") };
    next.task = invoke<string>("authorize_research_project", { path: configured }).then((path) => {
      next.canonical = absolutePath(path);
      return next.canonical;
    });
    authorization = next;
  }
  try {
    const canonical = await authorization!.task;
    if (Settings.literatureLibraryPath !== setting) throw new Error("library.pathNotAllowed");
    const info = await lstat(canonical);
    if (!info.isDirectory || info.isSymlink) throw new Error("library.pathNotAllowed");
    return canonical;
  } catch (cause) {
    if (authorization?.setting === setting) authorization = undefined;
    throw errorCode(cause, "library.unavailable");
  }
}

/** The fs scope may also cover opened projects, so check each component inside this library. */
async function checkedPath(root: string, path: string, missingLeaf = false): Promise<string> {
  const normalized = absolutePath(path);
  const prefix = `${root.replace(/\/$/, "")}/`;
  if (!documentKey(normalized).startsWith(documentKey(prefix).replace(/\/$/, "") + "/")) {
    throw new Error("library.pathNotAllowed");
  }
  let current = root;
  const parts = normalized.slice(prefix.length).split("/");
  for (const [index, part] of parts.entries()) {
    safeName(part);
    if (missingLeaf && index === parts.length - 1) {
      const entry = (await readDir(current)).find(
        (entry) => documentKey(`${current}/${entry.name}`) === documentKey(normalized),
      );
      if (!entry) return normalized;
      if (entry.isSymlink) throw new Error("library.pathNotAllowed");
    }
    current = `${current.replace(/\/$/, "")}/${part}`;
    const info = await lstat(current);
    if (info.isSymlink || (index < parts.length - 1 && !info.isDirectory)) throw new Error("library.pathNotAllowed");
  }
  return normalized;
}

async function readHeader(path: string): Promise<Record<string, unknown>> {
  let first = true;
  let yaml = "";
  for await (const raw of await readTextFileLines(path)) {
    const line = raw.replace(/\r?\n$/, "").replace(/\r$/, "");
    if (first) {
      first = false;
      if (!/^\uFEFF?---[\t ]*$/.test(line)) throw new Error("library.invalidFrontmatter");
    } else if (/^---[\t ]*$/.test(line)) {
      return parseLibraryYaml(yaml).values;
    } else {
      yaml += `${line}\n`;
      if (yaml.length > 1024 * 1024) throw new Error("library.invalidFrontmatter");
    }
  }
  throw new Error("library.invalidFrontmatter");
}

async function readItem(root: string, key: string): Promise<LibraryItem> {
  const { dir, notePath } = itemPaths(root, key);
  await checkedPath(root, notePath);
  const [values, entries] = await Promise.all([readHeader(notePath), readDir(dir)]);
  const files = entries.filter((entry) => entry.isFile && !entry.isSymlink).map((entry) => safeName(entry.name));
  const pdfs = files.filter((name) => /\.pdf$/i.test(name)).sort((a, b) => a.localeCompare(b));
  const translation = (name: string) =>
    /([-_.](mono|dual)|译|[-_.]zh)\.[^.]+$/i.test(name) || /^(zh|zht|ch)-/i.test(name);
  const declared = typeof values.pdf === "string" && values.pdf.trim() ? safeName(values.pdf.trim()) : undefined;
  const pdf =
    (declared && pdfs.includes(declared) ? declared : undefined) ?? pdfs.find((name) => !translation(name)) ?? pdfs[0];
  const dual = pdfs.find((name) => /[-_.]dual\.pdf$/i.test(name));
  const mono = pdfs.find((name) => /[-_.]mono\.pdf$/i.test(name));
  const annotations = pdf?.replace(/\.pdf$/i, ".annotations.json");
  return {
    key,
    dir,
    notePath,
    ...libraryMetadata(values, key),
    pdfPath: pdf ? `${dir}/${pdf}` : undefined,
    translations: { dual: dual ? `${dir}/${dual}` : undefined, mono: mono ? `${dir}/${mono}` : undefined },
    annotationsPath: annotations && files.includes(annotations) ? `${dir}/${annotations}` : undefined,
    extra: libraryExtra(values),
  };
}

async function readManifest(root: string) {
  const manifests = (await readDir(root)).filter((entry) => /\.litlib$/i.test(entry.name));
  if (manifests.length !== 1)
    throw new Error(manifests.length ? "library.manifestAmbiguous" : "library.manifestMissing");
  const entry = manifests[0];
  if (!entry.isFile || entry.isSymlink) throw new Error("library.pathNotAllowed");
  const path = await checkedPath(root, `${root.replace(/\/$/, "")}/${safeName(entry.name)}`);
  const bytes = await readFile(path);
  try {
    const data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as Record<string, unknown>;
    if (
      !data ||
      typeof data !== "object" ||
      Array.isArray(data) ||
      (data.version !== undefined && data.version !== 1) ||
      !Array.isArray(data.collections) ||
      !data.collections.every((entry) => typeof entry === "string")
    ) {
      throw new Error("library.invalidManifest");
    }
    return { path, bytes, data: { ...data, version: 1, collections: data.collections as string[] } };
  } catch (cause) {
    throw errorCode(cause, "library.invalidManifest");
  }
}

function allCollections(collections: string[], items: LibraryItem[]): string[] {
  const result = new Set(collections.map((value) => value.trim()).filter(Boolean));
  for (const collection of [...result, ...items.flatMap((item) => item.collections)]) {
    const parts = collection.split("/");
    for (let i = 1; i <= parts.length; i++) result.add(parts.slice(0, i).join("/"));
  }
  return [...result];
}

async function snapshotAt(root: string, previous?: LibrarySnapshot, changed?: Set<string>): Promise<LibrarySnapshot> {
  const manifest = await readManifest(root);
  const itemsDir = `${root.replace(/\/$/, "")}/${itemsName}`;
  await checkedPath(root, itemsDir, true);
  const entries = (await exists(itemsDir)) ? await readDir(itemsDir) : [];
  const keys = entries
    .filter((entry) => !entry.name.startsWith(".") && (entry.isDirectory || entry.isSymlink))
    .map((entry) => entry.name)
    .sort();
  const oldItems = new Map(previous?.items.map((item) => [item.key, item]));
  const oldErrors = new Map(previous?.errors.map((error) => [error.key, error]));
  const items: LibraryItem[] = [];
  const errors: LibraryItemError[] = [];
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, keys.length) }, async () => {
      while (cursor < keys.length) {
        const key = keys[cursor++];
        if (changed && !changed.has(documentKey(`${itemsDir}/${key}`)) && (oldItems.has(key) || oldErrors.has(key))) {
          if (oldItems.has(key)) items.push(oldItems.get(key)!);
          else errors.push(oldErrors.get(key)!);
          continue;
        }
        try {
          items.push(await readItem(root, key));
        } catch (cause) {
          errors.push({
            key,
            notePath: `${itemsDir}/${key}/${key}.md`,
            code: errorCode(cause, "library.readFailed").message,
          });
        }
      }
    }),
  );
  items.sort((a, b) => a.key.localeCompare(b.key));
  errors.sort((a, b) => a.key.localeCompare(b.key));
  return { root, collections: allCollections(manifest.data.collections, items), items, errors };
}

export async function loadLibrary(root: string): Promise<LibrarySnapshot> {
  try {
    return await snapshotAt(await authorizeLibrary(root));
  } catch (cause) {
    throw errorCode(cause, "library.readFailed");
  }
}

async function writeLibrary<T>(root: string, action: (canonical: string) => Promise<T>): Promise<T> {
  const canonical = await authorizeLibrary(root);
  const key = documentKey(canonical);
  // Earlier callers keep their rejection; a failed save must not poison the next queued edit.
  const ready = (writes.get(key) ?? Promise.resolve()).then(
    () => undefined,
    () => undefined,
  );
  const task = ready.then(async () => {
    await authorizeLibrary(root);
    try {
      return await action(canonical);
    } catch (cause) {
      throw errorCode(cause, "library.writeFailed");
    }
  });
  writes.set(key, task);
  try {
    return await task;
  } finally {
    if (writes.get(key) === task) writes.delete(key);
  }
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

async function atomicWrite(root: string, path: string, bytes: Uint8Array, expected: Uint8Array | null): Promise<void> {
  if (expected && equalBytes(bytes, expected)) return;
  await checkedPath(root, path, expected === null);
  const temporary = `${path.slice(0, path.lastIndexOf("/"))}/.library-${crypto.randomUUID()}.tmp`;
  const handle = await open(temporary, { write: true, createNew: true });
  let published = false;
  try {
    try {
      let offset = 0;
      while (offset < bytes.length) {
        const count = await handle.write(bytes.subarray(offset, offset + 256 * 1024));
        if (!count) throw new Error("library.writeFailed");
        offset += count;
      }
    } finally {
      await handle.close();
    }
    await checkedPath(root, path, expected === null);
    if (expected ? !equalBytes(await readFile(path), expected) : await exists(path))
      throw new Error("library.fileChanged");
    await checkedPath(root, temporary);
    await rename(temporary, path);
    published = true;
  } finally {
    if (!published) await remove(await checkedPath(root, temporary));
  }
}

async function updateAt(root: string, key: string, patch: LibraryItemPatch): Promise<LibraryItem> {
  validateLibraryPatch(patch);
  const { notePath } = itemPaths(root, key);
  await checkedPath(root, notePath);
  const original = await readFile(notePath);
  const updated = updateLibraryNote(original, patch);
  await atomicWrite(root, notePath, updated, original);
  return readItem(root, key);
}

export function updateItem(root: string, key: string, patch: LibraryItemPatch): Promise<LibraryItem> {
  return writeLibrary(root, (canonical) => updateAt(canonical, key, patch));
}

export function trashItem(root: string, key: string): Promise<LibraryItem> {
  return updateItem(root, key, { trashed: true });
}

export function restoreItem(root: string, key: string): Promise<LibraryItem> {
  return updateItem(root, key, { trashed: false });
}

function suffix(number: number): string {
  let result = "";
  while (number > 0) {
    number--;
    result = String.fromCharCode(97 + (number % 26)) + result;
    number = Math.floor(number / 26);
  }
  return result;
}

export function createItem(root: string, fields: CreateLibraryItemFields, pdfSource?: string): Promise<LibraryItem> {
  return writeLibrary(root, async (canonical) => {
    validateLibraryPatch(fields);
    await readManifest(canonical);
    let source: string | undefined;
    if (pdfSource) {
      source = absolutePath(pdfSource);
      const info = await lstat(source);
      if (!/\.pdf$/i.test(source) || !info.isFile || info.isSymlink) throw new Error("library.pathNotAllowed");
    }
    // These headings are the plugin's on-disk template, independent of the application's UI language.
    const meta = {
      ...fields,
      title:
        fields.title?.trim() ||
        source
          ?.split("/")
          .at(-1)
          ?.replace(/\.pdf$/i, "") ||
        i18next.t("library.untitled", { ns: "research", lng: "zh_CN" }),
    };
    const base = safeName(makeLibraryKey(meta));
    const itemsDir = `${canonical.replace(/\/$/, "")}/${itemsName}`;
    await checkedPath(canonical, itemsDir, true);
    if (!(await exists(itemsDir))) await mkdir(itemsDir);
    const names = new Set((await readDir(itemsDir)).map((entry) => entry.name.normalize("NFC").toLowerCase()));
    let key = base;
    for (let n = 1; names.has(key.normalize("NFC").toLowerCase()); n++) key = base + suffix(n);
    const { dir, notePath } = itemPaths(canonical, key);
    const staging = `${itemsDir}/.library-${crypto.randomUUID()}.tmp`;
    await mkdir(staging);
    const stagedNote = `${staging}/${key}.md`;
    const stagedPdf = `${staging}/${key}.pdf`;
    let published = false;
    try {
      if (source) await copyFile(source, await checkedPath(canonical, stagedPdf, true));
      const bytes = createLibraryNote(
        meta,
        source ? `${key}.pdf` : "",
        i18next.t("library.noteTemplate", { ns: "research", lng: "zh_CN" }),
      );
      await atomicWrite(canonical, stagedNote, bytes, null);
      await checkedPath(canonical, dir, true);
      if (await exists(dir)) throw new Error("library.fileChanged");
      await rename(await checkedPath(canonical, staging), dir);
      published = true;
    } finally {
      if (!published) {
        // Remove only files created by this import, never recursively delete an item folder.
        for (const path of [stagedNote, stagedPdf]) {
          await checkedPath(canonical, path, true);
          if (await exists(path)) await remove(path);
        }
        await remove(await checkedPath(canonical, staging));
      }
    }
    await checkedPath(canonical, notePath);
    return readItem(canonical, key);
  });
}

function collectionPath(path: string): string {
  if (
    !path ||
    path !== path.trim() ||
    path.split("/").some((part) => !part.trim() || part !== part.trim() || part === "." || part === "..") ||
    /[\r\n\0]/.test(path)
  ) {
    throw new Error("library.invalidCollection");
  }
  return path;
}

const inCollection = (value: string, parent: string) => value === parent || value.startsWith(`${parent}/`);

async function changeCollections(
  root: string,
  action: "add" | "rename" | "remove",
  path: string,
  newPath?: string,
): Promise<LibrarySnapshot> {
  collectionPath(path);
  if (newPath !== undefined) collectionPath(newPath);
  return writeLibrary(root, async (canonical) => {
    const manifest = await readManifest(canonical);
    const snapshot = await snapshotAt(canonical);
    if (action !== "add" && snapshot.errors.length) throw new Error("library.itemsHaveErrors");
    if (action === "add" || action === "rename") {
      const target = newPath ?? path;
      if (target !== path || action === "add") {
        if (snapshot.collections.includes(target)) throw new Error("library.collectionExists");
      }
    }
    if (action !== "add" && !snapshot.collections.includes(path)) throw new Error("library.collectionNotFound");
    if (action === "rename" && inCollection(newPath!, path) && newPath !== path)
      throw new Error("library.invalidCollection");
    const transform = (values: string[]) => [
      ...new Set(
        values.flatMap((value) =>
          !inCollection(value, path) ? [value] : action === "remove" ? [] : [newPath + value.slice(path.length)],
        ),
      ),
    ];
    const next = action === "add" ? [...snapshot.collections, path] : transform(snapshot.collections);
    const plans: { path: string; original: Uint8Array; updated: Uint8Array }[] = [];
    if (action !== "add") {
      for (const item of snapshot.items) {
        if (!item.collections.some((value) => inCollection(value, path))) continue;
        await checkedPath(canonical, item.notePath);
        const original = await readFile(item.notePath);
        const current = libraryMetadata(parseLibraryYaml(splitLibraryNote(original).yaml).values, item.key);
        if (!current.collections.some((value) => inCollection(value, path))) continue;
        plans.push({
          path: item.notePath,
          original,
          updated: updateLibraryNote(original, { collections: transform(current.collections) }),
        });
      }
    }
    const collections = allCollections(next, []);
    const manifestBytes = new TextEncoder().encode(JSON.stringify({ ...manifest.data, collections }, null, 2));
    let written = 0;
    try {
      for (const plan of plans) {
        await atomicWrite(canonical, plan.path, plan.updated, plan.original);
        written++;
      }
      await atomicWrite(canonical, manifest.path, manifestBytes, manifest.bytes);
    } catch (cause) {
      const failures: unknown[] = [];
      for (const plan of plans.slice(0, written).reverse()) {
        try {
          await atomicWrite(canonical, plan.path, plan.original, plan.updated);
        } catch (error) {
          failures.push(error);
        }
      }
      // Rollback also checks the current bytes, so another application's edits are never deliberately overwritten.
      if (failures.length) throw new AggregateError([cause, ...failures], "library.partialWrite", { cause });
      throw cause;
    }
    return snapshotAt(canonical);
  });
}

export function addCollection(root: string, path: string): Promise<LibrarySnapshot> {
  return changeCollections(root, "add", path);
}

/** Both arguments are full collection paths, e.g. "AI/PDE" → "AI/方程". */
export function renameCollection(root: string, path: string, newPath: string): Promise<LibrarySnapshot> {
  return changeCollections(root, "rename", path, newPath);
}

export function removeCollection(root: string, path: string): Promise<LibrarySnapshot> {
  return changeCollections(root, "remove", path);
}

export function queryLibrary(
  snapshot: LibrarySnapshot,
  filter: LibraryFilter = {},
  sort: LibrarySort = { key: "title", direction: "asc" },
): LibraryItem[] {
  const query = filter.search?.trim().toLowerCase();
  const statusOrder = Object.keys(libraryStatuses);
  const value = (item: LibraryItem): string | number =>
    sort.key === "authors"
      ? (item.authors[0]?.toLowerCase() ?? "")
      : sort.key === "status"
        ? statusOrder.indexOf(item.status)
        : sort.key === "year"
          ? Number(item.year) || 0
          : (item[sort.key] ?? "").toLowerCase();
  return snapshot.items
    .filter(
      (item) =>
        (filter.trashed === "all" || item.trashed === (filter.trashed ?? false)) &&
        (!filter.collection || item.collections.some((path) => inCollection(path, filter.collection!))) &&
        (!filter.unfiled || item.collections.length === 0) &&
        (!filter.status || item.status === filter.status) &&
        (!filter.tags?.length || filter.tags.every((tag) => item.tags.includes(tag))) &&
        (!query ||
          [item.title, ...item.authors, item.venue, item.year, ...item.tags, item.doi, item.arxiv, item.key]
            .join(" ")
            .toLowerCase()
            .includes(query)),
    )
    .sort((a, b) => {
      const x = value(a),
        y = value(b);
      const order = x < y ? -1 : x > y ? 1 : 0;
      return order * (sort.direction === "asc" ? 1 : -1) || a.key.localeCompare(b.key);
    });
}

export function countLibrary(snapshot: LibrarySnapshot): LibraryCounts {
  const counts: LibraryCounts = {
    byStatus: { unread: 0, toRead: 0, reading: 0, read: 0 },
    byCollection: Object.fromEntries(snapshot.collections.map((path) => [path, 0])),
    byTag: Object.create(null),
    unfiled: 0,
    trashed: 0,
    total: 0,
  };
  for (const item of snapshot.items) {
    if (item.trashed) {
      counts.trashed++;
      continue;
    }
    counts.total++;
    counts.byStatus[item.status]++;
    if (!item.collections.length) counts.unfiled++;
    for (const path of snapshot.collections) {
      if (item.collections.some((value) => inCollection(value, path))) counts.byCollection[path]++;
    }
    for (const tag of new Set(item.tags)) counts.byTag[tag] = (counts.byTag[tag] ?? 0) + 1;
  }
  return counts;
}

export function useLibrary(root: string | null): LibraryState {
  const [state, setState] = useState<{ root: string | null } & Omit<LibraryState, "refresh" | "reloadAll">>({
    root,
    snapshot: null,
    loading: !!root,
    error: null,
  });
  const actions = useRef({ refresh: async () => {}, reloadAll: async () => {} });
  const refresh = useCallback(() => actions.current.refresh(), []);
  const reloadAll = useCallback(() => actions.current.reloadAll(), []);
  useEffect(() => {
    let stopped = false;
    let snapshot: LibrarySnapshot | undefined;
    let stamps: LibraryStamps | undefined;
    let pending: Promise<void> = Promise.resolve();
    let lastCheck = 0;
    const publish = (loading: boolean, error: Error | null) => {
      if (!stopped) setState({ root, snapshot: snapshot ?? null, loading, error });
    };
    const reload = (full: boolean): Promise<void> => {
      const task = pending.then(async () => {
        if (stopped || !root) return;
        try {
          const canonical = await authorizeLibrary(root);
          const next = await libraryStamps(canonical);
          let changed: Set<string> | undefined;
          if (!full && snapshot && stamps) {
            changed = changedItems(stamps, next);
            if (!changed.size && next.manifest === stamps.manifest) return;
          }
          publish(true, null);
          const fresh = await snapshotAt(canonical, changed && snapshot, changed);
          if (stopped) return;
          snapshot = fresh;
          stamps = next;
          publish(false, null);
        } catch (cause) {
          publish(false, errorCode(cause, "library.readFailed"));
        }
      });
      pending = task;
      return task;
    };
    // 用户定的是「切回来时刷新」，不装实时监听：切回窗口、鼠标移进文献库时比一遍修改时间
    const check = () => {
      if (Date.now() - lastCheck < 1500) return pending;
      lastCheck = Date.now();
      return reload(false);
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") void check();
    };
    actions.current = { refresh: () => reload(false), reloadAll: () => reload(true) };
    publish(!!root, null);
    if (root) {
      void reload(true);
      window.addEventListener("focus", check);
      document.addEventListener("visibilitychange", onVisible);
    }
    return () => {
      stopped = true;
      window.removeEventListener("focus", check);
      document.removeEventListener("visibilitychange", onVisible);
      actions.current = { refresh: async () => {}, reloadAll: async () => {} };
    };
  }, [root]);
  return state.root === root
    ? { ...state, refresh, reloadAll }
    : { snapshot: null, loading: !!root, error: null, refresh, reloadAll };
}

type LibraryStamps = { manifest: string; items: Map<string, string> };

/** 每篇条目的「文件夹 + 笔记」修改时间。文件夹里加减 PDF、译文，或笔记被改写，这里都会变 */
async function libraryStamps(root: string): Promise<LibraryStamps> {
  const stamp = (info: { mtime: Date | null; size: number }) => `${info.mtime?.getTime() ?? ""}:${info.size}`;
  const manifests = (await readDir(root)).filter((entry) => /\.litlib$/i.test(entry.name));
  const manifest = (
    await Promise.all(manifests.map(async (entry) => stamp(await lstat(`${root.replace(/\/$/, "")}/${entry.name}`))))
  ).join("|");
  const itemsDir = `${root.replace(/\/$/, "")}/${itemsName}`;
  const keys = (await exists(itemsDir))
    ? (await readDir(itemsDir)).filter((entry) => !entry.name.startsWith(".")).map((entry) => entry.name)
    : [];
  const items = new Map<string, string>();
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, keys.length) }, async () => {
      while (cursor < keys.length) {
        const key = keys[cursor++];
        const dir = `${itemsDir}/${key}`;
        const note = `${dir}/${key}.md`;
        // 笔记不在或读不了时记成「缺」，交给 snapshotAt 去读并报出这篇的错误
        const noteStamp = (await exists(note)) ? stamp(await lstat(note)) : "missing";
        items.set(documentKey(dir), `${stamp(await lstat(dir))}|${noteStamp}`);
      }
    }),
  );
  return { manifest, items };
}

function changedItems(before: LibraryStamps, after: LibraryStamps): Set<string> {
  const changed = new Set<string>();
  for (const [key, value] of after.items) if (before.items.get(key) !== value) changed.add(key);
  for (const key of before.items.keys()) if (!after.items.has(key)) changed.add(key);
  return changed;
}

/** 选中的文件夹里还没有 .litlib 时，在里面新建一个空文献库（和插件一样叫「文献库.litlib」） */
export function createLibrary(root: string): Promise<LibrarySnapshot> {
  return writeLibrary(root, async (canonical) => {
    if ((await readDir(canonical)).some((entry) => /\.litlib$/i.test(entry.name)))
      throw new Error("library.manifestAmbiguous");
    const bytes = new TextEncoder().encode(JSON.stringify({ version: 1, collections: [] }, null, 2));
    await atomicWrite(canonical, `${canonical.replace(/\/$/, "")}/文献库.litlib`, bytes, null);
    return snapshotAt(canonical);
  });
}
