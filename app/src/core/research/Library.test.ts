// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as disk from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parse } from "yaml";
import { readFileSync } from "node:fs";
import i18next from "i18next";

const mocks = vi.hoisted(() => ({
  settings: { literatureLibraryPath: "" },
  invoke: vi.fn(),
  beforeRename: undefined as undefined | ((from: string, to: string) => Promise<void>),
}));
vi.mock("@/core/service/Settings", () => ({ Settings: mocks.settings }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/plugin-fs", async () => {
  const fs = await import("node:fs/promises");
  const info = (value: Awaited<ReturnType<typeof fs.lstat>>) => ({
    isFile: value.isFile(),
    isDirectory: value.isDirectory(),
    isSymlink: value.isSymbolicLink(),
    size: value.size,
    mtime: value.mtime,
  });
  return {
    lstat: vi.fn(async (path: string) => info(await fs.lstat(path))),
    stat: vi.fn(async (path: string) => info(await fs.stat(path))),
    exists: vi.fn(async (path: string) => {
      try {
        await fs.lstat(path);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
    }),
    readDir: vi.fn(async (path: string) =>
      (await fs.readdir(path, { withFileTypes: true })).map((entry) => ({
        name: entry.name,
        isFile: entry.isFile(),
        isDirectory: entry.isDirectory(),
        isSymlink: entry.isSymbolicLink(),
      })),
    ),
    readFile: vi.fn(async (path: string) => new Uint8Array(await fs.readFile(path))),
    writeFile: vi.fn(async (path: string, bytes: Uint8Array) => fs.writeFile(path, bytes)),
    mkdir: vi.fn(async (path: string) => {
      await fs.mkdir(path);
    }),
    copyFile: vi.fn(async (from: string, to: string) => fs.copyFile(from, to)),
    rename: vi.fn(async (from: string, to: string) => {
      await mocks.beforeRename?.(from, to);
      await fs.rename(from, to);
    }),
    remove: vi.fn(async (path: string) => {
      const value = await fs.lstat(path);
      if (value.isDirectory()) await fs.rmdir(path);
      else await fs.unlink(path);
    }),
    open: vi.fn(async (path: string, options: { createNew?: boolean }) => {
      const handle = await fs.open(path, options?.createNew ? "wx" : "r");
      return {
        write: async (bytes: Uint8Array) => (await handle.write(bytes)).bytesWritten,
        close: async () => handle.close(),
      };
    }),
    SeekMode: { Start: 0, Current: 1, End: 2 },
  };
});

import * as fs from "@tauri-apps/plugin-fs";
import {
  addCollection,
  countLibrary,
  createItem,
  createLibrary,
  loadLibrary,
  queryLibrary,
  removeCollection,
  renameCollection,
  restoreItem,
  trashItem,
  updateItem,
  useLibrary,
  type LibrarySnapshot,
  type LibraryState,
} from "./Library";

let root: string;
const fsDefaults = Object.values(fs).flatMap((mock) =>
  vi.isMockFunction(mock) ? [{ mock, implementation: mock.getMockImplementation() }] : [],
);
let outside: string;
let view: Root | undefined;
let state: LibraryState;
const template = "\n# 研究笔记\n\n## 研究问题\n\n\n## 方法\n\n\n## 结论与启发\n\n";
const smallPdf = Uint8Array.of(37, 80, 68, 70, 45, 49, 46, 55, 10);
const note = (key: string) => join(root, "条目", key, `${key}.md`);
const noteReads = () =>
  vi
    .mocked(fs.readFile)
    .mock.calls.map(([path]) => String(path))
    .filter((path) => path.endsWith(".md"));

async function item(key: string, yaml = "", attachments: string[] = []) {
  const dir = join(root, "条目", key);
  await disk.mkdir(dir, { recursive: true });
  await disk.writeFile(
    note(key),
    `---\ntype: 文献\ntitle: "${key}"\nauthors: []\nstatus: 未读\ncollections: []\ntags: []\n${yaml}---\n${template}`,
  );
  for (const attachment of attachments) await disk.writeFile(join(dir, attachment), smallPdf);
}

beforeEach(async () => {
  vi.clearAllMocks();
  for (const { mock, implementation } of fsDefaults) {
    mock.mockReset();
    if (implementation) mock.mockImplementation(implementation);
  }
  mocks.beforeRename = undefined;
  root = await disk.realpath(await disk.mkdtemp(join(tmpdir(), "library-test-")));
  outside = await disk.mkdtemp(join(tmpdir(), "library-source-"));
  mocks.settings.literatureLibraryPath = root;
  mocks.invoke.mockImplementation(async (command, { path }) => {
    expect(command).toBe("authorize_research_project");
    return disk.realpath(path);
  });
  await disk.writeFile(
    join(root, "文献库.litlib"),
    JSON.stringify({ version: 1, collections: ["AI", "AI/PDE", "Other"], custom: { keep: true } }, null, 2),
  );
  await i18next.init({
    lng: "en",
    resources: { zh_CN: { research: { library: { untitled: "未命名文献", noteTemplate: template } } } },
  });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});

afterEach(async () => {
  if (view) {
    await act(async () => view!.unmount());
    view = undefined;
  }
  vi.restoreAllMocks();
  await disk.rm(root, { recursive: true, force: true });
  await disk.rm(outside, { recursive: true, force: true });
});

describe("literature library loading", () => {
  it("retains the plugin's collection identities in the existing snapshot without writing", async () => {
    const path = join(root, "文献库.litlib");
    const data = { version: 1, collections: ["A"], zoteroCollections: { COL00001: "A" } };
    await disk.writeFile(path, JSON.stringify(data));
    await item("Paper", "zotero_key: PAPER001\ncustom: keep\n");
    const before = await disk.readFile(path);
    const snapshot = await loadLibrary(root);
    expect(snapshot.zoteroCollections).toEqual(data.zoteroCollections);
    expect(snapshot.items[0].frontmatter).toMatchObject({ zotero_key: "PAPER001", custom: "keep", title: "Paper" });
    expect(await disk.readFile(path)).toEqual(before);
    await disk.writeFile(path, JSON.stringify({ ...data, zoteroCollections: { COL00001: 1 } }));
    await expect(loadLibrary(root)).rejects.toThrow("library.invalidManifest");
  });

  it("reads each note in one call, bounds concurrency, and isolates malformed items", async () => {
    await Promise.all(Array.from({ length: 32 }, (_, i) => item(`Paper${i}`)));
    await item("Broken");
    await disk.writeFile(note("Broken"), "---\ntype: 文献\nx: [broken\n---\nbody");
    const read = vi.mocked(fs.readFile).getMockImplementation()!;
    let readers = 0;
    let peak = 0;
    vi.mocked(fs.readFile).mockImplementation(async (...args) => {
      peak = Math.max(++readers, peak);
      try {
        return await read(...args);
      } finally {
        readers--;
      }
    });
    const snapshot = await loadLibrary(root);
    expect(snapshot.items).toHaveLength(32);
    expect(snapshot.errors).toEqual([{ key: "Broken", notePath: note("Broken"), code: "library.invalidFrontmatter" }]);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(8);
    expect(noteReads()).toHaveLength(33);
    expect(new Set(noteReads()).size).toBe(33);
  });

  it("opens the original even when the note names a translation as its PDF", async () => {
    await item("Paper", "pdf: Paper.zh.mono.pdf\n", ["Paper.pdf", "Paper.zh.dual.pdf", "Paper.zh.mono.pdf"]);
    await item("Translated", "pdf: Translated.zh.mono.pdf\n", ["Translated.zh.dual.pdf", "Translated.zh.mono.pdf"]);
    const { items } = await loadLibrary(root);
    expect(items[0]).toMatchObject({
      pdfPath: join(root, "条目/Paper/Paper.pdf"),
      translations: { mono: join(root, "条目/Paper/Paper.zh.mono.pdf") },
    });
    // 只有译文时，登记的那份照旧算数
    expect(items[1].pdfPath).toBe(join(root, "条目/Translated/Translated.zh.mono.pdf"));
  });

  it("recognizes declared PDFs, modern and legacy translations and the matching annotation sidecar", async () => {
    await item("Paper", "pdf: Paper.pdf\nyear: 2024\ncustom: { keep: 'raw' }\n", [
      "Paper.pdf",
      "Paper.zh.dual.pdf",
      "Paper.zh.mono.pdf",
      "Paper.annotations.json",
    ]);
    const first = (await loadLibrary(root)).items[0];
    expect(first).toMatchObject({
      year: "2024",
      pdfPath: join(root, "条目/Paper/Paper.pdf"),
      translations: {
        dual: join(root, "条目/Paper/Paper.zh.dual.pdf"),
        mono: join(root, "条目/Paper/Paper.zh.mono.pdf"),
      },
      annotationsPath: join(root, "条目/Paper/Paper.annotations.json"),
      extra: { custom: { keep: "raw" } },
    });
    await item("Legacy", "", ["Legacy.pdf", "Legacy-dual.pdf", "Legacy-mono.pdf"]);
    expect((await loadLibrary(root)).items.find((entry) => entry.key === "Legacy")?.translations.dual).toMatch(
      /Legacy-dual\.pdf$/,
    );
  });

  it("adds missing parent collections in the snapshot without writing on load", async () => {
    await item("Paper");
    await updateItem(root, "Paper", { collections: ["New/Child/Leaf"] });
    const raw = await disk.readFile(join(root, "文献库.litlib"));
    const snapshot = await loadLibrary(root);
    expect(snapshot.collections).toEqual(["AI", "AI/PDE", "Other", "New", "New/Child", "New/Child/Leaf"]);
    expect(await disk.readFile(join(root, "文献库.litlib"))).toEqual(raw);
  });

  it("never overwrites a damaged manifest and rejects ambiguous manifests", async () => {
    await disk.writeFile(join(root, "文献库.litlib"), "{ broken");
    await expect(loadLibrary(root)).rejects.toThrow("library.invalidManifest");
    await expect(addCollection(root, "New")).rejects.toThrow("library.invalidManifest");
    expect(await disk.readFile(join(root, "文献库.litlib"), "utf8")).toBe("{ broken");
    await disk.writeFile(join(root, "Other.litlib"), "{}");
    await expect(loadLibrary(root)).rejects.toThrow("library.manifestAmbiguous");
  });
});

describe("atomic writes and imports", () => {
  it("changes YAML only, preserves unknown bytes and restores the trash marker", async () => {
    await item("Paper", "custom: { str: '007', list: [one, two] } # keep\n");
    const original = await disk.readFile(note("Paper"), "utf8");
    await updateItem(root, "Paper", { title: "New title" });
    expect(await disk.readFile(note("Paper"), "utf8")).toBe(original.replace('title: "Paper"', 'title: "New title"'));
    expect((await trashItem(root, "Paper")).trashed).toBe(true);
    expect((await restoreItem(root, "Paper")).trashed).toBe(false);
    expect(await disk.readFile(note("Paper"), "utf8")).not.toContain("deleted:");
    expect(await disk.readdir(join(root, "条目/Paper"))).toEqual(["Paper.md"]);
  });

  it("preserves the original after rename failure, removes its temp file, and accepts a later queued edit", async () => {
    await item("Paper");
    const original = await disk.readFile(note("Paper"));
    let failed = false;
    mocks.beforeRename = async () => {
      if (!failed) {
        failed = true;
        throw new Error("disk full");
      }
    };
    const first = updateItem(root, "Paper", { title: "fails" });
    const second = updateItem(root, "Paper", { venue: "saved" });
    await expect(first).rejects.toThrow("library.writeFailed");
    expect(await second).toMatchObject({ title: "Paper", venue: "saved" });
    expect(await disk.readdir(join(root, "条目/Paper"))).toEqual(["Paper.md"]);
    expect((await disk.readFile(note("Paper"), "utf8")).split("---\n").at(-1)).toBe(
      original.toString().split("---\n").at(-1),
    );
  });

  it("queues writes in call order even when the first authorization read is slower", async () => {
    await item("Paper");
    const nativeLstat = vi.mocked(fs.lstat).getMockImplementation()!;
    let delayed = false;
    vi.mocked(fs.lstat).mockImplementation(async (...args) => {
      if (args[0] === root && !delayed) {
        delayed = true;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return nativeLstat(...args);
    });
    const first = updateItem(root, "Paper", { title: "First" });
    const second = updateItem(root, "Paper", { title: "Second" });
    await Promise.all([first, second]);
    expect((await loadLibrary(root)).items[0].title).toBe("Second");
  });

  it("detects an external edit made during temporary-file writing and keeps that edit", async () => {
    await item("Paper");
    const nativeOpen = vi.mocked(fs.open).getMockImplementation()!;
    vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
      const handle = await nativeOpen(...args);
      const write = handle.write;
      handle.write = async (bytes) => {
        const count = await write(bytes);
        await disk.writeFile(note("Paper"), "---\ntype: 文献\ntitle: external\n---\nexternal body");
        return count;
      };
      return handle;
    });
    await expect(updateItem(root, "Paper", { title: "stale" })).rejects.toThrow("library.fileChanged");
    expect(await disk.readFile(note("Paper"), "utf8")).toContain("external body");
    expect(await disk.readdir(join(root, "条目/Paper"))).toEqual(["Paper.md"]);
  });

  it("imports by filename, copies rather than moves, and handles key collisions like the plugin", async () => {
    const source = join(outside, "the diffusion model.pdf");
    await disk.writeFile(source, smallPdf);
    const first = await createItem(root, { authors: ["Jiahe Huang"], year: "2024", added: "2026-11-10" }, source);
    const second = await createItem(root, { authors: ["Jiahe Huang"], year: "2024" }, source);
    expect(first).toMatchObject({
      key: "Huang2024Diffusion",
      title: "the diffusion model",
      status: "unread",
      collections: [],
    });
    expect(second.key).toBe("Huang2024Diffusiona");
    expect(first.pdfPath).toBe(join(first.dir, `${first.key}.pdf`));
    expect(await disk.readFile(first.pdfPath!)).toEqual(Buffer.from(smallPdf));
    expect(await disk.readFile(source)).toEqual(Buffer.from(smallPdf));
    expect(await disk.readFile(first.notePath, "utf8")).toContain(
      `pdf: "${first.key}.pdf"\nabstract:\n---\n${template}`,
    );
    expect((await disk.readdir(join(root, "条目"))).some((name) => name.startsWith("."))).toBe(false);
  });

  it("cleans up failed imports without publishing an incomplete item", async () => {
    const source = join(outside, "paper.pdf");
    await disk.writeFile(source, smallPdf);
    vi.mocked(fs.copyFile).mockRejectedValueOnce(new Error("read denied"));
    await expect(createItem(root, {}, source)).rejects.toThrow("library.writeFailed");
    expect(await disk.readdir(join(root, "条目"))).toEqual([]);
    expect(await disk.readFile(source)).toEqual(Buffer.from(smallPdf));
  });

  it.each(["../escape", "..\\escape", "C:\\escape", "CON", "LPT¹", "stream:other", "key.", ".hidden"])(
    "rejects unsafe item key %s before writing",
    async (key) => {
      await expect(updateItem(root, key, { title: "bad" })).rejects.toThrow("library.pathNotAllowed");
      expect(fs.open).not.toHaveBeenCalled();
    },
  );

  it("rejects unconfigured or unrelated roots before authorizing them", async () => {
    mocks.settings.literatureLibraryPath = "";
    await expect(loadLibrary(root)).rejects.toThrow("library.notConfigured");
    mocks.settings.literatureLibraryPath = root;
    await expect(loadLibrary(outside)).rejects.toThrow("library.pathNotAllowed");
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("rejects item, attachment, and manifest symlink escapes", async () => {
    await disk.mkdir(join(root, "条目"));
    await disk.writeFile(join(outside, "Linked.md"), "---\ntype: 文献\n---\nsecret");
    await disk.symlink(outside, join(root, "条目/Linked"), "dir");
    const snapshot = await loadLibrary(root);
    expect(snapshot.items).toEqual([]);
    expect(snapshot.errors[0].code).toBe("library.pathNotAllowed");
    await expect(updateItem(root, "Linked", { title: "escape" })).rejects.toThrow("library.pathNotAllowed");
    await item("Safe");
    await disk.symlink(join(outside, "Linked.md"), join(root, "条目/Safe/escape.pdf"));
    expect((await loadLibrary(root)).items[0].pdfPath).toBeUndefined();
    await disk.unlink(join(root, "文献库.litlib"));
    await disk.symlink(join(outside, "Linked.md"), join(root, "文献库.litlib"));
    await expect(loadLibrary(root)).rejects.toThrow("library.pathNotAllowed");
  });

  it("checks Windows drive and UNC roots without allowing siblings or alternate streams", async () => {
    for (const setting of ["C:\\Papers", "\\\\server\\share\\Papers"]) {
      mocks.settings.literatureLibraryPath = setting;
      mocks.invoke.mockImplementation(async (_command, { path }) => path);
      vi.mocked(fs.lstat).mockResolvedValue({ isDirectory: true, isSymlink: false } as Awaited<
        ReturnType<typeof fs.lstat>
      >);
      vi.mocked(fs.readDir).mockResolvedValue([
        { name: "文献库.litlib", isFile: true, isDirectory: false, isSymlink: false },
      ]);
      vi.mocked(fs.readFile).mockResolvedValue(new TextEncoder().encode('{"version":1,"collections":[]}'));
      vi.mocked(fs.exists).mockResolvedValue(false);
      expect((await loadLibrary(setting.toLowerCase())).items).toEqual([]);
      await expect(loadLibrary(`${setting}-other`)).rejects.toThrow("library.pathNotAllowed");
      await expect(updateItem(setting, "x:stream", {})).rejects.toThrow("library.pathNotAllowed");
    }
  });
});

describe("collections, queries and counts", () => {
  async function populated(): Promise<LibrarySnapshot> {
    await item("One", "doi: 10.1000/ABC\nyear: 2024\nvenue: Nature\n");
    await item("Two", "arxiv: '2406.17763'\nyear: 2023\n");
    await item("Trash");
    await updateItem(root, "One", {
      authors: ["Alice"],
      tags: ["ml", "pde"],
      collections: ["AI", "AI/PDE"],
      status: "reading",
      added: "2026-11-02",
    });
    await updateItem(root, "Two", { authors: ["Bob"], tags: ["ml"], status: "read", added: "2026-10-01" });
    await updateItem(root, "Trash", { trashed: true, collections: ["AI/PDE/Sub"], tags: ["ml"] });
    return loadLibrary(root);
  }

  it("renames/removes descendants in all items including trash, preserving notes and manifest extensions", async () => {
    await populated();
    const before = await disk.readFile(note("Trash"), "utf8");
    let snapshot = await renameCollection(root, "AI", "Learning");
    expect(snapshot.collections).toEqual(["Learning", "Learning/PDE", "Other", "Learning/PDE/Sub"]);
    expect(snapshot.items.find((entry) => entry.key === "Trash")?.collections).toEqual(["Learning/PDE/Sub"]);
    snapshot = await removeCollection(root, "Learning");
    expect(snapshot.collections).toEqual(["Other"]);
    expect(snapshot.items.every((entry) => entry.collections.length === 0)).toBe(true);
    expect((await disk.readFile(note("Trash"), "utf8")).split("---\n").at(-1)).toBe(before.split("---\n").at(-1));
    expect(JSON.parse(await disk.readFile(join(root, "文献库.litlib"), "utf8")).custom).toEqual({ keep: true });
    expect((await addCollection(root, "New/Child")).collections).toEqual(["Other", "New/Child", "New"]);
    expect(JSON.parse(await disk.readFile(join(root, "文献库.litlib"), "utf8"))).not.toHaveProperty(
      "zoteroCollections",
    );
    expect(await disk.readdir(join(root, "条目"))).toEqual(["One", "Trash", "Two"]);
  });

  it("renames and removes Zotero collection mappings with descendants but preserves sibling prefixes", async () => {
    const path = join(root, "文献库.litlib");
    const zoteroCollections = { COL00001: "AI", COL00002: "AI/PDE", COL00003: "AI/PDE/Sub", COL00004: "AI2" };
    await disk.writeFile(
      path,
      JSON.stringify({ version: 1, collections: Object.values(zoteroCollections), zoteroCollections, custom: "keep" }),
    );
    expect((await addCollection(root, "New")).zoteroCollections).toEqual(zoteroCollections);
    const renamed = { COL00001: "Learning", COL00002: "Learning/PDE", COL00003: "Learning/PDE/Sub", COL00004: "AI2" };
    expect((await renameCollection(root, "AI", "Learning")).zoteroCollections).toEqual(renamed);
    expect(JSON.parse(await disk.readFile(path, "utf8")).zoteroCollections).toEqual(renamed);
    expect((await removeCollection(root, "Learning")).zoteroCollections).toEqual({ COL00004: "AI2" });
    expect(JSON.parse(await disk.readFile(path, "utf8"))).toMatchObject({
      zoteroCollections: { COL00004: "AI2" },
      custom: "keep",
    });
    expect((await removeCollection(root, "AI2")).zoteroCollections).toEqual({});
    expect(JSON.parse(await disk.readFile(path, "utf8")).zoteroCollections).toEqual({});
  });

  it("refuses partial category changes when a malformed item is known in advance", async () => {
    await populated();
    await item("Bad");
    await disk.writeFile(note("Bad"), "---\ntitle: [\n---\nbody");
    const before = await disk.readFile(join(root, "文献库.litlib"));
    await expect(renameCollection(root, "AI", "New")).rejects.toThrow("library.itemsHaveErrors");
    expect(await disk.readFile(join(root, "文献库.litlib"))).toEqual(before);
    expect((await loadLibrary(root)).items.find((entry) => entry.key === "One")?.collections).toEqual(["AI", "AI/PDE"]);
  });

  it("rolls back earlier items when a category write fails, allowing a clean retry", async () => {
    await populated();
    const before = await disk.readFile(note("One"));
    mocks.beforeRename = async (_from, to) => {
      if (to === note("Trash")) throw new Error("disk full");
    };
    await expect(renameCollection(root, "AI", "Learning")).rejects.toThrow("library.writeFailed");
    expect(await disk.readFile(note("One"))).toEqual(before);
    expect((await loadLibrary(root)).collections).not.toContain("Learning");
    mocks.beforeRename = undefined;
    expect((await renameCollection(root, "AI", "Learning")).collections).not.toContain("AI");
  });

  it("reports partial progress when rollback would overwrite an external edit", async () => {
    await populated();
    const external = "---\ntype: 文献\ntitle: external\ncollections: [Learning]\n---\nexternal notes";
    mocks.beforeRename = async (_from, to) => {
      if (to === note("Trash")) {
        await disk.writeFile(note("One"), external);
        throw new Error("disk full");
      }
    };
    await expect(renameCollection(root, "AI", "Learning")).rejects.toThrow("library.partialWrite");
    expect(await disk.readFile(note("One"), "utf8")).toBe(external);
  });

  it("searches case-insensitively, intersects tags, filters descendants/status/trash and sorts all supported fields", async () => {
    const snapshot = await populated();
    for (const search of ["oNe", "ALICE", "nAtUrE", "PDE", "10.1000/abc"])
      expect(queryLibrary(snapshot, { search }).map((entry) => entry.key)).toEqual(["One"]);
    expect(queryLibrary(snapshot, { search: "2406.17763" }).map((entry) => entry.key)).toEqual(["Two"]);
    expect(
      queryLibrary(snapshot, { tags: ["ml", "pde"], collection: "AI", status: "reading" }).map((entry) => entry.key),
    ).toEqual(["One"]);
    expect(queryLibrary(snapshot, { unfiled: true }).map((entry) => entry.key)).toEqual(["Two"]);
    expect(queryLibrary(snapshot, { trashed: true }).map((entry) => entry.key)).toEqual(["Trash"]);
    expect(queryLibrary(snapshot, { trashed: "all" })).toHaveLength(3);
    for (const key of ["year", "added"] as const)
      expect(queryLibrary(snapshot, {}, { key, direction: "asc" }).map((entry) => entry.key)).toEqual(["Two", "One"]);
    for (const key of ["title", "authors", "status"] as const)
      expect(queryLibrary(snapshot, {}, { key, direction: "desc" }).map((entry) => entry.key)).toEqual(["Two", "One"]);
    expect(countLibrary(snapshot)).toEqual({
      byStatus: { unread: 0, toRead: 0, reading: 1, read: 1 },
      byCollection: { AI: 1, "AI/PDE": 1, Other: 0, "AI/PDE/Sub": 0 },
      byTag: { ml: 2, pde: 1 },
      unfiled: 1,
      trashed: 1,
      total: 2,
    });
  });
});

function Probe({ path }: { path: string | null }) {
  state = useLibrary(path);
  return null;
}
async function mount(path: string | null) {
  view ??= createRoot(document.createElement("div"));
  await act(async () => {
    view!.render(createElement(Probe, { path }));
  });
  await settle();
}
async function settle() {
  await vi.waitFor(async () => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(state.loading).toBe(false);
  });
}
const refreshed = async (action: () => Promise<void> | void) => {
  await act(async () => {
    await action();
  });
  await settle();
};

describe("useLibrary refresh when the user comes back", () => {
  it("rereads only items whose files changed; tracks additions, attachments, deletion and manifest edits", async () => {
    await item("One");
    await item("Two");
    await mount(root);
    expect(state.snapshot?.items).toHaveLength(2);
    expect(state.error).toBeNull();
    await updateItem(root, "One", { title: "external" });
    vi.mocked(fs.readFile).mockClear();
    await refreshed(() => state.refresh());
    expect(state.snapshot?.items.find((entry) => entry.key === "One")?.title).toBe("external");
    expect(noteReads()).toEqual([note("One")]);
    await item("Three", "", ["Three.zh.dual.pdf"]);
    await disk.rm(join(root, "条目/Two"), { recursive: true });
    await disk.writeFile(join(root, "文献库.litlib"), '{"version":1,"collections":["New"]}');
    await refreshed(() => state.refresh());
    expect(state.snapshot?.items.map((entry) => entry.key)).toEqual(["One", "Three"]);
    expect(state.snapshot?.collections).toEqual(["New"]);
    expect(state.snapshot?.items[1].translations.dual).toMatch(/Three.zh.dual.pdf$/);
  });

  it("does not reread anything when nothing changed, and reloadAll rereads everything", async () => {
    await item("One");
    await item("Two");
    await mount(root);
    vi.mocked(fs.readFile).mockClear();
    await refreshed(() => state.refresh());
    expect(noteReads()).toEqual([]);
    await refreshed(() => state.reloadAll());
    expect(noteReads()).toHaveLength(2);
  });

  it("shows what it already read when the tab is opened again, then picks up what changed meanwhile", async () => {
    await item("One");
    await item("Two");
    await mount(root);
    await act(async () => view!.unmount());
    await updateItem(root, "One", { title: "while away" });
    vi.mocked(fs.readFile).mockClear();
    view = createRoot(document.createElement("div"));
    act(() => view!.render(createElement(Probe, { path: root })));
    expect(state.loading).toBe(false);
    expect(state.snapshot?.items.map((entry) => entry.title)).toEqual(["One", "Two"]);
    expect(noteReads()).toEqual([]);
    await vi.waitFor(async () => {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
      expect(state.snapshot?.items[0].title).toBe("while away");
    });
    expect(state.loading).toBe(false);
    expect(noteReads()).toEqual([note("One")]);
  });

  it("checks again when the window regains focus, at most once every 1.5 seconds", async () => {
    await item("One");
    await mount(root);
    await updateItem(root, "One", { title: "focused" });
    await refreshed(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(state.snapshot?.items[0].title).toBe("focused");
    await updateItem(root, "One", { title: "too soon" });
    vi.mocked(fs.readFile).mockClear();
    await refreshed(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(noteReads()).toEqual([]);
  });

  it("stops listening when the library is closed", async () => {
    await item("One");
    await mount(root);
    await mount(null);
    expect(state.snapshot).toBeNull();
    vi.mocked(fs.readFile).mockClear();
    vi.mocked(fs.readDir).mockClear();
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(fs.readDir).not.toHaveBeenCalled();
    expect(noteReads()).toEqual([]);
  });
});

describe("createLibrary", () => {
  it("creates an empty library in a folder without a .litlib file and refuses a second one", async () => {
    await disk.rm(join(root, "文献库.litlib"));
    await expect(loadLibrary(root)).rejects.toThrow("library.manifestMissing");
    const snapshot = await createLibrary(root);
    expect(snapshot.collections).toEqual([]);
    expect(snapshot.items).toEqual([]);
    expect(JSON.parse(await disk.readFile(join(root, "文献库.litlib"), "utf8"))).toEqual({
      version: 1,
      collections: [],
    });
    await expect(createLibrary(root)).rejects.toThrow("library.manifestAmbiguous");
  });
});

it("supplies both locales for every stable error and the path setting", async () => {
  const source = await disk.readFile("app/src/core/research/Library.ts", "utf8");
  const codes = [...source.matchAll(/"(library\.[A-Za-z]+)"/g)].map((match) => match[1].split(".")[1]);
  for (const locale of ["zh_CN", "en"]) {
    const messages = parse(readFileSync(`app/src/locales/${locale}.yml`, "utf8"));
    expect(messages.settings.literatureLibraryPath.title).toBeTruthy();
    // 错误代码在 library.errors 下；untitled、noteTemplate 是新建条目用的文字，在 library 下
    for (const code of codes)
      expect(messages.research.library.errors[code] ?? messages.research.library[code], code).toBeTruthy();
  }
});
