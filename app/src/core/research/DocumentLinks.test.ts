import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  settings: { researchFolderPath: "/project", literatureLibraryPath: "" },
  projects: ["/project", "/other"],
  readDir: vi.fn(),
  lstat: vi.fn(),
  invoke: vi.fn(),
  authorizeLibrary: vi.fn(),
}));
vi.mock("@/core/service/Settings", () => ({ Settings: mocks.settings }));
vi.mock("@tauri-apps/plugin-fs", () => ({ readDir: mocks.readDir, lstat: mocks.lstat }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("./Library", () => ({ authorizeLibrary: mocks.authorizeLibrary }));
vi.mock("./ResearchWorkspace", () => ({
  loadResearchWorkspace: async () => ({}),
  activeResearchWorkspace: () => ({ projects: mocks.projects.map((path) => ({ path })) }),
  authorizeResearchProject: async (path: string) => path,
}));
import { documentKey, documentPath } from "./DocumentFile";
import { createDocumentLinkResolver } from "./DocumentLinks";

const files = new Map<string, { path: string; isDirectory: boolean; isFile: boolean; isSymlink: boolean }>();
function add(path: string, directory = false, symlink = false) {
  path = documentPath(path);
  files.set(documentKey(path), { path, isDirectory: directory, isFile: !directory, isSymlink: symlink });
}
beforeEach(() => {
  vi.clearAllMocks();
  files.clear();
  mocks.settings.researchFolderPath = "/project";
  mocks.settings.literatureLibraryPath = "";
  mocks.projects = ["/project", "/other"];
  mocks.invoke.mockImplementation(async (_command, { path }) => path);
  mocks.authorizeLibrary.mockImplementation(async (path) => path);
  mocks.lstat.mockImplementation(async (path: string) => {
    const entry = files.get(documentKey(path));
    if (!entry) throw new Error(`missing: ${path}`);
    return entry;
  });
  mocks.readDir.mockImplementation(async (path: string) =>
    [...files.values()]
      .filter((entry) => documentKey(entry.path.slice(0, entry.path.lastIndexOf("/"))) === documentKey(path))
      .map((entry) => ({ ...entry, name: entry.path.split("/").at(-1)! })),
  );
  add("/project", true);
  add("/project/notes", true);
  add("/project/notes/source.md");
  add("/project/assets", true);
  add("/other", true);
  add("/other/private.md");
});

describe("document wikilink resolution", () => {
  it("prefers siblings, then project-root paths, then filenames anywhere in the same project", async () => {
    add("/project/notes/paper.md");
    add("/project/paper.md");
    add("/project/assets/paper.md");
    const resolve = createDocumentLinkResolver("/project/notes/source.md");
    expect(await resolve("paper#Methods")).toEqual({ path: "/project/notes/paper.md", heading: "Methods" });
    expect(await resolve("assets/paper")).toEqual({ path: "/project/assets/paper.md" });
    add("/project/assets/figure.png");
    expect(await createDocumentLinkResolver("/project/notes/source.md")("figure.png")).toEqual({
      path: "/project/assets/figure.png",
    });
    files.delete("/project/notes/paper.md");
    expect(await createDocumentLinkResolver("/project/notes/source.md")("paper")).toEqual({
      path: "/project/paper.md",
    });
    expect(await resolve("#Results")).toEqual({ path: "/project/notes/source.md", heading: "Results" });
  });

  it("shares directory scans across links, but a new resolver sees added files", async () => {
    const resolve = createDocumentLinkResolver("/project/notes/source.md");
    expect(await Promise.all([resolve("missing"), resolve("also missing")])).toEqual([null, null]);
    const reads = mocks.readDir.mock.calls.map(([path]) => path);
    expect(new Set(reads).size).toBe(reads.length);
    add("/project/notes/missing.md");
    expect(await createDocumentLinkResolver("/project/notes/source.md")("missing")).toEqual({
      path: "/project/notes/missing.md",
    });
  });

  it("does not search other projects, hidden folders, symlinks or paths outside the document root", async () => {
    add("/project/link", true, true);
    add("/project/link/private.md");
    add("/project/.hidden", true);
    add("/project/.hidden/secret.md");
    const resolve = createDocumentLinkResolver("/project/notes/source.md");
    for (const name of [
      "private",
      "secret",
      "link/private",
      "../../other/private",
      "/other/private.md",
      "C:\\private.md",
      "https://host/a.png",
      "file:///a.md",
      "CON",
      "a.md:stream",
    ]) {
      expect(await resolve(name), name).toBeNull();
    }
    expect(mocks.readDir.mock.calls.map(([path]) => path)).not.toContain("/other");
    expect(mocks.readDir.mock.calls.map(([path]) => path)).not.toContain("/project/link");
  });

  it("checks both the source and target path components again for symlinks", async () => {
    add("/project/assets/paper.md");
    mocks.lstat.mockImplementation(async (path: string) => ({
      ...files.get(documentKey(path)),
      isSymlink: path === "/project/assets",
    }));
    expect(await createDocumentLinkResolver("/project/notes/source.md")("paper")).toBeNull();
    mocks.lstat.mockImplementation(async (path: string) => ({
      ...files.get(documentKey(path)),
      isSymlink: path === "/project/notes",
    }));
    expect(await createDocumentLinkResolver("/project/notes/source.md")("#Heading")).toBeNull();
  });

  it("limits library documents to the configured library, including its canonical alias", async () => {
    mocks.settings.literatureLibraryPath = "/library-alias";
    mocks.authorizeLibrary.mockResolvedValue("/library");
    add("/library", true);
    add("/library/source.md");
    add("/library/cited.md");
    const resolve = createDocumentLinkResolver("/library/source.md");
    expect(await resolve("cited")).toEqual({ path: "/library/cited.md" });
    expect(await createDocumentLinkResolver("/library-alias/source.md")("cited")).toEqual({
      path: "/library/cited.md",
    });
    expect(await resolve("private")).toBeNull();
    expect(mocks.authorizeLibrary).toHaveBeenCalledWith("/library-alias");
  });

  it("does not let a disconnected unrelated library break project links", async () => {
    mocks.settings.literatureLibraryPath = "/library";
    mocks.authorizeLibrary.mockRejectedValue(new Error("unavailable"));
    expect(await createDocumentLinkResolver("/project/notes/source.md")("#Heading")).toMatchObject({
      heading: "Heading",
    });
    expect(mocks.authorizeLibrary).not.toHaveBeenCalled();
  });

  it.each(["C:/Papers", "//server/share/Papers"])("handles Windows and UNC roots: %s", async (root) => {
    mocks.settings.researchFolderPath = "";
    mocks.projects = [root];
    add(root, true);
    add(`${root}/notes`, true);
    add(`${root}/assets`, true);
    add(`${root}/notes/source.md`);
    add(`${root}/assets/PAPER.md`);
    expect(await createDocumentLinkResolver(`${root}/notes/source.md`.replaceAll("/", "\\"))("paper")).toEqual({
      path: documentPath(`${root}/assets/PAPER.md`),
    });
  });

  it("never authorizes a standalone document's parent and surfaces disk read errors", async () => {
    expect(await createDocumentLinkResolver("/standalone/source.md")("paper")).toBeNull();
    mocks.readDir.mockRejectedValue(new Error("permission denied"));
    await expect(createDocumentLinkResolver("/project/notes/source.md")("paper")).rejects.toThrow("linkReadFailed");
  });
});
