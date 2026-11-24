import type { Project } from "@/core/Project";
import { Settings } from "@/core/service/Settings";
import { serialize } from "@graphif/serializer";
import { exists, mkdir, readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import i18next from "i18next";
import { toast } from "sonner";
import { buildAiSidecar } from "./AiSidecarBuilder";
import type { DocumentTab } from "./DocumentTab";
import type { LibraryItem } from "./Library";
import type { PdfAnnotation } from "./PdfAnnotations";
import {
  ACTIVITY_LOG_FILE,
  ACTIVITY_STATE_FILE,
  TEXT_CHARS,
  TITLE_CHARS,
  clip,
  diffItems,
  fingerprint,
  localTime,
  sidecarItems,
  type ActivityEntry,
  type ActivityItem,
  type ActivityItems,
  type ActivityKind,
  type ActivityState,
  type ActivityWhere,
} from "./ProjectRecord";
import { ResearchFolder } from "./ResearchFolder";

/*
 * 活动记录：项目里干了什么，程序自己记下来，以后做阶段小结、让 AI 写汇报都从这里取。
 *
 * 不是一下一下记的，是比出来的：每次保存后把这次的内容交过来，过一会儿和「上次记到哪」比一遍，
 * 多了什么、改了什么、少了什么各记一行。白板每 10 秒自动存一次、批注每半秒存一次，
 * 一张卡片打一段话会存很多回，所以攒着：停手两分钟、或者最多十分钟写一批。
 * 「上次记到哪」单独存一个文件，程序崩了、外面的 AI 直接改了白板文件，下次打开时也能补记。
 */

// 记录的格式和读的那一半在 ProjectRecord.ts（命令行里也要用，不能带着这里的界面和桌面端接口）
export {
  ACTIVITY_LOG_FILE,
  ACTIVITY_STATE_FILE,
  diffItems,
  localTime,
  sidecarItems,
  type ActivityEntry,
  type ActivityItem,
  type ActivityItems,
  type ActivityKind,
  type ActivityWhere,
} from "./ProjectRecord";

const QUIET_MS = 2 * 60 * 1000;
const MAX_WAIT_MS = 10 * 60 * 1000;

export interface ActivityIO {
  /** 文件不存在时给 undefined */
  read(path: string): Promise<string | undefined>;
  append(path: string, text: string): Promise<void>;
  write(path: string, text: string): Promise<void>;
}

const posix = (path: string) => path.replace(/\\/g, "/");
const fileName = (path: string) => posix(path).split("/").pop() ?? path;
const folderOf = (path: string) => posix(path).slice(0, Math.max(posix(path).lastIndexOf("/"), 0));

/** 一个文件在记录里怎么写：项目里的写相对路径，文献库里的写相对文献库的路径，别处的写完整路径 */
export function whereOfFile(path: string, root: string, library = ""): ActivityWhere {
  if (ResearchFolder.isInside(path, root)) return { file: ResearchFolder.toRelative(path, root) };
  if (library && ResearchFolder.isInside(path, library)) return { library: ResearchFolder.toRelative(path, library) };
  return { file: posix(path) };
}

/** 一块白板存盘时的卡片。比 sidecarItems 多一样：从 PDF 发上来的摘录卡片，记着它摘自哪个文件 */
export function boardItems(
  serializedStage: unknown[],
  board: { path: string; root: string; library?: string },
): ActivityItems {
  const { json } = buildAiSidecar({ serializedStage, workspaceFile: board.path, researchRoot: board.root });
  const items = sidecarItems(json);
  // 文字版里研究文件夹外的文件只留文件名；摘录卡片要知道 PDF 在哪，从原始数据里取。
  // 分组框里的卡片第一次出现是在框的 children 里（顶层那一格只是个回指），所以要顺着 children 找
  const stored = new Map<string, string>();
  const collect = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    const { uuid, sourcePath, children } = value as { uuid?: unknown; sourcePath?: unknown; children?: unknown };
    if (typeof uuid === "string" && typeof sourcePath === "string") stored.set(uuid, sourcePath);
    if (Array.isArray(children)) children.forEach(collect);
  };
  serializedStage.forEach(collect);
  for (const card of json.cards) {
    if (!card.file?.page) continue;
    // 卡片里存的路径相对白板所在的文件夹；研究文件夹外的存的是完整路径，toAbsolute 两种都认
    const absolute = ResearchFolder.toAbsolute(stored.get(card.id) ?? card.file.path, folderOf(board.path));
    items[card.id].source = {
      ...whereOfFile(absolute, board.root, board.library),
      page: card.file.page,
      ...(card.file.annotation && { annotation: card.file.annotation }),
    };
  }
  return items;
}

