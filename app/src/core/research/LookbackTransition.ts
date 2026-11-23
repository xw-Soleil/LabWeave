import type { Project } from "@/core/Project";
import type { Association } from "@/core/stage/stageObject/abstract/Association";
import type { Entity } from "@/core/stage/stageObject/abstract/StageEntity";
import { CollisionBox } from "@/core/stage/stageObject/collisionBox/collisionBox";
import { FileCardNode } from "@/core/stage/stageObject/entity/FileCardNode";
import { ImageNode } from "@/core/stage/stageObject/entity/ImageNode";
import { PenStroke } from "@/core/stage/stageObject/entity/PenStroke";
import { ReferenceBlockNode } from "@/core/stage/stageObject/entity/ReferenceBlockNode";
import { Section } from "@/core/stage/stageObject/entity/Section";
import { SvgNode } from "@/core/stage/stageObject/entity/SvgNode";
import { Color, Vector } from "@graphif/data-structures";
import { Rectangle } from "@graphif/shapes";
import {
  easeInOut,
  easeOut,
  easeOutBack,
  planTimeline,
  progress,
  type Span,
  type Timeline,
  type TimelineBoard,
} from "./LookbackTimeline";
import { renderSinceLast } from "./SnapshotDiff";

/*
 * 回看切节点的过渡（打开回看、切节点、回到现在都是它）：换到新白板以后的不到一秒里，
 * 由它按中间的样子来画——两边都有的卡片滑过去、改过的淡变、删掉的淡出、新加的长出来、新连线画出来。
 *
 * 旧白板和新白板的卡片都用原来的画法画，只在画这一帧的时候把卡片的位置借成中间的位置、画完就还，
 * 所以白板的数据不会变，也不会被存成中间的样子。镜头始终是新白板的。
 * 什么时候动什么在 LookbackTimeline.ts。
 */

/** 一帧最多算过了这么久：切过来那一下卡了一帧，动画也不会跳过去一截 */
const MAX_STEP = 40;
/** 新白板的图还没解码出来时，停在最后的样子、用旧白板的图顶着，最多等这么久 */
const IMAGE_GRACE = 800;
/** 没人来画（切到别的标签、窗口藏起来了）时，最晚这时候收场 */
const GIVE_UP = 1500;
const GROW_FROM = 0.8;
const LEAVE_TO = 0.88;

type Paint = (project: Project, entity: Entity) => void;

const boxOf = (entity: Entity) => entity.collisionBox.getRectangle();

/** 图片的大小由缩放倍数定、涂鸦的形状由笔迹定，光借位置变不了大小，要整个缩放 */
const drawsItself = (entity: Entity) =>
  entity instanceof ImageNode ||
  entity instanceof SvgNode ||
  entity instanceof ReferenceBlockNode ||
  entity instanceof PenStroke;

/** 它的图解码出来没有；没有图的总是好的 */
function ready(entity: Entity): boolean {
  if (entity instanceof FileCardNode) return !entity.attachmentId || !!entity.bitmap;
  return !("state" in entity) || entity.state !== "loading";
}

/** 看上去一不一样：文字、颜色、图片编号、选没选中这些；位置和大小不算 */
function look(entity: Entity): string {
  return JSON.stringify(
    Object.entries(entity)
      .map(([key, value]) => [key, value instanceof Color ? value.toString() : value] as const)
      .filter(([key, value]) => key !== "state" && ["string", "number", "boolean"].includes(typeof value))
      .sort(([a], [b]) => (a < b ? -1 : 1)),
  );
}

/** 把卡片的位置借成 box，返回怎么还 */
function lend(entity: Entity, box: Rectangle): () => void {
  const shown: [string, unknown][] = [["collisionBox", new CollisionBox([box])]];
  // 分组框的外框是从四条边现算的，不看碰撞箱
  if (entity instanceof Section) shown.push(["rectangle", box]);
  const kept = shown.map(([key]) => [key, Object.getOwnPropertyDescriptor(entity, key)] as const);
  for (const [key, value] of shown) {
    Object.defineProperty(entity, key, { value, configurable: true, enumerable: true, writable: true });
  }
  return () => {
    for (const [key, own] of kept) {
      if (own) Object.defineProperty(entity, key, own);
      else Reflect.deleteProperty(entity, key);
    }
  };
}

function boardOf(project: Project): TimelineBoard {
  return {
    items: project.stageManager.getEntities().map((entity) => {
      const { location, size } = boxOf(entity);
      return {
        id: entity.uuid,
        box: { x: location.x, y: location.y, w: size.x, h: size.y },
        frame: entity instanceof Section,
      };
    }),
    links: project.stageManager.getAssociations().map((link) => ({
      id: link.uuid,
      ends: link.associationList.map(({ uuid }) => uuid),
    })),
  };
}

