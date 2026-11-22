import { Project } from "@/core/Project";
import { ConnectableEntity } from "@/core/stage/stageObject/abstract/ConnectableEntity";
import { ResizeAble } from "@/core/stage/stageObject/abstract/StageObjectInterface";
import { Edge } from "@/core/stage/stageObject/association/Edge";
import { CollisionBox } from "@/core/stage/stageObject/collisionBox/collisionBox";
import { Settings } from "@/core/service/Settings";
import { applyBlackAndWhite } from "@/core/service/dataManageService/imageUtils";
import { toast } from "sonner";
import { Vector } from "@graphif/data-structures";
import { id, passExtraAtArg1, passObject, serializable } from "@graphif/serializer";
import { Rectangle } from "@graphif/shapes";
import type { Value } from "platejs";

export type Rotate90Direction = "cw" | "ccw";

export const JPEG_ROTATE_QUALITY = 0.92;

function invertRateAxis(value: number): number {
  return Number((1 - value).toPrecision(12));
}

export function rotateRate90(rate: Vector, direction: Rotate90Direction): Vector {
  if (rate.x === 0.5 && rate.y === 0.5) return new Vector(0.5, 0.5);
  return direction === "cw" ? new Vector(invertRateAxis(rate.y), rate.x) : new Vector(rate.y, invertRateAxis(rate.x));
}

export function rotateRgba90(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  direction: Rotate90Direction,
): { data: Uint8ClampedArray<ArrayBuffer>; width: number; height: number } {
  const outWidth = height;
  const outHeight = width;
  const out = new Uint8ClampedArray(outWidth * outHeight * 4);
  const src32 = new Uint32Array(data.buffer, data.byteOffset, width * height);
  const dst32 = new Uint32Array(out.buffer);
  if (direction === "cw") {
    for (let y = 0; y < height; y++) {
      const dstX = height - 1 - y;
      const rowOffset = y * width;
      for (let x = 0; x < width; x++) {
        dst32[x * outWidth + dstX] = src32[rowOffset + x];
      }
    }
  } else {
    for (let y = 0; y < height; y++) {
      const rowOffset = y * width;
      for (let x = 0; x < width; x++) {
        dst32[(width - 1 - x) * outWidth + y] = src32[rowOffset + x];
      }
    }
  }
  return { data: out, width: outWidth, height: outHeight };
}

export function rotatedMimeType(inputType: string): { type: string; quality?: number } {
  if (inputType === "image/jpeg") return { type: "image/jpeg", quality: JPEG_ROTATE_QUALITY };
  if (inputType === "image/webp") return { type: "image/webp", quality: JPEG_ROTATE_QUALITY };
  return { type: "image/png" };
}

type ImageNodeOptions = {
  uuid?: string;
  collisionBox?: CollisionBox;
  details?: Value;
  attachmentId?: string;
  scale?: number;
  isBackground?: boolean;
};

/**
 * 一个图片节点
 * 图片的路径字符串决定了这个图片是什么
 *
 * 有两个转换过程：
 *
 * 图片路径 -> base64字符串 -> 图片Element -> 完成
 *   gettingBase64
 *     |
 *     v
 *   fileNotfound
 *   base64EncodeError
 *
 */
@passExtraAtArg1
@passObject
export class ImageNode extends ConnectableEntity implements ResizeAble {
  isHiddenBySectionCollapse: boolean = false;
  @id
  @serializable
  public uuid: string;
  @serializable
  public collisionBox: CollisionBox;
  @serializable
  attachmentId: string;
  @serializable
  scale: number;
  /**
   * 是否为背景图片
   */
  @serializable
  isBackground: boolean = false;
  /**
   * 节点是否被选中
   */
  _isSelected: boolean = false;

  /**
   * 获取节点的选中状态
   */
  public get isSelected() {
    return this._isSelected;
  }

  public set isSelected(value: boolean) {
    this._isSelected = value;
  }

  bitmap: ImageBitmap | undefined;
  private disposed = false;
  private readonly pendingBitmapTasks = new Set<Promise<void>>();
  state: "loading" | "success" | "notFound" = "loading";

