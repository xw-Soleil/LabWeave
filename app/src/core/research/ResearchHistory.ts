import { invoke } from "@tauri-apps/api/core";
import { decode } from "@msgpack/msgpack";
import { Uint8ArrayReader, Uint8ArrayWriter, ZipReader } from "@zip.js/zip.js";
import { buildAiSidecar } from "./AiSidecarBuilder";
import type {
  ResearchSnapshot,
  ResearchSnapshotFile,
  SnapshotChange,
  SnapshotDiff,
  SnapshotReason,
} from "./ResearchHistoryTypes";

async function historyCommand<T>(name: string, args: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(name, args);
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error));
  }
}

export function snapshotWeekStart(date = new Date()): string {
  const monday = new Date(date);
  monday.setHours(0, 0, 0, 0);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  return `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, "0")}-${String(monday.getDate()).padStart(2, "0")}`;
}

export function captureSnapshot(root: string, reason: SnapshotReason): Promise<ResearchSnapshot> {
  const now = new Date();
  return historyCommand("capture_research_snapshot", {
    root,
    reason,
    weekStart: snapshotWeekStart(now),
    createdAt: now.toISOString(),
  });
}

export function listSnapshots(root: string): Promise<ResearchSnapshot[]> {
  return historyCommand("list_research_snapshots", { root });
}

export async function readSnapshotFile(root: string, snapshotId: string, path: string): Promise<Uint8Array> {
  const bytes = await historyCommand<ArrayBuffer | number[]>("read_research_snapshot_file", { root, snapshotId, path });
  return bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : Uint8Array.from(bytes);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

const byId = <T extends { id: string }>(values: T[]) => [...values].sort((a, b) => a.id.localeCompare(b.id));
const withoutLayout = <T extends { rect: unknown; color: unknown }>(value: T) =>
  Object.fromEntries(Object.entries(value).filter(([key]) => key !== "rect" && key !== "color"));

const layoutFields = new Set(["collisionBox", "_collisionBoxNormal", "_collisionBoxCollapsed", "color", "isCollapsed"]);
function semanticStage(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(semanticStage);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !layoutFields.has(key))
        .map(([key, child]) => [key, semanticStage(child)]),
    );
  }
  return value;
}

async function boardContent(bytes: Uint8Array, path: string, includeThumbnail = false) {
  const reader = new ZipReader(new Uint8ArrayReader(bytes));
  try {
    const entries = await reader.getEntries();
    if (entries.length > 20000 || entries.reduce((sum, entry) => sum + entry.uncompressedSize, 0) > 256 * 1024 * 1024) {
      throw new Error("history.workspaceTooLarge");
    }
    const values: Record<string, unknown> = {};
    const attachments: [string, string][] = [];
    let readme = "";
    let thumbnail: Uint8Array | undefined;
    for (const entry of entries) {
      if (entry.directory) continue;
      if (entry.filename === "thumbnail.png") {
        if (includeThumbnail && entry.uncompressedSize <= 8 * 1024 * 1024)
          thumbnail = await entry.getData!(new Uint8ArrayWriter());
        continue;
      }
      if (entry.uncompressedSize > 128 * 1024 * 1024) throw new Error("history.workspaceTooLarge");
      const data = await entry.getData!(new Uint8ArrayWriter());
      if (["stage.msgpack", "metadata.msgpack", "tags.msgpack", "reference.msgpack"].includes(entry.filename)) {
        values[entry.filename] = decode(data);
      } else if (entry.filename === "README.md") {
        readme = new TextDecoder().decode(data);
      } else {
        const digest = await crypto.subtle.digest("SHA-256", data as Uint8Array<ArrayBuffer>);
        attachments.push([
          entry.filename,
          Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""),
        ]);
      }
    }
    if (!Array.isArray(values["stage.msgpack"])) throw new Error("history.invalidWorkspace");
    const { json, markdown } = buildAiSidecar({
      serializedStage: values["stage.msgpack"],
      metadata: values["metadata.msgpack"],
      tags: values["tags.msgpack"],
      workspaceFile: path,
      readme,
      savedAt: "",
    });
    const sources: unknown[] = [];
    const visit = (value: unknown) => {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) {
        value.forEach(visit);
        return;
      }
      const item = value as Record<string, unknown>;
      if (typeof item.uuid === "string") {
        sources.push([item.uuid, item.pdfPage ?? null, item.pdfAnnotation ?? null, item.attachmentId ?? null]);
      }
      Object.values(item).forEach(visit);
    };
    visit(values["stage.msgpack"]);
    const common = {
      edges: byId(json.edges),
      hyperedges: byId(json.hyperedges),
      tags: byId(json.tags),
      readme,
      attachments: attachments.sort(([a], [b]) => a.localeCompare(b)),
      sources: sources.sort((a, b) => canonical(a).localeCompare(canonical(b))),
      references: values["reference.msgpack"] ?? null,
    };
    // The AI sidecar's display Markdown intentionally abbreviates long notes. History
    // needs the unabridged card text as well, especially when only a late paragraph changed.
    const fullText = [
      markdown,
      "\n## 完整卡片记录",
      ...byId(json.cards).map((card) =>
        [`### ${card.title || card.id}`, card.text, card.notes].filter(Boolean).join("\n\n"),
      ),
      ...byId(json.sections)
        .filter((section) => section.notes)
        .map((section) => `### ${section.title}\n\n${section.notes}`),
    ].join("\n\n");
    return {
      semantic: canonical({
        ...common,
        cards: byId(json.cards).map(withoutLayout),
        sections: byId(json.sections).map(withoutLayout),
        extraContent: semanticStage(values["stage.msgpack"]),
      }),
      full: canonical({
        ...common,
        cards: byId(json.cards),
        sections: byId(json.sections),
        fullStage: values["stage.msgpack"],
      }),
      text: fullText,
      thumbnail,
    };
  } finally {
    await reader.close();
  }
}