class LookbackTransition {
  readonly over: Promise<void>;
  private end!: () => void;
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly timeline: Timeline;
  private readonly revision: number;
  /** 旧白板上的卡片 */
  private readonly old: ReadonlyMap<string, Entity>;
  private readonly gone: readonly Entity[];
  private readonly now: readonly Entity[];
  private readonly goneLinks: readonly Association[];
  private readonly looks = new Map<string, boolean>();
  private time = 0;
  private last?: number;
  /** 这一帧里有卡片的图还没解码出来 */
  private waiting = false;

  constructor(
    readonly from: Project,
    readonly to: Project,
  ) {
    this.timeline = planTimeline(boardOf(from), boardOf(to));
    this.revision = to.editRevision;
    const before = from.stageManager.getEntities();
    this.old = new Map(before.map((entity) => [entity.uuid, entity]));
    this.gone = before.filter(({ uuid }) => this.timeline.removed.has(uuid));
    this.now = to.stageManager.getEntities();
    this.goneLinks = from.stageManager.getAssociations().filter(({ uuid }) => this.timeline.removedLinks.has(uuid));
    this.over = new Promise((resolve) => (this.end = resolve));
    this.timer = setTimeout(() => this.finish(), this.timeline.total + GIVE_UP);
  }

  finish() {
    clearTimeout(this.timer);
    if (playing.get(this.to) === this) playing.delete(this.to);
    if (leaving.get(this.from) === this) leaving.delete(this.from);
    this.end();
  }

  /** 画这一帧；已经到头、不用它画了就返回 false */
  render(view: Rectangle): boolean {
    const { from, to, timeline } = this;
    // 还没播完就在新白板上动手改了，或者旧白板已经拆掉了：直接到头
    if (to.editRevision !== this.revision || !from.getService("entityRenderer")) {
      this.finish();
      return false;
    }
    this.advance();
    if (this.time >= timeline.total && (!this.waiting || this.time >= timeline.total + IMAGE_GRACE)) {
      this.finish();
      return false;
    }
    this.waiting = false;
    this.onNewCanvas(() =>
      this.withBoxes(easeInOut(progress(timeline.move, this.time)), (sizes) => this.paint(view, sizes)),
    );
    return true;
  }

  /** 挂到屏幕上、画面循环跑起来了才开始计时 */
  private advance() {
    if (!this.to.looping || !this.to.canvas.element.isConnected) return;
    const now = performance.now();
    if (this.last !== undefined) this.time += Math.min(now - this.last, MAX_STEP);
    this.last = now;
  }

  /** 旧白板的卡片也画到新白板的画布上，用新白板的镜头 */
  private onNewCanvas(draw: () => void) {
    const { canvas, camera, renderer } = this.from;
    const { ctx } = canvas;
    const { location, currentScale } = camera;
    const { w, h } = renderer;
    canvas.ctx = this.to.canvas.ctx;
    camera.location = this.to.camera.location;
    camera.currentScale = this.to.camera.currentScale;
    renderer.w = this.to.renderer.w;
    renderer.h = this.to.renderer.h;
    try {
      draw();
    } finally {
      canvas.ctx = ctx;
      camera.location = location;
      camera.currentScale = currentScale;
      renderer.w = w;
      renderer.h = h;
    }
  }

  /** 两边都有、挪过或变了大小的卡片，这一帧都摆在中间的位置；draw 拿到的是它们本来的位置和大小 */
  private withBoxes(rate: number, draw: (own: ReadonlyMap<Entity, Rectangle>) => void) {
    const own = new Map<Entity, Rectangle>();
    const giveBack: (() => void)[] = [];
    try {
      for (const entity of this.now) {
        const old = this.old.get(entity.uuid);
        if (!old) continue;
        const [a, b] = [boxOf(old), boxOf(entity)];
        if (a.location.equals(b.location) && a.size.equals(b.size)) continue;
        const between = new Rectangle(
          a.location.add(b.location.subtract(a.location).multiply(rate)),
          a.size.add(b.size.subtract(a.size).multiply(rate)),
        );
        own.set(old, a).set(entity, b);
        giveBack.push(lend(old, between), lend(entity, between));
      }
      draw(own);
    } finally {
      for (const undo of giveBack) undo();
    }
  }