/** 一个 PDF 上自己划的批注（PDF 里自带的不算） */
export function annotationItems(annotations: readonly PdfAnnotation[]): ActivityItems {
  const items: ActivityItems = {};
  for (const annotation of annotations) {
    if (annotation.readOnly) continue;
    items[annotation.id] = {
      f: fingerprint([
        annotation.type,
        annotation.color,
        annotation.text ?? "",
        annotation.comment,
        annotation.tags.map((tag) => tag.name),
      ]),
      title: "",
      text: clip(annotation.text ?? "", TEXT_CHARS),
      more: {
        type: annotation.type,
        color: annotation.color,
        ...(annotation.comment && { comment: clip(annotation.comment, TEXT_CHARS) }),
        ...(annotation.tags.length > 0 && { tags: annotation.tags.map((tag) => tag.name) }),
        ...(annotation.pageLabel !== String(annotation.position.pageIndex + 1) && { pageLabel: annotation.pageLabel }),
      },
      page: annotation.position.pageIndex + 1,
      created: annotation.dateCreated,
      modified: annotation.dateModified,
    };
  }
  return items;
}

type Timestamped<T> = T & { at: Date };
interface Pending {
  boards: Map<string, Timestamped<{ first: () => ActivityItems; latest: () => ActivityItems }>>;
  annotations: Map<
    string,
    Timestamped<{ where: ActivityWhere; title: string; first: ActivityItems; latest: ActivityItems }>
  >;
  notes: Map<string, Timestamped<{ where: ActivityWhere; title: string; f: string; chars: number }>>;
  entries: ActivityEntry[];
}

const emptyState = (): ActivityState => ({ v: 1, boards: {}, annotations: {}, notes: {} });

