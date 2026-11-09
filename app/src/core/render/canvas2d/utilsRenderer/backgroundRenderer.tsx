import { Vector } from "@graphif/data-structures";
import { Rectangle } from "@graphif/shapes";
import { Project, service } from "@/core/Project";
import { dotGridLevels, gridIndexRange, isCoarseDot } from "@/core/research/CanvasBackground";

@service("backgroundRenderer")
export class BackgroundRenderer {
  constructor(private readonly project: Project) {}

  /**
   * 点阵背景：粗细两层，细的一层随缩放淡入淡出（见 CanvasBackground.ts）。坐标轴上的点不再加粗。
   * @param viewRect 当前视野覆盖的世界坐标矩形
   */
  renderDotBackground(viewRect: Rectangle) {
    const levels = dotGridLevels(this.project.camera.currentScale);
    if (!levels) return;
    const { fineGap, fineAlpha } = levels;
    // 世界坐标到视图坐标只是平移加等比缩放：算出原点的位置，每个点直接乘加，不用每个点都新建 Vector
    const origin = this.project.renderer.transformWorld2View(Vector.getZero());
    const step = fineGap * this.project.camera.currentScale;
    const [firstI, lastI] = gridIndexRange(viewRect.left, viewRect.right, fineGap);
    const [firstJ, lastJ] = gridIndexRange(viewRect.top, viewRect.bottom, fineGap);
    const radius = 1;
    const coarse = new Path2D();
    const fine = new Path2D();

    for (let j = firstJ; j <= lastJ; j++) {
      const y = origin.y + j * step;
      for (let i = firstI; i <= lastI; i++) {
        const onCoarse = isCoarseDot(i, j);
        if (!onCoarse && fineAlpha === 0) continue;
        const x = origin.x + i * step;
        const path = onCoarse ? coarse : fine;
        path.moveTo(x + radius, y);
        path.arc(x, y, radius, 0, 2 * Math.PI);
      }
    }

    const ctx = this.project.canvas.ctx;
    ctx.fillStyle = this.project.stageStyleManager.currentStyle.GridNormal.toString();
    ctx.fill(coarse);
    if (fineAlpha > 0) {
      ctx.globalAlpha = fineAlpha;
      ctx.fill(fine);
      ctx.globalAlpha = 1;
    }
  }

  /**
   * 水平线条式的背景
   */
  renderHorizonBackground(viewRect: Rectangle) {
    const currentGap = this.getCurrentGap();
    const gridColor = this.project.stageStyleManager.currentStyle.GridNormal;
    const mainColor = this.project.stageStyleManager.currentStyle.GridHeavy;

    // 画横线
    for (const y of this.getLocationYIterator(viewRect, currentGap)) {
      const lineStartLocation = new Vector(viewRect.left, y);
      const lineEndLocation = new Vector(viewRect.right, y);

      this.project.curveRenderer.renderSolidLine(
        this.project.renderer.transformWorld2View(lineStartLocation),
        this.project.renderer.transformWorld2View(lineEndLocation),
        y === 0 ? mainColor : gridColor,
        0.2,
      );
    }
  }

  /**
   * 垂直线条式的背景
   */
  renderVerticalBackground(viewRect: Rectangle) {
    const currentGap = this.getCurrentGap();
    const gridColor = this.project.stageStyleManager.currentStyle.GridNormal;
    const mainColor = this.project.stageStyleManager.currentStyle.GridHeavy;

    // 画竖线
    for (const x of this.getLocationXIterator(viewRect, currentGap)) {
      const lineStartLocation = new Vector(x, viewRect.top);
      const lineEndLocation = new Vector(x, viewRect.bottom);
      this.project.curveRenderer.renderSolidLine(
        this.project.renderer.transformWorld2View(lineStartLocation),
        this.project.renderer.transformWorld2View(lineEndLocation),
        x === 0 ? mainColor : gridColor,
        0.2,
      );
    }
  }

  /**
   * 平面直角坐标系背景
   * 只画一个十字坐标
   */
  renderCartesianBackground(viewRect: Rectangle) {
    // x轴
    this.project.curveRenderer.renderSolidLine(
      this.project.renderer.transformWorld2View(new Vector(viewRect.left, 0)),
      this.project.renderer.transformWorld2View(new Vector(viewRect.right, 0)),
      this.project.stageStyleManager.currentStyle.GridNormal,
      1,
    );
    // y轴
    this.project.curveRenderer.renderSolidLine(
      this.project.renderer.transformWorld2View(new Vector(0, viewRect.top)),
      this.project.renderer.transformWorld2View(new Vector(0, viewRect.bottom)),
      this.project.stageStyleManager.currentStyle.GridNormal,
      1,
    );
    const currentGap = this.getCurrentGap();
    // 画x轴上的刻度
    for (const x of this.getLocationXIterator(viewRect, currentGap)) {
      const renderLocation = this.project.renderer.transformWorld2View(new Vector(x, 0));
      renderLocation.y = Math.max(renderLocation.y, 0);
      renderLocation.y = Math.min(renderLocation.y, this.project.renderer.h - 10);
      this.project.textRenderer.renderText(
        `${x}`,
        renderLocation,
        10,
        this.project.stageStyleManager.currentStyle.GridNormal,
      );
    }
    // 画y轴上的刻度
    for (const y of this.getLocationYIterator(viewRect, currentGap)) {
      const renderLocation = this.project.renderer.transformWorld2View(new Vector(0, y));
      renderLocation.x = Math.max(renderLocation.x, 0);
      renderLocation.x = Math.min(renderLocation.x, this.project.renderer.w - 40);
      this.project.textRenderer.renderText(
        `${y}`,
        renderLocation,
        10,
        this.project.stageStyleManager.currentStyle.GridNormal,
      );
    }
  }

  getCurrentGap(): number {
    const gap = 50;
    let currentGap = gap;
    if (this.project.camera.currentScale < 1) {
      while (currentGap * this.project.camera.currentScale < gap - 1) {
        currentGap *= 2;
      }
    }
    return currentGap;
  }

  *getLocationXIterator(viewRect: Rectangle, currentGap: number): IterableIterator<number> {
    let xStart = viewRect.location.x - (viewRect.location.x % currentGap);
    while (xStart < viewRect.right) {
      yield xStart;
      xStart += currentGap;
    }
  }

  *getLocationYIterator(viewRect: Rectangle, currentGap: number): IterableIterator<number> {
    let yStart = viewRect.location.y - (viewRect.location.y % currentGap);
    while (yStart < viewRect.bottom) {
      yield yStart;
      yStart += currentGap;
    }
  }
}
