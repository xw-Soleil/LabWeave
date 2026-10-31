import { afterEach, describe, expect, it, vi } from "vitest";

const settings = vi.hoisted(() => ({ researchFolderPath: "/Users/me/Research" }));
vi.mock("@/core/service/Settings", () => ({ Settings: settings }));

import { LATEST_PROJECT_VERSION, parseProjectFile } from "@/core/ProjectFile";
import { readWorkbenchMetadata } from "@/types/metadata";
import { Decoder } from "@msgpack/msgpack";
import {
  checkWorkspaceName,
  createEmptyProjectFile,
  isHiddenResearchName,
  isOutsideResearchFolder,
  LIST_FILES_MAX_DEPTH,
  LIST_FILES_MAX_ENTRIES,
  scanResearchFolder,
  type ResearchFolderFs,
} from "./ResearchFolder";

type FakeNode = { [name: string]: FakeNode | "file" | "symlink" | { mtime: number } };

/** 用嵌套对象模拟目录树；字符串 "unreadable" 作为目录名后缀时读取会失败 */
function fakeFs(tree: FakeNode, root = "/r"): ResearchFolderFs & { readDirCalls: string[] } {
  const readDirCalls: string[] = [];
  const lookup = (path: string): FakeNode | "file" | "symlink" | { mtime: number } | undefined => {
    const rel = path.slice(root.length).split("/").filter(Boolean);
    let node: FakeNode | "file" | "symlink" | { mtime: number } | undefined = tree;
    for (const segment of rel) {
      if (typeof node !== "object" || node === null || "mtime" in node) return undefined;
      node = (node as FakeNode)[segment];
    }
    return node;
  };
  return {
    readDirCalls,
    async readDir(path) {
      readDirCalls.push(path);
      if (path.endsWith("unreadable")) throw new Error("permission denied");
      const node = lookup(path);
      if (typeof node !== "object" || "mtime" in node) throw new Error(`not a directory: ${path}`);
      return Object.entries(node).map(([name, child]) => ({
        name,
        isDirectory: typeof child === "object" && !("mtime" in child),
        isFile: child === "file" || (typeof child === "object" && "mtime" in child),
        isSymlink: child === "symlink",
      }));
    },
    async stat(path) {
      const node = lookup(path);
      if (typeof node === "object" && "mtime" in node) return { size: 1, mtime: new Date(node.mtime as number) };
      throw new Error(`no stat: ${path}`);
    },
  };
}

describe("isHiddenResearchName", () => {
  it("hides dot entries, backups, temp files, iCloud placeholders and sidecars", () => {
    for (const name of [
      ".workbench",
      ".DS_Store",
      ".paper.pdf.icloud",
      ".a.1234.tmp",
      "draft_backup_20260101.prg",
      "x.tmp",
      "~$notes.md",
      "综述.ai.json",
      "综述.ai.md",
    ]) {
      expect(isHiddenResearchName(name), name).toBe(true);
    }
    for (const name of ["paper.pdf", "综述.prg", "notes.md", "figure.PNG"]) {
      expect(isHiddenResearchName(name), name).toBe(false);
    }
  });
});