/** 攒着、比对、写文件。和界面无关，文件读写从外面给，测试里换成假的 */
export class ActivityRecorder {
  private pending = new Map<string, Pending>();
  private states = new Map<string, ActivityState>();
  private quiet?: ReturnType<typeof setTimeout>;
  private longest?: ReturnType<typeof setTimeout>;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly io: ActivityIO,
    private readonly options: { now?: () => Date; onError?: (error: unknown) => void } = {},
  ) {}

  private now() {
    return this.options.now?.() ?? new Date();
  }

  private of(root: string): Pending {
    let pending = this.pending.get(root);
    if (!pending) {
      pending = { boards: new Map(), annotations: new Map(), notes: new Map(), entries: [] };
      this.pending.set(root, pending);
    }
    clearTimeout(this.quiet);
    this.quiet = setTimeout(() => void this.flush(), QUIET_MS);
    this.longest ??= setTimeout(() => void this.flush(), MAX_WAIT_MS);
    return pending;
  }

  /**
   * 白板存了一次（或者刚打开）。path 相对项目文件夹，也是这块白板在「记到哪」里的名字：
   * 不用文件里的工作区编号，是因为在访达里复制出来的白板编号相同，会互相覆盖。
   * items 到真要写的时候才算，保存时不多花工夫。
   */
  observeBoard(root: string, path: string, items: () => ActivityItems) {
    const boards = this.of(root).boards;
    // 第一次看到的样子留着：这块白板以前没记过的话，拿它当起点
    boards.set(path, { at: this.now(), first: boards.get(path)?.first ?? items, latest: items });
  }

  observeAnnotations(root: string, key: string, where: ActivityWhere, title: string, items: ActivityItems) {
    const annotations = this.of(root).annotations;
    annotations.set(key, { where, title, at: this.now(), first: annotations.get(key)?.first ?? items, latest: items });
  }

  observeNote(root: string, key: string, where: ActivityWhere, title: string, text: string) {
    this.of(root).notes.set(key, { where, title, at: this.now(), f: fingerprint(text), chars: text.length });
  }

  /** 不用比对、当场就能定下来的一行：文献库加了一篇、右键标了一下 */
  add(root: string, entry: Omit<ActivityEntry, "at" | "project">) {
    this.of(root).entries.push({ at: localTime(this.now()), project: fileName(root), ...entry });
  }

  /** 把攒着的都写掉。关标签、切项目、关程序前要调 */
  flush(): Promise<void> {
    clearTimeout(this.quiet);
    clearTimeout(this.longest);
    this.quiet = this.longest = undefined;
    const run = () => this.write();
    this.queue = this.queue.then(run, run);
    return this.queue;
  }

  dispose() {
    clearTimeout(this.quiet);
    clearTimeout(this.longest);
  }

  private async state(root: string): Promise<ActivityState> {
    const known = this.states.get(root);
    if (known) return known;
    const text = await this.io.read(ResearchFolder.toAbsolute(ACTIVITY_STATE_FILE, root));
    let state = emptyState();
    if (text) {
      try {
        state = { ...state, ...(JSON.parse(text) as Partial<ActivityState>) };
      } catch (error) {
        // 写到一半断电会留下半个文件：当成没记过，从现状重新开始，并告诉用户
        this.options.onError?.(error);
      }
    }
    this.states.set(root, state);
    return state;
  }

  private async write() {
    for (const [root, pending] of [...this.pending]) {
      this.pending.delete(root);
      try {
        const state = await this.state(root);
        // 在副本上算：记录没写成的话，「记到哪」不能先往前挪
        const next = JSON.parse(JSON.stringify(state)) as ActivityState;
        const entries = [...pending.entries, ...this.compare(root, pending, next)];
        entries.sort((a, b) => a.at.localeCompare(b.at));
        if (entries.length > 0) {
          await this.io.append(
            ResearchFolder.toAbsolute(ACTIVITY_LOG_FILE, root),
            entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""),
          );
        }
        // 这一批已经写进记录了：「记到哪」先在内存里往前挪，当场定下来的那几行也清掉。
        // 下面存不上的话，至少这次运行里不会重复记
        this.states.set(root, next);
        pending.entries = [];
        if (JSON.stringify(next) !== JSON.stringify(state)) {
          await this.io.write(ResearchFolder.toAbsolute(ACTIVITY_STATE_FILE, root), JSON.stringify(next));
        }
      } catch (error) {
        // 没写成的放回去，下一次再试；这期间又攒下的排在它后面
        const newer = this.pending.get(root);
        if (newer) {
          for (const [key, board] of newer.boards) {
            pending.boards.set(key, { ...board, first: pending.boards.get(key)?.first ?? board.first });
          }
          for (const [key, annotations] of newer.annotations) {
            pending.annotations.set(key, {
              ...annotations,
              first: pending.annotations.get(key)?.first ?? annotations.first,
            });
          }
          for (const [key, note] of newer.notes) pending.notes.set(key, note);
          pending.entries.push(...newer.entries);
        }
        this.pending.set(root, pending);
        this.options.onError?.(error);
      }
    }
  }

  /** 把攒着的和「上次记到哪」比一遍，得出要写的几行，并把 next 改成新的「记到哪」 */
  private compare(root: string, pending: Pending, next: ActivityState): ActivityEntry[] {
    const project = fileName(root);
    const entries: ActivityEntry[] = [];
    for (const [path, board] of pending.boards) {
      let latest: ActivityItems;
      let known: ActivityItems | undefined;
      try {
        latest = board.latest();
        known = next.boards[path] ?? (board.first === board.latest ? undefined : board.first());
      } catch (error) {
        // 这块白板的内容理不出来：只丢它这一次，别的照常记，下次保存再比
        this.options.onError?.(error);
        continue;
      }
      next.boards[path] = latest;
      if (!known) continue;
      const at = localTime(board.at);
      const entry = (kind: ActivityKind, id: string, item: ActivityItem): ActivityEntry => ({
        at,
        project,
        kind,
        where: { board: path, card: id, ...(kind === "excerpt.send" && item.source) },
        title: item.title,
        ...(item.text && { text: item.text }),
        ...(item.more && { more: item.more }),
      });
      const { added, edited, removed } = diffItems(known, latest);
      for (const id of added) entries.push(entry(latest[id].source ? "excerpt.send" : "card.add", id, latest[id]));
      for (const id of edited) entries.push(entry("card.edit", id, latest[id]));
      for (const id of removed) entries.push(entry("card.delete", id, known[id]));
    }
    for (const [key, file] of pending.annotations) {
      const known = next.annotations[key] ?? (file.first === file.latest ? undefined : file.first);
      next.annotations[key] = file.latest;
      if (!known) continue;
      const seen = localTime(file.at);
      const entry = (kind: ActivityKind, id: string, item: ActivityItem, time?: string): ActivityEntry => ({
        // 批注自己记着什么时候划的、什么时候改的，比「什么时候看到的」准
        at: time && !Number.isNaN(Date.parse(time)) ? localTime(new Date(time)) : seen,
        project,
        kind,
        where: { ...file.where, ...(item.page && { page: item.page }), annotation: id },
        title: file.title,
        ...(item.text && { text: item.text }),
        ...(item.more && { more: item.more }),
      });
      const { added, edited, removed } = diffItems(known, file.latest);
      for (const id of added) {
        entries.push(entry("annotation.add", id, file.latest[id], file.latest[id].created ?? file.latest[id].modified));
      }
      for (const id of edited) entries.push(entry("annotation.edit", id, file.latest[id], file.latest[id].modified));
      for (const id of removed) entries.push(entry("annotation.delete", id, known[id]));
    }
    for (const [key, note] of pending.notes) {
      const known = next.notes[key];
      next.notes[key] = { f: note.f, chars: note.chars };
      // 没改内容的保存（连按 ⌘S）不记
      if (known?.f === note.f) continue;
      entries.push({
        at: localTime(note.at),
        project,
        kind: "note.save",
        where: note.where,
        title: note.title,
        more: { chars: note.chars, ...(known && { delta: note.chars - known.chars }) },
      });
    }
    return entries;
  }
}

