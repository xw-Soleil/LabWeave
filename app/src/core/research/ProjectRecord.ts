import type { ResearchSidecar } from "./AiSidecarBuilder";

/*
 * 项目记录在盘上的样子，以及怎么读：活动记录的一行、卡片和批注记下来的样子、快照的清单。
 *
 * 这里不碰界面和桌面端的接口：给 AI 的工具在命令行里（外部 AI 走 MCP、程序没开时）也要读这些文件。
 * 往里写的那一半在 ActivityLog.ts 和 Snapshot.ts。
 */

export const ACTIVITY_LOG_FILE = ".workbench/活动记录.jsonl";
export const ACTIVITY_STATE_FILE = ".workbench/活动记录.状态.json";
export const TITLE_CHARS = 80;
export const TEXT_CHARS = 300;

export const ACTIVITY_KINDS = [
  "card.add",
  "card.edit",
  "card.delete",
  "excerpt.send",
  "annotation.add",
  "annotation.edit",
  "annotation.delete",
  "note.save",
  "library.add",
  "mark",
  "snapshot",
  "summary",
] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

/** 指向哪里。路径相对项目文件夹；文献库里的文件用 library，相对文献库 */
export type ActivityWhere = Record<string, string | number>;

/** 活动记录里的一行 */
export interface ActivityEntry {
  /** 时间，带时区 */
  at: string;
  /** 项目文件夹的名字 */
  project: string;
  kind: ActivityKind;
  where: ActivityWhere;
  title: string;
  text?: string;
  more?: Record<string, unknown>;
}

/** 一张卡片、一条批注记下来的样子；f 是内容的指纹，用来看它变没变 */
export interface ActivityItem {
  f: string;
  title: string;
  text: string;
  more?: Record<string, unknown>;
  /** 卡片是从 PDF 发上来的摘录时：摘自哪个文件、哪一页、哪条批注 */
  source?: ActivityWhere;
  /** 批注自带的时间 */
  created?: string;
  modified?: string;
  page?: number;
}
export type ActivityItems = Record<string, ActivityItem>;

/** 「上次记到哪」：每块白板（按相对路径）、每个 PDF 上次记下的样子，每篇笔记上次的指纹 */
export interface ActivityState {
  v: 1;
  boards: Record<string, ActivityItems>;
  annotations: Record<string, ActivityItems>;
  notes: Record<string, { f: string; chars: number }>;
}

export function fingerprint(parts: unknown): string {
  const text = JSON.stringify(parts);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  // 带上长度：只有 32 位的指纹，多一道保险
  return `${(hash >>> 0).toString(16).padStart(8, "0")}${text.length.toString(36)}`;
}

export const clip = (text: string, length: number) => (text.length > length ? `${text.slice(0, length)}…` : text);

