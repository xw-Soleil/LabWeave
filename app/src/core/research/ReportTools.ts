import { parseProjectFile } from "@/core/ProjectFile";
import { Decoder } from "@msgpack/msgpack";
import { buildAiSidecar, type ResearchSidecar } from "./AiSidecarBuilder";
import { parseAnnotations, type PdfAnnotation } from "./PdfAnnotations";
import {
  ACTIVITY_LOG_FILE,
  ACTIVITY_STATE_FILE,
  baselineOf,
  clip,
  decodeJson,
  diffItems,
  isNode,
  listSnapshots,
  localTime,
  readSnapshotBoard,
  replacedNodes,
  sidecarItems,
  sinceOf,
  under,
  type ActivityEntry,
  type ActivityItem,
  type ActivityItems,
  type ActivityKind,
  type ActivityState,
  type ActivityWhere,
  type RecordReader,
  type Snapshot,
} from "./ProjectRecord";
import { isHiddenResearchName } from "./ResearchShell";

/*
 * 给 AI 做汇报用的几个只读工具背后的逻辑：读活动记录、列快照、比快照、读批注。
 *
 * 和 ProjectRecord.ts 一样不碰界面和桌面端接口：外部 AI 走 MCP、程序没开时，这些也要能直接读文件。
 * 文件怎么读由调用方给（RecordReader）。
 */

export interface ReportSource {
  /** 项目文件夹 */
  root: string;
  reader: RecordReader;
}

const fail = (error: string) => ({ success: false as const, error });
const projectName = (root: string) =>
  root
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .pop() ?? "";
const isAbsolute = (path: string) => /^(?:[\\/]|[a-zA-Z]:)/.test(path);
const pathKey = (path: string) => path.replace(/\\/g, "/").normalize("NFC").toLowerCase();

// 链接要放进 Markdown 的 [文字](链接) 里：空格和括号会把它截断，& = # ? % 在网址里另有意思。
// 中文不转，报告的源文件还看得懂
const escapeLinkChar = (char: string) =>
  char.charCodeAt(0) < 0x80
    ? `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`
    : encodeURIComponent(char);
const linkValue = (value: string | number) => String(value).replace(/[\s%&=+#?()<>[\]"'`\\]/g, escapeLinkChar);

/**
 * 能点回原处的链接。where 是活动记录里的写法：
 *   白板上的卡片   { board, card }
 *   项目里的文件   { file, page?, annotation? }
 *   文献库里的文件 { library, page?, annotation? }
 * 指不到具体地方的给 undefined。
 */
export function recordLink(root: string, where: ActivityWhere): string | undefined {
  const query: [string, string | number][] = [];
  if (typeof where.board === "string") {
    query.push(["project", projectName(root)], ["path", where.board]);
    if (where.card) query.push(["target", where.card]);
  } else {
    if (typeof where.library === "string") query.push(["library", 1], ["path", where.library]);
    else if (typeof where.file === "string") {
      // 项目外的文件记的是完整路径：换一台电脑就不对了，在这台上还能点开
      if (!isAbsolute(where.file)) query.push(["project", projectName(root)]);
      query.push(["path", where.file]);
    } else return undefined;
    if (where.page) query.push(["page", where.page]);
    if (where.annotation) query.push(["annotation", where.annotation]);
  }
  return `rwb://open?${query.map(([key, value]) => `${key}=${linkValue(value)}`).join("&")}`;
}

// —— 活动记录 ——

export interface ActivityLogQuery {
  since?: string;
  until?: string;
  days?: number;
  kinds?: readonly ActivityKind[];
  limit?: number;
  offset?: number;
}

const DEFAULT_DAYS = 7;
const DEFAULT_ENTRIES = 100;
const MAX_ENTRIES = 300;

/** 「2026-11-15」按本地的那一天算（当结尾用时算到那天结束），带时间的照原样 */
function timeOf(value: string, end: boolean): number {
  const day = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(value.trim());
  if (day) return new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3]) + (end ? 1 : 0)).getTime();
  return Date.parse(value) + (end ? 1 : 0);
}