// —— 下面是和程序接起来的部分。没有 startActivityLog 就什么都不做（别的模块的测试、命令行都不受影响）——

const fsIO: ActivityIO = {
  read: async (path) => ((await exists(path)) ? await readTextFile(path) : undefined),
  append: async (path, text) => {
    if (!(await exists(folderOf(path)))) await mkdir(folderOf(path), { recursive: true });
    await writeTextFile(path, text, { append: true });
  },
  write: async (path, text) => {
    if (!(await exists(folderOf(path)))) await mkdir(folderOf(path), { recursive: true });
    await writeTextFile(path, text);
  },
};

let live: ActivityRecorder | undefined;
const tracked = new Map<Project, () => void>();

// 固定 id：反复写不成时只留一条提示
const report = (error: unknown) =>
  toast.warning(
    i18next.t("activityLog.failed", {
      ns: "research",
      error: error instanceof Error ? error.message : String(error),
      interpolation: { escapeValue: false },
    }),
    { id: "research-activity-log-failed" },
  );

/**
 * 下面这些都是挂在「保存」后面的：记录出了岔子不能连累保存本身，所以只提示、不往外抛
 * （和保存时写 AI 文字版是一个道理）。
 */
function safely<T>(action: () => T): T | undefined {
  try {
    return action();
  } catch (error) {
    report(error);
    return undefined;
  }
}

function watchBoard(recorder: ActivityRecorder, uri: Project["uri"], stage: unknown[]) {
  const root = ResearchFolder.getRoot();
  // 草稿、研究文件夹外临时打开的白板不属于这个项目，不记
  if (!root || uri.scheme !== "file" || !ResearchFolder.isInside(uri.fsPath, root)) return;
  const board = { path: uri.fsPath, root, library: Settings.literatureLibraryPath };
  let items: ActivityItems | undefined;
  recorder.observeBoard(root, ResearchFolder.toRelative(uri.fsPath, root), () => (items ??= boardItems(stage, board)));
}

/** 程序启动时调一次，之后各处的 note… 才起作用。返回的函数用来停掉 */
export function startActivityLog(io: ActivityIO = fsIO): () => void {
  const recorder = new ActivityRecorder(io, { onError: report });
  live = recorder;
  return () => {
    for (const stop of tracked.values()) stop();
    tracked.clear();
    recorder.dispose();
    if (live === recorder) live = undefined;
  };
}

