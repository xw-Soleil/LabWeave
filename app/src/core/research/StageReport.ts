import type { Project } from "@/core/Project";
import { store } from "@/state";
import { serialize } from "@graphif/serializer";
import { readTextFile } from "@tauri-apps/plugin-fs";
import i18next from "i18next";
import { flushActivityLog, noteSummary, type ActivityMark } from "./ActivityLog";
import { buildAiSidecar, type ResearchSidecar } from "./AiSidecarBuilder";
import { localTime, under } from "./ProjectRecord";
import { readAnnotations, recordLink } from "./ReportTools";
import { reportBusy, startReportTask } from "./ReportTask";
import {
  assertReportAiConfigured,
  collectReportMaterials,
  generateResearchReport,
  type ReportMaterials,
} from "./ResearchReport";
import type { ReportMeta } from "./ResearchReportExport";
import { ResearchFolder } from "./ResearchFolder";
import { takeNode } from "./Snapshot";
import {
  leaveStageReview,
  recordFiles,
  reviewNode,
  stageReviewAtom,
  type ComparedBoard,
  type ReviewItem,
} from "./StageReview";

/*
 * 阶段小结的汇报：整理时勾选的条目和敲的原话编成材料（S1、S2……），交给汇报引擎（ResearchReport.ts）
 * 在后台生成报告和 PPT。这里管两件事：材料怎么取；定格以后怎么把任务跑起来。
 *
 * 报告是给人看的中文文档，材料的标签、待核对项这些直接写中文，不走文案文件。
 */

const MARK_LABEL: Record<ActivityMark, string> = { progress: "进展", problem: "问题", idea: "想法" };
const CHANGE_LABEL = { added: "新加", edited: "改过" } as const;
const MAX_PAPER_ANNOTATIONS = 40;
const MAX_SECTION_SHOTS = 6;

/** 一条批注里这里用得到的几样（read_annotations 给的就是这个样子） */
export interface ReportAnnotation {
  page?: number;
  pageLabel?: unknown;
  text?: string;
  comment?: string;
  created?: string;
  modified?: string;
  link?: string;
}

export interface StageReportInput {
  root: string;
  /** 这块白板相对项目文件夹的路径 */
  board: string;
  /** 这块白板现在的文字版 */
  sidecar: ResearchSidecar;
  /** 节点的名字 */
  title: string;
  /** 勾着要讲的条目：这块白板的卡片，加上别的白板、论文、笔记 */
  picked: readonly ReviewItem[];
  /** 用户敲的原话 */
  note: string;
  /** 别的白板和基准比出来的细节 */
  boards: readonly ComparedBoard[];
  /** 基准那份快照的时间：论文只取这之后动过的批注 */
  since?: string;
}

export interface StageReportIO {
  /** 读项目里的一篇笔记，path 相对项目文件夹 */
  readNote(path: string): Promise<string>;
  /** 读一篇论文的批注；读不出来给 undefined */
  annotations(place: { file: string } | { library: string }): Promise<ReportAnnotation[] | undefined>;
  /** 图片卡片的原图；不是图片卡片给 undefined */
  cardImage(id: string): Promise<Uint8Array | undefined>;
  /** 给一个分组截一张图 */
  sectionImage(id: string): Promise<Uint8Array | undefined>;
}