function entryOut(root: string, entry: ActivityEntry) {
  const { board, card, ...elsewhere } = entry.where;
  let link: string | undefined;
  let source: string | undefined;
  if (entry.kind === "library.add" || entry.kind === "snapshot") {
    // 文献库的一个条目、一份快照：现在还没有能点开它们的链接
  } else if (board !== undefined) {
    // 删掉的卡片点不回去
    if (entry.kind !== "card.delete") link = recordLink(root, { board, card });
    if (entry.kind === "excerpt.send") source = recordLink(root, elsewhere);
  } else if (entry.kind === "annotation.delete") {
    // 删掉的批注点不回去，指到它原来所在的那一页
    const page = { ...entry.where };
    delete page.annotation;
    link = recordLink(root, page);
  } else {
    link = recordLink(root, entry.where);
  }
  return {
    at: entry.at,
    kind: entry.kind,
    title: entry.title,
    ...(entry.text && { text: entry.text }),
    where: entry.where,
    ...(entry.more && { more: entry.more }),
    ...(link && { link }),
    ...(source && { source }),
  };
}

/**
 * 读一段时间的活动记录，最早的在前。
 * 范围：since / until，或者 days（今天和之前的 days-1 天）；都不给就是最近 7 天。
 */
export async function readActivityLog({ root, reader }: ReportSource, query: ActivityLogQuery = {}, now = new Date()) {
  const start =
    query.since !== undefined
      ? timeOf(query.since, false)
      : query.days !== undefined || query.until === undefined
        ? new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1 - (query.days ?? DEFAULT_DAYS)).getTime()
        : -Infinity;
  const end = query.until !== undefined ? timeOf(query.until, true) : Infinity;
  if (Number.isNaN(start) || Number.isNaN(end)) {
    return fail("since、until 要写成 2026-11-15 或 2026-11-15T10:30:00+08:00 这样。");
  }
  const kinds = query.kinds?.length ? new Set<string>(query.kinds) : undefined;
  const bytes = await reader.read(under(root, ACTIVITY_LOG_FILE));
  const matched: { time: number; entry: ActivityEntry }[] = [];
  let startedAt: string | undefined;
  let unreadable = 0;
  for (const line of bytes ? new TextDecoder().decode(bytes).split("\n") : []) {
    if (!line.trim()) continue;
    let entry: ActivityEntry;
    try {
      entry = JSON.parse(line) as ActivityEntry;
    } catch {
      // 写到一半断电留下的半行：跳过，条数报给调用方
      unreadable++;
      continue;
    }
    const time = Date.parse(entry?.at);
    if (Number.isNaN(time) || typeof entry.kind !== "string" || typeof entry.where !== "object" || !entry.where) {
      unreadable++;
      continue;
    }
    if (startedAt === undefined || time < Date.parse(startedAt)) startedAt = entry.at;
    if (time < start || time >= end) continue;
    if (kinds && !kinds.has(entry.kind)) continue;
    matched.push({ time, entry });
  }
  // 批注用的是它自己记的时间，可能比前面几行早：按时间排一遍
  matched.sort((a, b) => a.time - b.time);
  const counts: Record<string, number> = {};
  for (const { entry } of matched) counts[entry.kind] = (counts[entry.kind] ?? 0) + 1;
  const offset = Math.max(0, Math.trunc(query.offset ?? 0));
  const limit = Math.min(Math.max(1, Math.trunc(query.limit ?? DEFAULT_ENTRIES)), MAX_ENTRIES);
  const page = matched.slice(offset, offset + limit);
  return {
    success: true as const,
    project: projectName(root),
    now: localTime(now),
    range: {
      since: Number.isFinite(start) ? localTime(new Date(start)) : (startedAt ?? null),
      until: query.until ?? localTime(now),
    },
    ...(startedAt && { startedAt }),
    total: matched.length,
    counts,
    offset,
    entries: page.map(({ entry }) => entryOut(root, entry)),
    ...(offset + page.length < matched.length && { truncated: true, next: offset + page.length }),
    ...(unreadable > 0 && { unreadable }),
    ...(!startedAt && {
      note: "这个项目还没有活动记录。记录从装上这一版、在程序里打开这个项目那天开始。",
    }),
  };
}

