import type { Project } from "@/core/Project";
import { store } from "@/state";
import { serialize } from "@graphif/serializer";
import { exists, readDir } from "@tauri-apps/plugin-fs";
import { atom } from "jotai";
import { ACTIVITY_MARKS, flushActivityLog, type ActivityMark } from "./ActivityLog";
import { buildAiSidecar } from "./AiSidecarBuilder";
import {
  baselineOf,
  fingerprint,
  listSnapshots,
  localTime,
  nodeOnDay,
  nodeSince,
  readSnapshotBoard,
  type ActivityItems,
  type ActivityWhere,
  type NodeType,
  type RecordReader,
  type Snapshot,
} from "./ProjectRecord";
import {
  CURRENT_RECORD,
  loadNodeRecord,
  previewSealed,
  recordItemKey,
  recordPath,
  sealNodeRecord,
  type NodeRecord,
  type RecordLink,
  type RecordSection,
} from "./NodeRecord";
import { compareSnapshots, readActivityLog, recordLink, type ReportSource } from "./ReportTools";
import { ResearchFolder } from "./ResearchFolder";
import { nodeTitle, snapshotFiles, takeNode, type NodeInput } from "./Snapshot";
import { hideSinceLast, setSinceLastDropped, showSinceLast, type BoardDiff } from "./SnapshotDiff";

/*
 * 阶段小结的整理：点「阶段小结」以后，画布变成题板（没变的卡片压暗），
 * 角落的素材卡片列出上个节点以来的事，用户去掉不讲的、敲两句原话，再定格成一个节点。
 *
 * 这里是逻辑：有哪些事、怎么归并、勾选、定格。界面在 StageReviewTray.tsx，画布上的画法在 SnapshotDiff.ts，
 * 定格以后生成汇报在 StageReport.ts。
 */

export interface ReviewItem {
  /**
   * 勾选用的编号，也写进节点的清单：卡片是卡片编号；别的白板、论文、笔记是相对项目文件夹的路径，
   * 文献库里的论文前面加 library:
   */
  id: string;
  kind: "card" | "board" | "paper" | "note" | "record";
  title: string;
  /** 卡片：内容开头 */
  text?: string;
  /** 卡片：新加的还是改过的；只是右键标记过、内容没变的没有 */
  change?: "added" | "edited";
  /** 卡片：右键标成了什么 */
  mark?: ActivityMark;
  /** 归并出来的条目各有几样：白板是 added / edited / removed，论文是 annotations / excerpts */
  counts?: Record<string, number>;
  /** 点了跳到哪 */
  link?: string;
  /** 手填的记录：在哪一节、勾没勾、关联了什么 */
  record?: { section: RecordSection; done: boolean; links: readonly RecordLink[] };
}

/**
 * 手填的记录里的事项（进展记录）。编号是照内容算的：同一条再进整理时还是同一个编号，
 * 上次去掉不讲的才认得回来。内容一模一样的两条只列一次。
 */
export function recordItems(root: string, record: NodeRecord | undefined, file: string): ReviewItem[] {
  const listed = new Map<string, ReviewItem>();
  for (const item of record?.items ?? []) {
    const id = `record:${fingerprint(recordItemKey(item))}`;
    if (listed.has(id)) continue;
    listed.set(id, {
      id,
      kind: "record",
      title: item.summary || item.text.split("\n")[0],
      ...(item.text && { text: item.text }),
      link: recordLink(root, { file }),
      record: { section: item.section, done: item.done, links: item.links },
    });
  }
  return [...listed.values()];
}

const baseName = (path: string) => path.replace(/\\/g, "/").split("/").pop() ?? path;

/**
 * 这块白板上要列出来的卡片：上个节点以来新加的、改过的，加上右键标记过的（内容没变也列）。
 * 标记过的排最前（进展、问题、想法），其余照白板上的顺序。
 */
export function cardItems(
  root: string,
  board: string,
  diff: Pick<BoardDiff, "added" | "edited">,
  items: ActivityItems,
  marks: Readonly<Record<string, ActivityMark>>,
): ReviewItem[] {
  const listed: ReviewItem[] = [];
  for (const [id, item] of Object.entries(items)) {
    const change = diff.added.has(id) ? "added" : diff.edited.has(id) ? "edited" : undefined;
    const mark = marks[id];
    if (!change && !mark) continue;
    listed.push({
      id,
      kind: "card",
      title: item.title,
      ...(item.text && { text: item.text }),
      ...(change && { change }),
      ...(mark && { mark }),
      link: recordLink(root, { board, card: id }),
    });
  }
  const rank = (item: ReviewItem) => (item.mark ? ACTIVITY_MARKS.indexOf(item.mark) : ACTIVITY_MARKS.length);
  return listed.sort((a, b) => rank(a) - rank(b));
}

