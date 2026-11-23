import { parseProjectFile } from "@/core/ProjectFile";
import { Settings } from "@/core/service/Settings";
import { Decoder } from "@msgpack/msgpack";
import { exists, mkdir, readDir, readFile, writeFile } from "@tauri-apps/plugin-fs";
import { Uint8ArrayReader, Uint8ArrayWriter, ZipReader, ZipWriter } from "@zip.js/zip.js";
import i18next from "i18next";
import { toast } from "sonner";
import { noteSnapshot, trackedBoards } from "./ActivityLog";
import { buildAiSidecar, type ResearchSidecar } from "./AiSidecarBuilder";
import { documentKey } from "./DocumentFile";
import {
  SNAPSHOT_DIR,
  SNAPSHOT_IMAGE_DIR,
  SNAPSHOT_MANIFEST,
  baselineOf,
  listSnapshots,
  localTime,
  nodeSince,
  readSnapshotBoard,
  snapshotSidecarFile,
  under,
  type NodeType,
  type Snapshot,
  type SnapshotManifest,
  type SnapshotNode,
  type SnapshotReason,
} from "./ProjectRecord";
import { ResearchFolder } from "./ResearchFolder";
import { contentHash } from "./SnapshotBoard";

/*
 * 快照：把项目里每块白板当时的样子留一份，放在 项目/.workbench/快照/ 下面。
 *
 *   快照/2026-11-21 1030/清单.json        什么时候拍、为什么拍、有哪几块白板、每个图片附件对应哪个图片文件
 *   快照/2026-11-21 1030/测试白板.prg      白板文件，拿掉了图片和缩略图
 *   快照/2026-11-21 1030/测试白板.ai.json  这块白板的文字版，对比和给 AI 读都用它
 *   快照/图片/<内容指纹>.png               所有快照共用，同一张图只有一份
 *
 * 图片按内容算指纹，不按附件编号：粘贴一次图片就换一个附件编号，内容还是那张图。
 * 清单最后写：没有清单的文件夹是拍到一半的，不算数。
 *
 * 定格一个节点（做阶段小结）时拍的那份，清单里多一段节点信息：类型、名字、和哪份快照比的、用户的原话和勾选。
 * 画布上的对比永远和上一个节点比；自动拍的、手动拍的只是留底，不当基准。
 */

// 快照的格式和读的那一半在 ProjectRecord.ts（命令行里也要用，不能带着这里的界面和桌面端接口）
export {
  NODE_TYPES,
  SNAPSHOT_DIR,
  isNode,
  listSnapshots,
  readSnapshotBoard,
  type NodeType,
  type Snapshot,
  type SnapshotBoard,
  type SnapshotManifest,
  type SnapshotNode,
  type SnapshotReason,
} from "./ProjectRecord";

/** 定格时交进来的节点信息。和哪份快照比由程序定，不用给 */
export type NodeInput = Omit<SnapshotNode, "since">;

/** 超过这么久没拍，打开项目时自动拍一份 */
export const SNAPSHOT_DUE_MS = 7 * 24 * 60 * 60 * 1000;
const CHECK_DELAY_MS = 20 * 1000;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

export interface SnapshotIO {
  /** 文件不存在时给 undefined */
  read(path: string): Promise<Uint8Array | undefined>;
  /** 上级文件夹不在就先建 */
  write(path: string, bytes: Uint8Array): Promise<void>;
  exists(path: string): Promise<boolean>;
  /** 文件夹里的子文件夹名；文件夹不存在时给空 */
  folders(path: string): Promise<string[]>;
}

const posix = (path: string) => path.replace(/\\/g, "/");
const snapshotPath = (root: string, ...parts: string[]) => under(root, SNAPSHOT_DIR, ...parts);