  private paint(view: Rectangle, own: ReadonlyMap<Entity, Rectangle>) {
    const { from, to, timeline, time } = this;
    const isSection = (entity: Entity) => entity instanceof Section;
    const isStroke = (entity: Entity) => entity instanceof PenStroke;
    const isBackdrop = (entity: Entity) => entity instanceof ImageNode && entity.isBackground;
    const isCard = (entity: Entity) => !isSection(entity) && !isStroke(entity) && !isBackdrop(entity);
    const inOrder = () => 0;
    const byTop = (a: Entity, b: Entity) => boxOf(a).top - boxOf(b).top;
    const card: Paint = (project, entity) => project.entityRenderer.renderEntity(entity);
    const layer = (mine: (entity: Entity) => boolean, paint: Paint, order = inOrder as typeof byTop) => {
      for (const entity of this.gone.filter(mine).sort(order)) this.paintLeaving(view, entity, paint);
      for (const entity of this.now.filter(mine).sort(order)) this.paintNow(view, own, entity, paint);
    };

    // 次序和平时一样：分组底色、背景图、卡片、分组标题、涂鸦、连线
    layer(
      isSection,
      (project, entity) => {
        if (project.sectionMethods.isEntityHiddenByBigTitleSection(entity)) return;
        project.sectionRenderer.renderBackgroundColor(entity as Section);
      },
      byTop,
    );
    layer(isBackdrop, card);
    layer(isCard, card);
    layer(isSection, (project, entity) => project.entityRenderer.renderSection(entity as Section));
    layer(isStroke, card);

    this.faded(1 - easeOut(progress(timeline.leave, time)), () => {
      for (const link of this.goneLinks) from.renderer.renderEdge(view, link);
    });
    for (const link of to.stageManager.getAssociations()) {
      const span = timeline.addedLinks.get(link.uuid);
      if (!span) to.renderer.renderEdge(view, link);
      else this.paintGrowingLink(view, link, span);
    }

    to.entityRenderer.renderAllSectionsBigTitle(view);
    to.renderer.renderTags(view);
    // 旧的标记先淡掉，新的最后浮出来
    this.faded(1 - easeOut(Math.min(1, time / 120)), () => renderSinceLast(from, view));
    this.faded(easeOut(progress(timeline.marks, time)), () => renderSinceLast(to, view));
  }

  private faded(alpha: number, draw: () => void) {
    if (alpha <= 0) return;
    const { ctx } = this.to.canvas;
    ctx.save();
    try {
      ctx.globalAlpha = alpha;
      draw();
    } finally {
      ctx.restore();
    }
  }

  /** 以 at（世界坐标）为定点，把后面画的东西缩放 x、y 倍 */
  private scale(at: Vector, x: number, y: number) {
    const { ctx } = this.to.canvas;
    const { x: left, y: top } = this.to.renderer.transformWorld2View(at);
    ctx.translate(left, top);
    ctx.scale(x, y);
    ctx.translate(-left, -top);
  }

  private paintLeaving(view: Rectangle, entity: Entity, paint: Paint) {
    if (this.to.renderer.isOverView(view, entity)) return;
    const rate = progress(this.timeline.leave, this.time);
    this.faded(1 - easeOut(rate), () => {
      const size = 1 - (1 - LEAVE_TO) * rate;
      this.scale(boxOf(entity).center, size, size);
      paint(this.from, entity);
    });
  }

  private paintNow(view: Rectangle, own: ReadonlyMap<Entity, Rectangle>, entity: Entity, paint: Paint) {
    if (this.to.renderer.isOverView(view, entity)) return;
    // 平时是画到它才去解码预览图：先叫它解码，免得长出来、滑到位了还是空的
    if (entity instanceof FileCardNode) entity.ensureThumbnail();
    const span = this.timeline.added.get(entity.uuid);
    if (span) {
      const rate = progress(span, this.time);
      this.faded(easeOut(Math.min(1, rate * 1.6)), () => {
        const size = GROW_FROM + (1 - GROW_FROM) * easeOutBack(rate);
        this.scale(boxOf(entity).center, size, size);
        paint(this.to, entity);
      });
      return;
    }
    const old = this.old.get(entity.uuid);
    if (!old) {
      paint(this.to, entity);
      return;
    }
    if (!ready(entity) && ready(old)) {
      this.waiting = true;
      this.paintKept(own, this.from, old, 1, paint);
      return;
    }
    let same = this.looks.get(entity.uuid);
    if (same === undefined) this.looks.set(entity.uuid, (same = look(entity) === look(old)));
    if (same) {
      this.paintKept(own, this.to, entity, 1, paint);
      return;
    }
    // 改过的：新旧叠着淡变，中间有一段两张都比较实，底色不会闪
    const rate = progress(this.timeline.move, this.time);
    this.paintKept(own, this.from, old, 1 - easeOut(Math.max(0, (rate - 0.3) / 0.7)), paint);
    this.paintKept(own, this.to, entity, easeOut(Math.min(1, rate / 0.7)), paint);
  }