/** compare_snapshots 结果里的一张卡片，只取这里用得到的 */
export interface ComparedCard {
  title: string;
  text?: string;
  notes?: string;
}

/** compare_snapshots 结果里的一块白板，只取这里用得到的 */
export interface ComparedBoard {
  board: string;
  unreadable?: boolean;
  status?: string;
  counts?: { added: number; edited: number; removed: number };
  /** 新加的、改过的卡片（太多时只有前面一部分，truncated 是 true）：写汇报时当材料 */
  added?: ComparedCard[];
  edited?: ComparedCard[];
  truncated?: boolean;
}

/** 别的白板：有变化的各归并成一条。已经删掉的、读不出来的不列 */
export function boardItems(root: string, current: string, boards: readonly ComparedBoard[]): ReviewItem[] {
  return boards.flatMap(({ board, unreadable, status, counts }) => {
    if (board === current || unreadable || status === "gone" || !counts) return [];
    const { added, edited, removed } = counts;
    if (added + edited + removed === 0) return [];
    return [
      {
        id: board,
        kind: "board" as const,
        title: baseName(board).replace(/\.prg$/i, ""),
        counts: { added, edited, removed },
        link: recordLink(root, { board }),
      },
    ];
  });
}

/** 活动记录里的一行，只取这里用得到的 */
export interface LoggedEntry {
  kind: string;
  where: ActivityWhere;
  more?: Record<string, unknown>;
}

/**
 * 从这段时间的活动记录里归并：每篇论文一条（几条批注、几段摘录），每篇改过的笔记一条，
 * 再加上右键标记（卡片编号 → 标成了什么，后标的算数）。entries 最早的在前。
 */
