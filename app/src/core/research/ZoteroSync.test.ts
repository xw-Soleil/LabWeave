// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import * as disk from "node:fs/promises";
import { webcrypto } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import i18next from "i18next";
import { I18nextProvider } from "react-i18next";
import { loadLibrary, type LibraryItem, type LibrarySnapshot } from "./Library";
import { libraryExtra, libraryMetadata, parseLibraryYaml, splitLibraryNote } from "./LibraryFormat";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  diskEnabled: false,
  data: "/fixture-app-data",
  settings: { literatureLibraryPath: "" },
  confirm: vi.fn(),
  shell: vi.fn(),
  read: vi.fn(),
  beforeRename: undefined as undefined | ((from: string, to: string) => Promise<void>),
  fs: vi.fn(() => {
    throw new Error("Unexpected filesystem access");
  }),
}));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: mocks.fetch }));
vi.mock("@/core/service/Settings", () => ({ Settings: mocks.settings }));
vi.mock("@tauri-apps/api/path", () => ({ appDataDir: async () => mocks.data }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async (_name: string, { path }: { path: string }) => path }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: mocks.confirm }));
vi.mock("@tauri-apps/plugin-shell", () => ({ open: mocks.shell }));
vi.mock("@tauri-apps/plugin-fs", async () => {
  const fs = await import("node:fs/promises");
  const guard = () => {
    if (!mocks.diskEnabled) mocks.fs();
  };
  const info = (s: NonNullable<Awaited<ReturnType<typeof fs.stat>>>) => ({
    isFile: s.isFile(),
    isDirectory: s.isDirectory(),
    isSymlink: s.isSymbolicLink(),
    size: s.size,
    mtime: s.mtime,
    mode: s.mode,
  });
  return {
    exists: async (path: string) => {
      if (!mocks.diskEnabled) return false;
      try {
        await fs.lstat(path);
        return true;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw e;
      }
    },
    lstat: async (path: string) => {
      guard();
      return info(await fs.lstat(path));
    },
    stat: async (path: string) => {
      guard();
      return info(await fs.stat(path));
    },
    readDir: async (path: string) => {
      guard();
      return (await fs.readdir(path, { withFileTypes: true })).map((e) => ({
        name: e.name,
        isFile: e.isFile(),
        isDirectory: e.isDirectory(),
        isSymlink: e.isSymbolicLink(),
      }));
    },
    readFile: async (path: string) => {
      guard();
      mocks.read(path);
      return new Uint8Array(await fs.readFile(path));
    },
    mkdir: async (path: string, options?: { mode?: number; recursive?: boolean }) => {
      guard();
      await fs.mkdir(path, options);
    },
    remove: async (path: string, options?: { recursive?: boolean }) => {
      guard();
      if ((await fs.lstat(path)).isDirectory() && !options?.recursive) await fs.rmdir(path);
      else await fs.rm(path, { recursive: !!options?.recursive });
    },
    rename: async (from: string, to: string) => {
      guard();
      await mocks.beforeRename?.(from, to);
      await fs.rename(from, to);
    },
    open: async (path: string, options: { createNew?: boolean; mode?: number }) => {
      guard();
      const handle = await fs.open(path, options.createNew ? "wx" : "r", options.mode);
      return {
        write: async (bytes: Uint8Array) => (await handle.write(bytes)).bytesWritten,
        close: () => handle.close(),
      };
    },
    readTextFileLines: async (path: string) => {
      guard();
      return (async function* () {
        yield* (await fs.readFile(path, "utf8")).split(/\r?\n/);
      })();
    },
    SeekMode: {},
  };
});
vi.mock("./ZoteroSync", async (original) => {
  const actual = await original<typeof import("./ZoteroSync")>();
  return {
    ...actual,
    captureSyncFiles: async (...args: Parameters<typeof actual.captureSyncFiles>) => {
      if (mocks.diskEnabled) await actual.captureSyncFiles(...args);
    },
  };
});
vi.mock("./Library", async (original) => {
  const actual = await original<typeof import("./Library")>();
  return {
    ...actual,
    loadLibrary: async (root: string) =>
      mocks.diskEnabled ? actual.loadLibrary(root) : { root, items: [], collections: [], errors: [] },
  };
});
vi.mock("@/components/overlay-host", () => ({ OverlayHost: {} }));

import {
  localValues,
  captureSyncFiles,
  readSyncHistory,
  resolveZoteroSync,
  applyZoteroSync,
  rollbackZoteroSync,
  pendingSync,
  rowId,
  SyncRollbackError,
  type SyncChoice,
  type SyncRow,
  mergeField,
  planZoteroSync,
  readZotero,
  remoteValues,
  syncFields,
  type SyncBaseline,
  type ZoteroData,
  type ZoteroSnapshot,
} from "./ZoteroSync";
import ZoteroSyncDialog from "./ZoteroSyncDialog";

const item = (key: string, fields: Partial<LibraryItem> = {}): LibraryItem => ({
  key,
  dir: `/fixture/条目/${key}`,
  notePath: `/fixture/条目/${key}/${key}.md`,
  title: key,
  authors: [],
  status: "unread",
  collections: [],
  tags: [],
  trashed: false,
  extra: {},
  translations: {},
  ...fields,
});
const paper = (key = "PAPER001", fields: Partial<ZoteroData> = {}): ZoteroData => ({
  key,
  version: 7,
  itemType: "journalArticle",
  title: key,
  ...fields,
});
const collection = (key: string, name: string, parentCollection: string | false = false): ZoteroData => ({
  key,
  version: 3,
  name,
  parentCollection,
});
const library = (items: LibraryItem[] = [], fields: Partial<LibrarySnapshot> = {}): LibrarySnapshot => ({
  root: "/fixture",
  items,
  collections: [],
  errors: [],
  ...fields,
});
const remote = (items: ZoteroData[] = [], collections: ZoteroData[] = []): ZoteroSnapshot => ({
  serverId: "fixture-server",
  items,
  collections,
});
const plan = (local: LibrarySnapshot, snapshot: ZoteroSnapshot, baseline?: SyncBaseline) =>
  planZoteroSync(local, snapshot, new AbortController().signal, undefined, baseline);
const response = (body: unknown = [], status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Zotero-Server-ID": "fixture-server", ...headers } });
const envelope = (data: ZoteroData) => ({ key: data.key, version: data.version, data });
const load = () => readZotero(new AbortController().signal, vi.fn());

function largePreviewFixture() {
  const papers = Array.from({ length: 67 }, (_, i) => paper(`P${String(i).padStart(7, "0")}`));
  const children = Array.from({ length: 660 }, (_, i) =>
    paper(`C${String(i).padStart(7, "0")}`, {
      itemType: i < 490 ? "annotation" : i < 650 ? "attachment" : "note",
      parentItem: papers[0].key,
    }),
  );
  return {
    local: library(papers.map((p) => item(p.key, { extra: { zotero_key: p.key } }))),
    remote: remote([
      ...papers,
      ...children,
      paper("SOLO0001", { itemType: "note" }),
      paper("SOLO0002", { itemType: "attachment" }),
      paper("LINK0001", { itemType: "attachment", linkMode: "linked_url", parentItem: papers[0].key }),
    ]),
  };
}

beforeEach(() => {
  Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });
  mocks.diskEnabled = false;
  mocks.beforeRename = undefined;
  mocks.confirm.mockReset().mockResolvedValue(true);
  mocks.shell.mockReset().mockResolvedValue(undefined);
  mocks.fetch.mockReset();
  mocks.fs.mockClear();
  mocks.read.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
  expect(mocks.fs).not.toHaveBeenCalled();
});