  private paintKept(
    own: ReadonlyMap<Entity, Rectangle>,
    project: Project,
    entity: Entity,
    alpha: number,
    paint: Paint,
  ) {
    const natural = own.get(entity);
    if (!natural) {
      this.faded(alpha, () => paint(project, entity));
      return;
    }
    const shown = boxOf(entity);
    this.faded(alpha, () => {
      if (!natural.size.equals(shown.size)) {
        if (drawsItself(entity)) {
          if (natural.size.x > 0 && natural.size.y > 0) {
            this.scale(shown.location, shown.size.x / natural.size.x, shown.size.y / natural.size.y);
          }
        } else {
          // 框按中间的大小画，字还是原来的大小：框比字小的时候别让字露到框外面
          const { location, size } = this.to.renderer.transformWorld2View(shown.expandFromCenter(2));
          const { ctx } = this.to.canvas;
          ctx.beginPath();
          ctx.rect(location.x, location.y, size.x, size.y);
          ctx.clip();
        }
      }
      if (!(entity instanceof PenStroke)) {
        paint(project, entity);
        return;
      }
      // 笔迹是一串坐标，借不了位置：挪镜头
      const { camera } = project;
      const { location } = camera;
      camera.location = location.add(natural.location.subtract(shown.location));
      try {
        paint(project, entity);
      } finally {
        camera.location = location;
      }
    });
  }

  /** 新连线：从起点往外露出一个越来越大的圆，看上去就是从起点画到终点 */
  private paintGrowingLink(view: Rectangle, link: Association, span: Span) {
    const rate = progress(span, this.time);
    if (rate <= 0) return;
    if (rate >= 1) {
      this.to.renderer.renderEdge(view, link);
      return;
    }
    const start = link.associationList[0]?.collisionBox.getRectangle().center;
    if (!start) return;
    const { leftTop, rightTop, leftBottom, rightBottom } = link.collisionBox.getRectangle().expandFromCenter(40);
    const reach = Math.max(...[leftTop, rightTop, leftBottom, rightBottom].map((corner) => corner.distance(start)));
    const { x, y } = this.to.renderer.transformWorld2View(start);
    this.faded(1, () => {
      const { ctx } = this.to.canvas;
      ctx.beginPath();
      ctx.arc(x, y, reach * easeOut(rate) * this.to.camera.currentScale, 0, Math.PI * 2);
      ctx.clip();
      this.to.renderer.renderEdge(view, link);
    });
  }
}

/** 正在播的：新白板 → 过渡，旧白板 → 过渡 */
const playing = new WeakMap<Project, LookbackTransition>();
const leaving = new WeakMap<Project, LookbackTransition>();

/**
 * 从 from 过渡到 to。在把 to 切到前面之前调：第一帧（和 from 现在的样子一样）这里就画好，切过去那一下不会闪。
 * from 这块正在播的直接跳到末尾，所以连点不会攒着。系统开了「减弱动态效果」就不播。
 */
export function startLookbackTransition(from: Project, to: Project): void {
  for (const board of [from, to]) {
    playing.get(board)?.finish();
    leaving.get(board)?.finish();
  }
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const transition = new LookbackTransition(from, to);
  playing.set(to, transition);
  leaving.set(from, transition);
  // 「久不操作就停画」按最后一次操作算：点节点条不算在画布上操作，不能因此不画
  to.controller.resetCountdownTimer();
  to.entityRenderer.sortSectionsByZIndex();
  // 刚打开的还没挂到屏幕上，先按旧白板的大小备好；挂上去时大小一样，这一帧就留着
  if (to.renderer.w === 0 || to.renderer.h === 0) to.renderer.resizeWindow(from.renderer.w, from.renderer.h);
  to.renderer.tick();
}

/** 画白板的内容时先问它：返回 true 就是这一帧它画了 */
export function renderLookbackTransition(project: Project, view: Rectangle): boolean {
  const transition = playing.get(project);
  if (!transition) return false;
  try {
    return transition.render(view);
  } catch (error) {
    // 这里每帧都会走到：画不出来就不播了、报一次错，不能让画布每帧都出错
    transition.finish();
    window.dispatchEvent(new ErrorEvent("error", { error }));
    return false;
  }
}

/** 要拆这块白板了：它正在播的收场；它作为旧白板还在过渡里画着的话，等播完，新白板也在关就不等了 */
export async function lookbackTransitionOver(from: Project): Promise<void> {
  playing.get(from)?.finish();
  const transition = leaving.get(from);
  if (transition?.to.closing) transition.finish();
  await transition?.over;
}
