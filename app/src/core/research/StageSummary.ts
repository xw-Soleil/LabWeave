import type { Project } from "@/core/Project";
import { Settings } from "@/core/service/Settings";
import { store } from "@/state";
import { exists, mkdir, readDir, readTextFile, writeFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { atom } from "jotai";
import { flushActivityLog, noteSummary } from "./ActivityLog";
import { ACTIVITY_LOG_FILE, localTime, under } from "./ProjectRecord";
import { ResearchFolder } from "./ResearchFolder";
import { buildPptx, type Slide } from "./SlidesExport";
import { nodeTitle, takeNode, type NodeInput } from "./Snapshot";

/*
 * 阶段小结：点一下，定个范围，拍一份快照，让 AI 照「怎么做汇报」的说明写一份报告，
 * 存进「我的进展」；再点一下，把报告改成一页一页的提纲，转成 .pptx 放在报告旁边。
 *
 * AI 那一半走的是 AI 面板里的普通对话：这里只负责拼出要说的话、认出哪条回答是报告、把它存成文件。
 * 发给 AI 的话第一行带着记号和范围（【阶段小结】起 ~ 止），存报告时从这一行把范围读回来，
 * 所以关掉程序再打开，旧对话里的报告照样能存、能出 PPT。
 */

export const SUMMARY_MARK = "【阶段小结】";
export const SLIDES_MARK = "【出 PPT】";
export const PROGRESS_FOLDER = "我的进展";
const DAY_MS = 24 * 60 * 60 * 1000;

export interface SummaryRequest {
  /** 范围，带时区的时间，或者只写到日期 */
  since: string;
  until: string;
  /** 和哪份快照比；项目里只有刚拍的那一份时没有 */
  from?: string;
  /** 做这次小结时拍的快照 */
  to?: string;
}

const validTime = (value: unknown): value is string => typeof value === "string" && !Number.isNaN(Date.parse(value));

/**
 * 默认从哪天写起：上一次小结写到哪；没做过小结就从最早的记录；什么记录都没有就是 7 天前。
 * log 是活动记录文件的全文。
 */
export function summaryStart(
  log: string | undefined,
  now: Date,
): { since: string; lastSummary?: string; startedAt?: string } {
  let startedAt: string | undefined;
  let lastSummary: string | undefined;
  for (const line of (log ?? "").split("\n")) {
    if (!line.trim()) continue;
    let entry: { at?: unknown; kind?: unknown; more?: { until?: unknown } };
    try {
      entry = JSON.parse(line);
    } catch {
      // 写到一半断电留下的半行
      continue;
    }
    const at = entry?.at;
    if (!validTime(at)) continue;
    if (!startedAt || Date.parse(at) < Date.parse(startedAt)) startedAt = at;
    const until = entry.more?.until;
    if (entry.kind === "summary") lastSummary = validTime(until) ? until : at;
  }
  return {
    since: lastSummary ?? startedAt ?? localTime(new Date(now.getTime() - 7 * DAY_MS)),
    ...(lastSummary && { lastSummary }),
    ...(startedAt && { startedAt }),
  };
}

/** 整理时用户给的：敲的原话，去掉不讲的那些条目的标题 */
export interface SummaryPicks {
  note?: string;
  skip?: readonly string[];
}

const MAX_SKIPPED = 40;
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

/** 发给 AI 的话 */
export function summaryPrompt(request: SummaryRequest, picks: SummaryPicks = {}): string {
  const { since, until, from, to } = request;
  const note = oneLine(picks.note ?? "");
  const skip = (picks.skip ?? []).map(oneLine).filter(Boolean);
  return [
    `${SUMMARY_MARK}${since} ~ ${until}`,
    "请写这段时间的阶段小结。先调用 read_report_guide，照里面的步骤取材料：",
    `- read_activity_log：since 填 ${since}，until 填 ${until}。`,
    from && to
      ? `- compare_snapshots：from 填「${from}」，to 填「${to}」（后一份是做这次小结时刚拍的）。`
      : to
        ? `- 这个项目只有做这次小结时刚拍的「${to}」这一份快照，没有可以比的：跳过比快照这一步，并在「没写进来的」里交代。`
        : "- 这次没有快照可以比：跳过比快照这一步，并在「没写进来的」里交代。",
    ...(note ? [`用户自己想讲的（照这个定重点，可以引用原话）：${note}`] : []),
    ...(skip.length > 0
      ? [
          `用户整理时去掉了这些，不要写进报告：${skip.slice(0, MAX_SKIPPED).join("、")}${skip.length > MAX_SKIPPED ? " 等" : ""}`,
        ]
      : []),
    "只输出报告本身：从「# 日期 阶段小结」这一行标题开始，到「没写进来的」一节结束。最前面的属性不用写，程序会加；前后不要加别的话。",
  ].join("\n");
}

/** 一条用户消息是不是「阶段小结」的请求；是的话把范围和快照读回来 */
export function parseSummaryRequest(text: string): SummaryRequest | undefined {
  const head = /^【阶段小结】(\S+) ~ (\S+)$/m.exec(text);
  if (!head) return undefined;
  const from = /from 填「([^」]+)」/.exec(text)?.[1];
  const to = (/to 填「([^」]+)」/.exec(text) ?? /刚拍的「([^」]+)」/.exec(text))?.[1];
  return { since: head[1], until: head[2], ...(from && { from }), ...(to && { to }) };
}

/** AI 的回答像不像一份写完的报告（中途被停掉的、报错的不算） */
export const looksLikeReport = (reply: string) => /^#{1,4}\s*做了什么/m.test(reply);

/** 把 AI 的回答整理成要存的 Markdown：去掉客套话和代码块外壳，最前面换成程序填的属性 */
export function reportMarkdown(reply: string, meta: { project: string; request: SummaryRequest; now: Date }): string {
  let body = reply.trim();
  const fenced = /^```[a-zA-Z]*\n([\s\S]*?)\n```$/.exec(body);
  if (fenced) body = fenced[1].trim();
  body = body.replace(/^---\n[\s\S]*?\n---\n*/, "");
  const heading = body.search(/^# /m);
  if (heading > 0) body = body.slice(heading);
  const day = (time: string) => time.slice(0, 10);
  // 项目名里有 YAML 认的符号时加引号，免得属性读错
  const project = /[,[\]{}:#"'&*!|>%@`]/.test(meta.project) ? JSON.stringify(meta.project) : meta.project;
  return [
    "---",
    "类型: 阶段小结",
    `日期: ${day(localTime(meta.now))}`,
    `范围: ${day(meta.request.since)} ~ ${day(meta.request.until)}`,
    `项目: [${project}]`,
    ...(meta.request.to ? [`快照: ${meta.request.to}`] : []),
    "---",
    "",
    body.trim(),
    "",
  ].join("\n");
}

/** 报告的文件名：2026-11-28 阶段小结.md；同一天的第二份加序号 */
export function reportFileName(now: Date, taken: (name: string) => boolean): string {
  const base = `${localTime(now).slice(0, 10)} 阶段小结`;
  let name = `${base}.md`;
  for (let n = 2; taken(name); n++) name = `${base}-${n}.md`;
  return name;
}

/** 让 AI 把报告改写成提纲的那句话。report 是报告文件的完整路径，转出来的 .pptx 放在它旁边 */
export function slidesPrompt(report: string): string {
  return [
    `${SLIDES_MARK}${report}`,
    "把上面这份阶段小结改写成一页一页的提纲，6 到 10 页。只输出一个 JSON 数组，不要别的话，格式：",
    '[{"title": "这一页的标题", "bullets": ["要点一", "要点二"], "card": "配图用的卡片编号"}]',
    "- 第一页是封面：标题写「日期 阶段小结」，要点写范围和项目名。最后一页写下一步。",
    "- 每页最多 5 条要点，每条不超过 40 个字，不带链接。",
    "- card 是报告里卡片链接 target= 后面的那一串。这一页讲的内容有对应的卡片就填一张，没有就不写这一项。",
  ].join("\n");
}

export function parseSlidesRequest(text: string): { report: string } | undefined {
  const head = /^【出 PPT】(.+)$/m.exec(text);
  return head ? { report: head[1].trim() } : undefined;
}

export interface SlideOutline {
  title: string;
  bullets: string[];
  card?: string;
}

const MAX_SLIDES = 30;
const MAX_BULLETS = 8;

/** 从 AI 的回答里取出提纲。取不出来抛 stageSummary.outlineInvalid */
export function parseOutline(reply: string): SlideOutline[] {
  const invalid = () => new Error("stageSummary.outlineInvalid");
  // 前后可能带着说明文字或代码块外壳：从第一个「[ {」取到最后一个「]」
  const start = reply.search(/\[\s*\{/);
  const end = reply.lastIndexOf("]");
  if (start < 0 || end <= start) throw invalid();
  let value: unknown;
  try {
    value = JSON.parse(reply.slice(start, end + 1));
  } catch {
    throw invalid();
  }
  if (!Array.isArray(value)) throw invalid();
  const slides = value
    .flatMap((item): SlideOutline[] => {
      if (!item || typeof item !== "object") return [];
      const { title, bullets, card } = item as Record<string, unknown>;
      if (typeof title !== "string" || !title.trim()) return [];
      // 模型有时把整条链接或「target=…」填进来，只留编号
      const id = typeof card === "string" ? card.replace(/^.*target=/, "").split(/[&\s)]/)[0] : "";
      return [
        {
          title: title.trim(),
          bullets: (Array.isArray(bullets) ? bullets : [])
            .filter((bullet): bullet is string => typeof bullet === "string" && bullet.trim() !== "")
            .map((bullet) => bullet.trim())
            .slice(0, MAX_BULLETS),
          ...(id && { card: id }),
        },
      ];
    })
    .slice(0, MAX_SLIDES);
  if (slides.length === 0) throw invalid();
  return slides;
}

/** 「我的进展」默认放在项目文件夹的同一级 */
export function defaultProgressFolder(root: string): string {
  const trimmed = root.replace(/[\\/]+$/, "");
  const parent = trimmed.replace(/[\\/][^\\/]*$/, "");
  // 项目文件夹就是盘的根目录时没有上一级，放在它里面
  return under(parent && parent !== trimmed ? parent : trimmed, PROGRESS_FOLDER);
}

// —— 下面是和程序接起来的部分 ——

const projectNameOf = (root: string) => root.replace(/\\/g, "/").split("/").filter(Boolean).at(-1) ?? "";

/** 报告存到哪：设置里填了就用填的，没填用默认位置；还没选项目时是空的 */
export function progressFolder(): string {
  const root = ResearchFolder.getRoot();
  return Settings.progressFolderPath || (root ? defaultProgressFolder(root) : "");
}

const pendingRequestsAtom = atom<string[]>([]);

/** 把一句话交给 AI 面板发出去；面板没开会先打开 */
function askAi(text: string) {
  store.set(pendingRequestsAtom, (pending) => [...pending, text]);
  void import("@/sub/AIWindow").then(({ default: AIWindow }) => AIWindow.open());
}

/** AI 面板用：有要发的话就交给 send。返回的函数用来取消 */
export function subscribeStageRequests(send: (text: string) => void): () => void {
  const consume = () => {
    const pending = store.get(pendingRequestsAtom);
    if (pending.length === 0) return;
    store.set(pendingRequestsAtom, []);
    pending.forEach(send);
  };
  const unsubscribe = store.sub(pendingRequestsAtom, consume);
  consume();
  return unsubscribe;
}

/** 打开「阶段小结」时先看默认从哪天写起。没选项目抛 stageSummary.noProject */
export async function loadSummaryStart(now = new Date()) {
  const root = ResearchFolder.getRoot();
  if (!root) throw new Error("stageSummary.noProject");
  await ResearchFolder.ensureRootRegistered();
  // 攒着还没写的活动先写掉：刚做完一次小结马上再开，也要从上一次接着算
  await flushActivityLog();
  const path = under(root, ACTIVITY_LOG_FILE);
  return summaryStart((await exists(path)) ? await readTextFile(path) : undefined, now);
}

/**
 * 开始做一次阶段小结：定格一个节点，让 AI 写。项目里没有白板时抛 snapshot.noBoard。
 * node 是整理时定好的节点信息（类型、原话、勾选），不给就定格一个什么都没填的「组会」；
 * skip 是去掉不讲的那些条目的标题，写进给 AI 的话里。
 */
export async function startStageSummary(
  range: { since: string; until: string },
  options: { node?: NodeInput; skip?: readonly string[] } = {},
): Promise<void> {
  if (!ResearchFolder.getRoot()) throw new Error("stageSummary.noProject");
  // AI 读的是盘上的活动记录，攒着没写的要先落盘
  await flushActivityLog();
  // 白板的变化和上一个节点比；这一份定格下来以后，它就是下一次的基准
  const taken = await takeNode(options.node ?? { type: "meeting", title: nodeTitle("meeting") });
  const from = taken?.manifest.node?.since;
  askAi(
    summaryPrompt(
      { ...range, ...(from && { from }), ...(taken && { to: taken.name }) },
      { note: options.node?.note, skip: options.skip },
    ),
  );
}

/** 让 AI 把存好的报告改写成 PPT 提纲 */
export function requestSlides(report: string) {
  askAi(slidesPrompt(report));
}

/**
 * 把 AI 写的报告存进「我的进展」，返回文件路径。
 * 同一份报告再存一次不会多出一个文件。存下来的同时在活动记录里记一行，下一次小结从这里接着算。
 */
export async function saveStageReport(reply: string, request: SummaryRequest, now = new Date()): Promise<string> {
  const root = ResearchFolder.getRoot();
  const folder = progressFolder();
  if (!root || !folder) throw new Error("stageSummary.noProject");
  const text = reportMarkdown(reply, { project: projectNameOf(root), request, now });
  if (!(await exists(folder))) await mkdir(folder, { recursive: true });
  const names = new Set((await readDir(folder)).map((entry) => entry.name));
  const today = `${localTime(now).slice(0, 10)} 阶段小结`;
  for (const name of names) {
    if (name.startsWith(today) && name.endsWith(".md") && (await readTextFile(under(folder, name))) === text) {
      return under(folder, name);
    }
  }
  const path = under(
    folder,
    reportFileName(now, (name) => names.has(name)),
  );
  await writeTextFile(path, text);
  noteSummary(root, path, {
    since: request.since,
    until: request.until,
    ...(request.to && { snapshot: request.to }),
  });
  await flushActivityLog();
  return path;
}

/** 提纲里指定的卡片截一张图当配图；卡片不在这块白板上就不配 */
export async function cardImage(project: Project, card: string): Promise<Uint8Array | undefined> {
  const entity = project.stageManager.getEntities().find((candidate) => candidate.uuid === card);
  if (!entity) return undefined;
  const { GenerateScreenshot } = await import("@/core/service/dataGenerateService/generateScreenshot");
  const wasLooping = project.looping;
  const selected = project.stageManager.getSelectedStageObjects();
  // 选中框不要截进去
  project.stageManager.clearSelectAll();
  try {
    const blob = await GenerateScreenshot.generateFromActiveProject(project, entity.collisionBox.getRectangle(), 1600);
    return blob && blob.size > 0 ? new Uint8Array(await blob.arrayBuffer()) : undefined;
  } finally {
    for (const object of selected) object.isSelected = true;
    // 截图会把白板的画面循环停掉，原来在跑的要接着跑
    if (wasLooping) project.loop();
  }
}

/**
 * 把 AI 写的提纲转成 .pptx，放在报告旁边，返回文件路径。
 * report 必须是「我的进展」里的一份报告；提纲读不出来抛 stageSummary.outlineInvalid。
 */
export async function exportSlides(
  reply: string,
  report: string,
  image: (card: string) => Promise<Uint8Array | undefined>,
): Promise<string> {
  // 这个路径是从对话里读回来的，只认「我的进展」里现成的报告，免得往别处写文件
  if (!/\.md$/i.test(report) || !ResearchFolder.isInside(report, progressFolder()) || !(await exists(report))) {
    throw new Error("stageSummary.reportMissing");
  }
  const slides: Slide[] = [];
  for (const { title, bullets, card } of parseOutline(reply)) {
    slides.push({ title, bullets, image: card ? await image(card) : undefined });
  }
  const path = `${report.replace(/\.md$/i, "")}.pptx`;
  await writeFile(path, await buildPptx(slides));
  return path;
}