// —— 快照 ——

const MAX_SNAPSHOTS = 30;
const MAX_LISTED = 40;
const MAX_DEPTH = 6;

/** 节点信息：类型、名字、和哪份比的、用户的原话；被同一天的后一次定格顶替了的写明被谁顶替 */
function nodeOut(all: readonly Snapshot[], snapshot: Snapshot, replacedBy?: string) {
  const node = snapshot.manifest.node;
  const since = sinceOf(all, snapshot);
  return {
    type: node?.type ?? "meeting",
    ...(node?.title && { title: node.title }),
    ...(since && { since }),
    ...(node?.note && { note: node.note }),
    ...(replacedBy && { replacedBy }),
  };
}

export async function snapshotList({ root, reader }: ReportSource) {
  const snapshots = await listSnapshots(reader, root);
  const replaced = replacedNodes(snapshots);
  const baseline = baselineOf(snapshots);
  return {
    success: true as const,
    project: projectName(root),
    total: snapshots.length,
    // 「自上次小结以来」该和哪份比：上一个节点；一个节点都没有时是最早的那份
    ...(baseline && { baseline: baseline.name }),
    snapshots: snapshots.slice(0, MAX_SNAPSHOTS).map((snapshot) => {
      const { name, manifest } = snapshot;
      return {
        name,
        at: manifest.at,
        reason: manifest.reason,
        ...(isNode(snapshot) && { node: nodeOut(snapshots, snapshot, replaced.get(name)) }),
        boards: manifest.boards.map(({ file, cards, sections, edges }) => ({ board: file, cards, sections, edges })),
      };
    }),
    ...(snapshots.length === 0 && {
      note: "这个项目还没有快照。做一次阶段小结会定格一份；在白板底部状态栏点相机按钮可以拍一份留底；超过 7 天没拍，程序也会自动拍。",
    }),
  };
}

/** 对比结果里的一份快照；是节点的带上节点的名字 */
const snapshotOut = ({ name, manifest }: Snapshot) => ({
  name,
  at: manifest.at,
  ...(manifest.node && { node: manifest.node.title }),
});

/** 调用方手里开着的那块白板：用它当前的内容，不用盘上可能旧一点的文件 */
export interface CurrentBoard {
  /** 白板文件的完整路径 */
  path: string;
  /** workspaceFile 是这块白板按项目文件夹拼出来的路径，算文件卡片的相对路径要用同一个基准 */
  sidecar(workspaceFile: string): ResearchSidecar;
}

interface BoardState {
  items: ActivityItems;
  /** 连线：编号拼出来的 key → 写给人看的样子 */
  edges: Map<string, string>;
}

function boardState(sidecar: ResearchSidecar): BoardState {
  const items = sidecarItems(sidecar);
  const title = (id: string) => items[id]?.title || "（没有标题）";
  return {
    items,
    edges: new Map(
      sidecar.edges.map((edge) => [
        `${edge.from}\n${edge.to}\n${edge.label}`,
        `${title(edge.from)} → ${title(edge.to)}${edge.label ? `（${edge.label}）` : ""}`,
      ]),
    ),
  };
}

