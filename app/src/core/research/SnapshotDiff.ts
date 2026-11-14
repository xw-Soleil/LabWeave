import type { Project } from "@/core/Project";
import { Settings } from "@/core/service/Settings";
import { Color, Vector } from "@graphif/data-structures";
import { serialize } from "@graphif/serializer";
import { Rectangle } from "@graphif/shapes";
import { diffItems, sidecarItems } from "./ActivityLog";
import { buildAiSidecar, type ResearchSidecar, type ResearchSidecarRect } from "./AiSidecarBuilder";
import { ResearchFolder } from "./ResearchFolder";

/*
 * 画布上的「自上次以来」：拿现在的白板和最近一份快照比，
 * 新加的卡片描一圈边，改过的右上角打一个小点，删掉的在原来的位置留一个淡影。
 * 「改没改」和活动记录是同一个标准（只看内容，挪位置不算）；差别不另存，开着的时候现场比。
 */

export interface BoardDiff {
  added: Set<string>;
  edited: Set<string>;
  /** 删掉的卡片：快照里它在哪、叫什么 */
  removed: { id: string; title: string; rect: ResearchSidecarRect }[];
}

/** before 是快照里的文字版，after 是现在的 */
export function compareBoards(before: ResearchSidecar | undefined, after: ResearchSidecar): BoardDiff {
  const known = before ? sidecarItems(before) : {};
  const { added, edited, removed } = diffItems(known, sidecarItems(after));
  const places = new Map(
    [...(before?.cards ?? []), ...(before?.sections ?? [])].map((item) => [item.id, item.rect] as const),
  );
  return {
    added: new Set(added),
    edited: new Set(edited),
    removed: removed.map((id) => ({ id, title: known[id].title, rect: places.get(id)! })),
  };
}

interface Overlay {
  /** 和哪份快照比 */
  name: string;
  base: ResearchSidecar | undefined;
  diff: BoardDiff;
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

/** 打开对比。base 是那份快照里这块白板的文字版；快照里没有这块白板（拍完才建的）就全算新加 */
export function showSinceLast(project: Project, name: string, base: ResearchSidecar | undefined) {
  overlays.set(project, {
    name,
    base,
    diff: compareBoards(base, current(project)),
    revision: project.editRevision,
    computedAt: performance.now(),
  });
}

export function hideSinceLast(project: Project) {
  overlays.delete(project);
}

/** 开着的话：和哪份快照比、三种各多少；没开给 undefined */
export function sinceLastCounts(
  project: Project,
): { name: string; added: number; edited: number; removed: number } | undefined {
  const overlay = overlays.get(project);
  return (
    overlay && {
      name: overlay.name,
      added: overlay.diff.added.size,
      edited: overlay.diff.edited.size,
      removed: overlay.diff.removed.length,
    }
  );
}

const ADDED = new Color(34, 160, 90);
const EDITED = new Color(230, 140, 20);
const OUTLINE_GAP = 5;
const GHOST_FONT_SIZE = 12;

/** 画完卡片以后调。没开对比时什么都不做 */
export function renderSinceLast(project: Project, view: Rectangle) {
  const overlay = overlays.get(project);
  if (!overlay) return;
  // 白板改过了就重新比；连着改的时候隔一会儿比一次，不是每帧都比
  if (overlay.revision !== project.editRevision && performance.now() - overlay.computedAt > REFRESH_MS) {
    try {
      overlay.diff = compareBoards(overlay.base, current(project));
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
    const rect = project.stageManager.get(id)?.collisionBox.getRectangle();
    if (!rect || !view.isCollideWith(rect)) continue;
    project.shapeRenderer.renderRect(
      toView(rect.expandFromCenter(OUTLINE_GAP)),
      Color.Transparent,
      ADDED,
      line,
      (10 + OUTLINE_GAP) * scale,
    );
  }
  for (const id of overlay.diff.edited) {
    const rect = project.stageManager.get(id)?.collisionBox.getRectangle();
    if (!rect || !view.isCollideWith(rect)) continue;
    project.shapeRenderer.renderCircle(
      project.renderer.transformWorld2View(new Vector(rect.right, rect.top)),
      Math.max(3.5, 6 * scale),
      EDITED,
      style.Background,
      line,
    );
  }
}
