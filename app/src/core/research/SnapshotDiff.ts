import type { Project } from "@/core/Project";
import { Settings } from "@/core/service/Settings";
import { Color, Vector } from "@graphif/data-structures";
import { serialize } from "@graphif/serializer";
import { Rectangle } from "@graphif/shapes";
import { diffItems, sidecarItems } from "./ActivityLog";
import { buildAiSidecar, type ResearchSidecar, type ResearchSidecarRect } from "./AiSidecarBuilder";
import type { ActivityItems } from "./ProjectRecord";
import { ResearchFolder } from "./ResearchFolder";

/*
 * 画布上的「自上次小结以来」：拿现在的白板和上一个节点的快照比，
 * 新加的卡片描一圈边，改过的右上角打一个小点，删掉的在原来的位置留一个淡影。
 * 「改没改」和活动记录是同一个标准（只看内容，挪位置不算）；差别不另存，开着的时候现场比。
 *
 * 做阶段小结整理的时候多两种画法，让画布像一块题板：没变的卡片压暗，去掉不讲的卡片变灰。
 */

export interface BoardDiff {
  added: Set<string>;
  edited: Set<string>;
  /** 删掉的卡片：快照里它在哪、叫什么 */
  removed: { id: string; title: string; rect: ResearchSidecarRect }[];
  /** 没变的卡片。不含分组框：把它压暗会连里面的新卡片一起盖住 */
  same: Set<string>;
}

/** before 是快照里的文字版，after 是现在的 */
export function compareBoards(before: ResearchSidecar | undefined, after: ResearchSidecar): BoardDiff {
  const known = before ? sidecarItems(before) : {};
  const { added, edited, removed } = diffItems(known, sidecarItems(after));
  const places = new Map(
    [...(before?.cards ?? []), ...(before?.sections ?? [])].map((item) => [item.id, item.rect] as const),
  );
  const changed = new Set([...added, ...edited]);
  return {
    added: new Set(added),
    edited: new Set(edited),
    removed: removed.map((id) => ({ id, title: known[id].title, rect: places.get(id)! })),
    same: new Set(after.cards.map((card) => card.id).filter((id) => !changed.has(id))),
  };
}

/** 整理时的画法：dropped 是去掉不讲的，变灰；lit 是没变但要亮着的（右键标记过的） */
export interface ReviewMarks {
  dropped: ReadonlySet<string>;
  lit: ReadonlySet<string>;
}

interface Overlay {
  /** 和哪份快照比 */
  name: string;
  base: ResearchSidecar | undefined;
  diff: BoardDiff;
  /** 白板现在的卡片（分组框也算）：标题和内容开头，整理时列清单用 */
  items: ActivityItems;
  review?: ReviewMarks;
  /** 回看历史时：差别是两份快照比出来的，不跟着白板的改动重新比 */
  frozen?: boolean;
  revision: number;
  computedAt: number;
}

const overlays = new WeakMap<Project, Overlay>();
/** 白板在变的时候，最多这么久重新比一次 */
const REFRESH_MS = 500;

function current(project: Project): ResearchSidecar {
  return buildAiSidecar({
    serializedStage: serialize(project.stage),
    workspaceFile: project.uri.fsPath,
    researchRoot: ResearchFolder.getRoot(),
  }).json;
}

function compare(project: Project, base: ResearchSidecar | undefined) {
  const now = current(project);
  return { diff: compareBoards(base, now), items: sidecarItems(now) };
}

/**
 * 打开对比。base 是那份快照里这块白板的文字版；快照里没有这块白板（拍完才建的）就全算新加。
 * 给了 review 就是整理状态。
 */
export function showSinceLast(project: Project, name: string, base: ResearchSidecar | undefined, review?: ReviewMarks) {
  overlays.set(project, {
    name,
    base,
    ...compare(project, base),
    ...(review && { review }),
    revision: project.editRevision,
    computedAt: performance.now(),
  });
}

/**
 * 回看历史用：project 是照某个节点的快照打开的只读白板，after 是那份快照里它的文字版，
 * base 是再前一个节点的。两份都是当时存下的，直接比，不拿白板现算（现算的话文件卡片的路径对不上）。
 */
export function showSnapshotDiff(
  project: Project,
  name: string,
  base: ResearchSidecar | undefined,
  after: ResearchSidecar,
) {
  overlays.set(project, {
    name,
    base,
    diff: compareBoards(base, after),
    items: sidecarItems(after),
    frozen: true,
    revision: project.editRevision,
    computedAt: performance.now(),
  });
}

export function hideSinceLast(project: Project) {
  overlays.delete(project);
}

/** 整理时换一批不讲的卡片 */
export function setSinceLastDropped(project: Project, dropped: ReadonlySet<string>) {
  const overlay = overlays.get(project);
  if (overlay?.review) overlay.review = { ...overlay.review, dropped };
}