describe("scanResearchFolder", () => {
  it("classifies files, skips hidden entries and symlinks, and lists shallow files first", async () => {
    const fs = fakeFs({
      "b.prg": { mtime: 1 },
      "a.prg": { mtime: 2 },
      "paper.pdf": "file",
      "Fig.JPG": "file",
      "notes.md": "file",
      "data.csv": "file",
      "link.pdf": "symlink",
      linkedDir: "symlink",
      ".workbench": { "a.ai.json": "file", "a.ai.md": "file" },
      "a_backup_1.prg": "file",
      sub: { "deep.pdf": "file", ".hidden.pdf": "file" },
    });
    const { entries, truncated, unreadableDirs } = await scanResearchFolder("/r", fs);
    expect(truncated).toBe(false);
    expect(unreadableDirs).toEqual([]);
    expect(entries.map((entry) => [entry.relPath, entry.kind])).toEqual([
      ["a.prg", "workspace"],
      ["b.prg", "workspace"],
      ["Fig.JPG", "image"],
      ["notes.md", "markdown"],
      ["paper.pdf", "pdf"],
      ["sub/deep.pdf", "pdf"],
    ]);
    expect(entries.find((entry) => entry.relPath === "sub/deep.pdf")?.absPath).toBe("/r/sub/deep.pdf");
    expect(entries.find((entry) => entry.relPath === "a.prg")?.mtime).toBe(2);
    expect(fs.readDirCalls).not.toContain("/r/.workbench");
    expect(fs.readDirCalls).not.toContain("/r/linkedDir");
  });

  it("stops descending below the depth limit", async () => {
    let tree: FakeNode = { "bottom.pdf": "file" };
    for (let i = 0; i < LIST_FILES_MAX_DEPTH + 2; i++) tree = { [`d${i}`]: tree, [`level${i}.pdf`]: "file" };
    const { entries } = await scanResearchFolder("/r", fakeFs(tree));
    const depths = entries.map((entry) => entry.relPath.split("/").length - 1);
    expect(Math.max(...depths)).toBe(LIST_FILES_MAX_DEPTH);
    expect(entries.some((entry) => entry.name === "bottom.pdf")).toBe(false);
  });

  it("caps the number of entries", async () => {
    const tree: FakeNode = {};
    for (let i = 0; i < LIST_FILES_MAX_ENTRIES + 10; i++) tree[`p${i}.pdf`] = "file";
    const { entries, truncated } = await scanResearchFolder("/r", fakeFs(tree));
    expect(entries).toHaveLength(LIST_FILES_MAX_ENTRIES);
    expect(truncated).toBe(true);
  });

  it("skips unreadable subfolders but reports them", async () => {
    const { entries, unreadableDirs } = await scanResearchFolder(
      "/r",
      fakeFs({ "a.pdf": "file", unreadable: { "b.pdf": "file" } }),
    );
    expect(entries.map((entry) => entry.relPath)).toEqual(["a.pdf"]);
    expect(unreadableDirs).toEqual(["unreadable"]);
  });

  it("throws when the root itself cannot be read", async () => {
    await expect(scanResearchFolder("/r/unreadable", fakeFs({}, "/r/unreadable"))).rejects.toThrow("permission denied");
  });
});

describe("checkWorkspaceName", () => {
  it("trims, strips .prg and rejects bad names", () => {
    expect(checkWorkspaceName("  综述 ")).toEqual({ ok: true, name: "综述" });
    expect(checkWorkspaceName("实验.prg")).toEqual({ ok: true, name: "实验" });
    expect(checkWorkspaceName("   ")).toEqual({ ok: false, reason: "empty" });
    expect(checkWorkspaceName(".prg")).toEqual({ ok: false, reason: "empty" });
    expect(checkWorkspaceName("a/b")).toEqual({ ok: false, reason: "invalidChars" });
    expect(checkWorkspaceName('a"b')).toEqual({ ok: false, reason: "invalidChars" });
    expect(checkWorkspaceName(".secret")).toEqual({ ok: false, reason: "hidden" });
    expect(checkWorkspaceName("old_backup")).toEqual({ ok: false, reason: "hidden" });
  });
});

describe("createEmptyProjectFile", () => {
  it("produces an empty project at the latest version", async () => {
    const parsed = await parseProjectFile(await createEmptyProjectFile(), new Decoder(), new Map());
    expect(parsed.serializedStageObjects).toEqual([]);
    expect(parsed.tags).toEqual([]);
    expect(parsed.references).toEqual({ sections: {}, files: [] });
    expect(parsed.metadata.version).toBe(LATEST_PROJECT_VERSION);
    expect(readWorkbenchMetadata(parsed.metadata)?.id).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("isOutsideResearchFolder", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    settings.researchFolderPath = "/Users/me/Research";
  });

  it("only blocks paths outside a chosen folder in research mode", () => {
    expect(isOutsideResearchFolder("/Users/me/Research/a.prg")).toBe(false);
    expect(isOutsideResearchFolder("/Users/me/Other/a.prg")).toBe(true);

    settings.researchFolderPath = "";
    expect(isOutsideResearchFolder("/Users/me/Other/a.prg")).toBe(false);

    settings.researchFolderPath = "/Users/me/Research";
    vi.stubEnv("LR_RESEARCH_SHELL", "false");
    expect(isOutsideResearchFolder("/Users/me/Other/a.prg")).toBe(false);
  });
});