/** 项目里现在有哪些白板文件，相对项目文件夹。和文件面板一样跳过隐藏的、备份的 */
async function boardFiles(reader: RecordReader, root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string, depth: number) => {
    const here = dir ? under(root, dir) : root;
    for (const name of (await reader.files(here)).sort()) {
      if (/\.prg$/i.test(name) && !isHiddenResearchName(name)) found.push(dir ? `${dir}/${name}` : name);
    }
    if (depth >= MAX_DEPTH) return;
    for (const name of (await reader.folders(here)).sort()) {
      if (!isHiddenResearchName(name)) await walk(dir ? `${dir}/${name}` : name, depth + 1);
    }
  };
  await walk("", 0);
  return found;
}

async function boardOnDisk(reader: RecordReader, root: string, file: string): Promise<ResearchSidecar | undefined> {
  const bytes = await reader.read(under(root, file));
  if (!bytes) return undefined;
  const parsed = await parseProjectFile(bytes, new Decoder(), new Map());
  return buildAiSidecar({
    serializedStage: parsed.serializedStageObjects,
    tags: parsed.tags,
    metadata: parsed.metadata,
    readme: parsed.readme,
    workspaceFile: under(root, file),
    researchRoot: root,
  }).json;
}

const notesOf = (item: ActivityItem) => (typeof item.more?.notes === "string" ? item.more.notes : "");

function cardOut(root: string, id: string, item: ActivityItem, board?: string) {
  return {
    card: id,
    type: item.more?.type,
    title: item.title,
    ...(item.text && { text: item.text }),
    ...(notesOf(item) && { notes: notesOf(item) }),
    ...(board && { link: recordLink(root, { board, card: id }) }),
  };
}

/** 改过的卡片原来是什么样：只给变了的那几样 */
function wasOf(before: ActivityItem, after: ActivityItem) {
  return {
    ...(before.title !== after.title && { title: before.title }),
    ...(before.text !== after.text && { text: before.text }),
    ...(notesOf(before) !== notesOf(after) && { notes: notesOf(before) }),
  };
}

/**
 * 比两份快照，或者一份快照和现在。to 不填是和现在比。
 * from 不填：to 是节点就用它当初比的那一份，不是节点用它的前一份；
 * to 也不填就是「自上次小结以来」，用上一个节点（一个节点都没有时是最早的那份）。
 */