/** 把一个白板文件拆开：拿掉图片和缩略图的白板文件，加上按内容指纹命名的图片 */
export async function splitBoard(content: Uint8Array): Promise<{
  stripped: Uint8Array;
  images: Map<string, Uint8Array>;
  refs: Record<string, string>;
}> {
  const reader = new ZipReader(new Uint8ArrayReader(content));
  const output = new Uint8ArrayWriter();
  const writer = new ZipWriter(output, { level: 0 });
  const images = new Map<string, Uint8Array>();
  const refs: Record<string, string> = {};
  try {
    for (const entry of await reader.getEntries()) {
      // 缩略图能重新生成，不留
      if (entry.directory || entry.filename === "thumbnail.png") continue;
      const bytes = await entry.getData!(new Uint8ArrayWriter());
      // 和读白板文件时认附件的规则一样（parseProjectFile）；名字不合规范的原样留在白板文件里
      const attachment = /^attachments\/([a-zA-Z0-9-]+)\.([a-zA-Z0-9]+)$/.exec(entry.filename.trim());
      if (!attachment) {
        await writer.add(entry.filename, new Uint8ArrayReader(bytes), { level: 0 });
        continue;
      }
      const name = `${await contentHash(bytes)}.${attachment[2].toLowerCase()}`;
      images.set(name, bytes);
      refs[attachment[1]] = name;
    }
  } finally {
    await reader.close();
    await writer.close();
  }
  return { stripped: await output.getData(), images, refs };
}

async function boardSidecar(content: Uint8Array, path: string, root: string): Promise<ResearchSidecar> {
  const parsed = await parseProjectFile(content, new Decoder(), new Map());
  return buildAiSidecar({
    serializedStage: parsed.serializedStageObjects,
    tags: parsed.tags,
    metadata: parsed.metadata,
    readme: parsed.readme,
    workspaceFile: path,
    researchRoot: root,
  }).json;
}

/** 两份文字版内容一样不一样。存盘时间每次都不同，不算 */
const sameBoard = (a: ResearchSidecar, b: ResearchSidecar) =>
  JSON.stringify({ ...a, workspace: { ...a.workspace, savedAt: "" } }) ===
  JSON.stringify({ ...b, workspace: { ...b.workspace, savedAt: "" } });

/**
 * 拍一份快照。boards 是项目里每块白板这一刻的完整文件内容。
 * unlessSameAs：和这份快照比，每块白板都没变就不拍，返回 undefined（自动拍时用）。
 * unlessEmpty：所有白板上一张卡片都没有就不拍（项目的第一份自动快照用）。
 * node：这一份是定格一个节点，把节点信息连同「和哪份快照比」一起写进清单。
 */