// 相对链接要放进 Markdown 的 [文字](链接) 里：空格、括号这些会把它截断。中文不转，报告的源文件还看得懂
const linkPath = (path: string) =>
  path
    .replace(/\\/g, "/")
    .replace(/[\s%&=+#?()<>[\]"'`]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);

const withoutFrontmatter = (text: string) => text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n*/, "");

/**
 * 把勾选的条目编成材料。顺序就是编号的顺序，也是超过上限时谁先占额度的顺序：
 * 原话 → 这块白板的卡片（标记过的在前）→ 卡片之间的连线 → 图 → 别的白板 → 论文的批注 → 笔记。
 */
export async function collectStageMaterials(
  input: StageReportInput,
  io: StageReportIO,
  signal?: AbortSignal,
): Promise<ReportMaterials> {
  const { root, board, sidecar, picked } = input;
  const materials = collectReportMaterials(signal);
  const note = input.note.trim();
  if (note) materials.add({ path: `节点：${input.title}`, label: "这次想讲的", text: note });

  const cardsById = new Map(sidecar.cards.map((card) => [card.id, card]));
  const sectionsById = new Map(sidecar.sections.map((section) => [section.id, section]));
  const titleOf = (id: string) => cardsById.get(id)?.title || sectionsById.get(id)?.title || "（没有标题）";
  /** 卡片编号 → 它那条材料的编号 */
  const sources = new Map<string, string>();
  const cards = picked.filter((item) => item.kind === "card");
  for (const item of cards) {
    const card = cardsById.get(item.id);
    const section = sectionsById.get(item.id);
    const group = card?.sectionId ? sectionsById.get(card.sectionId)?.title : undefined;
    const title = card?.title || section?.title || item.title || "（没有标题）";
    const text = [
      item.change && `（上个节点以来${CHANGE_LABEL[item.change]}的）`,
      card ? card.text : item.text,
      section && section.children.length > 0 && `分组里有：${section.children.map(titleOf).join("、")}`,
      (card?.notes || section?.notes) && `备注：${card?.notes || section?.notes}`,
      group && `所在分组：${group}`,
      card?.file && `来源文件：${card.file.path}${card.file.page ? ` 第 ${card.file.page} 页` : ""}`,
      card?.url && `链接：${card.url}`,
    ]
      .filter(Boolean)
      .join("\n");
    const id = materials.add({
      path: `${board}#${item.id}`,
      label: `${item.mark ? `【${MARK_LABEL[item.mark]}】` : ""}${title}`,
      text: text || title,
      link: item.link ?? recordLink(root, { board, card: item.id }),
    });
    if (id) sources.set(item.id, id);
  }

  const relations = sidecar.edges
    .filter((edge) => sources.has(edge.from) && sources.has(edge.to))
    .map((edge) => `${titleOf(edge.from)} → ${titleOf(edge.to)}${edge.label ? `：${edge.label}` : ""}`);
  if (relations.length > 0) {
    materials.add({
      path: board,
      label: "卡片之间的连线",
      text: relations.join("\n"),
      link: recordLink(root, { board }),
    });
  }

  for (const item of cards) {
    const source = sources.get(item.id);
    if (!source) continue;
    signal?.throwIfAborted();
    const bytes = await io.cardImage(item.id);
    if (bytes) await materials.addImage(bytes, source, titleOf(item.id));
  }
  // 一个分组里有两张以上要讲的，给这个分组截一张图：卡片怎么摆、怎么连，一眼能看到
  let shots = 0;
  for (const section of sidecar.sections) {
    const inside = section.children.filter((id) => sources.has(id));
    if (inside.length < 2) continue;
    if (shots >= MAX_SECTION_SHOTS) {
      materials.warn(`分组比较多，只给前 ${MAX_SECTION_SHOTS} 个配了截图。`);
      break;
    }
    signal?.throwIfAborted();
    const label = `分组「${section.title || "没有标题"}」`;
    // 这个分组自己也勾着，图就配给它那一条；没有就另加一条
    const source =
      sources.get(section.id) ??
      materials.add({
        path: `${board}#${section.id}`,
        label,
        text: [`这个分组里这次要讲的：${inside.map(titleOf).join("、")}`, section.notes && `备注：${section.notes}`]
          .filter(Boolean)
          .join("\n"),
        link: recordLink(root, { board, card: section.id }),
      });
    if (!source) continue;
    let bytes: Uint8Array | undefined;
    try {
      bytes = await io.sectionImage(section.id);
    } catch {
      // 截图没成不挡着出汇报：在报告的待核对项里说一声
      materials.warn(`分组的截图没有截成：${label}`);
    }
    if (bytes) {
      await materials.addImage(bytes, source, label);
      shots++;
    }
  }

  for (const item of picked.filter((candidate) => candidate.kind === "board")) {
    const compared = input.boards.find((candidate) => candidate.board === item.id);
    const counts = compared?.counts ?? { added: 0, edited: 0, removed: 0 };
    const listed = (name: string, list: ComparedBoard["added"]) =>
      list?.length
        ? [
            `${name}：`,
            ...list.map(
              (card) =>
                `- ${[card.title, card.text, card.notes && `备注：${card.notes}`].filter(Boolean).join("｜") || "（没有文字）"}`,
            ),
          ]
        : [];
    materials.add({
      path: item.id,
      label: `白板「${item.title}」`,
      text: [
        `上个节点以来：新加 ${counts.added} 张、改了 ${counts.edited} 张、删了 ${counts.removed} 张。`,
        ...listed("新加的", compared?.added),
        ...listed("改过的", compared?.edited),
        ...(compared?.truncated ? ["（卡片太多，只列了一部分）"] : []),
      ].join("\n"),
      link: item.link,
    });
  }

  const sinceMs = input.since ? Date.parse(input.since) : Number.NaN;
  for (const item of picked.filter((candidate) => candidate.kind === "paper")) {
    signal?.throwIfAborted();
    const inLibrary = item.id.startsWith("library:");
    const path = inLibrary ? item.id.slice("library:".length) : item.id;
    const all = await io.annotations(inLibrary ? { library: path } : { file: path });
    if (!all) {
      materials.warn(`论文的批注读不出来，未纳入：${item.title}`);
      continue;
    }
    const recent = all.filter((annotation) => {
      if (!annotation.text && !annotation.comment) return false;
      const at = Date.parse(annotation.modified ?? annotation.created ?? "");
      // 没记时间的分不清是哪段时间的：这篇论文这段时间确实动过，算进来
      return Number.isNaN(sinceMs) || Number.isNaN(at) || at >= sinceMs;
    });
    if (recent.length === 0) {
      materials.warn(`论文这段时间没有带文字的批注，未纳入：${item.title}`);
      continue;
    }
    for (const annotation of recent.slice(0, MAX_PAPER_ANNOTATIONS)) {
      const page = typeof annotation.pageLabel === "string" ? annotation.pageLabel : annotation.page;
      materials.add({
        path: `${path}${annotation.page ? `#page=${annotation.page}` : ""}`,
        label: `${item.title}${page ? ` · 第 ${page} 页` : ""}`,
        text: [annotation.text, annotation.comment && `批注：${annotation.comment}`].filter(Boolean).join("\n"),
        link: annotation.link ?? item.link,
      });
    }
    if (recent.length > MAX_PAPER_ANNOTATIONS) {
      materials.warn(`论文的批注比较多，只放了前 ${MAX_PAPER_ANNOTATIONS} 条：${item.title}`);
    }
  }

  for (const item of picked.filter((candidate) => candidate.kind === "note")) {
    signal?.throwIfAborted();
    let text: string;
    try {
      text = await io.readNote(item.id);
    } catch {
      // 笔记被删了、挪走了：这一篇不放，在待核对项里说一声
      materials.warn(`笔记读不出来，未纳入：${item.title}`);
      continue;
    }
    // 报告在 汇报/节点名/ 里，往上两级是项目文件夹
    materials.add({
      path: item.id,
      label: item.title,
      text: withoutFrontmatter(text),
      link: `../../${linkPath(item.id)}`,
    });
  }
  return materials.done();
}

// —— 下面是和程序接起来的部分 ——

/** 白板上一个对象（卡片、分组）截一张图；对象已经不在了给 undefined */
async function regionImage(project: Project, id: string): Promise<Uint8Array | undefined> {
  const entity = project.stageManager.getEntities().find((candidate) => candidate.uuid === id);
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

/** 勾着的卡片里带图的（图片卡片、PDF 框选的摘录）：卡片编号 → 图。趁白板还开着先拿到手 */
function attachedImages(project: Project, cards: readonly ReviewItem[]): Map<string, Blob> {
  const wanted = new Set(cards.map((card) => card.id));
  const found = new Map<string, Blob>();
  for (const entity of project.stageManager.getEntities()) {
    if (!wanted.has(entity.uuid)) continue;
    const attachment = (entity as { attachmentId?: unknown }).attachmentId;
    const blob = typeof attachment === "string" ? project.attachments.get(attachment) : undefined;
    // SVG 放不进 PPT
    if (blob && /^image\/(?!svg)/.test(blob.type)) found.set(entity.uuid, blob);
  }
  return found;
}

async function libraryAnnotations(path: string): Promise<unknown> {
  const [{ Settings }, { annotationIO, annotationTarget }] = await Promise.all([
    import("@/core/service/Settings"),
    import("./PdfAnnotationStore"),
  ]);
  const library = Settings.literatureLibraryPath;
  if (!library) return [];
  const target = await annotationTarget(ResearchFolder.toAbsolute(path, library));
  return (await annotationIO.load(target)).annotations;
}

const projectNameOf = (root: string) => root.replace(/\\/g, "/").split("/").filter(Boolean).at(-1) ?? "";

/**
 * 定格并生成汇报：拍节点快照，退出整理，汇报在后台生成（右下角有进度，能取消）。
 * 生成完报告在标签页里打开。之后白板的对比从这个节点算起。
 * AI 接口没配好抛 researchReport.aiNotConfigured，已经有一份在生成抛 researchReport.busy，
 * 什么都没勾也没敲话抛 researchReport.nothingPicked——这三种都不会定格。
 */
export async function freezeAndReport(cards: readonly ReviewItem[]): Promise<void> {
  const state = store.get(stageReviewAtom);
  if (!state) return;
  if (reportBusy()) throw new Error("researchReport.busy");
  await assertReportAiConfigured();
  const { project, root, board, base } = state;
  const all = [...cards, ...state.others];
  const picked = all.filter((item) => !state.dropped.has(item.id));
  if (picked.length === 0 && !state.note.trim()) throw new Error("researchReport.nothingPicked");
  const skip = all.filter((item) => state.dropped.has(item.id)).map((item) => item.title);

  await flushActivityLog();
  const node = reviewNode(state, cards);
  const snapshot = await takeNode(node);
  const until = localTime(new Date());
  const meta: ReportMeta = {
    title: node.title,
    type: i18next.t(`stageNode.types.${node.type}`, { ns: "research" }),
    project: projectNameOf(root),
    ...(base && { since: base.manifest.at }),
    until,
    ...(snapshot && { snapshot: snapshot.name }),
  };
  const input: StageReportInput = {
    root,
    board,
    sidecar: buildAiSidecar({
      serializedStage: serialize(project.stage),
      workspaceFile: project.uri.fsPath,
      researchRoot: root,
    }).json,
    title: node.title,
    picked,
    note: state.note,
    boards: state.boards,
    ...(base && { since: base.manifest.at }),
  };
  const images = attachedImages(
    project,
    picked.filter((item) => item.kind === "card"),
  );
  // 先退出整理再截图：压暗、描边这些题板上的标记不能截进去
  leaveStageReview();

  const io: StageReportIO = {
    readNote: (path) => readTextFile(under(root, path)),
    async annotations(place) {
      const result = await readAnnotations({ root, reader: recordFiles }, place, { library: libraryAnnotations });
      return result.success && "annotations" in result ? (result.annotations as ReportAnnotation[]) : undefined;
    },
    async cardImage(id) {
      const blob = images.get(id);
      return blob && new Uint8Array(await blob.arrayBuffer());
    },
    sectionImage: (id) => regionImage(project, id),
  };
  startReportTask({
    root,
    title: node.title,
    async run(signal, onProgress) {
      onProgress({ stage: "collecting" });
      const materials = await collectStageMaterials(input, io, signal);
      return generateResearchReport({ root, meta, skip, signal, onProgress }, materials);
    },
    onDone(result) {
      // 活动记录里记一行：哪天出了哪份汇报
      noteSummary(root, result.markdownPath, {
        ...(meta.since && { since: meta.since }),
        until,
        ...(meta.snapshot && { snapshot: meta.snapshot }),
      });
      void flushActivityLog();
    },
  });
}