export async function compareSnapshots(
  { root, reader }: ReportSource,
  query: { from?: string; to?: string } = {},
  current?: CurrentBoard,
  now = new Date(),
) {
  const all = await listSnapshots(reader, root);
  if (all.length === 0) {
    return fail("这个项目还没有快照，比不了。在白板底部状态栏点相机按钮可以拍一份；这次先只用活动记录。");
  }
  const named = (name: string) => all.find((snapshot) => snapshot.name === name);
  const unknown = (name: string) =>
    fail(
      `没有叫「${name}」的快照。现有的：${all
        .slice(0, 10)
        .map((snapshot) => snapshot.name)
        .join("、")}`,
    );
  const to = query.to === undefined ? undefined : named(query.to);
  if (query.to !== undefined && !to) return unknown(query.to);
  // 节点当初比的那份要是已经不在了（文件夹被删），退回它的前一份
  const sinceOfTo = to && isNode(to) ? sinceOf(all, to) : undefined;
  const from =
    query.from !== undefined
      ? named(query.from)
      : to
        ? ((sinceOfTo ? named(sinceOfTo) : undefined) ?? all[all.indexOf(to) + 1])
        : baselineOf(all);
  if (!from) {
    return query.from !== undefined ? unknown(query.from) : fail(`「${to!.name}」是最早的一份快照，前面没有可以比的。`);
  }
  if (to && from.name >= to.name) return fail("from 要比 to 早。");

  // 读不出来的白板记成 null：单独标出来，不连累别的白板
  const inSnapshot = async (snapshot: Snapshot) => {
    const boards = new Map<string, BoardState | null>();
    for (const { file } of snapshot.manifest.boards) {
      const sidecar = await readSnapshotBoard(reader, root, snapshot.name, file);
      boards.set(file, sidecar ? boardState(sidecar) : null);
    }
    return boards;
  };
  const rightNow = async () => {
    const boards = new Map<string, BoardState | null>();
    for (const file of await boardFiles(reader, root)) {
      const path = under(root, file);
      let sidecar: ResearchSidecar | undefined;
      try {
        sidecar =
          current && pathKey(path) === pathKey(current.path)
            ? current.sidecar(path)
            : await boardOnDisk(reader, root, file);
      } catch {
        // 旧版格式、正在写入、已经损坏：这一块标成读不了
        sidecar = undefined;
      }
      boards.set(file, sidecar ? boardState(sidecar) : null);
    }
    return boards;
  };
  const before = await inSnapshot(from);
  const after = to ? await inSnapshot(to) : await rightNow();

  // 白板改了名或挪了位置，卡片编号不变：少掉的和多出来的两块白板里卡片大半相同，就当成同一块
  const renamed = new Map<string, string>();
  for (const [oldFile, old] of before) {
    if (after.has(oldFile) || !old) continue;
    const ids = Object.keys(old.items);
    let best: string | undefined;
    let bestShared = 0;
    for (const [file, board] of after) {
      if (before.has(file) || renamed.has(file) || !board) continue;
      const shared = ids.filter((id) => id in board.items).length;
      if (shared > bestShared) [best, bestShared] = [file, shared];
    }
    if (best && bestShared * 2 >= Math.min(ids.length, Object.keys(after.get(best)!.items).length)) {
      renamed.set(best, oldFile);
    }
  }

  const empty: BoardState = { items: {}, edges: new Map() };
  const moved = new Set(renamed.values());
  const totals = { added: 0, edited: 0, removed: 0 };
  const boards: Record<string, unknown>[] = [];
  let unchanged = 0;
  for (const file of [...new Set([...after.keys(), ...before.keys()])].sort()) {
    // 改名前的那个名字：已经并到新名字那一块里了
    if (moved.has(file) && !after.has(file)) continue;
    const renamedFrom = renamed.get(file);
    const old = before.get(renamedFrom ?? file);
    const fresh = after.get(file);
    if (old === null || fresh === null) {
      boards.push({ board: file, unreadable: true });
      continue;
    }
    const a = old ?? empty;
    const b = fresh ?? empty;
    const { added, edited, removed } = diffItems(a.items, b.items);
    const edgesAdded = [...b.edges].filter(([key]) => !a.edges.has(key)).map(([, text]) => text);
    const edgesRemoved = [...a.edges].filter(([key]) => !b.edges.has(key)).map(([, text]) => text);
    const status = !fresh ? "gone" : !old ? "new" : undefined;
    const changes = added.length + edited.length + removed.length + edgesAdded.length + edgesRemoved.length;
    if (!status && !renamedFrom && changes === 0) {
      unchanged++;
      continue;
    }
    totals.added += added.length;
    totals.edited += edited.length;
    totals.removed += removed.length;
    const lists = [added, edited, removed, edgesAdded, edgesRemoved];
    boards.push({
      board: file,
      ...(renamedFrom && { renamedFrom }),
      ...(status && { status }),
      counts: {
        added: added.length,
        edited: edited.length,
        removed: removed.length,
        edgesAdded: edgesAdded.length,
        edgesRemoved: edgesRemoved.length,
      },
      added: added.slice(0, MAX_LISTED).map((id) => cardOut(root, id, b.items[id], file)),
      edited: edited
        .slice(0, MAX_LISTED)
        .map((id) => ({ ...cardOut(root, id, b.items[id], file), was: wasOf(a.items[id], b.items[id]) })),
      removed: removed.slice(0, MAX_LISTED).map((id) => cardOut(root, id, a.items[id])),
      ...(edgesAdded.length > 0 && { edgesAdded: edgesAdded.slice(0, MAX_LISTED) }),
      ...(edgesRemoved.length > 0 && { edgesRemoved: edgesRemoved.slice(0, MAX_LISTED) }),
      // 每样最多列 MAX_LISTED 条，准数看 counts
      ...(lists.some((list) => list.length > MAX_LISTED) && { truncated: true }),
    });
  }
  return {
    success: true as const,
    project: projectName(root),
    from: snapshotOut(from),
    to: to ? snapshotOut(to) : { now: localTime(now) },
    totals,
    unchanged,
    boards,
  };
}