export async function writeSnapshot(
  io: SnapshotIO,
  root: string,
  reason: SnapshotReason,
  boards: readonly { file: string; content: Uint8Array }[],
  options: { now?: Date; unlessSameAs?: Snapshot; unlessEmpty?: boolean; node?: NodeInput } = {},
): Promise<Snapshot | undefined> {
  if (boards.length === 0) return undefined;
  const prepared = [];
  for (const board of boards) {
    const file = posix(board.file);
    const split = await splitBoard(board.content);
    const sidecar = await boardSidecar(split.stripped, ResearchFolder.toAbsolute(file, root), root);
    prepared.push({ file, ...split, sidecar });
  }
  if (options.unlessEmpty && prepared.every(({ sidecar }) => sidecar.cards.length + sidecar.sections.length === 0)) {
    return undefined;
  }
  const previous = options.unlessSameAs;
  if (previous && previous.manifest.boards.length === prepared.length) {
    let same = true;
    for (const board of prepared) {
      const before = await readSnapshotBoard(io, root, previous.name, board.file);
      if (!before || !sameBoard(before, board.sidecar)) {
        same = false;
        break;
      }
    }
    if (same) return undefined;
  }

  const now = options.now ?? new Date();
  const at = localTime(now);
  // 文件夹名用「日期 时分」：2026-11-21 1030；一分钟里拍了两份的，后一份加序号
  const stamp = `${at.slice(0, 10)} ${at.slice(11, 13)}${at.slice(14, 16)}`;
  let name = stamp;
  for (let n = 2; await io.exists(snapshotPath(root, name)); n++) name = `${stamp}-${n}`;

  let node: SnapshotNode | undefined;
  if (options.node) {
    const { type, title, note, picked, dropped } = options.node;
    const since = nodeSince(await listSnapshots(io, root), type, at);
    node = {
      type,
      title,
      ...(since && { since }),
      ...(note?.trim() && { note: note.trim() }),
      ...(picked?.length && { picked }),
      ...(dropped?.length && { dropped }),
    };
  }
  const manifest: SnapshotManifest = {
    v: 1,
    at,
    reason,
    project: posix(root).split("/").pop() ?? "",
    ...(node && { node }),
    boards: [],
  };
  for (const board of prepared) {
    for (const [image, bytes] of board.images) {
      const path = snapshotPath(root, SNAPSHOT_IMAGE_DIR, image);
      if (!(await io.exists(path))) await io.write(path, bytes);
    }
    await io.write(snapshotPath(root, name, board.file), board.stripped);
    await io.write(
      snapshotPath(root, name, snapshotSidecarFile(board.file)),
      new TextEncoder().encode(JSON.stringify(board.sidecar, null, 2)),
    );
    manifest.boards.push({
      file: board.file,
      cards: board.sidecar.cards.length,
      sections: board.sidecar.sections.length,
      edges: board.sidecar.edges.length,
      images: board.refs,
    });
  }
  await io.write(
    snapshotPath(root, name, SNAPSHOT_MANIFEST),
    new TextEncoder().encode(JSON.stringify(manifest, null, 2)),
  );
  return { name, manifest };
}

// —— 下面是和程序接起来的部分 ——

export const snapshotFiles: SnapshotIO = {
  read: async (path) => ((await exists(path)) ? await readFile(path) : undefined),
  write: async (path, bytes) => {
    const folder = posix(path).slice(0, posix(path).lastIndexOf("/"));
    if (!(await exists(folder))) await mkdir(folder, { recursive: true });
    await writeFile(path, bytes);
  },
  exists,
  folders: async (path) =>
    (await exists(path)) ? (await readDir(path)).filter((entry) => entry.isDirectory).map((entry) => entry.name) : [],
};

/** 项目里每块白板这一刻的内容：开着的用当前内容（哪怕还没存），没开的读文件 */
async function collectBoards(root: string): Promise<{ file: string; content: Uint8Array }[]> {
  const open = new Map(trackedBoards().map((project) => [documentKey(project.uri.fsPath), project]));
  const boards = [];
  for (const entry of await ResearchFolder.listFiles()) {
    if (entry.kind !== "workspace") continue;
    const project = open.get(documentKey(entry.absPath));
    boards.push({
      file: ResearchFolder.toRelative(entry.absPath, root),
      content: project ? await project.getFileContent({ includeThumbnail: false }) : await readFile(entry.absPath),
    });
  }
  return boards;
}

