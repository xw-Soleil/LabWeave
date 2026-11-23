import mime from "mime";
import {
  baselineOf,
  isNode,
  replacedNodes,
  sinceOf,
  SNAPSHOT_DIR,
  SNAPSHOT_IMAGE_DIR,
  under,
  type RecordReader,
  type Snapshot,
} from "./ProjectRecord";

/*
 * 回看历史要用到的几样：项目有哪些节点、一个节点当初是和谁比的、把快照里的一块白板连同图片读出来。
 * 只读文件，不碰界面；打开成白板在 LookbackBoard.ts。
 */

const pathKey = (path: string) => path.replace(/\\/g, "/").normalize("NFC").toLowerCase();

/** 内容指纹：快照里的图片按它命名 */
export async function contentHash(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * 这个项目的节点，最早的在前。同一天同一种类型定格过几次的只算最后一次。
 * snapshots 最新的在前（listSnapshots 给的顺序）。
 */
export function nodesOf(snapshots: readonly Snapshot[]): Snapshot[] {
  const replaced = replacedNodes(snapshots);
  return snapshots.filter((snapshot) => isNode(snapshot) && !replaced.has(snapshot.name)).reverse();
}

/**
 * 一个节点当初是和哪份快照比的：节点里记着的那一份；它已经不在了（文件夹被删）就退回再往前的节点。
 * 前面什么都没有（项目的第一份快照）给 undefined，这时那个节点上的卡片都算新加的。
 */
export function previousOf(snapshots: readonly Snapshot[], node: Snapshot): Snapshot | undefined {
  const since = sinceOf(snapshots, node);
  // 同一天同一种类型更早定格的那几份是这个节点自己，不能拿来当「前一个」
  const replaced = replacedNodes(snapshots);
  const older = snapshots
    .slice(snapshots.findIndex((snapshot) => snapshot.name === node.name) + 1)
    .filter((snapshot) => replaced.get(snapshot.name) !== node.name);
  return older.find((snapshot) => snapshot.name === since) ?? (since ? baselineOf(older) : undefined);
}

/** 快照里这块白板记在清单的哪一条；那时候还没有这块白板给 undefined。file 相对项目文件夹 */
export function boardInSnapshot(snapshot: Snapshot, file: string) {
  return snapshot.manifest.boards.find((board) => pathKey(board.file) === pathKey(file));
}

/** 快照里的一块白板：拿掉了图片的白板文件，和它用到的图片（附件编号 → 图片） */
export interface SnapshotBoardContent {
  stripped: Uint8Array;
  images: Map<string, Blob>;
}

/**
 * 读出一份快照里的一块白板。那份快照里没有这块白板给 undefined；
 * 白板文件或者某张图片找不到了抛 snapshot.boardMissing / snapshot.imageMissing。
 *
 * have：手边开着的白板里同一个附件编号的图片。绝大多数没变过，指纹对得上就直接用，不再读文件；
 * 附件面板里能给旧编号换上新内容，所以指纹要真的算一遍。
 */
export async function readSnapshotBoardContent(
  io: Pick<RecordReader, "read">,
  root: string,
  snapshot: Snapshot,
  file: string,
  have: (attachmentId: string) => Blob | undefined = () => undefined,
): Promise<SnapshotBoardContent | undefined> {
  const board = boardInSnapshot(snapshot, file);
  if (!board) return undefined;
  const reading = new Map<string, Promise<Blob>>();
  const image = async (id: string, name: string): Promise<Blob> => {
    const kept = have(id);
    if (kept && (await contentHash(new Uint8Array(await kept.arrayBuffer()))) === name.split(".")[0]) return kept;
    let blob = reading.get(name);
    if (!blob) {
      blob = io.read(under(root, SNAPSHOT_DIR, SNAPSHOT_IMAGE_DIR, name)).then((bytes) => {
        if (!bytes) throw new Error("snapshot.imageMissing");
        return new Blob([bytes as Uint8Array<ArrayBuffer>], {
          type: mime.getType(name) ?? "application/octet-stream",
        });
      });
      reading.set(name, blob);
    }
    return blob;
  };
  const [stripped, images] = await Promise.all([
    io.read(under(root, SNAPSHOT_DIR, snapshot.name, board.file)),
    Promise.all(Object.entries(board.images ?? {}).map(async ([id, name]) => [id, await image(id, name)] as const)),
  ]);
  if (!stripped) throw new Error("snapshot.boardMissing");
  return { stripped, images: new Map(images) };
}