/** 本地时间，带时区：2026-11-15T10:32:08+08:00 */
export function localTime(date: Date): string {
  const pad = (value: number) => String(Math.trunc(Math.abs(value))).padStart(2, "0");
  const offset = -date.getTimezoneOffset();
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${offset < 0 ? "-" : "+"}${pad(offset / 60)}:${pad(offset % 60)}`
  );
}

/**
 * 白板文字版里的卡片（分组框也算），按编号列出来。活动记录和快照对比都用它，「改没改」是同一个标准：
 * 只看内容，位置、大小、颜色、在哪个分组里都不算进指纹，挪一挪不算改。
 */
export function sidecarItems(json: ResearchSidecar): ActivityItems {
  const items: ActivityItems = {};
  for (const card of json.cards) {
    items[card.id] = {
      f: fingerprint([card.type, card.title, card.text, card.notes, card.file?.path ?? "", card.url ?? ""]),
      title: clip(card.title, TITLE_CHARS),
      text: clip(card.text, TEXT_CHARS),
      more: { type: card.type, ...(card.notes && { notes: clip(card.notes, TEXT_CHARS) }) },
    };
  }
  for (const section of json.sections) {
    items[section.id] = {
      f: fingerprint(["Section", section.title, section.notes]),
      title: clip(section.title, TITLE_CHARS),
      text: clip(section.notes, TEXT_CHARS),
      more: { type: "Section" },
    };
  }
  return items;
}

/**
 * 两次之间多了、改了、少了哪些。
 * 剪切再粘贴会给卡片换一个新编号：少掉的和多出来的内容一样，就当成同一张，两边都不算。
 */
export function diffItems(
  before: ActivityItems,
  after: ActivityItems,
): { added: string[]; edited: string[]; removed: string[] } {
  const added = Object.keys(after).filter((id) => !(id in before));
  const edited = Object.keys(after).filter((id) => id in before && before[id].f !== after[id].f);
  const removed: string[] = [];
  for (const id of Object.keys(before)) {
    if (id in after) continue;
    const same = added.findIndex((candidate) => after[candidate].f === before[id].f);
    if (same < 0) removed.push(id);
    else added.splice(same, 1);
  }
  return { added, edited, removed };
}

export const SNAPSHOT_DIR = ".workbench/快照";
export const SNAPSHOT_IMAGE_DIR = "图片";
export const SNAPSHOT_MANIFEST = "清单.json";

/** manual：以前状态条上的相机按钮拍的，现在没有了，旧的照样读；auto：超过 7 天自动拍的；node：定格一个节点时拍的；summary：加节点信息之前做阶段小结时拍的 */
export type SnapshotReason = "manual" | "auto" | "summary" | "node";

/** 节点的类型：组会、周报、自己复盘 */
export const NODE_TYPES = ["meeting", "weekly", "review"] as const;
export type NodeType = (typeof NODE_TYPES)[number];

/** 节点：一次阶段小结定格下来的那一刻。之后的对比都和它比，直到下一个节点 */
export interface SnapshotNode {
  type: NodeType;
  /** 显示用的名字，例如「2026-11-21 组会」 */
  title: string;
  /** 这个节点是和哪份快照比的；它前面一份快照都没有时不写 */
  since?: string;
  /** 用户敲的原话 */
  note?: string;
  /** 要讲的和不讲的：卡片编号，或者论文、笔记相对项目文件夹的路径 */
  picked?: string[];
  dropped?: string[];
}

export interface SnapshotBoard {
  /** 白板文件，相对项目文件夹 */
  file: string;
  cards: number;
  sections: number;
  edges: number;
  /** 这块白板里的图片附件：附件编号 → 快照/图片/ 里的文件名 */
  images: Record<string, string>;
}

export interface SnapshotManifest {
  v: 1;
  at: string;
  reason: SnapshotReason;
  project: string;
  /** 只有定格出来的快照有 */
  node?: SnapshotNode;
  boards: SnapshotBoard[];
}

export interface Snapshot {
  /** 快照文件夹的名字，也是它的编号 */
  name: string;
  manifest: SnapshotManifest;
}

/** 读记录用的文件接口。桌面端和命令行各有一套实现 */
export interface RecordReader {
  /** 文件不存在时给 undefined */
  read(path: string): Promise<Uint8Array | undefined>;
  /** 文件夹里的子文件夹名；文件夹不存在时给空 */
  folders(path: string): Promise<string[]>;
  /** 文件夹里的文件名；文件夹不存在时给空 */
  files(path: string): Promise<string[]>;
}

/** 项目文件夹下面的一个路径。统一用 / 分隔，Windows 上也认 */
export const under = (root: string, ...parts: string[]) =>
  [root.replace(/[\\/]+$/, ""), ...parts].join("/").replace(/\\/g, "/");

export const snapshotSidecarFile = (boardFile: string) => `${boardFile.replace(/\.prg$/i, "")}.ai.json`;

export function decodeJson<T>(bytes: Uint8Array | undefined): T | undefined {
  if (!bytes) return undefined;
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    // 写到一半断电留下的半个文件：和没有一样
    return undefined;
  }
}

/** 项目里的快照，最新的在前。没有清单的文件夹是拍到一半的，不算数 */
export async function listSnapshots(
  io: Pick<RecordReader, "read" | "folders">,
  root: string,
  limit = Infinity,
): Promise<Snapshot[]> {
  const names = (await io.folders(under(root, SNAPSHOT_DIR))).filter((name) => name !== SNAPSHOT_IMAGE_DIR);
  const read = async (name: string): Promise<Snapshot[]> => {
    const manifest = decodeJson<SnapshotManifest>(await io.read(under(root, SNAPSHOT_DIR, name, SNAPSHOT_MANIFEST)));
    return manifest?.v === 1 && Array.isArray(manifest.boards) ? [{ name, manifest }] : [];
  };
  names.sort().reverse();
  if (limit === Infinity) return (await Promise.all(names.map(read))).flat();
  const snapshots: Snapshot[] = [];
  for (const name of names) {
    if (snapshots.length >= limit) break;
    snapshots.push(...(await read(name)));
  }
  return snapshots;
}

/** 这份快照是不是一个节点。加节点信息之前做阶段小结时拍的也算 */
export const isNode = ({ manifest }: Snapshot) => !!manifest.node || manifest.reason === "summary";

/** 同一天、同一种类型定格的几份算同一个节点 */
const nodeKey = ({ manifest }: Snapshot) => `${manifest.at.slice(0, 10)} ${manifest.node?.type ?? "meeting"}`;

/**
 * 现在该和哪份快照比（「自上次小结以来」的基准）：最近的节点；一个节点都没有时用最早的那份快照。
 * snapshots 最新的在前，下面几个函数都一样。
 */
export function baselineOf(snapshots: readonly Snapshot[]): Snapshot | undefined {
  return snapshots.find(isNode) ?? snapshots.at(-1);
}

/** 一个节点当初是和哪份快照比的。清单里没记的（加节点信息之前拍的）按它前面的快照现算 */
export function sinceOf(snapshots: readonly Snapshot[], node: Snapshot): string | undefined {
  if (node.manifest.node) return node.manifest.node.since;
  const older = snapshots.slice(snapshots.findIndex((snapshot) => snapshot.name === node.name) + 1);
  return baselineOf(older)?.name;
}

/**
 * 在 at 这一刻定格一个节点，它该和哪份快照比。
 * 同一天已经定格过同一种类型的：算同一个节点，照抄那一次的基准，重新定格不推基准；否则和 baselineOf 一样。
 */
export function nodeSince(snapshots: readonly Snapshot[], type: NodeType, at: string): string | undefined {
  const again = nodeOnDay(snapshots, type, at);
  return again ? sinceOf(snapshots, again) : baselineOf(snapshots)?.name;
}

/** at 那一天已经定格过的同一种类型的节点（有几份时是最后一份）；没有给 undefined */
export function nodeOnDay(snapshots: readonly Snapshot[], type: NodeType, at: string): Snapshot | undefined {
  const key = `${at.slice(0, 10)} ${type}`;
  return snapshots.find((snapshot) => isNode(snapshot) && nodeKey(snapshot) === key);
}

/** 被同一天同类型的后一次定格顶替掉的节点：它的名字 → 顶替它的那份的名字 */
export function replacedNodes(snapshots: readonly Snapshot[]): Map<string, string> {
  const latest = new Map<string, string>();
  const replaced = new Map<string, string>();
  for (const snapshot of snapshots) {
    if (!isNode(snapshot)) continue;
    const newer = latest.get(nodeKey(snapshot));
    if (newer) replaced.set(snapshot.name, newer);
    else latest.set(nodeKey(snapshot), snapshot.name);
  }
  return replaced;
}

/** 某份快照里某块白板的文字版；那份快照里没有这块白板时给 undefined */
export async function readSnapshotBoard(
  io: Pick<RecordReader, "read">,
  root: string,
  name: string,
  file: string,
): Promise<ResearchSidecar | undefined> {
  return decodeJson<ResearchSidecar>(
    await io.read(under(root, SNAPSHOT_DIR, name, snapshotSidecarFile(file.replace(/\\/g, "/")))),
  );
}