/** 开着的白板变了（开了一块、关了一块）时调：新开的开始盯着它的保存，关掉的把攒着的写掉 */
export function trackActivityBoards(boards: readonly Project[]) {
  const recorder = live;
  if (!recorder) return;
  for (const [project, stop] of tracked) {
    if (boards.includes(project)) continue;
    stop();
    tracked.delete(project);
    void recorder.flush();
  }
  for (const project of boards) {
    if (tracked.has(project)) continue;
    const saved = (event: { uri: Project["uri"]; serializedStage?: unknown[] }) => {
      const { uri, serializedStage } = event;
      if (serializedStage) safely(() => watchBoard(recorder, uri, serializedStage));
    };
    project.on("saved", saved);
    tracked.set(project, () => project.off("saved", saved));
    // 打开时先看一眼：以前记过的，补上这期间在别处改的；没记过的，记下现状当起点
    safely(() => watchBoard(recorder, project.uri, serialize(project.stage)));
  }
}

/** 批注读进来了、或者批注和笔记存成功了 */
export function noteDocument(tab: Pick<DocumentTab, "path" | "kind" | "annotations" | "markdown">) {
  // 没启动时什么都不碰：别的模块的测试里，研究文件夹这些都是假的
  const recorder = live;
  if (!recorder) return;
  safely(() => {
    const root = ResearchFolder.getRoot();
    if (!root) return;
    const where = whereOfFile(tab.path, root, Settings.literatureLibraryPath);
    const key = JSON.stringify(where);
    if (tab.kind === "pdf" && tab.annotations) {
      recorder.observeAnnotations(root, key, where, fileName(tab.path), annotationItems(tab.annotations.annotations));
    } else if (tab.kind === "markdown" && tab.markdown && !tab.markdown.dirty) {
      // 汇报文件夹里是程序生成的报告，打开、改两个字不算这段时间写的笔记
      if (typeof where.file === "string" && /^汇报[\\/]/.test(where.file)) return;
      recorder.observeNote(root, key, where, fileName(tab.path), tab.markdown.text);
    }
  });
}

/** 文献库里新加了一篇 */
export function noteLibraryItem(item: LibraryItem, library: string) {
  const recorder = live;
  if (!recorder) return;
  safely(() => {
    const root = ResearchFolder.getRoot();
    if (!root) return;
    recorder.add(root, {
      kind: "library.add",
      where: { library: ResearchFolder.toRelative(item.dir, library) },
      title: clip(item.title ?? "", TITLE_CHARS),
      more: {
        ...(item.authors?.length && { authors: item.authors }),
        ...(item.year && { year: item.year }),
        pdf: !!item.pdfPath,
      },
    });
  });
}

export const ACTIVITY_MARKS = ["progress", "problem", "idea"] as const;
export type ActivityMark = (typeof ACTIVITY_MARKS)[number];

/**
 * 右键把几张卡片标成「进展 / 问题 / 想法」：各记一行。标记只记在活动记录里，不改白板。
 * 这块白板不属于当前项目（草稿、研究文件夹外临时打开的）时记不了，返回 false。
 */
export function noteCardMarks(
  project: Pick<Project, "uri" | "stage">,
  cards: readonly { uuid: string }[],
  mark: ActivityMark,
): boolean {
  if (!live) return false;
  const root = ResearchFolder.getRoot();
  const { uri } = project;
  if (!root || uri.scheme !== "file" || !ResearchFolder.isInside(uri.fsPath, root)) return false;
  const items = boardItems(serialize(project.stage), {
    path: uri.fsPath,
    root,
    library: Settings.literatureLibraryPath,
  });
  for (const { uuid } of cards) {
    const item = items[uuid];
    if (!item) continue;
    live.add(root, {
      kind: "mark",
      where: { board: ResearchFolder.toRelative(uri.fsPath, root), card: uuid },
      title: item.title,
      ...(item.text && { text: item.text }),
      more: { ...item.more, mark },
    });
  }
  return true;
}

/** 开着的、正在被盯着保存的白板。拍快照时用它们当前的内容，不用盘上可能旧一点的文件 */
export function trackedBoards(): Project[] {
  return [...tracked.keys()];
}

/** 拍了一份快照 */
export function noteSnapshot(root: string, name: string, more: Record<string, unknown>) {
  live?.add(root, { kind: "snapshot", where: { snapshot: name }, title: name, more });
}

/** 出了一份阶段小结的汇报，报告存在 path（项目的「汇报」文件夹里）。more 里记着范围和当时定格的快照 */
export function noteSummary(root: string, path: string, more: Record<string, unknown>) {
  live?.add(root, { kind: "summary", where: whereOfFile(path, root), title: fileName(path), more });
}

export function flushActivityLog(): Promise<void> {
  return live?.flush() ?? Promise.resolve();
}