/** 开着的话：和哪份快照比、三种各多少、是不是在整理；没开给 undefined */
export function sinceLastCounts(
  project: Project,
): { name: string; added: number; edited: number; removed: number; review: boolean } | undefined {
  const overlay = overlays.get(project);
  return (
    overlay && {
      name: overlay.name,
      added: overlay.diff.added.size,
      edited: overlay.diff.edited.size,
      removed: overlay.diff.removed.length,
      review: !!overlay.review,
    }
  );
}

/** 开着的话：现在比出来的差别和白板上的卡片；白板每改一次、重新比过，computedAt 就换一个 */
export function sinceLastLive(
  project: Project,
): { diff: BoardDiff; items: ActivityItems; computedAt: number } | undefined {
  const overlay = overlays.get(project);
  return overlay && { diff: overlay.diff, items: overlay.items, computedAt: overlay.computedAt };
}

const ADDED = new Color(34, 160, 90);
const EDITED = new Color(230, 140, 20);
const OUTLINE_GAP = 5;
const GHOST_FONT_SIZE = 12;
/** 压暗：盖一层半透明的背景色 */
const VEIL_ALPHA = 0.62;
const DROPPED_ALPHA = 0.45;

/** 画完卡片以后调。没开对比时什么都不做 */
export function renderSinceLast(project: Project, view: Rectangle) {
  const overlay = overlays.get(project);
  if (!overlay) return;
  // 白板改过了就重新比；连着改的时候隔一会儿比一次，不是每帧都比
  if (
    !overlay.frozen &&
    overlay.revision !== project.editRevision &&
    performance.now() - overlay.computedAt > REFRESH_MS
  ) {
    try {
      Object.assign(overlay, compare(project, overlay.base));
    } catch (error) {
      // 这里每帧都会走到：比不出来就关掉对比、报一次错，不能让画布每帧都出错
      overlays.delete(project);
      window.dispatchEvent(new ErrorEvent("error", { error }));
      return;
    }
    overlay.revision = project.editRevision;
    overlay.computedAt = performance.now();
  }
  const scale = project.camera.currentScale;
  const style = project.stageStyleManager.currentStyle;
  const toView = (rect: Rectangle) => project.renderer.transformWorld2View(rect);
  // 缩得很小时线和点也要看得见，所以有个最小的像素尺寸
  const line = Math.max(1.5, 2 * scale);
  const { review } = overlay;
  const dropped = (id: string) => !!review?.dropped.has(id);
  const rectOf = (id: string) => {
    const rect = project.stageManager.get(id)?.collisionBox.getRectangle();
    return rect && view.isCollideWith(rect) ? rect : undefined;
  };

  if (review) {
    // 先盖暗的，再画标记：没变的卡片压暗；去掉不讲的也压暗，另描一圈灰边，看得出它是这段时间动过的
    const veil = style.Background.toNewAlpha(VEIL_ALPHA);
    const gray = style.StageObjectBorder.toNewAlpha(DROPPED_ALPHA);
    const dim = (id: string, border: Color) => {
      const rect = rectOf(id);
      if (rect) project.shapeRenderer.renderRect(toView(rect.expandFromCenter(2)), veil, border, line, 12 * scale);
    };
    for (const id of overlay.diff.same) if (!review.lit.has(id) || dropped(id)) dim(id, Color.Transparent);
    for (const id of [...overlay.diff.added, ...overlay.diff.edited]) if (dropped(id)) dim(id, gray);
  }

  for (const ghost of overlay.diff.removed) {
    const rect = new Rectangle(new Vector(ghost.rect.x, ghost.rect.y), new Vector(ghost.rect.w, ghost.rect.h));
    if (!view.isCollideWith(rect)) continue;
    project.shapeRenderer.renderRect(
      toView(rect),
      style.StageObjectBorder.toNewAlpha(0.05),
      style.StageObjectBorder.toNewAlpha(0.3),
      Math.max(1, scale),
      10 * scale,
    );
    if (ghost.title && GHOST_FONT_SIZE * scale > Settings.ignoreTextNodeTextRenderLessThanFontSize) {
      project.textRenderer.renderFittedText(
        ghost.title,
        project.renderer.transformWorld2View(rect.location.add(new Vector(10, 8))),
        GHOST_FONT_SIZE * scale,
        Math.max(0, rect.size.x - 20) * scale,
        style.StageObjectBorder.toNewAlpha(0.4),
      );
    }
  }
  for (const id of overlay.diff.added) {
    const rect = dropped(id) ? undefined : rectOf(id);
    if (!rect) continue;
    project.shapeRenderer.renderRect(
      toView(rect.expandFromCenter(OUTLINE_GAP)),
      Color.Transparent,
      ADDED,
      line,
      (10 + OUTLINE_GAP) * scale,
    );
  }
  for (const id of overlay.diff.edited) {
    const rect = dropped(id) ? undefined : rectOf(id);
    if (!rect) continue;
    project.shapeRenderer.renderCircle(
      project.renderer.transformWorld2View(new Vector(rect.right, rect.top)),
      Math.max(3.5, 6 * scale),
      EDITED,
      style.Background,
      line,
    );
  }
}