// —— PDF 批注 ——

const ANNOTATION_DIR = ".workbench/annotations";
const MAX_ANNOTATIONS = 200;
const ANNOTATION_CHARS = 1000;

export interface AnnotationQuery {
  /** 项目里的 PDF，相对项目文件夹 */
  file?: string;
  /** 文献库里的 PDF，相对文献库 */
  library?: string;
}

export interface AnnotationOptions {
  /**
   * 读文献库里一篇 PDF 的批注，path 相对文献库。这些批注存在程序的数据目录里，只有桌面端读得到；
   * 不给（命令行、程序没开）时退一步，用活动记录里记下的那部分。
   */
  library?: (path: string) => Promise<unknown>;
}

const relativePdf = (path: string) => {
  const posix = path.replace(/\\/g, "/").replace(/^\.\//, "");
  const bad = isAbsolute(posix) || posix.split("/").some((part) => part === ".." || part === "");
  return bad || !/\.pdf$/i.test(posix) ? undefined : posix;
};

/** 自己划的批注（PDF 里自带的不算）；内容不合格式时给 undefined */
function ownAnnotations(value: unknown): PdfAnnotation[] | undefined {
  try {
    return parseAnnotations(value).filter((annotation) => !annotation.readOnly);
  } catch {
    // 文件坏了：调用方会把这篇标成读不了
    return undefined;
  }
}

const shownTime = (value: unknown) =>
  typeof value === "string" && !Number.isNaN(Date.parse(value)) ? localTime(new Date(value)) : undefined;

function annotationOut(root: string, where: ActivityWhere, annotation: PdfAnnotation) {
  const page = annotation.position.pageIndex + 1;
  return {
    id: annotation.id,
    type: annotation.type,
    page,
    ...(annotation.pageLabel !== String(page) && { pageLabel: annotation.pageLabel }),
    color: annotation.color,
    ...(annotation.text && { text: clip(annotation.text, ANNOTATION_CHARS) }),
    ...(annotation.comment && { comment: clip(annotation.comment, ANNOTATION_CHARS) }),
    ...(annotation.tags.length > 0 && { tags: annotation.tags.map((tag) => tag.name) }),
    ...(shownTime(annotation.dateCreated) && { created: shownTime(annotation.dateCreated) }),
    modified: shownTime(annotation.dateModified),
    link: recordLink(root, { ...where, page, annotation: annotation.id }),
  };
}

/** 活动记录里记下的一条批注：原文和批注上写的话都只有开头 */
function recordedAnnotationOut(root: string, where: ActivityWhere, id: string, item: ActivityItem) {
  const more = item.more ?? {};
  return {
    id,
    type: more.type,
    page: item.page,
    ...(more.pageLabel !== undefined && { pageLabel: more.pageLabel }),
    color: more.color,
    ...(item.text && { text: item.text }),
    ...(more.comment !== undefined && { comment: more.comment }),
    ...(more.tags !== undefined && { tags: more.tags }),
    ...(shownTime(item.created) && { created: shownTime(item.created) }),
    modified: shownTime(item.modified),
    link: recordLink(root, { ...where, ...(item.page && { page: item.page }), annotation: id }),
  };
}

/** 项目里哪些 PDF 有批注文件，相对项目文件夹 */
async function annotatedFiles(reader: RecordReader, root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string, depth: number) => {
    const here = under(root, ANNOTATION_DIR, ...(dir ? [dir] : []));
    for (const name of (await reader.files(here)).sort()) {
      if (/\.pdf\.json$/i.test(name)) found.push(`${dir ? `${dir}/` : ""}${name.slice(0, -".json".length)}`);
    }
    if (depth >= MAX_DEPTH) return;
    for (const name of (await reader.folders(here)).sort()) {
      // .trash 里是删掉的 PDF 留下的批注
      if (!name.startsWith(".")) await walk(dir ? `${dir}/${name}` : name, depth + 1);
    }
  };
  await walk("", 0);
  return found;
}

