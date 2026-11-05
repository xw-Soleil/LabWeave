import { LATEST_PROJECT_VERSION } from "@/core/ProjectFile";
import { fileKindOf, SIDECAR_JSON_SUFFIX, SIDECAR_MD_SUFFIX, type FileKind } from "@/core/research/ResearchShell";
import { Settings } from "@/core/service/Settings";
import { createDefaultMetadata } from "@/types/metadata";
import { encode } from "@msgpack/msgpack";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { exists, readDir, stat, writeFile } from "@tauri-apps/plugin-fs";
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import i18next from "i18next";
import { toast } from "sonner";
import { URI } from "vscode-uri";

export interface ResearchFileEntry {
  absPath: string;
  relPath: string;
  name: string;
  kind: FileKind | "workspace";
  size?: number;
  mtime?: number;
}

export interface ResearchFolderScan {
  entries: ResearchFileEntry[];
  /** 条目数到了上限，后面的没有列出来 */
  truncated: boolean;
  /** 读不了的子文件夹（相对路径），已跳过 */
  unreadableDirs: string[];
}

/** 扫描用到的文件系统操作，测试里可以换成假的 */
export interface ResearchFolderFs {
  readDir(path: string): Promise<{ name: string; isDirectory: boolean; isFile: boolean; isSymlink: boolean }[]>;
  stat(path: string): Promise<{ size: number; mtime: Date | null }>;
}

export const LIST_FILES_MAX_DEPTH = 6;
export const LIST_FILES_MAX_ENTRIES = 5000;

/** 研究文件夹里的文件有增减时发出（新建工作区、导入文件等），文件面板据此刷新 */
export const RESEARCH_FILES_CHANGED_EVENT = "research:files-changed";

export function notifyResearchFilesChanged() {
  window.dispatchEvent(new CustomEvent(RESEARCH_FILES_CHANGED_EVENT));
}

function t(key: string, options?: Record<string, unknown>) {
  return i18next.t(key, { ns: "research", ...options });
}

function toPosix(path: string): string {
  return path.replace(/\\/g, "/");
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || path.startsWith("\\") || /^[a-zA-Z]:[\\/]/.test(path);
}

/**
 * 盘符（"C:"）或 UNC 共享根（"//server/share"）这种自带根的首段。
 * Windows 上把研究文件夹选在网络共享或映射网络盘上时，Rust 端给回来的是 \\server\share\...
 */
function isRootSegment(segment: string | undefined): boolean {
  return segment !== undefined && (/^[a-zA-Z]:$/.test(segment) || segment.startsWith("//"));
}

function splitSegments(path: string): string[] {
  const posix = toPosix(path);
  const unc = /^\/\/([^/]+)(?:\/([^/]+))?/.exec(posix);
  const rootSegments = unc ? [unc[2] ? `//${unc[1]}/${unc[2]}` : `//${unc[1]}`] : [];
  const rest = unc ? posix.slice(unc[0].length) : posix;
  return [...rootSegments, ...rest.split("/").filter((segment) => segment !== "" && segment !== ".")];
}

function joinSegments(segments: string[], absolute: boolean): string {
  const joined = segments.join("/");
  // 盘符路径（C:/...）和 UNC 路径（//server/share/...）本身就是绝对路径，不需要再加前导 /
  if (absolute && !isRootSegment(segments[0])) return `/${joined}`;
  return joined;
}

// macOS 默认文件系统大小写不敏感，Finder 给的文件名可能是 NFD，比较前统一成 NFC 小写
function sameSegment(a: string, b: string): boolean {
  return a.normalize("NFC").toLowerCase() === b.normalize("NFC").toLowerCase();
}

function resolveSegments(segments: string[]): string[] {
  const resolved: string[] = [];
  for (const segment of segments) {
    if (segment === "..") {
      // 不能退到盘符或 UNC 共享根的外面
      if (resolved.length === 1 && isRootSegment(resolved[0])) continue;
      resolved.pop();
    } else {
      resolved.push(segment);
    }
  }
  return resolved;
}