export async function readSnapshotWorkspacePreview(
  root: string,
  id: string,
  path: string,
): Promise<{
  markdown: string;
  thumbnail?: Uint8Array;
  thumbnailMime?: string;
}> {
  const content = await boardContent(await readSnapshotFile(root, id, path), path, true);
  return {
    markdown: content.text,
    thumbnail: content.thumbnail,
    thumbnailMime: content.thumbnail ? "image/png" : undefined,
  };
}

export function changeExcerpt(before: string, after: string): { before: string; after: string } {
  const oldLines = before.replace(/\r\n?/g, "\n").split("\n");
  const newLines = after.replace(/\r\n?/g, "\n").split("\n");
  let first = 0;
  while (first < oldLines.length && first < newLines.length && oldLines[first] === newLines[first]) first++;
  const start = Math.max(0, first - 2);
  const excerpt = (lines: string[]) => {
    const text = lines.slice(start, start + 45).join("\n");
    const clipped = text.length > 6000 || start + 45 < lines.length;
    return `${start ? "…\n" : ""}${text.slice(0, 6000)}${clipped ? "\n…" : ""}`;
  };
  return { before: excerpt(oldLines), after: excerpt(newLines) };
}

function sameContent(a: ResearchSnapshotFile, b: ResearchSnapshotFile) {
  return a.hash === b.hash || (!!a.contentHash && a.contentHash === b.contentHash);
}

type ReadFrozen = (id: string, path: string) => Promise<Uint8Array>;

export async function compareSnapshotContents(
  before: ResearchSnapshot,
  after: ResearchSnapshot,
  read: ReadFrozen,
): Promise<SnapshotDiff> {
  if (before.projectId !== after.projectId) throw new Error("history.differentProjects");
  const oldFiles = new Map(before.files.map((file) => [file.path, file]));
  const newFiles = new Map(after.files.map((file) => [file.path, file]));
  const removed = before.files.filter((file) => !newFiles.has(file.path));
  const added = after.files.filter((file) => !oldFiles.has(file.path));
  const moves = new Map<string, string>();
  const matchedOld = new Set<string>();
  for (const next of added) {
    if (before.warnings.length || after.warnings.length) break;
    const matches = removed.filter((old) => old.kind === next.kind && sameContent(old, next));
    if (
      matches.length === 1 &&
      added.filter((candidate) => candidate.kind === next.kind && sameContent(candidate, next)).length === 1
    ) {
      moves.set(next.path, matches[0].path);
      matchedOld.add(matches[0].path);
    }
  }
  const changes: SnapshotChange[] = [];
  const warnings = [
    ...before.warnings.map((warning) => `较早快照：${warning}`),
    ...after.warnings.map((warning) => `较新快照：${warning}`),
  ];
  if (removed.length && after.warnings.length) {
    warnings.push("较新快照未完整采集，缺少的旧资料可能只是未被记录，本次不将其判断为删除。");
  }
  if (added.length && before.warnings.length) {
    warnings.push("较早快照未完整采集，当前资料可能此前已存在，本次不将其判断为新增。");
  }
  for (const old of removed) {
    if (!after.warnings.length && !matchedOld.has(old.path)) changes.push({ path: old.path, kind: "removed" });
  }
  for (const file of after.files) {
    const old = oldFiles.get(file.path);
    if (moves.has(file.path)) {
      changes.push({ path: file.path, kind: "moved", previousPath: moves.get(file.path) });
      continue;
    }
    if (!old) {
      if (!before.warnings.length) changes.push({ path: file.path, kind: "added" });
      continue;
    }
    if (sameContent(old, file)) continue;
    const change: SnapshotChange = { path: file.path, kind: "modified" };
    try {
      if (file.kind === "workspace" && old.kind === "workspace") {
        const [previous, next] = await Promise.all([
          read(before.id, old.path).then((bytes) => boardContent(bytes, old.path)),
          read(after.id, file.path).then((bytes) => boardContent(bytes, file.path)),
        ]);
        if (previous.full === next.full) continue;
        change.kind = previous.semantic === next.semantic ? "layout" : "modified";
        Object.assign(change, changeExcerpt(previous.text, next.text));
      } else if (["markdown", "annotations", "other"].includes(file.kind)) {
        const [a, b] = await Promise.all([read(before.id, old.path), read(after.id, file.path)]);
        const decoder = new TextDecoder("utf-8", { fatal: true });
        const oldText = decoder.decode(a);
        const newText = decoder.decode(b);
        if (oldText.replace(/\r\n?/g, "\n") === newText.replace(/\r\n?/g, "\n")) continue;
        Object.assign(change, changeExcerpt(oldText, newText));
      }
    } catch (error) {
      warnings.push(`${file.path}：无法展开内容差异（${error instanceof Error ? error.message : String(error)}）`);
    }
    changes.push(change);
  }
  return { beforeId: before.id, afterId: after.id, changes, warnings };
}

export async function diffSnapshots(root: string, beforeId: string, afterId: string): Promise<SnapshotDiff> {
  const snapshots = await listSnapshots(root);
  const before = snapshots.find((snapshot) => snapshot.id === beforeId);
  const after = snapshots.find((snapshot) => snapshot.id === afterId);
  if (!before || !after) throw new Error("history.snapshotMissing");
  return compareSnapshotContents(before, after, (id, path) => readSnapshotFile(root, id, path));
}
