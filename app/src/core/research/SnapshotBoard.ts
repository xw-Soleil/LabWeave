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
 * 回看历史要用到的几样：项目有哪些节点、一个节点当初是和谁比的、把快照里的一块白板拼回完整的白板文件。
 * 只读文件，不碰界面；打开成白板在 LookbackBoard.ts。
 */

const pathKey = (path: string) => path.replace(/\\/g, "/").normalize("NFC").toLowerCase();

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

/**
 * 把一份快照里的一块白板拼回完整的白板文件（图片装回去）。那份快照里没有这块白板给 undefined；
 * 白板文件或者某张图片找不到了抛 snapshot.boardMissing / snapshot.imageMissing。
 * join 是 Snapshot.ts 的 joinBoard，由调用方给，这个文件不用带上打包那一套。
 */
export async function snapshotBoardFile(
  io: Pick<RecordReader, "read">,
  root: string,
  snapshot: Snapshot,
  file: string,
  join: (
    stripped: Uint8Array,
    refs: Record<string, string>,
    image: (name: string) => Promise<Uint8Array | undefined>,
  ) => Promise<Uint8Array>,
): Promise<Uint8Array | undefined> {
  const board = boardInSnapshot(snapshot, file);
  if (!board) return undefined;
  const stripped = await io.read(under(root, SNAPSHOT_DIR, snapshot.name, board.file));
  if (!stripped) throw new Error("snapshot.boardMissing");
  return join(stripped, board.images ?? {}, (name) => io.read(under(root, SNAPSHOT_DIR, SNAPSHOT_IMAGE_DIR, name)));
}
