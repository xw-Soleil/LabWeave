// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import i18next from "i18next";
import { I18nextProvider } from "react-i18next";
import type { LibraryItem, LibrarySnapshot } from "./Library";
import { libraryExtra, libraryMetadata, parseLibraryYaml, splitLibraryNote } from "./LibraryFormat";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  fs: vi.fn(() => {
    throw new Error("Unexpected filesystem access");
  }),
}));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: mocks.fetch }));
vi.mock("@tauri-apps/plugin-fs", () => ({
  open: mocks.fs,
  readFile: mocks.fs,
  stat: mocks.fs,
  writeFile: mocks.fs,
  SeekMode: {},
}));
vi.mock("@/components/overlay-host", () => ({ OverlayHost: {} }));

import {
  localValues,
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
  mocks.fetch.mockReset();
  mocks.fs.mockClear();
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
        headers: { "Zotero-API-Version": "3", "Zotero-Server-ID": index ? "fixture-server" : "" },
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
      deferred: { total: 660, annotations: 490, attachments: 160, notes: 10 },
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
    expect(result.summary.deferred).toEqual({ total: 1, annotations: 0, attachments: 0, notes: 1 });
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

  it("renders compact summaries with separate child counts and one missing-collections notice", async () => {
    const fixture = largePreviewFixture();
    fixture.remote.items[0].collections = ["MISSING1", "MISSING2"];
    const dialog = await showPreview(fixture.local, fixture.remote);
    const skip = dialog.querySelector('section[aria-label="保留／跳过"]')!;
    expect(skip.querySelector("h3")?.textContent).toBe("保留／跳过 (7)");
    expect(skip.textContent).toContain("67 篇没有变化");
    expect(skip.textContent).toContain("660 条子记录（批注 490 条、附件 160 条、子笔记 10 条），第 3 步再处理。");
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
    expect(dialog.querySelector('section[aria-label="保留／跳过"]')?.textContent).toContain("条目/AI/broken.md");
    expect(dialog.textContent).not.toContain(libraryRoot);
    expect(dialog.textContent).not.toContain(dir);
  });

  it("shows four groups and both conflict values, with only refresh and close controls", async () => {
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
    for (const label of [
      "写到 Zotero",
      "写到本地",
      "冲突",
      "保留／跳过",
      "Local <script>title</script>",
      "Remote title",
    ])
      expect(dialog.textContent).toContain(label);
    expect(dialog.querySelector("script")).toBeNull();
    expect(dialog.textContent).toContain("条目/local/local.md");
    expect(dialog.textContent).not.toContain("/fixture");
    expect([...dialog.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["重新预览", "关闭"]);
    await act(async () => (dialog.querySelectorAll("button")[1] as HTMLButtonElement).click());
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