  constructor(
    protected readonly project: Project,
    {
      uuid = crypto.randomUUID() as string,
      collisionBox = new CollisionBox([new Rectangle(Vector.getZero(), Vector.getZero())]),
      details = [] as Value,
      attachmentId = "",
      scale = 1,
      isBackground = false,
    }: ImageNodeOptions,
    public unknown = false,
    public onReady?: () => void,
  ) {
    super();
    this.uuid = uuid;
    this.collisionBox = collisionBox;
    this.details = details;
    this.attachmentId = attachmentId;
    this.scale = scale;
    this.isBackground = isBackground;

    const blob = project.attachments.get(attachmentId);
    if (!blob) {
      this.state = "notFound";
      return;
    }
    if (typeof createImageBitmap === "undefined") return;
    this.loadBitmap(createImageBitmap(blob), () => {
      this.state = "success";
      // 设置碰撞箱
      this.scaleUpdate(0);
      this.onReady?.();
    });
  }

  private loadBitmap(bitmapPromise: Promise<ImageBitmap>, onLoaded: () => void): void {
    const task = bitmapPromise.then((bitmap) => {
      if (this.disposed) {
        bitmap.close();
        return;
      }
      this.bitmap?.close();
      this.bitmap = bitmap;
      onLoaded();
    });
    this.pendingBitmapTasks.add(task);
    void task.then(
      () => this.pendingBitmapTasks.delete(task),
      (error) => window.dispatchEvent(new ErrorEvent("error", { error })),
    );
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const results = await Promise.allSettled(this.pendingBitmapTasks);
    this.bitmap?.close();
    this.bitmap = undefined;
    const errors = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map(({ reason }) => reason);
    if (errors.length > 0) throw new AggregateError(errors, "ImageNode cleanup failed");
  }

  public scaleUpdate(scaleDiff: number) {
    this.scale += scaleDiff;
    if (this.scale < 0.1) {
      this.scale = 0.1;
    }
    if (this.scale > 10) {
      this.scale = 10;
    }
    if (!this.bitmap) return;
    this.collisionBox = new CollisionBox([
      new Rectangle(this.rectangle.location, new Vector(this.bitmap.width, this.bitmap.height).multiply(this.scale)),
    ]);
    this.updateFatherSectionByMove();
  }

  /**
   * 只读，获取节点的矩形
   * 若要修改节点的矩形，请使用 moveTo等 方法
   */
  public get rectangle(): Rectangle {
    return this.collisionBox.shapes[0] as Rectangle;
  }

  public get geometryCenter() {
    return this.rectangle.location.clone().add(this.rectangle.size.clone().multiply(0.5));
  }

  move(delta: Vector): void {
    const newRectangle = this.rectangle.clone();
    newRectangle.location = newRectangle.location.add(delta);
    this.collisionBox.shapes[0] = newRectangle;
    this.updateFatherSectionByMove();
  }
  moveTo(location: Vector): void {
    const newRectangle = this.rectangle.clone();
    newRectangle.location = location.clone();
    this.collisionBox.shapes[0] = newRectangle;
    this.updateFatherSectionByMove();
  }

  /**
   * 反转图片颜色
   * 将图片的RGB值转换为互补色（255-R, 255-G, 255-B）
   * 并将反色后的图片数据保存到project.attachments中，实现持久化存储
   */
  reverseColors() {
    if (!this.bitmap) return;

    // 创建临时canvas
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // 设置canvas尺寸
    canvas.width = this.bitmap.width;
    canvas.height = this.bitmap.height;

    // 绘制原图
    ctx.drawImage(this.bitmap, 0, 0);

    // 获取图像数据
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = imageData.data;

    // 反转颜色（255-R, 255-G, 255-B）
    for (let i = 0; i < data.length; i += 4) {
      data[i] = 255 - data[i]; // R
      data[i + 1] = 255 - data[i + 1]; // G
      data[i + 2] = 255 - data[i + 2]; // B
      // data[i + 3] 保持不变（alpha通道）
    }

    // 将修改后的图像数据绘制回canvas
    ctx.putImageData(imageData, 0, 0);

    // 创建新的ImageBitmap并保存到attachments中
    this.loadBitmap(createImageBitmap(imageData), () => {
      // 将canvas转换为Blob并保存到project.attachments中
      canvas.toBlob((blob) => {
        if (blob) {
          // 创建新的attachmentId并替换原有数据
          const newAttachmentId = this.project.addAttachment(blob);
          // 更新当前节点的attachmentId
          this.attachmentId = newAttachmentId;
        }
      }, "image/png");
    });
  }