/** 读一篇 PDF 的批注；file、library 都不给时，列出哪些 PDF 有批注、各几条 */
export async function readAnnotations(
  { root, reader }: ReportSource,
  query: AnnotationQuery = {},
  options: AnnotationOptions = {},
) {
  const project = projectName(root);
  const recorded = async () =>
    decodeJson<Partial<ActivityState>>(await reader.read(under(root, ACTIVITY_STATE_FILE)))?.annotations ?? {};
  const projectFile = async (file: string) => {
    const bytes = await reader.read(under(root, ANNOTATION_DIR, `${file}.json`));
    return bytes ? ownAnnotations(decodeJson<unknown>(bytes)) : [];
  };

  if (query.file === undefined && query.library === undefined) {
    const files: Record<string, unknown>[] = [];
    for (const file of await annotatedFiles(reader, root)) {
      const own = await projectFile(file);
      if (!own) files.push({ file, unreadable: true });
      else if (own.length > 0) files.push({ file, count: own.length });
    }
    // 文献库里的 PDF，批注存在程序数据目录里、文件名是算出来的，列不出来：只知道活动记录里记过的那些
    for (const [key, items] of Object.entries(await recorded())) {
      const where = decodeJson<ActivityWhere>(new TextEncoder().encode(key));
      const count = Object.keys(items).length;
      if (typeof where?.library === "string" && count > 0) files.push({ library: where.library, count });
    }
    return {
      success: true as const,
      project,
      files,
      note: "file 是项目里的 PDF，library 是文献库里的 PDF（只列得出有了活动记录以后、在程序里打开过的）。读某一篇时把这里的 file 或 library 原样填回来。",
    };
  }

  if (query.file !== undefined && query.library !== undefined) return fail("file 和 library 只填一个。");
  const inLibrary = query.library !== undefined;
  const path = relativePdf((query.library ?? query.file)!);
  if (!path) {
    return fail(
      "要填以 .pdf 结尾的相对路径：file 相对项目文件夹，library 相对文献库。可以照活动记录里 where 的写法填。",
    );
  }
  const where: ActivityWhere = inLibrary ? { library: path } : { file: path };
  if (inLibrary && !options.library) {
    const items = (await recorded())[JSON.stringify(where)] ?? {};
    const annotations = Object.entries(items)
      .map(([id, item]) => recordedAnnotationOut(root, where, id, item))
      .sort((a, b) => (a.page ?? 0) - (b.page ?? 0));
    return {
      success: true as const,
      project,
      ...where,
      count: annotations.length,
      annotations: annotations.slice(0, MAX_ANNOTATIONS),
      ...(annotations.length > MAX_ANNOTATIONS && { truncated: true }),
      partial: true,
      note: "科研工作台没开着，文献库里 PDF 的批注读不全：这里是活动记录里记下的那部分，每条只有开头 300 字。要读全，请用户在程序里打开一块白板后再试。",
    };
  }
  const own = inLibrary ? ownAnnotations(await options.library!(path)) : await projectFile(path);
  if (!own) return fail("这篇 PDF 的批注文件读不了，可能已损坏。");
  const annotations = own
    .toSorted((a, b) => a.sortIndex.localeCompare(b.sortIndex))
    .map((annotation) => annotationOut(root, where, annotation));
  return {
    success: true as const,
    project,
    ...where,
    count: annotations.length,
    annotations: annotations.slice(0, MAX_ANNOTATIONS),
    ...(annotations.length > MAX_ANNOTATIONS && { truncated: true }),
  };
}