describe("read-only local API", () => {
  it("reads whole pages with pinned headers, retaining versions and raw child data without authorization", async () => {
    const hundred = Array.from({ length: 100 }, (_, i) => paper(`A${String(i).padStart(7, "0")}`));
    const last = paper("NOTE0001", { itemType: "note", parentItem: "A0000000", note: "<p>note</p>" });
    mocks.fetch
      .mockResolvedValueOnce(response())
      .mockResolvedValueOnce(response(hundred.map(envelope), 200, { "Last-Modified-Version": "42" }))
      .mockResolvedValueOnce(response([envelope(last)], 200, { "Last-Modified-Version": "42" }))
      .mockResolvedValueOnce(
        response([envelope(collection("COL00001", "Methods"))], 200, { "Last-Modified-Version": "42" }),
      );
    const progress = vi.fn();
    const result = await readZotero(new AbortController().signal, progress);
    expect(result.items).toHaveLength(101);
    expect(result.items.at(-1)).toEqual(last);
    expect(result.libraryVersion).toBe("42");
    expect(mocks.fetch.mock.calls.map(([url]) => url)).toEqual([
      "http://localhost:23119/api/",
      "http://localhost:23119/api/users/0/items?start=0&limit=100",
      "http://localhost:23119/api/users/0/items?start=100&limit=100",
      "http://localhost:23119/api/users/0/collections?start=0&limit=100",
    ]);
    for (const [index, [, options]] of mocks.fetch.mock.calls.entries()) {
      expect(options).toMatchObject({
        method: "GET",
        maxRedirections: 0,
        // Zotero closes the connection on any Origin header; "" tells the HTTP plugin to send none
        headers: { Origin: "", "Zotero-API-Version": "3", "Zotero-Server-ID": index ? "fixture-server" : "" },
      });
      expect(options.headers).not.toHaveProperty("Zotero-API-Key");
    }
    expect(progress).toHaveBeenCalledWith({ phase: "items", count: 101 });
  });

  it("fetches the final empty page for exactly 100 collections", async () => {
    const cols = Array.from({ length: 100 }, (_, i) => envelope(collection(`C${String(i).padStart(7, "0")}`, `C${i}`)));
    mocks.fetch
      .mockResolvedValueOnce(response())
      .mockResolvedValueOnce(response())
      .mockResolvedValueOnce(response(cols))
      .mockResolvedValueOnce(response());
    expect((await load()).collections).toHaveLength(100);
    expect(mocks.fetch.mock.calls.at(-1)?.[0]).toMatch(/collections\?start=100&limit=100$/);
  });

  it.each([
    [new Response("{}"), "oldVersion"],
    [new Response("Not found", { status: 404 }), "oldVersion"],
    [new Response("Local API is not enabled", { status: 403 }), "communicationDisabled"],
    [response({}, 401), "authorizationDenied"],
    [response({}, 403), "authorizationDenied"],
    [response({}, 412), "snapshotChanged"],
    [response({}, 500), "requestFailed"],
    [response({}, 302, { Location: "https://example.invalid/not-local" }), "redirectRefused"],
  ])("classifies connection failures without a write or redirect", async (result, code) => {
    mocks.fetch.mockResolvedValueOnce(result);
    await expect(load()).rejects.toThrow(`zoteroSync.${code}`);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it("reports a stopped server", async () => {
    mocks.fetch.mockRejectedValueOnce(new TypeError("connection refused"));
    await expect(load()).rejects.toThrow("zoteroSync.notRunning");
  });

  it("cancels pending requests and times out stalled responses", async () => {
    vi.useFakeTimers();
    mocks.fetch.mockImplementation(
      (_url, options) =>
        new Promise((_resolve, reject) =>
          options.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError"))),
        ),
    );
    const timed = expect(load()).rejects.toThrow("zoteroSync.timeout");
    await vi.advanceTimersByTimeAsync(15000);
    await timed;
    const controller = new AbortController();
    const pending = expect(readZotero(controller.signal, vi.fn())).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await pending;
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    [() => response({}, 200, { "Zotero-Server-ID": "another-server" }), "snapshotChanged"],
    [() => response({ items: [] }), "invalidResponse"],
    [
      () =>
        response([
          envelope(paper("PAPER001", { creators: [{ creatorType: "author", name: 7 as unknown as string }] })),
        ]),
      "invalidResponse",
    ],
    [() => response([envelope(paper("../wrong", {}))]), "invalidResponse"],
    [() => new Response("{", { headers: { "Zotero-Server-ID": "fixture-server" } }), "invalidResponse"],
  ])("rejects changed servers and malformed pages", async (make, code) => {
    mocks.fetch.mockResolvedValueOnce(response()).mockResolvedValueOnce(make());
    await expect(load()).rejects.toThrow(`zoteroSync.${code}`);
  });

  it("rejects mixed library versions and repeated page records", async () => {
    mocks.fetch
      .mockResolvedValueOnce(response())
      .mockResolvedValueOnce(response([], 200, { "Last-Modified-Version": "1" }))
      .mockResolvedValueOnce(response([], 200, { "Last-Modified-Version": "2" }));
    await expect(load()).rejects.toThrow("zoteroSync.snapshotChanged");
    mocks.fetch
      .mockResolvedValueOnce(response())
      .mockResolvedValueOnce(response([envelope(paper()), envelope(paper())]));
    await expect(load()).rejects.toThrow("zoteroSync.snapshotChanged");
  });
});

describe("field mapping and three-way merge", () => {
  it("compares the original frontmatter instead of UI-normalized display values", () => {
    const values = localValues(
      item("fallback title", {
        authors: ["A", "B"],
        tags: ["topic"],
        status: "unread",
        frontmatter: { title: "", authors: "A; B", tags: ["#topic"], status: "自定义状态", year: 2024 },
      }),
      new Map(),
    );
    expect(values).toMatchObject({
      title: "",
      authors: ["A; B"],
      tags: ["#topic"],
      status: "自定义状态",
      year: "2024",
    });
  });
  it("maps every plugin field, preserving author order and filtering reading tags", () => {
    const values = remoteValues(
      paper("PAPER001", {
        title: " Paper ",
        creators: [
          { creatorType: "author", firstName: "Ada", lastName: "Lovelace" },
          { creatorType: "author", name: "Lab" },
          { creatorType: "editor", name: "Ignored" },
        ],
        date: "2024-12-01",
        proceedingsTitle: "Conference",
        volume: "2",
        issue: "3",
        pages: "1–8",
        DOI: "10.1/x",
        url: "https://example.invalid",
        abstractNote: "Abstract",
        tags: [{ tag: "b" }, { tag: "a" }, { tag: "a" }, { tag: "阅读/已读" }, { tag: "阅读/custom" }],
        collections: ["COL00002", "COL00001"],
      }),
    );
    const local = localValues(
      item("p", {
        title: "Paper",
        authors: ["Ada Lovelace", "Lab"],
        year: "2024",
        venue: "Conference",
        volume: "2",
        issue: "3",
        pages: "1–8",
        doi: "10.1/x",
        url: "https://example.invalid",
        abstract: "Abstract",
        tags: ["a", "b"],
        status: "read",
        collections: ["A", "A/B"],
      }),
      new Map([
        ["A", "COL00001"],
        ["A/B", "COL00002"],
      ]),
    );
    expect(values).toEqual(local);
    expect(Object.keys(values)).toEqual([...syncFields]);
    expect(
      remoteValues(
        paper("PAPER001", { repository: "arXiv", date: "1880", tags: [{ tag: "阅读/已读" }, { tag: "阅读/待读" }] }),
      ),
    ).toMatchObject({ venue: "arXiv", year: "", status: "conflict" });
  });

  it.each([
    ["a", "a", "b", "a", "push"],
    ["a", "a", "a", "b", "pull"],
    ["a", "a", "b", "c", "conflict"],
    ["a", "a", "b", "b", "same"],
    ["presentation A", "presentation B", "presentation A", "presentation B", "same"],
    [undefined, undefined, "", "nonempty", "conflict"],
    [undefined, undefined, "same", "same", "same"],
  ])("merges paired baselines", (bl, br, l, r, expected) => expect(mergeField(bl, br, l, r)).toBe(expected));

  it("reports first-sync differences including blanks, and keeps skipped conflicts on repeated previews", async () => {
    const l = library([item("p", { title: "Same", extra: { zotero_key: "PAPER001" }, doi: "10.1/x" })]);
    const r = remote([paper("PAPER001", { title: "Same", abstractNote: "New" })]);
    const first = await plan(l, r),
      second = await plan(l, r);
    expect(first.rows.filter((r) => r.group === "conflict").map((r) => r.field)).toEqual(["doi", "abstract"]);
    expect(second.rows).toEqual(first.rows);
    expect(first.source).toEqual({ local: l, remote: r });
  });

  it("plans both one-sided updates from a paired baseline and rejects unrelated baselines", async () => {
    const p = item("p", { title: "Original", extra: { zotero_key: "PAPER001" } });
    const r = paper("PAPER001", { title: "Original" });
    const b: SyncBaseline = {
      schema: 1,
      root: "/fixture",
      serverId: "fixture-server",
      collections: {},
      pairs: { PAPER001: { path: p.notePath, local: localValues(p, new Map()), remote: remoteValues(r) } },
    };
    const result = await plan(
      library([{ ...p, title: "Local change" }]),
      remote([{ ...r, abstractNote: "Remote change" }]),
      b,
    );
    expect(result.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ group: "push", field: "title" }),
        expect.objectContaining({ group: "pull", field: "abstract" }),
      ]),
    );
    await expect(plan(library([p]), remote([r]), { ...b, serverId: "wrong" })).rejects.toThrow("baselineMismatch");
    await expect(plan(library([p]), remote([r]), { ...b, root: "/another" })).rejects.toThrow("baselineMismatch");
    await expect(
      plan(library([p], { root: "C:\\Library" }), remote([r]), { ...b, root: "c:/library/" }),
    ).resolves.toMatchObject({ blocked: false });
  });
});

