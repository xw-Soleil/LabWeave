import { beforeEach, describe, expect, it, vi } from "vitest";
import { encode } from "@msgpack/msgpack";
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import type { ResearchSnapshot, ResearchSnapshotFile } from "./ResearchHistoryTypes";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
import {
  captureSnapshot,
  changeExcerpt,
  compareSnapshotContents,
  readSnapshotFile,
  readSnapshotWorkspacePreview,
  snapshotWeekStart,
} from "./ResearchHistory";

const file = (path: string, hash: string, kind: ResearchSnapshotFile["kind"] = "markdown"): ResearchSnapshotFile => ({
  path,
  hash,
  kind,
  size: 1,
});
const snapshot = (id: string, files: ResearchSnapshotFile[]): ResearchSnapshot => ({
  version: 1,
  id,
  files,
  projectId: "project",
  createdAt: "2026-11-20T00:00:00.000Z",
  weekStart: "2026-11-16",
  reason: "manual",
  warnings: [],
});
const text = (value: string) => new TextEncoder().encode(value);

async function board(x: number, note = "Read paper", image = "image", thumbnail = "thumbnail") {
  const writer = new ZipWriter(new Uint8ArrayWriter());
  await writer.add(
    "stage.msgpack",
    new Uint8ArrayReader(
      encode([
        {
          _: "TextNode",
          uuid: "node-1",
          text: note,
          collisionBox: {
            _: "CollisionBox",
            shapes: [{ _: "Rectangle", location: { _: "Vector", x, y: 20 }, size: { _: "Vector", x: 200, y: 60 } }],
          },
          color: { _: "Color", r: 0, g: 0, b: 0, a: 1 },
        },
      ]),
    ),
    { level: 0 },
  );
  await writer.add("attachments/img.png", new Uint8ArrayReader(text(image)), { level: 0 });
  await writer.add("thumbnail.png", new Uint8ArrayReader(text(thumbnail)), { level: 0 });
  return writer.close();
}