  /**
   * 交换图片的红蓝通道
   * 将图片的红色和蓝色通道对调，绿色和alpha通道保持不变
   * 并将处理后的图片数据保存到project.attachments中，实现持久化存储
   */
  swapRedBlueChannels() {
    if (!this.bitmap) return;

    // 创建临时canvas
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // 设置canvas尺寸
    canvas.width = this.bitmap.width;
    canvas.height = this.bitmap.height;

    // 绘制原图
    ctx.drawImage(this.bitmap, 0, 0);

    // 获取图像数据
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = imageData.data;

    // 交换红色和蓝色通道
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i]; // R
      const b = data[i + 2]; // B
      data[i] = b; // R = B
      data[i + 2] = r; // B = R
      // data[i + 1] 保持不变（绿色通道）
      // data[i + 3] 保持不变（alpha通道）
    }

    // 将修改后的图像数据绘制回canvas
    ctx.putImageData(imageData, 0, 0);

    // 创建新的ImageBitmap并保存到attachments中
    this.loadBitmap(createImageBitmap(imageData), () => {
      // 将canvas转换为Blob并保存到project.attachments中
      canvas.toBlob((blob) => {
        if (blob) {
          // 创建新的attachmentId并替换原有数据
          const newAttachmentId = this.project.addAttachment(blob);
          // 更新当前节点的attachmentId
          this.attachmentId = newAttachmentId;
        }
      }, "image/png");
    });
  }

  compressImage() {
    const blob = this.project.attachments.get(this.attachmentId);
    if (!blob) {
      toast.error("无法获取图片数据");
      return;
    }

    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      let w = img.naturalWidth;
      let h = img.naturalHeight;

      if (Settings.resizePastedImages) {
        const maxSize = Settings.maxPastedImageSize;
        const maxDim = Math.max(w, h);
        if (maxDim > maxSize) {
          const scale = maxSize / maxDim;
          w = Math.round(w * scale);
          h = Math.round(h * scale);
        }
      }

      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        URL.revokeObjectURL(url);
        return;
      }
      ctx.drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);

      if (Settings.compressImageToBlackAndWhite) {
        applyBlackAndWhite(canvas);
      }

      const sourceIsPng = blob.type === "image/png";
      const outputType = Settings.compressImageToBlackAndWhite
        ? "image/png"
        : sourceIsPng && Settings.compressImageToWebp
          ? "image/webp"
          : blob.type;

      canvas.toBlob(
        (newBlob) => {
          if (!newBlob) {
            toast.error("图片压缩失败");
            return;
          }
          if (outputType === "image/webp" && !newBlob.type.includes("webp")) {
            toast.warning("当前系统 webview 不支持 WebP 编码，已回退为 PNG");
          }
          const newAttachmentId = this.project.addAttachment(newBlob);
          this.attachmentId = newAttachmentId;
          this.loadBitmap(createImageBitmap(newBlob), () => {
            this.scaleUpdate(0);
          });
        },
        outputType,
        Settings.compressImageToBlackAndWhite
          ? undefined
          : Settings.compressImageToWebp && sourceIsPng
            ? Settings.webpQuality
            : undefined,
      );
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      toast.error("图片加载失败");
    };
    img.src = url;
  }

  /**
   * 处理拖拽缩放逻辑
   * @param delta 拖拽距离向量
   */
  resizeHandle(delta: Vector) {
    if (!this.bitmap) return;

    // 计算当前图片的实际显示尺寸
    const currentDisplayWidth = this.bitmap.width * this.scale;

    // 根据delta计算新的显示尺寸（只使用delta.x，保持等比例缩放）
    const newDisplayWidth = Math.max(currentDisplayWidth + delta.x, this.bitmap.width * 0.1);

    // 计算新的缩放比例
    const newScale = newDisplayWidth / this.bitmap.width;

    // 更新缩放比例，使用现有的scaleUpdate方法保持一致性
    const scaleDiff = newScale - this.scale;
    this.scaleUpdate(scaleDiff);
  }

  /**
   * 获取缩放控制点矩形
   * 返回右下角的一个小矩形，用于拖拽缩放
   */
  getResizeHandleRect(): Rectangle {
    const rect = this.collisionBox.getRectangle();
    // 创建一个25x25的矩形，位于图片右下角
    return new Rectangle(new Vector(rect.right - 25, rect.bottom - 25), new Vector(25, 25));
  }

  canRotate(): boolean {
    return (
      !this.disposed &&
      this.state === "success" &&
      Boolean(this.bitmap) &&
      this.bitmap!.width > 0 &&
      this.bitmap!.height > 0 &&
      this.project.attachments.has(this.attachmentId)
    );
  }

  async prepareRotated90(direction: Rotate90Direction): Promise<{ blob: Blob; bitmap: ImageBitmap } | null> {
    if (!this.canRotate() || !this.bitmap) return null;
    const sourceBlob = this.project.attachments.get(this.attachmentId);
    if (!sourceBlob) return null;

    const srcCanvas = document.createElement("canvas");
    srcCanvas.width = this.bitmap.width;
    srcCanvas.height = this.bitmap.height;
    const srcCtx = srcCanvas.getContext("2d");
    if (!srcCtx) return null;
    srcCtx.drawImage(this.bitmap, 0, 0);
    const srcImage = srcCtx.getImageData(0, 0, srcCanvas.width, srcCanvas.height);
    const rotated = rotateRgba90(srcImage.data, srcImage.width, srcImage.height, direction);

    const dstCanvas = document.createElement("canvas");
    dstCanvas.width = rotated.width;
    dstCanvas.height = rotated.height;
    const dstCtx = dstCanvas.getContext("2d");
    if (!dstCtx) return null;
    const dstImage = dstCtx.createImageData(rotated.width, rotated.height);
    dstImage.data.set(rotated.data);
    dstCtx.putImageData(dstImage, 0, 0);

    const { type, quality } = rotatedMimeType(sourceBlob.type);
    const blob = await new Promise<Blob | null>((resolve) => dstCanvas.toBlob(resolve, type, quality));
    if (!blob) return null;
    const bitmap = await createImageBitmap(blob);
    return { blob, bitmap };
  }

  applyRotatedImage(newAttachmentId: string, bitmap: ImageBitmap): void {
    if (this.disposed) {
      bitmap.close();
      return;
    }
    const center = this.geometryCenter;
    this.bitmap?.close();
    this.bitmap = bitmap;
    this.attachmentId = newAttachmentId;
    this.state = "success";
    const newSize = new Vector(bitmap.width, bitmap.height).multiply(this.scale);
    this.collisionBox = new CollisionBox([new Rectangle(center.subtract(newSize.multiply(0.5)), newSize)]);
    this.updateFatherSectionByMove();
  }
}