describe("pairing and preview", () => {
  it("uses key, then normalized DOI, arXiv without version, then whitespace/case-normalized title", async () => {
    const l = library([
      item("key", { title: "local", doi: "10.1/doi", extra: { zotero_key: "PAPER001" } }),
      item("doi", { title: "Different", doi: "https://doi.org/10.1/DOI", arxiv: "2401.12345" }),
      item("ax", { title: "Other", arxiv: "arXiv:2401.12345v3" }),
      item("title", { title: "  A   PAPER  " }),
    ]);
    const r = remote([
      paper("PAPER001"),
      paper("PAPER002", { DOI: "10.1/doi" }),
      paper("PAPER003", { url: "https://arxiv.org/abs/2401.12345v9" }),
      paper("PAPER004", { title: "a paper" }),
    ]);
    const result = await plan(l, r);
    expect(Object.values(result.pairs).map((p) => p.matchedBy)).toEqual(["key", "doi", "arxiv", "title"]);
    expect(result.rows.filter((r) => r.kind === "link")).toHaveLength(3);
    expect(result.blocked).toBe(false);
  });

  it("can relink a stale key by DOI, but does not recreate an absent linked paper", async () => {
    const result = await plan(
      library([
        item("a", { doi: "10.1/x", extra: { zotero_key: "OLD00001" } }),
        item("b", { extra: { zotero_key: "OLD00002" } }),
      ]),
      remote([paper("PAPER001", { DOI: "10.1/x" })]),
    );
    expect(result.pairs.PAPER001.matchedBy).toBe("doi");
    expect(result.rows).toContainEqual(expect.objectContaining({ title: "b", group: "skip", reason: "deletion" }));
  });

  it.each(["doi", "arxiv", "title"] as const)("stops on ambiguous %s candidates", async (by) => {
    const l = item("local", {
      title: "Same",
      doi: by === "doi" ? "10.1/x" : "",
      arxiv: by === "arxiv" ? "2401.12345" : "",
    });
    const fields = { title: "Same", DOI: "10.1/x", extra: "arXiv:2401.12345v2" };
    const result = await plan(library([l]), remote([paper("PAPER001", fields), paper("PAPER002", fields)]));
    expect(result.blocked).toBe(true);
    expect(result.pairingIssues[0]).toMatchObject({
      by,
      candidates: expect.arrayContaining([
        expect.objectContaining({ key: "PAPER001" }),
        expect.objectContaining({ key: "PAPER002" }),
      ]),
    });
    expect(result.rows.every((r) => r.group === "skip")).toBe(true);
  });

  it("blocks duplicate local keys, identifiers, and attempts to claim an already linked record", async () => {
    const duplicateKey = await plan(
      library([item("a", { extra: { zotero_key: "PAPER001" } }), item("b", { extra: { zotero_key: "PAPER001" } })]),
      remote([paper()]),
    );
    expect(duplicateKey.pairingIssues[0].by).toBe("key");
    for (const fields of [{ doi: "10.1/x" }, { arxiv: "2401.12345" }]) {
      expect((await plan(library([item("a", fields), item("b", fields)]), remote())).blocked).toBe(true);
    }
    const occupied = await plan(
      library([item("a", { extra: { zotero_key: "PAPER001" } }), item("b", { doi: "10.1/x" })]),
      remote([paper("PAPER001", { DOI: "10.1/x" })]),
    );
    expect(occupied.blocked).toBe(true);
    expect(occupied.pairingIssues[0].candidates).toHaveLength(3);
  });

  it("only blocks duplicate local titles when a Zotero paper matches the normalized title", async () => {
    const l = library([item("a", { title: "Same title" }), item("b", { title: " SAME   TITLE " })]);
    const noHit = await plan(
      l,
      remote([
        paper("OTHER001", { title: "Other" }),
        paper("DEL00001", { title: "same title", deleted: 1 }),
        paper("NOTE0001", { title: "same title", itemType: "note" }),
      ]),
    );
    expect(noHit.blocked).toBe(false);
    expect(noHit.pairingIssues).toEqual([]);
    expect(noHit.rows.filter((r) => r.group === "push" && r.kind === "item")).toHaveLength(2);
    const hit = await plan(l, remote([paper("PAPER001", { title: "same title" })]));
    expect(hit.blocked).toBe(true);
    expect(hit.pairingIssues).toContainEqual(expect.objectContaining({ by: "title", value: "same title" }));
    expect(hit.rows.every((r) => r.group === "skip")).toBe(true);
  });

  it("summarizes unchanged papers and child records without allocating a row per record", async () => {
    const fixture = largePreviewFixture();
    expect(fixture.remote.items).toHaveLength(730);
    const result = await plan(fixture.local, fixture.remote);
    expect(result.blocked).toBe(false);
    expect(result.summary).toEqual({
      unchanged: 67,
      deferred: { total: 0, annotations: 0, attachments: 0, notes: 0 },
      missingCollections: 0,
    });
    expect(result.rows).toHaveLength(4);
    expect(result.rows.map((r) => r.reason)).toEqual(["preserved", "standalone", "standalone", "linkedAttachment"]);
  });

  it("lists additions in both directions and preserves deletions, child records and custom fields", async () => {
    const l = library([
      item("new", { arxiv: "2401.00001", itemType: "自定义", extra: { custom: "keep" }, pdfPath: "/fixture/new.pdf" }),
      item("trashed", { trashed: true, extra: { zotero_key: "PAPER001" } }),
    ]);
    const r = remote([
      paper(),
      paper("NEW00001"),
      paper("DEL00001", { deleted: 1 }),
      paper("NOTE0001", { itemType: "note", parentItem: "NEW00001" }),
      paper("FILE0001", { itemType: "attachment", parentItem: "NEW00001", linkMode: "linked_url" }),
      paper("SOLO0001", { itemType: "attachment" }),
    ]);
    const before = JSON.stringify({ l, r });
    const result = await plan(l, r);
    expect(result.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ title: "new", group: "push", kind: "item" }),
        expect.objectContaining({ key: "NEW00001", group: "pull", kind: "item" }),
        expect.objectContaining({ key: "PAPER001", group: "skip", reason: "deletion" }),
        expect.objectContaining({ key: "DEL00001", group: "skip", reason: "deletion" }),
        expect.objectContaining({ key: "FILE0001", group: "skip", reason: "linkedAttachment" }),
        expect.objectContaining({ key: "SOLO0001", group: "skip", reason: "standalone" }),
        expect.objectContaining({ reason: "preserved" }),
      ]),
    );
    expect(result.summary.deferred).toEqual({ total: 0, annotations: 0, attachments: 0, notes: 0 });
    expect(result.rows.some((r) => r.key === "NOTE0001")).toBe(false);
    expect(JSON.stringify({ l, r })).toBe(before);
  });

  it("blocks a partial local snapshot instead of proposing duplicate imports", async () => {
    const result = await plan(
      library([], { errors: [{ key: "broken", notePath: "/fixture/broken.md", code: "library.invalidFrontmatter" }] }),
      remote([paper()]),
    );
    expect(result.blocked).toBe(true);
    expect(result.rows.every((r) => r.group === "skip")).toBe(true);
    expect(result.rows).toContainEqual(expect.objectContaining({ reason: "unreadable" }));
  });

  it("uses stable collection keys, handles empty folders, and shows readable conflict paths", async () => {
    const l = library([item("p", { title: "Same", extra: { zotero_key: "PAPER001" }, collections: ["A/B"] })], {
      collections: ["A", "A/B", "Local empty"],
    });
    const r = remote(
      [paper("PAPER001", { title: "Same", collections: ["COL00001"] })],
      [collection("COL00001", "A"), collection("COL00002", "B", "COL00001"), collection("COL00003", "Remote empty")],
    );
    const result = await plan(l, r);
    expect(result.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "collections", group: "conflict", local: ["A/B"], remote: ["A"] }),
        expect.objectContaining({ kind: "collection", title: "Local empty", group: "push" }),
        expect.objectContaining({ kind: "collection", title: "Remote empty", group: "pull" }),
      ]),
    );
    expect(result.pairs.PAPER001.local.collections).toEqual(["COL00002"]);
  });

  it("uses the plugin collection map for rename conflicts and baselines for one-sided renames", async () => {
    const l = library([], { collections: ["Local name"], zoteroCollections: { COL00001: "Local name" } });
    const r = remote([], [collection("COL00001", "Old name")]);
    expect((await plan(l, r)).rows).toContainEqual(
      expect.objectContaining({ group: "conflict", kind: "collection", local: "Local name", remote: "Old name" }),
    );
    const b: SyncBaseline = {
      schema: 1,
      root: "/fixture",
      serverId: "fixture-server",
      pairs: {},
      collections: { COL00001: { local: "Old name", remote: "Old name" } },
    };
    expect((await plan(l, r, b)).rows).toContainEqual(expect.objectContaining({ group: "push", kind: "collection" }));
    expect((await plan(library(), r, b)).rows).toContainEqual(
      expect.objectContaining({ group: "skip", reason: "deletion" }),
    );
    expect((await plan(l, remote())).rows).toContainEqual(
      expect.objectContaining({ group: "skip", reason: "deletion", key: "COL00001" }),
    );
  });

  it("ignores missing collection IDs for paired and new papers and counts each affected paper once", async () => {
    const l = library([item("PAPER001", { collections: ["AI"], extra: { zotero_key: "PAPER001" } })], {
      collections: ["AI"],
    });
    const r = remote(
      [
        paper("PAPER001", { collections: ["COL00001", "MISSING1", "MISSING2"] }),
        paper("NEW00001", { collections: ["MISSING1", "MISSING2"] }),
        paper("NEW00002", { collections: ["COL00001"] }),
        paper("NOTE0001", { itemType: "note", parentItem: "PAPER001", collections: ["MISSING1"] }),
        paper("DEL00001", { deleted: 1, collections: ["MISSING1"] }),
      ],
      [collection("COL00001", "AI")],
    );
    const before = JSON.stringify(r);
    const result = await plan(l, r);
    expect(result.blocked).toBe(false);
    expect(result.summary).toMatchObject({ unchanged: 1, missingCollections: 2 });
    expect(result.pairs.PAPER001.remote.collections).toEqual(["COL00001"]);
    expect(result.rows.some((row) => row.field === "collections")).toBe(false);
    expect(result.rows).toContainEqual(expect.objectContaining({ key: "NEW00001", group: "pull" }));
    expect(JSON.stringify(result.rows)).not.toContain("MISSING");
    expect(JSON.stringify(r)).toBe(before);
    const baseline: SyncBaseline = {
      schema: 1,
      root: l.root,
      serverId: r.serverId,
      collections: {},
      pairs: { PAPER001: { ...result.pairs.PAPER001, remote: remoteValues(r.items[0]) } },
    };
    const changed = await plan(library([{ ...l.items[0], collections: [] }], { collections: ["AI"] }), r, baseline);
    expect(changed.rows).toContainEqual(
      expect.objectContaining({ field: "collections", group: "push", local: [], remote: ["AI"] }),
    );
  });

  it("shows the actual conflicting reading tags, also for newly imported papers", async () => {
    const r = remote([paper("PAPER001", { tags: [{ tag: "阅读/待读" }, { tag: "阅读/已读" }] })]);
    const initial = await plan(library(), r);
    const paired = await plan(library([item("p", { extra: { zotero_key: "PAPER001" } })]), r);
    for (const result of [initial, paired])
      expect(result.rows).toContainEqual(
        expect.objectContaining({ group: "conflict", field: "status", remote: ["已读", "待读"] }),
      );
  });

  it.each([
    [collection("COL00001", "Bad/name")],
    [collection("COL00001", "")],
    [collection("COL00001", "A", "MISSING1")],
    [collection("COL00001", "A", "COL00002"), collection("COL00002", "B", "COL00001")],
    [collection("COL00001", "Same"), collection("COL00002", "Same")],
  ])("rejects broken collection hierarchies", async (...cols) => {
    await expect(plan(library(), remote([], cols))).rejects.toThrow("invalidCollections");
  });

  it("checks cancellation while comparing", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(planZoteroSync(library([item("p")]), remote(), controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  it("leaves fixture files byte-for-byte unchanged and creates no sync state", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zotero-preview-"));
    const path = join(dir, "fixture.md");
    const bytes = Buffer.from(
      "---\r\ntype: 文献\r\ntitle: Fixture\r\nzotero_key: PAPER001\r\ncustom: keep\r\n---\r\n# Research\r\nDo not alter.\r\n",
    );
    try {
      await writeFile(path, bytes);
      const { values } = parseLibraryYaml(splitLibraryNote(await readFile(path)).yaml);
      await plan(
        library([
          item("fixture", { ...libraryMetadata(values, "fixture"), extra: libraryExtra(values), notePath: path }),
        ]),
        remote([paper("PAPER001", { title: "Changed" })]),
      );
      expect(await readFile(path)).toEqual(bytes);
      expect(await readdir(dir)).toEqual(["fixture.md"]);
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});

describe("dialog", () => {
  let root: Root, host: HTMLDivElement;
  beforeEach(async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    await i18next.init({
      lng: "zh_CN",
      resources: { zh_CN: { research: parse(readFileSync("app/src/locales/zh_CN.yml", "utf8")).research } },
    });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  async function showPreview(snapshot: LibrarySnapshot, zotero: ZoteroSnapshot) {
    mocks.fetch.mockImplementation(async (url: string) => {
      const request = new URL(url);
      const records = request.pathname.endsWith("/items") ? zotero.items : zotero.collections;
      const start = Number(request.searchParams.get("start"));
      return response(records.slice(start, start + 100).map(envelope));
    });
    await act(async () =>
      root.render(
        createElement(
          I18nextProvider,
          { i18n: i18next },
          createElement(ZoteroSyncDialog, { snapshot, onClose: vi.fn() }),
        ),
      ),
    );
    await vi.waitFor(async () => {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      expect(document.querySelector('[aria-busy="false"]')).not.toBeNull();
    });
    return document.querySelector('[role="dialog"]')!;
  }
  /** 「不处理的」默认收起，点开再看 */
  async function skipped(dialog: Element) {
    const skip = dialog.querySelector('section[aria-label="不处理的"]')!;
    await act(async () => skip.querySelector("button")!.click());
    return skip;
  }

  it("renders compact summaries with separate child counts and one missing-collections notice", async () => {
    const fixture = largePreviewFixture();
    fixture.remote.items[0].collections = ["MISSING1", "MISSING2"];
    const dialog = await showPreview(fixture.local, fixture.remote);
    const skip = await skipped(dialog);
    expect(skip.querySelector("button")?.textContent).toBe("不处理的（6）");
    expect(skip.textContent).toContain("67 篇没有变化");
    expect(skip.textContent).not.toContain("这一版还不同步");
    expect(skip.textContent).toContain("1 篇文献引用了列表中不存在的 Zotero 分类");
    for (const key of ["SOLO0001", "SOLO0002", "LINK0001"]) expect(skip.textContent).toContain(key);
    for (const key of ["P0000000", "C0000000", "MISSING", "继续显示"]) expect(skip.textContent).not.toContain(key);
  });

  it.each([
    ["/fixture/", "/fixture/条目/AI"],
    ["C:\\Library\\", "c:\\library\\条目\\AI"],
    ["\\\\Server\\Library\\", "\\\\server\\library\\条目\\AI"],
  ])("shows paths relative to %s for pairing candidates and unreadable entries", async (libraryRoot, dir) => {
    const snapshot = library(
      [item("a", { title: "Same", notePath: `${dir}/a.md` }), item("b", { title: "Same", notePath: `${dir}/b.md` })],
      {
        root: libraryRoot,
        errors: [{ key: "broken", notePath: `${dir}/broken.md`, code: "library.invalidFrontmatter" }],
      },
    );
    const dialog = await showPreview(snapshot, remote([paper("PAPER001", { title: "Same" })]));
    const candidates = dialog.querySelector('section[aria-label="配对不明确"]')!;
    for (const name of ["a", "b"]) expect(candidates.textContent).toContain(`条目/AI/${name}.md`);
    expect((await skipped(dialog)).textContent).toContain("条目/AI/broken.md");
    expect(dialog.textContent).not.toContain(libraryRoot);
    expect(dialog.textContent).not.toContain(dir);
  });

  it("ticks rows one by one or a whole group, filters by direction and counts the selection", async () => {
    const dialog = await showPreview(
      library([item("mine", { title: "Mine" })]),
      remote([paper("THEIRS01", { title: "Theirs" })]),
    );
    const box = (label: string) =>
      dialog.querySelector<HTMLButtonElement>(`button[role="checkbox"][aria-label^="${label}"]`)!;
    const syncButton = () =>
      [...dialog.querySelectorAll("button")].find((b) => b.textContent?.startsWith("备份并同步"))!;
    expect(dialog.textContent).toContain("已选 2 / 2 处");
    expect(dialog.textContent).toContain("新建到 Zotero");
    expect(dialog.textContent).toContain("新建到本地");
    await act(async () => box("Mine").click());
    expect(box("Mine").getAttribute("aria-checked")).toBe("false");
    expect(dialog.textContent).toContain("已选 1 / 2 处");
    expect(syncButton().textContent).toBe("备份并同步（1 处）");
    await act(async () => box("勾选整组：文献").click());
    expect(dialog.textContent).toContain("已选 2 / 2 处");
    await act(async () => box("勾选整组：文献").click());
    expect(dialog.textContent).toContain("已选 0 / 2 处");
    expect(syncButton().disabled).toBe(true);
    await act(async () =>
      [...dialog.querySelectorAll("button")].find((b) => b.textContent === "↓ 写到本地 1")!.click(),
    );
    expect(dialog.textContent).toContain("Theirs");
    expect(dialog.textContent).not.toContain("Mine");
  });

  it("shows the direction filters, one-line conflict choices and the sync control", async () => {
    mocks.fetch.mockImplementation(async (url: string) =>
      response(url.includes("/items?") ? [envelope(paper("PAPER001", { title: "Remote title" }))] : []),
    );
    const onClose = vi.fn();
    await act(async () => {
      root.render(
        createElement(
          I18nextProvider,
          { i18n: i18next },
          createElement(ZoteroSyncDialog, {
            snapshot: library([
              item("local", { title: "Local <script>title</script>", extra: { zotero_key: "PAPER001" } }),
            ]),
            onClose,
          }),
        ),
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    const dialog = document.querySelector('[role="dialog"]')!;
    const buttons = () => [...dialog.querySelectorAll("button")];
    const pressed = () =>
      buttons().find((b) => b.getAttribute("aria-pressed") === "true" && b.closest('[role="group"]'));
    for (const label of [
      "↑ 写到 Zotero 0",
      "↓ 写到本地 0",
      "冲突 1",
      "不处理的",
      "Local <script>title</script>",
      "Remote title",
    ])
      expect(dialog.textContent).toContain(label);
    expect(dialog.querySelector("script")).toBeNull();
    expect(dialog.textContent).not.toContain("条目/local/local.md");
    await act(async () =>
      buttons()
        .find((b) => b.textContent === "Local <script>title</script>")!
        .click(),
    );
    expect(dialog.textContent).toContain("条目/local/local.md");
    expect(dialog.textContent).not.toContain("/fixture");
    expect(buttons().map((b) => b.textContent)).toEqual(
      expect.arrayContaining(["全部用本地", "全部用 Zotero", "这次跳过", "备份并同步（0 处）", "重新预览", "关闭"]),
    );
    expect(pressed()?.textContent).toBe("这次跳过");
    expect(buttons().find((b) => b.textContent === "备份并同步（0 处）")!.disabled).toBe(true);
    await act(async () =>
      buttons()
        .find((b) => b.textContent === "全部用本地")!
        .click(),
    );
    expect(pressed()?.textContent).toBe("用本地");
    expect(dialog.textContent).toContain("已选 1 / 1 处");
    await act(async () =>
      buttons()
        .find((b) => b.textContent === "全部用 Zotero")!
        .click(),
    );
    expect(pressed()?.textContent).toBe("用 Zotero");
    await act(async () => [...dialog.querySelectorAll("button")].find((b) => b.textContent === "关闭")!.click());
    expect(onClose).toHaveBeenCalled();
  });

  it("shows actionable connection errors and can retry", async () => {
    mocks.fetch
      .mockResolvedValueOnce(new Response("Local API is not enabled", { status: 403 }))
      .mockImplementation(async () => response());
    await act(async () =>
      root.render(
        createElement(
          I18nextProvider,
          { i18n: i18next },
          createElement(ZoteroSyncDialog, { snapshot: library(), onClose: vi.fn() }),
        ),
      ),
    );
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("允许本机其他程序通讯");
    const refresh = [...document.querySelectorAll("button")].find((b) => b.textContent === "重新预览")!;
    await act(async () => {
      refresh.click();
    });
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("已连接本机 Zotero");
  });
});

describe("sync, backups and rollback with a fake Zotero", () => {
  let temp: string, root: string, items: ZoteroData[], collections: ZoteroData[], version: number;
  let beforeWrite: ((kind: string, data: Record<string, unknown>) => void) | undefined;
  let afterWrite: (() => void) | undefined;
  let refusal: number, remember: boolean, serverId: string;
  let files: Map<string, string>,
    uploadURL: string,
    prefix: string,
    suffix: string,
    corruptUpload: boolean,
    fileLocation: string | undefined,
    uploadExists: boolean;
  const secret = "fixture-secret-never-in-journals-or-errors";
  const signal = () => new AbortController().signal;
  const manifest = () => join(root, "文献库.litlib");
  const notePath = (key: string) => join(root, "条目", key, `${key}.md`);
  const note = async (key: string, fields: Record<string, unknown> = {}) => {
    await disk.mkdir(join(root, "条目", key), { recursive: true });
    const { stringify } = await import("yaml");
    await writeFile(
      notePath(key),
      `---\n${stringify({ type: "文献", title: key, authors: [], collections: [], tags: [], status: "未读", ...fields })}---\n\n# 研究笔记\nKeep my body.\r\n`,
    );
  };
  const localEdit = async (key: string, fields: Record<string, unknown>) => {
    const { stringify } = await import("yaml");
    const parts = splitLibraryNote(new Uint8Array(await readFile(notePath(key))));
    await writeFile(
      notePath(key),
      `---\n${stringify({ ...parseLibraryYaml(parts.yaml).values, ...fields })}---\n${new TextDecoder().decode(parts.body)}`,
    );
  };
  const preview = async () => {
    const local = await loadLibrary(root),
      history = await readSyncHistory(root);
    const p = await plan(local, await readZotero(signal(), vi.fn()), history.baseline);
    await captureSyncFiles(p);
    return p;
  };
  const sync = async (choice: SyncChoice = "skip") => {
    const p = await preview();
    const choices = Object.fromEntries(p.rows.filter((r) => r.group === "conflict").map((r) => [rowId(r), choice]));
    const run = await resolveZoteroSync(p, choices, signal());
    const path = await applyZoteroSync(p, run, signal(), vi.fn());
    return { p, run, path };
  };
  const changedRows = async () => (await preview()).rows.filter((r) => r.group !== "skip");
  beforeEach(async () => {
    mocks.diskEnabled = true;
    temp = await disk.realpath(await mkdtemp(join(tmpdir(), "zotero-sync-")));
    root = join(temp, "library");
    mocks.data = join(temp, "app-data");
    await disk.mkdir(join(root, "条目"), { recursive: true });
    await disk.mkdir(mocks.data);
    await writeFile(manifest(), JSON.stringify({ version: 1, collections: [], custom: "keep" }));
    mocks.settings.literatureLibraryPath = root;
    items = [];
    collections = [];
    version = 20;
    refusal = 0;
    remember = true;
    serverId = "fixture-server";
    beforeWrite = undefined;
    afterWrite = undefined;
    files = new Map();
    uploadURL = "http://localhost:23119/api/local/uploads/fixture";
    prefix = suffix = "";
    corruptUpload = uploadExists = false;
    fileLocation = undefined;
    const uploads = new Map<string, string>();
    mocks.fetch.mockImplementation(
      async (url: string, options: { method: string; headers: Record<string, string>; body?: string | Uint8Array }) => {
        const u = new URL(url);
        expect(u.origin).toBe("http://localhost:23119");
        expect(options.headers["Zotero-API-Version"]).toBe("3");
        const reply = (data: unknown, status = 200) =>
          response(data, status, { "Last-Modified-Version": String(version), "Zotero-Server-ID": serverId });
        if (u.pathname === "/api/") return reply([]);
        expect(options.headers["Zotero-Server-ID"]).toBe(serverId);
        if (u.pathname === "/api/local/authorize") {
          expect(JSON.parse(options.body as string)).toEqual({ appName: "LabWeave" });
          return reply({ key: secret, remember });
        }
        if (u.pathname === "/api/itemTypeFields")
          return reply(
            [
              "title",
              "date",
              "publicationTitle",
              "proceedingsTitle",
              "repository",
              "volume",
              "issue",
              "pages",
              "DOI",
              "url",
              "abstractNote",
            ].map((field) => ({ field })),
          );
        if (u.pathname.startsWith("/api/local/uploads/")) {
          expect(options.headers["Zotero-API-Key"]).toBe(secret);
          const key = uploads.keys().next().value!;
          const path = join(temp, `${key}.pdf`);
          await writeFile(path, corruptUpload ? "corrupt" : options.body!);
          files.set(key, path);
          return reply({});
        }
        const file = /^\/api\/users\/0\/items\/([A-Z0-9]{8})\/file$/.exec(u.pathname);
        if (file) {
          const key = file[1],
            path = files.get(key);
          if (options.method === "GET")
            return path || fileLocation
              ? response({}, 302, { "Zotero-Server-ID": serverId, Location: fileLocation ?? pathToFileURL(path!).href })
              : reply({}, 404);
          expect(options.headers["Zotero-API-Key"]).toBe(secret);
          expect(options.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
          const form = new URLSearchParams(options.body as string);
          if (form.has("upload")) {
            expect(form.get("upload")).toBe(key);
            Object.assign(items.find((d) => d.key === key)!, {
              md5: uploads.get(key),
              mtime: Date.now(),
              version: ++version,
            });
            uploads.delete(key);
            return reply({});
          }
          expect(options.headers["If-None-Match"]).toBe("*");
          expect(form.get("md5")).toMatch(/^[\da-f]{32}$/);
          uploads.set(key, form.get("md5")!);
          if (uploadExists) {
            const existing = [...files.values()][0];
            files.set(key, existing);
          }
          return reply({
            exists: uploadExists,
            url: uploadURL,
            prefix,
            suffix,
            contentType: "application/octet-stream",
            uploadKey: key,
          });
        }
        const match = /^\/api\/users\/0\/(items|collections)(?:\/([A-Z0-9]{8}))?$/.exec(u.pathname);
        expect(match, url).not.toBeNull();
        const kind = match![1],
          key = match![2],
          records = kind === "items" ? items : collections;
        if (options.method === "GET") {
          if (key) {
            const record = records.find((d) => d.key === key);
            return reply(record ? envelope(record) : {}, record ? 200 : 404);
          }
          const start = Number(u.searchParams.get("start"));
          return reply(
            records
              .filter((d) => kind === "items" || !d.deleted)
              .slice(start, start + 100)
              .map(envelope),
          );
        }
        expect(options.headers["Zotero-API-Key"]).toBe(secret);
        const data = JSON.parse(options.body as string);
        beforeWrite?.(kind, Array.isArray(data) ? data[0] : data);
        if (refusal) return reply({ error: secret }, refusal);
        if (options.method === "POST") {
          expect(data[0].version).toBe(0);
          if (records.some((r) => r.key === data[0].key)) return reply({}, 412);
          records.push({ ...data[0], version: ++version });
        } else {
          const record = records.find((r) => r.key === key)!;
          if (record.version !== data.version) return reply({}, 412);
          Object.assign(record, data, { version: ++version });
        }
        afterWrite?.();
        return reply({ successful: { "0": true }, failed: {} });
      },
    );
  });
  afterEach(async () => {
    await rm(temp, { recursive: true, force: true });
  });

  const attachment = async (key = "ATTACH01", content = "%PDF-fixture", filename = "paper.pdf") => {
    const path = join(temp, `${key}-${filename}`);
    await writeFile(path, content);
    files.set(key, path);
    items.push({
      key,
      version: 1,
      itemType: "attachment",
      parentItem: "PAPER001",
      linkMode: "imported_file",
      filename,
      title: filename,
    });
    return path;
  };
  const paired = async () => {
    items.push(paper("PAPER001", { title: "one" }));
    await note("one", { zotero_key: "PAPER001" });
    return join(root, "条目/one");
  };
  /** Sync with the rows matching `untick` unticked in the window */
  const syncWithout = async (untick: (row: SyncRow) => boolean) => {
    const p = await preview();
    const choices = Object.fromEntries(p.rows.filter(untick).map((r) => [rowId(r), "skip" as const]));
    await applyZoteroSync(p, await resolveZoteroSync(p, choices, signal()), signal(), vi.fn());
  };

  it("does not create unticked papers or collections, and lists them again next time", async () => {
    collections.push(collection("COLZ0001", "Remote col"));
    items.push(paper("NEWZ0001", { title: "Remote paper", collections: ["COLZ0001"] }));
    await writeFile(manifest(), JSON.stringify({ version: 1, collections: ["Local col"] }));
    await note("local", { title: "Local paper", collections: ["Local col"] });
    await syncWithout(
      (r) => (r.kind === "item" && r.group === "pull") || (r.kind === "collection" && r.group === "push"),
    );
    const library = await loadLibrary(root);
    expect(library.items.some((i) => i.extra.zotero_key === "NEWZ0001")).toBe(false);
    expect(library.collections).toContain("Remote col");
    expect(collections.map((c) => c.name)).toEqual(["Remote col"]);
    // The ticked new paper is created, just outside the collection that was not created
    expect(items.find((d) => d.title === "Local paper")?.collections).toEqual([]);
    expect(await changedRows()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "item", group: "pull", key: "NEWZ0001" }),
        expect.objectContaining({ kind: "collection", group: "push", local: "Local col" }),
        expect.objectContaining({ kind: "field", group: "push", field: "collections", title: "Local paper" }),
      ]),
    );
  });

  it("does not write an unticked field change or upload, and offers both again", async () => {
    const folder = await paired();
    await sync();
    await localEdit("one", { title: "Local title" });
    await writeFile(join(folder, "paper.pdf"), "%PDF-upload-fixture");
    await syncWithout((r) => r.kind === "field" || r.group === "attachment");
    expect(items.find((d) => d.key === "PAPER001")?.title).toBe("one");
    expect(items.filter((d) => d.itemType === "attachment")).toEqual([]);
    expect(await changedRows()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "field", group: "push", field: "title", local: "Local title" }),
        expect.objectContaining({ group: "attachment", reason: "upload", title: "paper.pdf" }),
      ]),
    );
  });

  it("uploads PDF and CSV, journals metadata only and trashes the new attachments on rollback", async () => {
    const folder = await paired();
    await writeFile(join(folder, "paper.pdf"), "%PDF-upload-fixture");
    await writeFile(join(folder, "data.csv"), "a,b\n1,2\n");
    await writeFile(join(folder, "leave.txt"), "do not upload");
    const result = await sync();
    expect(result.p.rows.filter((r) => r.group === "attachment")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: "upload", title: "paper.pdf", size: 19 }),
        expect.objectContaining({ reason: "upload", title: "data.csv", size: 8 }),
      ]),
    );
    const uploaded = items.filter((d) => d.itemType === "attachment");
    expect(uploaded).toHaveLength(2);
    for (const d of uploaded)
      expect(await readFile(files.get(d.key)!, "utf8")).toBe(
        await readFile(join(folder, d.filename as string), "utf8"),
      );
    const journal = await readFile(join(result.path, "journal.json"), "utf8");
    expect(journal).not.toContain("%PDF-upload-fixture");
    expect(journal).not.toContain("a,b");
    expect(await readdir(result.path)).toEqual(["journal.json"]);
    expect((await preview()).rows.filter((r) => r.group === "attachment")).toEqual([]);
    await rollbackZoteroSync(root, signal(), vi.fn());
    expect(uploaded.every((d) => d.deleted)).toBe(true);
    expect(await readFile(join(folder, "paper.pdf"), "utf8")).toBe("%PDF-upload-fixture");
  });

  it.each([
    "https://localhost:23119/api/local/uploads/x",
    "http://example.invalid/api/local/uploads/x",
    "http://localhost:23120/api/local/uploads/x",
    "http://user@localhost:23119/api/local/uploads/x",
    "http://localhost:23119/api/other/x",
    "http://localhost:23119/api/local/uploads/../../other",
    "malformed",
  ])("rejects upload address %s before sending bytes", async (url) => {
    const folder = await paired();
    await writeFile(join(folder, "paper.pdf"), "%PDF-upload");
    uploadURL = url;
    await expect(sync()).rejects.toThrow("uploadAddress");
    expect(mocks.fetch.mock.calls.some(([, o]) => o.body instanceof Uint8Array)).toBe(false);
    await rollbackZoteroSync(root, signal(), vi.fn());
    expect(items.at(-1)?.deleted).toBe(true);
  });
  it.each(["prefix", "suffix"])("rejects nonempty upload %s", async (part) => {
    const folder = await paired();
    await writeFile(join(folder, "paper.pdf"), "%PDF-upload");
    if (part === "prefix") prefix = "unsafe";
    else suffix = "unsafe";
    await expect(sync()).rejects.toThrow("uploadFormat");
    expect(mocks.fetch.mock.calls.some(([, o]) => o.body instanceof Uint8Array)).toBe(false);
  });
  it("rejects an upload whose verified bytes differ", async () => {
    const folder = await paired();
    await writeFile(join(folder, "paper.pdf"), "%PDF-upload");
    corruptUpload = true;
    await expect(sync()).rejects.toThrow("writeMismatch");
    expect(pendingSync((await readSyncHistory(root)).run)).toBe(true);
  });
  it("verifies deduplicated upload responses too", async () => {
    const folder = await paired(),
      path = join(temp, "stored.pdf");
    await writeFile(path, "%PDF-upload");
    files.set("STORED01", path);
    await writeFile(join(folder, "paper.pdf"), "%PDF-upload");
    uploadExists = true;
    await sync();
    expect(mocks.fetch.mock.calls.some(([, o]) => o.body instanceof Uint8Array)).toBe(false);
  });
  it("downloads local files without authorization and moves them into removed on rollback", async () => {
    const folder = await paired();
    await attachment();
    const result = await sync();
    expect(result.p.rows).toContainEqual(
      expect.objectContaining({ group: "attachment", reason: "download", title: "paper.pdf", size: 12 }),
    );
    expect(await readFile(join(folder, "paper.pdf"), "utf8")).toBe("%PDF-fixture");
    expect((await loadLibrary(root)).items[0].frontmatter?.pdf).toBe("paper.pdf");
    expect(mocks.fetch.mock.calls.every(([, o]) => o.method === "GET")).toBe(true);
    expect(await readFile(join(result.path, "journal.json"), "utf8")).not.toContain("%PDF-fixture");
    await rollbackZoteroSync(root, signal(), vi.fn());
    await expect(disk.stat(join(folder, "paper.pdf"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(result.path, "removed/条目/one/paper.pdf"), "utf8")).toBe("%PDF-fixture");
    expect(items[1].deleted).toBeUndefined();
  });
  it.each([
    "https://example.invalid/file.pdf",
    "file://other-host/share/file.pdf",
    "file:////server/share/file.pdf",
    "file:///C:/%5C%5Cserver/share.pdf",
  ])("rejects non-local download %s", async (location) => {
    await paired();
    await attachment();
    fileLocation = location;
    await expect(preview()).rejects.toThrow("attachmentAddress");
    expect(mocks.fetch.mock.calls.every(([url]) => String(url).startsWith("http://localhost:23119/api"))).toBe(true);
  });
  it("adopts matching hashes on first sync and skips hashing unchanged size and mtime", async () => {
    const folder = await paired(),
      path = await attachment();
    await writeFile(join(folder, "renamed.pdf"), "%PDF-fixture");
    const result = await sync();
    expect(result.p.rows.filter((r) => r.group === "attachment")).toEqual([]);
    expect(result.run.actions.some((a) => a.kind === "api" || (a.kind === "file" && a.download))).toBe(false);
    mocks.read.mockClear();
    await preview();
    expect(mocks.read.mock.calls.filter(([p]) => [path, join(folder, "renamed.pdf")].includes(p))).toEqual([]);
    await disk.utimes(join(folder, "renamed.pdf"), new Date(), new Date(Date.now() + 10000));
    await preview();
    expect(mocks.read).toHaveBeenCalledWith(join(folder, "renamed.pdf"));
  });
  it("keeps edited local and remote attachments as additional versions without changing annotations", async () => {
    const folder = await paired(),
      path = await attachment();
    await writeFile(join(folder, "paper.pdf"), "%PDF-fixture");
    items.push({
      key: "ANNOT001",
      version: 1,
      itemType: "annotation",
      parentItem: "ATTACH01",
      annotationType: "highlight",
      annotationText: "original",
      annotationPosition: '{"pageIndex":0}',
    });
    await sync();
    await writeFile(join(folder, "paper.pdf"), "%PDF-local-edited");
    const uploaded = await sync();
    expect(uploaded.p.rows).toContainEqual(expect.objectContaining({ reason: "uploadVersion" }));
    expect(items.filter((d) => d.itemType === "attachment")).toHaveLength(2);
    expect(await readFile(path, "utf8")).toBe("%PDF-fixture");
    await writeFile(path, "%PDF-remote-edited");
    const downloaded = await sync();
    expect(downloaded.p.rows).toContainEqual(
      expect.objectContaining({ reason: "downloadVersion", title: "paper.zotero-2.pdf" }),
    );
    expect(await readFile(join(folder, "paper.pdf"), "utf8")).toBe("%PDF-local-edited");
    expect(await readFile(join(folder, "paper.zotero-2.pdf"), "utf8")).toBe("%PDF-remote-edited");
    expect(items.find((d) => d.key === "ANNOT001")?.annotationText).toBe("original");
    expect((await preview()).rows.filter((r) => r.group === "attachment")).toEqual([]);
    mocks.read.mockClear();
    await preview();
    expect(mocks.read.mock.calls.some(([p]) => /\.pdf$/.test(p))).toBe(false);
  });

  it("adopts nested non-PDF files and downloads duplicate remote bytes only once", async () => {
    const folder = await paired();
    await attachment("ATTACH01", "image", "image.png");
    await disk.mkdir(join(folder, "assets"));
    await writeFile(join(folder, "assets/renamed.png"), "image");
    expect((await sync()).p.rows.filter((r) => r.group === "attachment")).toEqual([]);
    await attachment("ATTACH02", "new-image", "image.png");
    await attachment("ATTACH03", "new-image", "same.png");
    const result = await sync();
    expect(result.p.rows.filter((r) => r.group === "attachment")).toHaveLength(1);
    expect(result.run.next.attachments?.ATTACH02.local.path).toBe(result.run.next.attachments?.ATTACH03.local.path);
  });

  it("rolls back a new paper with only exported notes, removing its empty directory", async () => {
    items.push(paper("PAPER001"), {
      key: "NOTE0001",
      version: 1,
      itemType: "note",
      parentItem: "PAPER001",
      note: "<p>note</p>",
    });
    await sync();
    await rollbackZoteroSync(root, signal(), vi.fn());
    expect((await loadLibrary(root)).errors).toEqual([]);
    expect(await readdir(join(root, "条目"))).toEqual([]);
  });

  it("recovers when upload completes just before the journal is written", async () => {
    const folder = await paired();
    await writeFile(join(folder, "paper.pdf"), "%PDF-upload");
    const p = await preview(),
      run = await resolveZoteroSync(p, {}, signal());
    mocks.beforeRename = async (from, to) => {
      if (to.endsWith("journal.json") && (await readFile(from, "utf8")).includes('"mtime"') && items.some((d) => d.md5))
        throw new Error("interrupted");
    };
    await expect(applyZoteroSync(p, run, signal(), vi.fn())).rejects.toThrow("interrupted");
    mocks.beforeRename = undefined;
    await rollbackZoteroSync(root, signal(), vi.fn());
    expect(items.find((d) => d.itemType === "attachment")?.deleted).toBe(true);
  });
  it("blocks stale attachment sources and later edits during rollback", async () => {
    const folder = await paired(),
      source = await attachment();
    const p = await preview(),
      run = await resolveZoteroSync(p, {}, signal());
    await writeFile(source, "%PDF-later");
    await expect(applyZoteroSync(p, run, signal(), vi.fn())).rejects.toThrow("snapshotChanged");
    await sync();
    await writeFile(join(folder, "paper.pdf"), "%PDF-user-edit");
    await expect(rollbackZoteroSync(root, signal(), vi.fn())).rejects.toThrow("rollbackChanged");
  });
  it("imports attachments with new parents and ignores linked URLs and unavailable files", async () => {
    items.push(paper("PAPER001", { title: "Remote" }));
    await attachment();
    items.push(
      { key: "LINK0001", version: 1, itemType: "attachment", parentItem: "PAPER001", linkMode: "linked_url" },
      { key: "MISSING1", version: 1, itemType: "attachment", parentItem: "PAPER001", linkMode: "imported_file" },
    );
    const result = await sync();
    expect(result.p.rows).toContainEqual(expect.objectContaining({ key: "MISSING1", reason: "attachmentMissing" }));
    expect(mocks.fetch.mock.calls.some(([url]) => String(url).includes("LINK0001/file"))).toBe(false);
    const imported = (await loadLibrary(root)).items[0];
    expect(await readFile(join(imported.dir, "paper.pdf"), "utf8")).toBe("%PDF-fixture");
    await rollbackZoteroSync(root, signal(), vi.fn());
    expect((await loadLibrary(root)).errors).toEqual([]);
    await note("new-local");
    await writeFile(join(root, "条目/new-local/data.csv"), "a\n1");
    await sync();
    expect(
      items.some(
        (d) => d.filename === "data.csv" && items.some((p) => p.key === d.parentItem && p.title === "new-local"),
      ),
    ).toBe(true);
  });

  it.each([
    [
      "<p>研究 <strong>重点</strong>，<em>强调</em> a_b * x &amp; y<br>下一行</p>",
      "研究 **重点**，*强调* a\\_b \\* x & y  \n下一行",
    ],
    [
      '<h1>标题</h1><h2>二级</h2><h3>三级</h3><p><a href="https://example.invalid">链接</a></p>',
      "标题\n==\n\n二级\n--\n\n### 三级\n\n[链接](https://example.invalid)",
    ],
    [
      '<ul><li>One<ul><li>Nested</li></ul></li><li>Two</li></ul><ol start="3"><li>Three</li></ol>',
      "* One\n  + Nested\n* Two\n\n3. Three",
    ],
    [
      "<blockquote><p>Quote</p><p>More</p></blockquote><pre><code> a_b\n * c\n</code></pre>",
      "> Quote\n>\n> More\n\n```\n a_b\n * c\n```",
    ],
    [
      "<table><tr><th>A</th><th>B</th></tr><tr><td>x</td><td>y</td></tr></table>",
      "| A | B |\n| --- | --- |\n| x | y |",
    ],
    [
      '<p><code>a`b</code> <s>gone</s> x<sub>2</sub> <img src="local.png" alt="图"></p>',
      "`` a`b `` ~~gone~~ x2 ![图](local.png)",
    ],
    [
      '<table><thead><tr><td colspan="2">A</td></tr></thead><tbody><tr><td>x</td><td>y</td></tr></tbody></table>',
      "| A | |\n| --- | --- |\n| x | y |",
    ],
    ["<table><tr><td>x</td><td>y</td></tr></table>", "|  |  |\n| --- | --- |\n| x | y |"],
    [
      '<div data-schema-version="9">\n<p> <span class="citation">(A, 2020)</span> &nbsp;<a href="https://example.invalid/a_b">https://example.invalid/a_b</a></p>\n<p>Text <sup>2</sup> <code>x_y</code></p></div>',
      "(A, 2020) \u00a0<https://example.invalid/a_b>\n\nText 2 `x_y`",
    ],
    [
      "<dl><dt>Term</dt><dd>Definition</dd></dl><p><q>Quote</q></p><hr><pre>code  </pre>",
      'Term\n:   Definition\n\n"Quote"\n\n---\n\n```\ncode\n```',
    ],
    [
      '<p><span>&nbsp;</span></p><video src="movie.mp4" poster="poster.png">caption</video><script>alert(1)</script><style>p{color:red}</style>',
      "\u00a0\n\n[![caption](poster.png)](movie.mp4)",
    ],
  ])("exports plugin-compatible Markdown and raw JSON for %s", async (html, expected) => {
    const folder = await paired();
    const records: ZoteroData[] = [
      { key: "NOTE0001", version: 1, itemType: "note", parentItem: "PAPER001", note: html },
      {
        key: "ANNOT001",
        version: 2,
        itemType: "annotation",
        parentItem: "ATTACH01",
        annotationType: "highlight",
        annotationText: "  quoted  ",
        annotationComment: "评论",
        annotationPosition: '{"pageIndex":2}',
        annotationSortIndex: "00003",
      },
    ];
    items.push(
      { key: "ATTACH01", version: 1, itemType: "attachment", parentItem: "PAPER001", linkMode: "linked_url" },
      ...records,
    );
    const expectedMD = `# Zotero 批注与笔记\n\n此文件由同步更新；研究笔记请写在文献条目的正文中。\n\n## p.3 · highlight\n\n  quoted  \n评论\n[在 Zotero 中打开](zotero://open-pdf/library/items/ATTACH01?page=3&annotation=ANNOT001)\n\n## Zotero 笔记\n\n${expected}\n`;
    const expectedJSON = JSON.stringify(records, null, 2) + "\n";
    if (process.env.ZOTERO_SYNC_REFERENCE) {
      // Execute only the reference exporter with synthetic records; never instantiate API or Sync.
      const generated = JSON.parse(
        execFileSync(
          process.env.ZOTERO_SYNC_PYTHON!,
          [
            "-B",
            "-c",
            `
import sys, json, socket
sys.path.insert(0, sys.argv[1])
def forbidden(*args, **kwargs): raise RuntimeError('Network forbidden in fixture generator')
from zotero_sync import Sync
socket.socket = forbidden
s = Sync.__new__(Sync)
s.remote = {d['key']: d for d in json.load(sys.stdin)}
s.by_key = {'PAPER001': '条目/one/one.md'}
s.top = {'PAPER001': {'title': 'one'}}
s.blocked_pairs = set()
s.state = {'exports': {}}
s.files = {}
s.plan = {'next_state': {'exports': {}}}
out = {}
s.file_action = lambda path, data, label: out.update({path: data.decode()})
s.plan_exports()
print(json.dumps(out, ensure_ascii=False))
`,
            process.env.ZOTERO_SYNC_REFERENCE,
          ],
          { input: JSON.stringify(items), encoding: "utf8" },
        ),
      );
      expect(generated["条目/one/zotero/同步批注与笔记.md"]).toBe(expectedMD);
      expect(generated["条目/one/zotero/同步批注与笔记.json"]).toBe(expectedJSON);
    }
    const bodyBefore = splitLibraryNote(await readFile(notePath("one"))).body;
    await writeFile(join(folder, "paper.pdf.annotations.json"), "our annotations");
    await sync();
    const md = join(folder, "zotero/同步批注与笔记.md"),
      raw = join(folder, "zotero/同步批注与笔记.json");
    expect(await readFile(md, "utf8")).toBe(expectedMD);
    expect(await readFile(raw, "utf8")).toBe(expectedJSON);
    expect(splitLibraryNote(await readFile(notePath("one"))).body).toEqual(bodyBefore);
    expect(await readFile(join(folder, "paper.pdf.annotations.json"), "utf8")).toBe("our annotations");
    const mtime = (await disk.stat(md)).mtimeMs;
    expect((await sync()).run.actions).toEqual([]);
    expect((await disk.stat(md)).mtimeMs).toBe(mtime);
    await writeFile(md, "edited excerpt");
    await writeFile(raw, "edited raw excerpt");
    await sync();
    expect(await readFile(md, "utf8")).toBe(expectedMD);
    expect(await readFile(raw, "utf8")).toBe(expectedJSON);
    items = items.filter((d) => !["note", "annotation"].includes(d.itemType!));
    await sync();
    expect(await readFile(raw, "utf8")).toBe("[]\n");
    expect(await readFile(md, "utf8")).not.toContain("## Zotero 笔记");
  });

  it("writes fields in both directions and preserves body, custom fields, creator roles and tag metadata", async () => {
    items.push(
      paper("PAPER001", {
        title: "Original",
        date: "2020-02-03",
        creators: [
          { creatorType: "author", firstName: "Ada", lastName: "Lovelace" },
          { creatorType: "editor", name: "Editor" },
        ],
        tags: [{ tag: "keep", type: 1 }],
      }),
    );
    await note("one", {
      title: "Original",
      year: "2020",
      authors: ["Ada Lovelace"],
      tags: ["keep"],
      zotero_key: "PAPER001",
      custom: { preserved: true },
    });
    await sync();
    await localEdit("one", {
      title: "Local title",
      year: "2024",
      authors: ["Ada Lovelace", "Grace Hopper"],
      tags: ["keep", "new"],
      status: "已读",
    });
    Object.assign(items[0], { abstractNote: "Remote abstract", DOI: "10.1/remote", version: ++version });
    const before = await readFile(notePath("one"), "utf8");
    const result = await sync();
    expect(result.run.actions.filter((a) => a.kind === "api")).toHaveLength(1);
    expect(items[0]).toMatchObject({
      title: "Local title",
      date: "2024-02-03",
      creators: [
        { creatorType: "author", firstName: "Ada", lastName: "Lovelace" },
        { creatorType: "author", firstName: "Grace", lastName: "Hopper" },
        { creatorType: "editor", name: "Editor" },
      ],
      tags: expect.arrayContaining([{ tag: "keep", type: 1 }, { tag: "阅读/已读" }]),
    });
    const saved = (await loadLibrary(root)).items[0];
    expect(saved.abstract).toBe("Remote abstract");
    expect(saved.doi).toBe("10.1/remote");
    expect(saved.extra.custom).toEqual({ preserved: true });
    expect((await readFile(notePath("one"), "utf8")).split("# 研究笔记")[1]).toBe(before.split("# 研究笔记")[1]);
    expect(await changedRows()).toEqual([]);
    const reads = mocks.fetch.mock.calls.filter(([url]) => /\/items\?/.test(url));
    expect(reads.length).toBeLessThan(10);
  });

  it.each(["local", "remote", "skip"] as const)(
    "resolves conflicts with %s and keeps skipped conflicts visible",
    async (choice) => {
      items.push(paper("PAPER001", { title: "Remote" }));
      await note("one", { title: "Local", zotero_key: "PAPER001" });
      await sync(choice);
      expect(items[0].title).toBe(choice === "local" ? "Local" : "Remote");
      expect((await loadLibrary(root)).items[0].title).toBe(choice === "remote" ? "Remote" : "Local");
      expect((await changedRows()).filter((r) => r.field === "title")).toHaveLength(choice === "skip" ? 1 : 0);
    },
  );

  it("creates both ways using plugin paths, writes zotero_key, and rolls creations into trash and removed", async () => {
    await note("Local", { title: "Local addition", itemType: "期刊文章", authors: ["Local Person"] });
    items.push(
      paper("REMOTE01", {
        title: "The Diffusion Method",
        date: "2024",
        creators: [{ creatorType: "author", name: "Huang" }],
      }),
    );
    const original = await readFile(notePath("Local"), "utf8");
    const result = await sync();
    const loaded = await loadLibrary(root);
    const imported = loaded.items.find((i) => i.extra.zotero_key === "REMOTE01")!;
    expect(imported.notePath).toBe(notePath("Huang2024Diffusion"));
    const localKey = loaded.items.find((i) => i.key === "Local")!.extra.zotero_key;
    expect(items.find((i) => i.key === localKey)?.title).toBe("Local addition");
    expect(await changedRows()).toEqual([]);
    await rollbackZoteroSync(root, signal(), vi.fn());
    expect(items.find((i) => i.key === localKey)?.deleted).toBe(true);
    expect(await readFile(notePath("Local"), "utf8")).toBe(original);
    expect(
      await readFile(join(result.path, "removed", "条目", "Huang2024Diffusion", "Huang2024Diffusion.md"), "utf8"),
    ).toContain("zotero_key: REMOTE01");
    expect((await loadLibrary(root)).errors).toEqual([]);
    expect((await changedRows()).map((r) => [r.group, r.kind, r.title])).toEqual(
      result.p.rows.filter((r) => r.group !== "skip").map((r) => [r.group, r.kind, r.title]),
    );
    await rollbackZoteroSync(root, signal(), vi.fn());
  });

  it("adds and renames nested collections both ways, updating membership and the stable map", async () => {
    collections.push(collection("COL00001", "Remote"));
    await writeFile(manifest(), JSON.stringify({ version: 1, collections: ["Local", "Local/Sub"], custom: "keep" }));
    await note("one", { title: "Same", zotero_key: "PAPER001", collections: ["Local/Sub"] });
    items.push(paper("PAPER001", { title: "Same", collections: ["COL00001"] }));
    await sync("local");
    let data = JSON.parse(await readFile(manifest(), "utf8"));
    expect(data.collections).toEqual(["Local", "Local/Sub", "Remote"]);
    expect(data.custom).toBe("keep");
    const localKey = Object.keys(data.zoteroCollections).find((k) => data.zoteroCollections[k] === "Local")!;
    const subKey = Object.keys(data.zoteroCollections).find((k) => data.zoteroCollections[k] === "Local/Sub")!;
    expect(collections.find((c) => c.key === subKey)?.parentCollection).toBe(localKey);
    data.collections = ["Renamed", "Renamed/Sub", "Remote"];
    data.zoteroCollections[localKey] = "Renamed";
    data.zoteroCollections[subKey] = "Renamed/Sub";
    await writeFile(manifest(), JSON.stringify(data));
    await localEdit("one", { collections: ["Renamed/Sub"] });
    Object.assign(collections.find((c) => c.key === "COL00001")!, { name: "Remote renamed", version: ++version });
    await sync();
    data = JSON.parse(await readFile(manifest(), "utf8"));
    expect(data.zoteroCollections).toMatchObject({
      [localKey]: "Renamed",
      [subKey]: "Renamed/Sub",
      COL00001: "Remote renamed",
    });
    expect(collections.find((c) => c.key === localKey)?.name).toBe("Renamed");
    expect((await loadLibrary(root)).items[0].collections).toEqual(["Renamed/Sub"]);
    expect(await changedRows()).toEqual([]);
  });

  it.each(["remote", "local", "newLocal", "collection", "state"])(
    "rejects a stale %s preview before mutations",
    async (side) => {
      items.push(paper("PAPER001", { title: "Remote" }));
      await note("one", { title: "Local", zotero_key: "PAPER001" });
      const p = await preview(),
        run = await resolveZoteroSync(p, { "field:PAPER001:title": "local" }, signal());
      if (side === "remote") items[0].version++;
      if (side === "local") await localEdit("one", { title: "Later" });
      if (side === "newLocal") await note("new");
      if (side === "collection") collections.push(collection("COL00001", "Later"));
      if (side === "state") await sync("remote");
      mocks.fetch.mockClear();
      await expect(applyZoteroSync(p, run, signal(), vi.fn())).rejects.toThrow("snapshotChanged");
      expect(
        mocks.fetch.mock.calls.filter(
          ([, o]) => o.method === "PATCH" || (o.method === "POST" && !o.body?.includes("appName")),
        ),
      ).toEqual([]);
    },
  );

  it("stops at 412 without retry and can roll back the pending operation", async () => {
    items.push(paper("PAPER001", { title: "Remote" }));
    await note("one", { title: "Local", zotero_key: "PAPER001" });
    refusal = 412;
    await expect(sync("local")).rejects.toThrow("snapshotChanged");
    expect(mocks.fetch.mock.calls.filter(([, o]) => o.method === "PATCH")).toHaveLength(1);
    expect(pendingSync((await readSyncHistory(root)).run)).toBe(true);
    refusal = 0;
    await rollbackZoteroSync(root, signal(), vi.fn());
    expect(items[0].title).toBe("Remote");
  });

  it("recovers an interrupted sync and an interrupted rollback, including the response-before-journal gap", async () => {
    items.push(paper("PAPER001", { title: "Remote", abstractNote: "remote abstract" }));
    await note("one", { title: "Local", zotero_key: "PAPER001" });
    const bytes = await readFile(notePath("one"));
    afterWrite = () => {
      throw new Error(`transport included ${secret}`);
    };
    await expect(sync("local")).rejects.toThrow("requestFailed");
    expect(items[0].title).toBe("Local");
    expect(pendingSync((await readSyncHistory(root)).run)).toBe(true);
    await expect(sync()).rejects.toThrow("unfinished");
    await expect(rollbackZoteroSync(root, signal(), vi.fn())).rejects.toThrow("requestFailed");
    expect(items[0].title).toBe("Remote");
    expect((await readSyncHistory(root)).run?.status).toBe("rolling-back");
    afterWrite = undefined;
    await rollbackZoteroSync(root, signal(), vi.fn());
    expect(await readFile(notePath("one"))).toEqual(bytes);
    expect((await readSyncHistory(root)).run?.status).toBe("rolled-back");
  });

  it("recovers a local write interrupted before completion is journaled", async () => {
    items.push(paper("PAPER001", { title: "Remote" }));
    await note("one", { title: "Local", zotero_key: "PAPER001" });
    const bytes = await readFile(notePath("one"));
    mocks.beforeRename = async (from, to) => {
      if (to.endsWith("journal.json") && (await readFile(from, "utf8")).includes('"status": "done"'))
        throw new Error("simulated crash");
    };
    await expect(sync("remote")).rejects.toThrow("simulated crash");
    expect((await loadLibrary(root)).items[0].title).toBe("Remote");
    mocks.beforeRename = undefined;
    await rollbackZoteroSync(root, signal(), vi.fn());
    expect(await readFile(notePath("one"))).toEqual(bytes);
  });

  it("lists later local and remote edits and performs no rollback writes", async () => {
    items.push(paper("PAPER001", { title: "Remote" }));
    await note("one", { title: "Local", zotero_key: "PAPER001" });
    await sync("local");
    await writeFile(manifest(), (await readFile(manifest(), "utf8")) + "\n");
    Object.assign(items[0], { title: "Later edit", version: ++version });
    const calls = mocks.fetch.mock.calls.length;
    const error = await rollbackZoteroSync(root, signal(), vi.fn()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SyncRollbackError);
    expect((error as SyncRollbackError).changes).toEqual(expect.arrayContaining([manifest(), "PAPER001/title"]));
    expect(mocks.fetch.mock.calls.slice(calls).every(([, o]) => o.method === "GET")).toBe(true);
    expect(items[0].title).toBe("Later edit");
  });

  it("preserves unrelated later Zotero edits, restores the baseline and leaves a clean preview", async () => {
    items.push(paper("PAPER001", { title: "Same" }));
    await note("one", { title: "Same", zotero_key: "PAPER001" });
    await sync();
    const baseline = (await readSyncHistory(root)).baseline;
    await sync();
    await rollbackZoteroSync(root, signal(), vi.fn());
    expect((await readSyncHistory(root)).baseline).toEqual(baseline);
    expect(await changedRows()).toEqual([]);
    await localEdit("one", { title: "Local edit" });
    await sync();
    Object.assign(items[0], { extra: "Later unsynced property", version: ++version });
    await rollbackZoteroSync(root, signal(), vi.fn());
    expect(items[0]).toMatchObject({ title: "Same", extra: "Later unsynced property" });
  });

  it("refuses rollback when a created item has a later attachment", async () => {
    await note("new", { itemType: "期刊文章" });
    await sync();
    items.push(paper("ATTACH01", { itemType: "attachment", parentItem: items[0].key }));
    await expect(rollbackZoteroSync(root, signal(), vi.fn())).rejects.toMatchObject({ changes: ["ATTACH01"] });
    expect(items[0].deleted).toBeUndefined();
  });

  it("protects later membership in a new collection even if that item had another field synced", async () => {
    items.push(paper("PAPER001", { title: "Remote" }));
    await note("one", { title: "Local", zotero_key: "PAPER001" });
    await writeFile(manifest(), JSON.stringify({ version: 1, collections: ["New category"] }));
    await sync("local");
    items[0].collections = [collections[0].key];
    items[0].version = ++version;
    await expect(rollbackZoteroSync(root, signal(), vi.fn())).rejects.toMatchObject({ changes: ["PAPER001"] });
    expect(collections[0].deleted).toBeUndefined();
    expect(items[0].title).toBe("Local");
  });

  it("stores secrets only in a private per-server credential file, erases it on 401 and sanitizes errors", async () => {
    items.push(paper("PAPER001", { title: "Remote" }));
    await note("one", { title: "Local", zotero_key: "PAPER001" });
    const { path } = await sync("local");
    const files = await readdir(temp, { recursive: true });
    const containing: string[] = [];
    for (const file of files)
      if ((await disk.stat(join(temp, file))).isFile() && (await readFile(join(temp, file), "utf8")).includes(secret))
        containing.push(file);
    expect(containing).toHaveLength(1);
    expect(containing[0]).toMatch(/app-data\/zotero-sync\/auth\/[a-f0-9]{64}\.json$/);
    expect((await disk.stat(join(temp, containing[0]))).mode & 0o777).toBe(0o600);
    expect((await disk.stat(join(mocks.data, "zotero-sync", "auth"))).mode & 0o777).toBe(0o700);
    expect(await readFile(join(path, "journal.json"), "utf8")).not.toContain(secret);
    await localEdit("one", { title: "Another edit" });
    refusal = 401;
    const error = await sync().catch((e: unknown) => e);
    expect(String(error)).toContain("authorizationDenied");
    expect(String(error)).not.toContain(secret);
    expect(await readdir(join(mocks.data, "zotero-sync", "auth"))).toEqual([]);
    refusal = 0;
    await rollbackZoteroSync(root, signal(), vi.fn());
    serverId = "another-server";
    const p = await plan(await loadLibrary(root), await readZotero(signal(), vi.fn()));
    await captureSyncFiles(p);
    const run = await resolveZoteroSync(p, { "field:PAPER001:title": "local" }, signal());
    // Different Zotero instances cannot reuse a library baseline or its authorization.
    await expect(applyZoteroSync(p, run, signal(), vi.fn())).rejects.toThrow("snapshotChanged");
  });

  it("does not save temporary authorization and retains only ten backups", async () => {
    await note("new", { itemType: "期刊文章" });
    remember = false;
    await expect(sync()).rejects.toThrow("persistentAuthorization");
    expect(await readdir(join(mocks.data, "zotero-sync", "auth"))).toEqual([]);
    remember = true;
    for (let i = 0; i < 12; i++) await sync();
    const h = await readSyncHistory(root);
    expect((await readdir(h.directory)).filter((n) => n.startsWith("run-"))).toHaveLength(10);
  });

  it("does not expose credentials when their file cannot be saved", async () => {
    await note("new", { itemType: "期刊文章" });
    mocks.beforeRename = async (_from, to) => {
      if (to.includes("/auth/")) throw new Error(secret);
    };
    const error = await sync().catch((e: unknown) => e);
    expect(String(error)).toContain("storageFailed");
    expect(String(error)).not.toContain(secret);
    expect(error).not.toHaveProperty("cause");
    expect(await readdir(join(mocks.data, "zotero-sync", "auth"))).toEqual([]);
  });

  it("stops when the saved Zotero version does not advance", async () => {
    items.push(paper("PAPER001", { title: "Remote" }));
    await note("one", { title: "Local", zotero_key: "PAPER001" });
    afterWrite = () => {
      items[0].version = 7;
    };
    await expect(sync("local")).rejects.toThrow("snapshotChanged");
    expect(mocks.fetch.mock.calls.filter(([, o]) => o.method === "PATCH")).toHaveLength(1);
  });

  it("imports into a new library without an items folder and retries an interrupted removal", async () => {
    await disk.rmdir(join(root, "条目"));
    items.push(paper("REMOTE01", { title: "Remote" }));
    const { path } = await sync();
    const imported = (await loadLibrary(root)).items[0];
    mocks.beforeRename = async (from, to) => {
      if (to.endsWith("journal.json") && (await readFile(from, "utf8")).includes('"status": "restored"'))
        throw new Error("crash after removal");
    };
    await expect(rollbackZoteroSync(root, signal(), vi.fn())).rejects.toThrow("crash after removal");
    expect((await loadLibrary(root)).items).toEqual([]);
    // A process can exit after removing the file but before removing its empty directory.
    await disk.mkdir(imported.dir);
    mocks.beforeRename = undefined;
    await rollbackZoteroSync(root, signal(), vi.fn());
    expect((await loadLibrary(root)).errors).toEqual([]);
    expect(await readFile(join(path, "removed", "条目", imported.key, `${imported.key}.md`), "utf8")).toContain(
      "zotero_key: REMOTE01",
    );
  });

  it("uses separate credentials for separate server IDs", async () => {
    await note("first", { itemType: "期刊文章" });
    await sync();
    const auth = join(mocks.data, "zotero-sync", "auth"),
      first = await readdir(auth);
    serverId = "second-server";
    items = [];
    root = join(temp, "second-library");
    mocks.settings.literatureLibraryPath = root;
    await disk.mkdir(join(root, "条目"), { recursive: true });
    await writeFile(manifest(), JSON.stringify({ version: 1, collections: [] }));
    await note("second", { itemType: "期刊文章" });
    await sync();
    expect(await readdir(auth)).toHaveLength(2);
    expect(mocks.fetch.mock.calls.filter(([url]) => url.endsWith("/local/authorize"))).toHaveLength(2);
    await localEdit("second", { title: "Later" });
    refusal = 401;
    await expect(sync()).rejects.toThrow("authorizationDenied");
    expect(await readdir(auth)).toEqual(first);
  });

  it("handles collection conflict choices and keeps skipped renames visible", async () => {
    collections.push(collection("COL00001", "Original"));
    await writeFile(
      manifest(),
      JSON.stringify({ version: 1, collections: ["Original"], zoteroCollections: { COL00001: "Original" } }),
    );
    await sync();
    await writeFile(
      manifest(),
      JSON.stringify({ version: 1, collections: ["Local"], zoteroCollections: { COL00001: "Local" } }),
    );
    collections[0].name = "Remote";
    collections[0].version = ++version;
    await sync("skip");
    expect((await changedRows()).filter((r) => r.kind === "collection")).toHaveLength(1);
    await sync("remote");
    expect((await loadLibrary(root)).zoteroCollections).toEqual({ COL00001: "Remote" });
    expect(await changedRows()).toEqual([]);
    await rollbackZoteroSync(root, signal(), vi.fn());
    await sync("local");
    expect(collections[0].name).toBe("Local");
    expect(await changedRows()).toEqual([]);
  });

  it("refuses a version race during rollback without retrying", async () => {
    items.push(paper("PAPER001", { title: "Remote" }));
    await note("one", { title: "Local", zotero_key: "PAPER001" });
    await sync("local");
    beforeWrite = () => {
      items[0].version = ++version;
    };
    mocks.fetch.mockClear();
    await expect(rollbackZoteroSync(root, signal(), vi.fn())).rejects.toThrow("snapshotChanged");
    expect(items[0].title).toBe("Local");
    expect(mocks.fetch.mock.calls.filter(([, o]) => o.method === "PATCH")).toHaveLength(1);
    beforeWrite = undefined;
    await rollbackZoteroSync(root, signal(), vi.fn());
  });

  it("keeps a skipped multiple-status conflict and rejects choosing an invalid remote status", async () => {
    items.push(paper("PAPER001", { title: "Remote", tags: [{ tag: "阅读/已读" }, { tag: "阅读/待读" }] }));
    await sync();
    expect((await loadLibrary(root)).items).toHaveLength(0);
    await expect(sync("remote")).rejects.toThrow("invalidStatus");
    expect(items[0].tags).toHaveLength(2);
  });

  async function showWindow() {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    await i18next.init({
      lng: "zh_CN",
      resources: { zh_CN: { research: parse(readFileSync("app/src/locales/zh_CN.yml", "utf8")).research } },
    });
    const host = document.createElement("div");
    document.body.append(host);
    const view = createRoot(host),
      snapshot = await loadLibrary(root);
    await act(async () =>
      view.render(
        createElement(
          I18nextProvider,
          { i18n: i18next },
          createElement(ZoteroSyncDialog, { snapshot, onClose: vi.fn() }),
        ),
      ),
    );
    const settle = () =>
      vi.waitFor(async () => {
        await act(async () => {
          await new Promise((r) => setTimeout(r, 10));
        });
        expect(document.querySelector('[aria-busy="false"]')).not.toBeNull();
      });
    await settle();
    const click = async (label: string) => {
      await act(async () => [...document.querySelectorAll("button")].find((b) => b.textContent === label)!.click());
      await settle();
    };
    const close = async () => {
      await act(async () => view.unmount());
      host.remove();
    };
    return { click, close };
  }

  it("asks for a concrete system confirmation, respects cancel, shows results and opens the backup", async () => {
    items.push(paper("PAPER001", { title: "Remote" }));
    await note("one", { title: "Local", zotero_key: "PAPER001" });
    const ui = await showWindow();
    try {
      await ui.click("全部用本地");
      mocks.confirm.mockResolvedValue(false);
      await ui.click("备份并同步（1 处）");
      expect(mocks.confirm).toHaveBeenCalledWith(
        expect.stringContaining("将修改 2 处"),
        expect.objectContaining({ kind: "warning" }),
      );
      expect(items[0].title).toBe("Remote");
      expect((await readSyncHistory(root)).run).toBeUndefined();
      mocks.confirm.mockResolvedValue(true);
      await ui.click("备份并同步（1 处）");
      expect(document.body.textContent).toContain("上次同步已完成：改了 2 处");
      await ui.click("打开备份文件夹");
      expect(mocks.shell).toHaveBeenCalledWith((await readSyncHistory(root)).runPath);
      await ui.click("回退本次同步");
      expect(document.body.textContent).toContain("已回退，可以重新预览");
      expect(items[0].title).toBe("Remote");
    } finally {
      await ui.close();
    }
  });

  it("shows attachment direction, filename and size in its own preview group", async () => {
    const folder = await paired();
    await writeFile(join(folder, "paper.pdf"), "%PDF-upload-fixture");
    const ui = await showWindow();
    try {
      const section = document.querySelector('section[aria-label="附件与批注摘录"]')!;
      expect(section.textContent).toContain("paper.pdf");
      expect(section.textContent).toContain("上传 · 19 B");
      expect(section.querySelector('svg[aria-label="↑ 写到 Zotero"]')).not.toBeNull();
    } finally {
      await ui.close();
    }
  });

  it("shows unfinished work before contacting Zotero when the window reopens", async () => {
    items.push(paper("PAPER001", { title: "Remote" }));
    await note("one", { title: "Local", zotero_key: "PAPER001" });
    afterWrite = () => {
      throw new Error("closed");
    };
    await expect(sync("local")).rejects.toThrow("requestFailed");
    afterWrite = undefined;
    mocks.fetch.mockClear();
    const ui = await showWindow();
    try {
      expect(mocks.fetch).not.toHaveBeenCalled();
      expect(document.body.textContent).toContain("上次同步或回退没有完成");
      await ui.click("回退上次同步");
      expect(document.body.textContent).toContain("已回退，可以重新预览");
    } finally {
      await ui.close();
    }
  });
});