describe("research history", () => {
  beforeEach(() => {
    invoke.mockReset();
    vi.useRealTimers();
  });

  it("uses local Monday boundaries across Sunday and a year boundary", () => {
    expect(snapshotWeekStart(new Date(2026, 10, 22, 23, 59))).toBe("2026-11-16");
    expect(snapshotWeekStart(new Date(2026, 10, 23, 0, 0))).toBe("2026-11-23");
    expect(snapshotWeekStart(new Date(2027, 0, 1, 12, 0))).toBe("2026-12-28");
  });

  it("requests a capture with explicit scope and reason and normalizes backend errors", async () => {
    invoke.mockRejectedValue("history.noMaterials");
    await expect(captureSnapshot("D:/research", "auto")).rejects.toThrow("history.noMaterials");
    expect(invoke).toHaveBeenCalledWith(
      "capture_research_snapshot",
      expect.objectContaining({ root: "D:/research", reason: "auto" }),
    );
  });

  it("reads the named frozen object rather than a live file", async () => {
    invoke.mockResolvedValue(text("old notes").buffer);
    expect(new TextDecoder().decode(await readSnapshotFile("D:/research", "old-id", "note.md"))).toBe("old notes");
    expect(invoke).toHaveBeenCalledWith("read_research_snapshot_file", {
      root: "D:/research",
      snapshotId: "old-id",
      path: "note.md",
    });
  });

  it("detects additions deletions unique renames and late text edits", async () => {
    const before = snapshot("a", [file("old.md", "same"), file("deleted.md", "d"), file("note.md", "old")]);
    const after = snapshot("b", [file("renamed.md", "same"), file("new.md", "n"), file("note.md", "new")]);
    const prefix = Array.from({ length: 100 }, (_, index) => `unchanged ${index}`).join("\n");
    const result = await compareSnapshotContents(before, after, async (id) =>
      text(`${prefix}\n${id === "a" ? "old claim" : "new hypothesis"}`),
    );
    expect(result.changes).toEqual(
      expect.arrayContaining([
        { path: "deleted.md", kind: "removed" },
        { path: "renamed.md", kind: "moved", previousPath: "old.md" },
        { path: "new.md", kind: "added" },
        expect.objectContaining({
          path: "note.md",
          kind: "modified",
          before: expect.stringContaining("old claim"),
          after: expect.stringContaining("new hypothesis"),
        }),
      ]),
    );
  });

  it("does not guess a rename when multiple identical sources exist", async () => {
    const result = await compareSnapshotContents(
      snapshot("a", [file("a.md", "same"), file("b.md", "same")]),
      snapshot("b", [file("c.md", "same")]),
      vi.fn(),
    );
    expect(result.changes.map((change) => change.kind)).toEqual(["removed", "removed", "added"]);
  });

  it("does not report a deletion when a later snapshot could not capture the source", async () => {
    const before = snapshot("a", [file("paper.pdf", "pdf", "pdf"), file("note.md", "old")]);
    const after = snapshot("b", [file("note.md", "new")]);
    after.warnings.push("未纳入 paper.pdf：history.fileTooLarge");
    const result = await compareSnapshotContents(before, after, async (id) =>
      text(id === "a" ? "old note" : "new note"),
    );
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]).toMatchObject({ path: "note.md", kind: "modified" });
    expect(result.warnings.join("\n")).toContain("不将其判断为删除");
  });

  it("does not label a recovered previously unrecorded source as newly added", async () => {
    const before = snapshot("a", []);
    before.warnings.push("目录不可读取：papers");
    const after = snapshot("b", [file("papers/paper.pdf", "pdf", "pdf")]);
    const result = await compareSnapshotContents(before, after, vi.fn());
    expect(result.changes).toEqual([]);
    expect(result.warnings.join("\n")).toContain("不将其判断为新增");
  });

  it("does not infer a rename from incomplete snapshots", async () => {
    const before = snapshot("a", [file("old.md", "same")]);
    const after = snapshot("b", [file("new.md", "same")]);
    before.warnings.push("some sources were not captured");
    after.warnings.push("some sources were not captured");
    const result = await compareSnapshotContents(before, after, vi.fn());
    expect(result.changes).toEqual([]);
    expect(result.warnings.join("\n")).toContain("不将其判断为删除");
  });

  it("separates node layout from content and ignores regenerated ZIP thumbnails", async () => {
    const original = await board(0);
    const moved = await board(120);
    const changed = await board(120, "Revised hypothesis");
    const regenerated = await board(0, "Read paper", "image", "new preview");
    const a = snapshot("a", [file("board.prg", "a", "workspace")]);
    const b = snapshot("b", [file("board.prg", "b", "workspace")]);
    expect((await compareSnapshotContents(a, b, async (id) => (id === "a" ? original : moved))).changes[0].kind).toBe(
      "layout",
    );
    expect((await compareSnapshotContents(a, b, async (id) => (id === "a" ? original : changed))).changes[0].kind).toBe(
      "modified",
    );
    expect((await compareSnapshotContents(a, b, async (id) => (id === "a" ? original : regenerated))).changes).toEqual(
      [],
    );
  });

  it("does not label replaced image attachments as mere layout changes", async () => {
    const a = await board(0);
    const b = await board(0, "Read paper", "replacement image");
    const result = await compareSnapshotContents(
      snapshot("a", [file("board.prg", "a", "workspace")]),
      snapshot("b", [file("board.prg", "b", "workspace")]),
      async (id) => (id === "a" ? a : b),
    );
    expect(result.changes[0].kind).toBe("modified");
  });

  it("shows a changed late paragraph beyond the abbreviated AI sidecar text", async () => {
    const prefix = "Unchanged reading note.\n".repeat(80);
    const a = await board(0, `${prefix}Original conclusion`);
    const b = await board(0, `${prefix}Corrected conclusion`);
    const result = await compareSnapshotContents(
      snapshot("a", [file("board.prg", "a", "workspace")]),
      snapshot("b", [file("board.prg", "b", "workspace")]),
      async (id) => (id === "a" ? a : b),
    );
    expect(result.changes[0].before).toContain("Original conclusion");
    expect(result.changes[0].after).toContain("Corrected conclusion");
  });

  it("previews the historical board and its own thumbnail without loading a live project", async () => {
    const archived = await board(0, "Historical claim", "image", "old preview");
    invoke.mockResolvedValue(archived.buffer);
    const preview = await readSnapshotWorkspacePreview("D:/research", "old-id", "board.prg");
    expect(preview.markdown).toContain("Historical claim");
    expect(new TextDecoder().decode(preview.thumbnail)).toBe("old preview");
    expect(preview.thumbnailMime).toBe("image/png");
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("reports unreadable differences and preserves snapshot coverage warnings", async () => {
    const before = snapshot("a", [file("board.prg", "a", "workspace")]);
    before.warnings.push("missing PDF");
    const result = await compareSnapshotContents(
      before,
      snapshot("b", [file("board.prg", "b", "workspace")]),
      async () => {
        throw new Error("history.corruptObject");
      },
    );
    expect(result.changes[0].kind).toBe("modified");
    expect(result.warnings.join("\n")).toContain("history.corruptObject");
    expect(result.warnings.join("\n")).toContain("missing PDF");
  });

  it("rejects comparisons across unrelated projects", async () => {
    const after = { ...snapshot("b", []), projectId: "another-project" };
    await expect(compareSnapshotContents(snapshot("a", []), after, vi.fn())).rejects.toThrow(
      "history.differentProjects",
    );
  });

  it("bounds displayed text while retaining the first changed lines", () => {
    const result = changeExcerpt("old\n".repeat(10000), "new\n".repeat(10000));
    expect(result.before.length).toBeLessThan(6100);
    expect(result.after).toContain("new");
    expect(result.after.endsWith("…")).toBe(true);
  });
});