export async function rotateSelectedImageNodes(project: Project, direction: Rotate90Direction): Promise<void> {
  const nodes = project.stageManager
    .getSelectedEntities()
    .filter((entity): entity is ImageNode => entity instanceof ImageNode && entity.canRotate());
  if (nodes.length === 0) return;

  const prepared = await Promise.all(
    nodes.map(async (node) => ({
      node,
      result: await node.prepareRotated90(direction),
    })),
  );
  if (project.closing) {
    for (const item of prepared) item.result?.bitmap.close();
    return;
  }

  const ready = prepared.filter(
    (item): item is { node: ImageNode; result: { blob: Blob; bitmap: ImageBitmap } } => item.result !== null,
  );
  if (ready.length === 0) return;

  const rotatedNodes = new Set<ImageNode>();
  for (const { node, result } of ready) {
    const newAttachmentId = project.addAttachment(result.blob);
    node.applyRotatedImage(newAttachmentId, result.bitmap);
    rotatedNodes.add(node);
  }

  for (const association of project.stageManager.getAssociations()) {
    if (!(association instanceof Edge)) continue;
    if (rotatedNodes.has(association.source as ImageNode)) {
      association.sourceRectangleRate = rotateRate90(association.sourceRectangleRate, direction);
    }
    if (rotatedNodes.has(association.target as ImageNode)) {
      association.targetRectangleRate = rotateRate90(association.targetRectangleRate, direction);
    }
  }

  project.historyManager.recordStep();
}