function joinPath(dir: string, relPath: string): string {
  return `${dir.replace(/[\\/]+$/, "")}/${relPath}`;
}

function compareNames(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

/**
 * 文件面板里不显示、也不往里走的名字：
 * - 点开头的：.workbench、.DS_Store、iCloud 占位文件（.论文.pdf.icloud）、命令行写的临时文件（.名字.uuid.tmp）
 * - 备份文件、临时文件、Office 锁文件、AI 读的文字版
 */
export function isHiddenResearchName(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    name.startsWith(".") ||
    name.startsWith("~$") ||
    lower.includes("_backup") ||
    lower.endsWith(".tmp") ||
    lower.endsWith(".icloud") ||
    lower.endsWith(SIDECAR_JSON_SUFFIX) ||
    lower.endsWith(SIDECAR_MD_SUFFIX)
  );
}

function researchKindOf(name: string): ResearchFileEntry["kind"] | null {
  if (name.toLowerCase().endsWith(".prg")) return "workspace";
  return fileKindOf(name);
}

/**
 * 按层遍历研究文件夹，先列浅层的文件，这样条目太多被截断时丢的是深层文件。
 * 不跟随符号链接，防止绕出研究文件夹或者绕成环。
 */
export async function scanResearchFolder(
  root: string,
  fs: ResearchFolderFs = { readDir, stat },
): Promise<ResearchFolderScan> {
  const entries: ResearchFileEntry[] = [];
  const unreadableDirs: string[] = [];
  let truncated = false;
  let level: { relPath: string; children: Awaited<ReturnType<ResearchFolderFs["readDir"]>> }[] = [
    { relPath: "", children: await fs.readDir(root) },
  ];

  for (let depth = 0; level.length > 0; depth++) {
    const nextDirs: string[] = [];
    for (const dir of level) {
      const children = [...dir.children].sort((a, b) => compareNames(a.name, b.name));
      for (const child of children) {
        if (child.isSymlink || isHiddenResearchName(child.name)) continue;
        const relPath = dir.relPath ? `${dir.relPath}/${child.name}` : child.name;
        if (child.isDirectory) {
          if (depth < LIST_FILES_MAX_DEPTH) nextDirs.push(relPath);
          continue;
        }
        if (!child.isFile) continue;
        const kind = researchKindOf(child.name);
        if (!kind) continue;
        if (entries.length >= LIST_FILES_MAX_ENTRIES) {
          truncated = true;
          break;
        }
        entries.push({ absPath: joinPath(root, relPath), relPath, name: child.name, kind });
      }
      if (truncated) break;
    }
    if (truncated) break;

    const results = await Promise.allSettled(nextDirs.map((relPath) => fs.readDir(joinPath(root, relPath))));
    level = [];
    results.forEach((result, index) => {
      if (result.status === "fulfilled") {
        level.push({ relPath: nextDirs[index], children: result.value });
      } else {
        unreadableDirs.push(nextDirs[index]);
      }
    });
  }

  // 只给工作区取修改时间（数量少），用来把最近改过的排前面；论文、图片不逐个 stat
  const workspaces = entries.filter((entry) => entry.kind === "workspace");
  const stats = await Promise.allSettled(workspaces.map((entry) => fs.stat(entry.absPath)));
  stats.forEach((result, index) => {
    // 取不到修改时间（比如刚被删掉）只影响排序，这个条目照样列出来
    if (result.status !== "fulfilled") return;
    workspaces[index].size = result.value.size;
    workspaces[index].mtime = result.value.mtime?.getTime();
  });

  entries.sort((a, b) => {
    if (a.kind === "workspace" && b.kind === "workspace" && (a.mtime ?? 0) !== (b.mtime ?? 0)) {
      return (b.mtime ?? 0) - (a.mtime ?? 0);
    }
    return compareNames(a.relPath, b.relPath);
  });
  return { entries, truncated, unreadableDirs };
}