const listeners = new Set<(snapshot: Snapshot) => void>();
/** 拍了新快照时叫一声（画布上的「自上次以来」要换成和新的比） */
export function onSnapshotTaken(listener: (snapshot: Snapshot) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

let taking: Promise<Snapshot | undefined> | undefined;

/** 等正在拍的快照写完再退出，避免留下写到一半的快照文件夹 */
export async function finishPendingSnapshots(): Promise<void> {
  while (taking) {
    await taking.catch(() => undefined);
  }
}

/**
 * 给当前项目拍一份快照。同一时间只拍一份，正在拍时再调拿到的是同一份。
 * unlessUnchanged：和最近一份比没变化就不拍；项目里一张卡片都没有时也不拍第一份。
 * node：定格一个节点，见 takeNode。
 * 没选项目抛 snapshot.noProject，项目里没有白板抛 snapshot.noBoard。
 */
export function takeSnapshot(
  reason: SnapshotReason,
  options: { unlessUnchanged?: boolean; node?: NodeInput } = {},
): Promise<Snapshot | undefined> {
  // 正在拍的那一份不带这次的节点信息，不能拿它顶替：等它拍完再拍
  if (options.node && taking) {
    const again = () => takeSnapshot(reason, options);
    return taking.then(again, again);
  }
  taking ??= (async () => {
    const root = ResearchFolder.getRoot();
    if (!root) throw new Error("snapshot.noProject");
    await ResearchFolder.ensureRootRegistered();
    const boards = await collectBoards(root);
    if (boards.length === 0) throw new Error("snapshot.noBoard");
    const latest = options.unlessUnchanged ? (await listSnapshots(snapshotFiles, root, 1))[0] : undefined;
    const snapshot = await writeSnapshot(snapshotFiles, root, reason, boards, {
      unlessSameAs: latest,
      unlessEmpty: options.unlessUnchanged && !latest,
      node: options.node,
    });
    if (snapshot) {
      noteSnapshot(root, snapshot.name, {
        reason,
        boards: snapshot.manifest.boards.length,
        cards: snapshot.manifest.boards.reduce((sum, board) => sum + board.cards, 0),
        ...(snapshot.manifest.node && { node: snapshot.manifest.node.title }),
      });
      for (const listener of listeners) listener(snapshot);
    }
    return snapshot;
  })().finally(() => {
    taking = undefined;
  });
  return taking;
}

/** 节点显示用的名字：2026-11-21 组会 */
export const nodeTitle = (type: NodeType, now = new Date()) =>
  `${localTime(now).slice(0, 10)} ${i18next.t(`stageNode.types.${type}`, { ns: "research" })}`;

/** 定格一个节点：拍一份带节点信息的快照。之后画布上的对比就和它比 */
export const takeNode = (node: NodeInput) => takeSnapshot("node", { node });

/** 当前项目现在该和哪份快照比：上一个节点；一个节点都没有时是最早的那份快照 */
export async function currentBaseline(): Promise<Snapshot | undefined> {
  const root = ResearchFolder.getRoot();
  if (!root) return undefined;
  await ResearchFolder.ensureRootRegistered();
  return baselineOf(await listSnapshots(snapshotFiles, root));
}

/** 当前项目最近的一份快照 */
export async function latestSnapshot(): Promise<Snapshot | undefined> {
  const root = ResearchFolder.getRoot();
  if (!root) return undefined;
  await ResearchFolder.ensureRootRegistered();
  return (await listSnapshots(snapshotFiles, root, 1))[0];
}

/** 超过 7 天没拍（或者从来没拍过），而且白板有变化，就自动拍一份 */
export async function snapshotIfDue(now = new Date()): Promise<Snapshot | undefined> {
  const root = ResearchFolder.getRoot();
  if (!root) return undefined;
  const latest = await latestSnapshot();
  if (latest && now.getTime() - Date.parse(latest.manifest.at) < SNAPSHOT_DUE_MS) return undefined;
  if (!(await ResearchFolder.listFiles()).some((entry) => entry.kind === "workspace")) return undefined;
  return takeSnapshot("auto", { unlessUnchanged: true });
}

/**
 * 程序启动时调一次：过一会儿查一次要不要自动拍，之后每 6 小时、每次换项目后再查。
 * 拍不成只提示，不打断别的事。返回的函数用来停掉。
 */
export function startSnapshotSchedule(): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const check = () =>
    void snapshotIfDue().catch((error) =>
      toast.warning(
        i18next.t("snapshot.failed", {
          ns: "research",
          error: error instanceof Error ? error.message : String(error),
          interpolation: { escapeValue: false },
        }),
        { id: "research-snapshot-failed" },
      ),
    );
  // 等启动和换项目的那一阵忙完再查
  const soon = () => {
    clearTimeout(timer);
    timer = setTimeout(check, CHECK_DELAY_MS);
  };
  soon();
  const interval = setInterval(check, CHECK_EVERY_MS);
  const unwatch = Settings.watch("researchFolderPath", soon);
  return () => {
    clearTimeout(timer);
    clearInterval(interval);
    unwatch();
  };
}