export function logItems(
  root: string,
  entries: readonly LoggedEntry[],
): { papers: ReviewItem[]; notes: ReviewItem[]; marks: Record<string, ActivityMark> } {
  const papers = new Map<string, { where: ActivityWhere; annotations: Set<string>; excerpts: number }>();
  const notes = new Map<string, ReviewItem>();
  const marks: Record<string, ActivityMark> = {};
  for (const { kind, where, more } of entries) {
    if (kind === "mark") {
      const mark = ACTIVITY_MARKS.find((candidate) => candidate === more?.mark);
      if (mark && typeof where.card === "string") marks[where.card] = mark;
      continue;
    }
    if (kind === "note.save") {
      const file = where.file;
      // 项目外的笔记记的是完整路径；汇报文件夹里的是程序生成的报告；进展记录是手填的那一份，另有地方列。
      // 都不算这段时间写的笔记
      if (typeof file !== "string" || /^(?:[\\/]|[a-zA-Z]:)/.test(file) || /^(?:汇报|进展记录)\//.test(file)) continue;
      notes.set(file, { id: file, kind: "note", title: baseName(file), link: recordLink(root, { file }) });
      continue;
    }
    if (!/^(?:annotation\.(?:add|edit|delete)|excerpt\.send)$/.test(kind)) continue;
    const place: ActivityWhere | undefined =
      typeof where.library === "string"
        ? { library: where.library }
        : typeof where.file === "string"
          ? { file: where.file }
          : undefined;
    if (!place) continue;
    const id = place.library !== undefined ? `library:${place.library}` : String(place.file);
    const paper = papers.get(id) ?? { where: place, annotations: new Set<string>(), excerpts: 0 };
    papers.set(id, paper);
    if (kind === "excerpt.send") paper.excerpts++;
    else if (kind === "annotation.delete") paper.annotations.delete(String(where.annotation));
    else paper.annotations.add(String(where.annotation));
  }
  return {
    papers: [...papers].flatMap(([id, { where, annotations, excerpts }]) =>
      annotations.size + excerpts === 0
        ? []
        : [
            {
              id,
              kind: "paper" as const,
              title: baseName(String(where.library ?? where.file)),
              counts: { annotations: annotations.size, excerpts },
              link: recordLink(root, where),
            },
          ],
    ),
    notes: [...notes.values()],
    marks,
  };
}

/** 只讲选中的：这块白板的卡片里选中的留下，其余去掉；别的条目不动 */
export function onlySelected(
  cards: readonly ReviewItem[],
  selected: ReadonlySet<string>,
  dropped: ReadonlySet<string>,
): Set<string> {
  const next = new Set(dropped);
  for (const { id } of cards) {
    if (selected.has(id)) next.delete(id);
    else next.add(id);
  }
  return next;
}

/** 不讲选中的 */
export function dropSelected(
  cards: readonly ReviewItem[],
  selected: ReadonlySet<string>,
  dropped: ReadonlySet<string>,
): Set<string> {
  const next = new Set(dropped);
  for (const { id } of cards) if (selected.has(id)) next.add(id);
  return next;
}

// —— 下面是和程序接起来的部分 ——

export interface StageReviewState {
  project: Project;
  root: string;
  /** 这块白板相对项目文件夹的路径 */
  board: string;
  type: NodeType;
  /** 和哪份快照比；项目里一份快照都没有时没有，这时白板上的卡片全算新加 */
  base?: Snapshot;
  /** 用户敲的原话 */
  note: string;
  /** 去掉不讲的 */
  dropped: ReadonlySet<string>;
  /** 别的白板、论文、笔记：进来时算一次 */
  others: readonly ReviewItem[];
  /** 你自己手填的记录里的事项：这个节点定格以后会封存进去的那些。便签里记了新的会跟着变 */
  records: readonly ReviewItem[];
  /** 别的白板和基准比出来的细节，写汇报时当材料 */
  boards: readonly ComparedBoard[];
  marks: Readonly<Record<string, ActivityMark>>;
}

/** 正在整理的那一次；没在整理是 null */
export const stageReviewAtom = atom<StageReviewState | null>(null);

/** 读项目里的记录（活动记录、快照、批注）用的文件接口 */
export const recordFiles: RecordReader = {
  read: snapshotFiles.read,
  folders: snapshotFiles.folders,
  files: async (path) =>
    (await exists(path)) ? (await readDir(path)).filter((entry) => entry.isFile).map((entry) => entry.name) : [],
};

/** 活动记录一次最多给 300 条：翻到底 */
async function entriesSince(source: ReportSource, since: string | undefined, now: Date): Promise<LoggedEntry[]> {
  const all: LoggedEntry[] = [];
  for (let offset = 0; ; ) {
    const page = await readActivityLog(source, { since: since ?? "1970-01-01", limit: 300, offset }, now);
    if (!page.success) throw new Error(page.error);
    all.push(...page.entries);
    if (!page.truncated || page.next === undefined) return all;
    offset = page.next;
  }
}

/**
 * 进入整理：定好和哪份快照比，画布换成题板的画法，算出别的白板、论文、笔记各有什么。
 * 今天已经定格过同一种类型的节点时，是接着改那一次：基准和它一样，上次去掉的、敲的原话都带回来。
 * 没选项目抛 stageSummary.noProject；白板不在项目里抛 stageReview.outside。
 */
export async function enterStageReview(project: Project, type: NodeType = "meeting", note?: string): Promise<void> {
  const root = ResearchFolder.getRoot();
  if (!root) throw new Error("stageSummary.noProject");
  if (project.uri.scheme !== "file" || !ResearchFolder.isInside(project.uri.fsPath, root)) {
    throw new Error("stageReview.outside");
  }
  await ResearchFolder.ensureRootRegistered();
  // 攒着还没写的活动先落盘，下面要读
  await flushActivityLog();
  const now = new Date();
  const at = localTime(now);
  const snapshots = await listSnapshots(snapshotFiles, root);
  const again = nodeOnDay(snapshots, type, at);
  const since = nodeSince(snapshots, type, at);
  // 记着的那份已经不在了（文件夹被删）：退回再往前的那个节点
  const older = again ? snapshots.slice(snapshots.indexOf(again) + 1) : snapshots;
  const base = snapshots.find((snapshot) => snapshot.name === since) ?? (since ? baselineOf(older) : undefined);

  const board = ResearchFolder.toRelative(project.uri.fsPath, root);
  const source: ReportSource = { root, reader: recordFiles };
  const { papers, notes, marks } = logItems(root, await entriesSince(source, base?.manifest.at, now));
  let compared: ComparedBoard[] = [];
  if (base) {
    const result = await compareSnapshots(
      source,
      { from: base.name },
      {
        path: project.uri.fsPath,
        sidecar: (workspaceFile) =>
          buildAiSidecar({ serializedStage: serialize(project.stage), workspaceFile, researchRoot: root }).json,
      },
      now,
    );
    if (!result.success) throw new Error(result.error);
    compared = result.boards as unknown as ComparedBoard[];
  }
  const boards = boardItems(root, board, compared);
  const records = await reviewRecords(root, type);
  const dropped = new Set(again?.manifest.node?.dropped ?? []);
  showSinceLast(
    project,
    base?.name ?? "",
    base ? await readSnapshotBoard(snapshotFiles, root, base.name, board) : undefined,
    { dropped, lit: new Set(Object.keys(marks)) },
  );
  store.set(stageReviewAtom, {
    project,
    root,
    board,
    type,
    ...(base && { base }),
    note: note ?? again?.manifest.node?.note ?? "",
    dropped,
    others: [...boards, ...papers, ...notes],
    records,
    boards: compared,
    marks,
  });
  // 白板可能暂停着渲染，让它马上重画
  project.loop();
}

/** 这个节点现在定格的话会封存进去的手记：「进行中」里的，加上今天同一个节点已经封存过的 */
async function reviewRecords(root: string, type: NodeType): Promise<ReviewItem[]> {
  const title = nodeTitle(type);
  const [current, before] = await Promise.all([loadNodeRecord(root), loadNodeRecord(root, title)]);
  // 点了打开的是东西主要在的那一份：今天封存过就是封存的那份，没有就是「进行中」
  return recordItems(root, previewSealed(current, before, title), recordPath(before ? title : CURRENT_RECORD));
}

/** 便签里记了新的、勾了一条：整理着的话把「你记的」那一组重新读一遍。没在整理时什么都不做 */
export async function refreshReviewRecords(): Promise<void> {
  const state = store.get(stageReviewAtom);
  if (!state) return;
  const records = await reviewRecords(state.root, state.type);
  // 读的这会儿可能已经退出、或者换了一次整理
  if (store.get(stageReviewAtom) === state) store.set(stageReviewAtom, { ...state, records });
}

/** 退出整理，画布恢复原样。没在整理时什么都不做 */
export function leaveStageReview() {
  const state = store.get(stageReviewAtom);
  if (!state) return;
  hideSinceLast(state.project);
  store.set(stageReviewAtom, null);
  state.project.loop();
}

export function setReviewNote(note: string) {
  const state = store.get(stageReviewAtom);
  if (state) store.set(stageReviewAtom, { ...state, note });
}

export function setReviewDropped(dropped: ReadonlySet<string>) {
  const state = store.get(stageReviewAtom);
  if (!state) return;
  store.set(stageReviewAtom, { ...state, dropped });
  setSinceLastDropped(state.project, dropped);
  state.project.loop();
}

/** 这次整理要写进节点的内容。cards 是这块白板上列出来的卡片（跟着白板的修改现算，所以由界面给） */
export function reviewNode(state: StageReviewState, cards: readonly ReviewItem[]): NodeInput {
  const ids = [...cards, ...state.records, ...state.others].map((item) => item.id);
  return {
    type: state.type,
    title: nodeTitle(state.type),
    note: state.note,
    picked: ids.filter((id) => !state.dropped.has(id)),
    dropped: ids.filter((id) => state.dropped.has(id)),
  };
}

/**
 * 定格一个节点：拍节点快照，再把手填的记录（进展记录/进行中.md）封存进这个节点、换上新的一份。
 * 快照拍好了、记录却没封存成（比如那份记录正开着没保存）时抛 nodeRecord.sealFailed，原因在 cause 里；
 * 这时节点已经在了，处理好以后再定格一次（算同一个节点）就会补上。
 */
export async function freezeNode(state: StageReviewState, cards: readonly ReviewItem[]) {
  const node = reviewNode(state, cards);
  const snapshot = await takeNode(node);
  try {
    await sealNodeRecord(state.root, node.title);
  } catch (cause) {
    throw new Error("nodeRecord.sealFailed", { cause });
  }
  return { node, snapshot };
}

/** 只定格：拍一份节点快照，退出整理。之后的对比从这个节点算起 */
export async function freezeStageReview(cards: readonly ReviewItem[]): Promise<Snapshot | undefined> {
  const state = store.get(stageReviewAtom);
  if (!state) return undefined;
  await flushActivityLog();
  const { snapshot } = await freezeNode(state, cards);
  leaveStageReview();
  return snapshot;
}
