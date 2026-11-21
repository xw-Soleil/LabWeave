import { describe, expect, it, vi } from "vitest";
import type { Snapshot, SnapshotManifest } from "./ProjectRecord";
import { boardInSnapshot, nodesOf, previousOf, snapshotBoardFile } from "./SnapshotBoard";

const root = "/research/课题";
const board = (file: string, images: Record<string, string> = {}) => ({
  file,
  cards: 1,
  sections: 0,
  edges: 0,
  images,
});

/** name 是「2026-11-14 1000」这样的文件夹名；more 里给 reason、node、boards */
function snapshot(name: string, more: Partial<SnapshotManifest> = {}): Snapshot {
  const [day, time] = name.split(" ");
  return {
    name,
    manifest: {
      v: 1,
      at: `${day}T${time.slice(0, 2)}:${time.slice(2, 4)}:00+08:00`,
      reason: more.node ? "node" : "auto",
      project: "课题",
      boards: [board("白板.prg")],
      ...more,
    },
  };
}
const meeting = (name: string, since?: string, type: "meeting" | "weekly" = "meeting") =>
  snapshot(name, { node: { type, title: `${name.slice(0, 10)} ${type}`, ...(since && { since }) } });
/** listSnapshots 给的顺序：最新的在前 */
const newestFirst = (...snapshots: Snapshot[]) =>
  snapshots.toSorted((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));

describe("the nodes of a project", () => {
  const all = newestFirst(
    snapshot("2026-11-01 0900"),
    snapshot("2026-11-07 1000", { reason: "summary" }),
    snapshot("2026-11-10 1200"),
    meeting("2026-11-14 1000", "2026-11-07 1000"),
    meeting("2026-11-21 0900", "2026-11-14 1000"),
    meeting("2026-11-21 1500", "2026-11-14 1000"),
    meeting("2026-11-21 1600", "2026-11-14 1000", "weekly"),
    snapshot("2026-11-22 0800", { reason: "manual" }),
  );

  it("lists them oldest first: frozen ones and old summaries, not automatic or camera snapshots", () => {
    // 同一天同一种类型定格了两次，只算后一次；同一天另一种类型的是另一个节点
    expect(nodesOf(all).map(({ name }) => name)).toEqual([
      "2026-11-07 1000",
      "2026-11-14 1000",
      "2026-11-21 1500",
      "2026-11-21 1600",
    ]);
    expect(nodesOf([])).toEqual([]);
  });

  it("finds what a node was compared with when it was frozen", () => {
    const named = (name: string) => all.find((candidate) => candidate.name === name)!;
    expect(previousOf(all, named("2026-11-21 1500"))?.name).toBe("2026-11-14 1000");
    expect(previousOf(all, named("2026-11-14 1000"))?.name).toBe("2026-11-07 1000");
    // 加节点信息之前做的小结没记和谁比：按它前面的快照算，前面没有节点就是最早的那一份
    expect(previousOf(all, named("2026-11-07 1000"))?.name).toBe("2026-11-01 0900");
  });

  it("falls back to an earlier node when the recorded one was deleted, and to nothing for the very first", () => {
    const pruned = all.filter(({ name }) => name !== "2026-11-14 1000");
    const node = pruned.find(({ name }) => name === "2026-11-21 1500")!;
    expect(previousOf(pruned, node)?.name).toBe("2026-11-07 1000");
    const first = meeting("2026-11-01 0900");
    expect(previousOf([first], first)).toBeUndefined();
  });
});

describe("a board inside a snapshot", () => {
  const node = snapshot("2026-11-14 1000", {
    boards: [board("白板.prg", { att1: "abc.png", att2: "def.webp" }), board("子文件夹/另一块.prg")],
  });

  it("is found by its path, whichever way the slashes or the case go", () => {
    expect(boardInSnapshot(node, "子文件夹\\另一块.PRG")?.file).toBe("子文件夹/另一块.prg");
    expect(boardInSnapshot(node, "后来才建的.prg")).toBeUndefined();
  });

  it("is put back together from the stripped file and the shared images", async () => {
    const disk = new Map<string, Uint8Array>([
      [`${root}/.workbench/快照/2026-11-14 1000/白板.prg`, new Uint8Array([1, 2, 3])],
      [`${root}/.workbench/快照/图片/abc.png`, new Uint8Array([9])],
    ]);
    const io = { read: async (path: string) => disk.get(path) };
    const join = vi.fn(async (stripped: Uint8Array, refs: Record<string, string>, image) => {
      expect(await image("abc.png")).toEqual(new Uint8Array([9]));
      expect(await image("def.webp")).toBeUndefined();
      return new Uint8Array([...stripped, Object.keys(refs).length]);
    });
    expect(await snapshotBoardFile(io, root, node, "白板.prg", join)).toEqual(new Uint8Array([1, 2, 3, 2]));
    expect(join.mock.calls[0][1]).toEqual({ att1: "abc.png", att2: "def.webp" });

    // 那时候还没有这块白板：不是错，只是没有
    expect(await snapshotBoardFile(io, root, node, "后来才建的.prg", join)).toBeUndefined();
    // 清单里有、文件却不在了
    await expect(snapshotBoardFile(io, root, node, "子文件夹/另一块.prg", join)).rejects.toThrow(
      "snapshot.boardMissing",
    );
  });
});