export type WorkspaceNameCheck =
  | { ok: true; name: string }
  | { ok: false; reason: "empty" | "invalidChars" | "hidden" };

/** 和「在当前目录新建文件」的规则一致，另外不能取会被文件面板隐藏的名字 */
export function checkWorkspaceName(input: string): WorkspaceNameCheck {
  let name = input.trim();
  if (name.toLowerCase().endsWith(".prg")) name = name.slice(0, -4).trim();
  if (name === "") return { ok: false, reason: "empty" };
  if (/[\\/:*?"<>|]/.test(name)) return { ok: false, reason: "invalidChars" };
  if (isHiddenResearchName(`${name}.prg`)) return { ok: false, reason: "hidden" };
  return { ok: true, name };
}

/** 空白工作区文件，格式和 Project.getFileContent 写出来的一致，带最新版本号，打开时不会弹升级提示 */
export async function createEmptyProjectFile(): Promise<Uint8Array> {
  const uwriter = new Uint8ArrayWriter();
  const writer = new ZipWriter(uwriter, { level: 0 });
  await writer.add("stage.msgpack", new Uint8ArrayReader(encode([])), { level: 0 });
  await writer.add("tags.msgpack", new Uint8ArrayReader(encode([])), { level: 0 });
  await writer.add("reference.msgpack", new Uint8ArrayReader(encode({ sections: {}, files: [] })), { level: 0 });
  // 一建好就带上稳定的工作区 id，AI 对话记录从第一次打开起就按 id 存，不会在第一次保存后换 key
  const metadata = {
    ...createDefaultMetadata(LATEST_PROJECT_VERSION),
    workbench: { id: crypto.randomUUID(), createdAt: Date.now() },
  };
  await writer.add("metadata.msgpack", new Uint8ArrayReader(encode(metadata)), { level: 0 });
  await writer.close();
  return await uwriter.getData();
}

let registeredRoot: { root: string; promise: Promise<string> } | null = null;

export const ResearchFolder = {
  /** 研究文件夹的绝对路径，没选过时是 "" */
  getRoot(): string {
    return Settings.researchFolderPath;
  },

  /** 弹窗选文件夹，存进设置并调用 Rust 的 set_research_root；用户取消或设置失败（已弹提示）时返回 null */
  async chooseRoot(): Promise<string | null> {
    const picked = await open({
      directory: true,
      multiple: false,
      title: t("files.chooseFolderDialogTitle"),
      defaultPath: ResearchFolder.getRoot() || undefined,
    });
    if (typeof picked !== "string") return null;
    let canonical: string;
    try {
      canonical = await invoke<string>("set_research_root", { path: picked });
    } catch (error) {
      toast.error(t("files.setRootFailed", { error: String(error) }));
      return null;
    }
    registeredRoot = { root: canonical, promise: Promise.resolve(canonical) };
    Settings.researchFolderPath = canonical;
    notifyResearchFilesChanged();
    return canonical;
  },

  /**
   * 把设置里的研究文件夹登记给 Rust（加进 fs 插件的允许范围）。每次启动后第一次读文件夹前要做一次，
   * 同一个路径只登记一次；失败会抛出，下次再试。
   */
  async ensureRootRegistered(): Promise<void> {
    const root = ResearchFolder.getRoot();
    if (!root) return;
    let entry = registeredRoot;
    if (entry?.root !== root) {
      const promise = invoke<string>("set_research_root", { path: root });
      const current = { root, promise };
      entry = registeredRoot = current;
      promise.then(
        (canonical) => {
          if (registeredRoot !== current || canonical === root) return;
          registeredRoot = { root: canonical, promise };
          Settings.researchFolderPath = canonical;
        },
        // 错误由下面的 await 抛给调用方，这里只是让下次调用重新登记
        () => {
          if (registeredRoot === current) registeredRoot = null;
        },
      );
    }
    await entry.promise;
  },

  isInside(absPath: string): boolean {
    const root = ResearchFolder.getRoot();
    if (!root || !isAbsolutePath(absPath)) return false;
    const rootSegments = resolveSegments(splitSegments(root));
    const pathSegments = resolveSegments(splitSegments(absPath));
    if (pathSegments.length < rootSegments.length) return false;
    return rootSegments.every((segment, index) => sameSegment(segment, pathSegments[index]));
  },

  /** 返回 POSIX 分隔符的相对路径，必要时带 ../；baseDir 默认是研究文件夹 */
  toRelative(absPath: string, baseDir: string = ResearchFolder.getRoot()): string {
    const fromSegments = resolveSegments(splitSegments(baseDir));
    const toSegments = resolveSegments(splitSegments(absPath));
    let common = 0;
    while (
      common < fromSegments.length &&
      common < toSegments.length &&
      sameSegment(fromSegments[common], toSegments[common])
    ) {
      common++;
    }
    // 不同盘符、不同网络共享之间没有相对路径
    if (common === 0 && (isRootSegment(fromSegments[0]) || isRootSegment(toSegments[0]))) {
      return joinSegments(toSegments, isAbsolutePath(absPath));
    }
    const ups = fromSegments.slice(common).map(() => "..");
    return [...ups, ...toSegments.slice(common)].join("/");
  },

  /** relPath 已经是绝对路径时原样返回（只统一分隔符） */
  toAbsolute(relPath: string, baseDir: string = ResearchFolder.getRoot()): string {
    if (isAbsolutePath(relPath)) {
      return joinSegments(resolveSegments(splitSegments(relPath)), true);
    }
    const segments = resolveSegments([...splitSegments(baseDir), ...splitSegments(relPath)]);
    return joinSegments(segments, isAbsolutePath(baseDir));
  },

  /** 列出研究文件夹里的文件，同时告诉调用方有没有被截断、哪些子文件夹读不了；没选文件夹时返回空列表 */
  async scan(): Promise<ResearchFolderScan> {
    const root = ResearchFolder.getRoot();
    if (!root) return { entries: [], truncated: false, unreadableDirs: [] };
    await ResearchFolder.ensureRootRegistered();
    return await scanResearchFolder(ResearchFolder.getRoot());
  },

  /** 跳过点开头的、符号链接、.workbench、*_backup*、临时文件；深度 ≤6，最多 5000 条 */
  async listFiles(): Promise<ResearchFileEntry[]> {
    return (await ResearchFolder.scan()).entries;
  },

  /**
   * 在研究文件夹里建一个空的 .prg 并打开，返回绝对路径。
   * 名字不合法、没选研究文件夹、文件已存在时弹提示，不覆盖任何文件，返回 ""。
   */
  async createWorkspace(name: string): Promise<string> {
    const root = ResearchFolder.getRoot();
    if (!root) {
      toast.error(t("files.noRoot"));
      return "";
    }
    const check = checkWorkspaceName(name);
    if (!check.ok) {
      toast.error(t(`files.workspaceName.${check.reason}`));
      return "";
    }
    await ResearchFolder.ensureRootRegistered();
    const absPath = joinPath(ResearchFolder.getRoot(), `${check.name}.prg`);
    if (await exists(absPath)) {
      toast.error(t("files.workspaceName.exists", { name: check.name }));
      return "";
    }
    // createNew：万一在检查之后有同名文件冒出来，写入会失败而不是覆盖它
    await writeFile(absPath, await createEmptyProjectFile(), { createNew: true });
    notifyResearchFilesChanged();
    // 动态 import：GlobalMenu 自己也引用了这个模块
    const { closeEmptyDrafts, onOpenFile } = await import("@/core/service/GlobalMenu");
    const project = await onOpenFile(URI.file(absPath), "科研工作台-新建工作区");
    if (project) await closeEmptyDrafts(project);
    return absPath;
  },
};

/** 选过研究文件夹时，文件夹外的本地文件一律不打开 */
export function isOutsideResearchFolder(absPath: string): boolean {
  return ResearchFolder.getRoot() !== "" && !ResearchFolder.isInside(absPath);
}
