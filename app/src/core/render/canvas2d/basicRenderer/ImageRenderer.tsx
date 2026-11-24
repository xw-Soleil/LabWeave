import { Project, service } from "@/core/Project";
import { isSideways, rotationMatrix, type ImageRotation } from "@/core/research/ImageRotation";
import { superellipseRect } from "@/utils/superellipse";
import { Vector } from "@graphif/data-structures";

/**
 * 图片渲染器
 * 基于View坐标系
 */
@service("imageRenderer")
export class ImageRenderer {
  constructor(private readonly project: Project) {}

  /**
   * 根据图片HTML元素来渲染图片到canvas指定位置
   * @param imageElement
   * @param location 图片左上角位置
   * @param scale 1 表示正常，0.5 表示缩小一半，2 表示放大两倍
   * @param rotation 顺时针转多少度；location 是转好以后的左上角
   */
  renderImageElement(
    source: Exclude<CanvasImageSource, VideoFrame | SVGElement>,
    location: Vector,
    scale: number = 1 / (window.devicePixelRatio || 1),
    radius: number = 0,
    rotation: ImageRotation = 0,
  ) {
    const ctx = this.project.canvas.ctx;
    const width = source.width * scale * this.project.camera.currentScale;
    const height = source.height * scale * this.project.camera.currentScale;
    const isolated = radius > 0 || rotation !== 0;
    if (isolated) ctx.save();
    try {
      if (radius > 0) {
        ctx.beginPath();
        const [boxWidth, boxHeight] = isSideways(rotation) ? [height, width] : [width, height];
        superellipseRect(ctx, location.x, location.y, boxWidth, boxHeight, radius);
        ctx.clip();
      }
      if (rotation === 0) {
        ctx.drawImage(source, location.x, location.y, width, height);
      } else {
        ctx.translate(location.x, location.y);
        ctx.transform(...rotationMatrix(rotation, width, height));
        ctx.drawImage(source, 0, 0, width, height);
      }
    } finally {
      if (isolated) ctx.restore();
    }
  }

  /**
   * 根据ImageBitmap来渲染图片到canvas指定位置
   * @param bitmap ImageBitmap对象
   * @param location 图片左上角位置
   * @param scale 1 表示正常，0.5 表示缩小一半，2 表示放大两倍
   */
  renderImageBitmap(
    bitmap: ImageBitmap | undefined,
    location: Vector,
    scale: number = 1 / (window.devicePixelRatio || 1),
    radius: number = 0,
  ) {
    if (!bitmap) {
      return;
    }
    this.renderImageElement(bitmap, location, scale, radius);
  }
}
