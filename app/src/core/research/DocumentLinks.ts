import { Settings } from "@/core/service/Settings";
import { lstat, readDir } from "@tauri-apps/plugin-fs";
import { documentKey, documentPath } from "./DocumentFile";
import { authorizeLibrary } from "./Library";
import { isHiddenResearchName, ResearchFolder } from "./ResearchFolder";
import { activeResearchWorkspace, authorizeResearchProject, loadResearchWorkspace } from "./ResearchWorkspace";

export interface ResolvedDocumentLink {
  path: string;
  heading?: string;
}

function inside(path: string, root: string) {
  return (
    ResearchFolder.isInside(path, root) && documentKey(path).startsWith(`${documentKey(root).replace(/\/$/, "")}/`)
  );
}

async function documentScope(path: string): Promise<{ root: string; path: string } | undefined> {
  const current = ResearchFolder.getRoot();
  const roots = activeResearchWorkspace(await loadResearchWorkspace()).projects.map((project) => project.path);
  if (current && !roots.includes(current)) roots.push(current);
  const library = Settings.literatureLibraryPath;
  const projectRoot = roots.filter((root) => inside(path, root)).sort((a, b) => b.length - a.length)[0];
  // The library can be registered through a path alias while its open documents use the canonical path.
  const libraryRoot = library && (!projectRoot || inside(path, library)) ? await authorizeLibrary(library) : undefined;
  if (libraryRoot) roots.push(library, libraryRoot);
  const root = roots.filter((root) => inside(path, root)).sort((a, b) => b.length - a.length)[0];
  if (!root) return;
  let canonical: string;
  if (root === library || root === libraryRoot) canonical = libraryRoot!;
  else if (root === current) {
    await ResearchFolder.ensureRootRegistered();
    canonical = ResearchFolder.getRoot();
  } else canonical = await authorizeResearchProject(root);
  return {
    root: documentPath(canonical),
    path: documentPath(ResearchFolder.toAbsolute(ResearchFolder.toRelative(path, root), canonical)),
  };
}

/** Share directory reads within one preview; a fresh resolver rechecks the disk when a link is clicked. */
export function createDocumentLinkResolver(document: string): (target: string) => Promise<ResolvedDocumentLink | null> {
  const path = documentPath(document);
  let scopeTask: ReturnType<typeof documentScope> | undefined;
  const directories = new Map<string, ReturnType<typeof readDir>>();

  async function checked(root: string, target: string) {
    if (!inside(target, root) && documentKey(target) !== documentKey(root)) throw new Error("noteNotFound");
    let current = root;
    const parts = ResearchFolder.toRelative(target, root).split("/").filter(Boolean);
    for (const part of ["", ...parts]) {
      if (part) current = ResearchFolder.toAbsolute(part, current);
      if ((await lstat(current)).isSymlink) throw new Error("noteNotFound");
    }
  }

  function entries(root: string, directory: string) {
    let pending = directories.get(documentKey(directory));
    if (!pending) {
      pending = checked(root, directory).then(() => readDir(directory));
      directories.set(documentKey(directory), pending);
    }
    return pending;
  }

  async function findFile(root: string, candidate: string): Promise<string | null> {
    if (!inside(candidate, root)) return null;
    const parts = ResearchFolder.toRelative(candidate, root).split("/");
    let directory = root;
    for (const [index, part] of parts.entries()) {
      const child = (await entries(root, directory)).find(
        (entry) => documentKey(`${directory}/${entry.name}`) === documentKey(`${directory}/${part}`),
      );
      if (!child || child.isSymlink || isHiddenResearchName(child.name)) return null;
      directory = ResearchFolder.toAbsolute(child.name, directory);
      if (index === parts.length - 1) {
        if (!child.isFile) return null;
        await checked(root, directory);
        return directory;
      }
      if (!child.isDirectory) return null;
    }
    return null;
  }

  return async (target) => {
    const hash = target.indexOf("#");
    const name = (hash < 0 ? target : target.slice(0, hash)).trim().replace(/\\/g, "/");
    const heading = hash < 0 ? undefined : target.slice(hash + 1).trim();
    // Never interpret URLs, absolute paths, device names or alternate streams as note names.
    if (
      name.startsWith("/") ||
      // eslint-disable-next-line no-control-regex -- Reject filesystem control characters from Markdown input.
      /[:*?"<>|\u0000-\u001f\u007f]/.test(name) ||
      name.split("/").some((part) => /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part))
    )
      return null;
    try {
      const scope = await (scopeTask ??= documentScope(path));
      if (!scope || !inside(scope.path, scope.root)) return null;
      const { root, path: sourcePath } = scope;
      await checked(root, sourcePath);
      if (!name) return heading ? { path: sourcePath, heading } : null;
      const filename = /\.[^/.]+$/.test(name) ? name : `${name}.md`;
      const folder = sourcePath.slice(0, sourcePath.lastIndexOf("/"));
      const local = ResearchFolder.toAbsolute(filename, folder);
      if (!inside(local, root)) return null;
      let found = await findFile(root, local);
      if (!found && !name.startsWith(".")) found = await findFile(root, ResearchFolder.toAbsolute(filename, root));
      if (!found && !name.startsWith(".")) {
        const suffix = documentKey(ResearchFolder.toAbsolute(filename, root)).slice(
          documentKey(root).replace(/\/$/, "").length,
        );
        const queue = [root];
        // 超大项目里只翻前几千个文件夹，找不到就当没有，免得一个坏链接卡住预览
        for (let index = 0; index < queue.length && index < 3000 && !found; index++) {
          const directory = queue[index];
          const children = (await entries(root, directory)).slice().sort((a, b) => a.name.localeCompare(b.name));
          for (const child of children) {
            if (child.isSymlink || isHiddenResearchName(child.name)) continue;
            const childPath = ResearchFolder.toAbsolute(child.name, directory);
            if (child.isDirectory) queue.push(childPath);
            else if (child.isFile && documentKey(childPath).endsWith(suffix)) {
              await checked(root, childPath);
              found = childPath;
              break;
            }
          }
        }
      }
      return found ? { path: documentPath(found), ...(heading ? { heading } : {}) } : null;
    } catch (cause) {
      if (cause instanceof Error && cause.message === "noteNotFound") return null;
      throw new Error("linkReadFailed", { cause });
    }
  };
}
