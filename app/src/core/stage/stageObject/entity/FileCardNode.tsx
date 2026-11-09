import { Project } from "@/core/Project";
import type { FileKind } from "@/core/research/ResearchShell";
import { ConnectableEntity } from "@/core/stage/stageObject/abstract/ConnectableEntity";
import { CollisionBox } from "@/core/stage/stageObject/collisionBox/collisionBox";
import { Color, Vector } from "@graphif/data-structures";
import { id, passExtraAtArg1, passObject, serializable } from "@graphif/serializer";
import { Rectangle } from "@graphif/shapes";
import type { Value } from "platejs";

/**
 * 文件卡片：白板上指向研究文件夹里一个文件（PDF / 图片 / Markdown）的卡片。
 * 原文件不复制进 .prg，只记路径；缩略图作为附件存进 .prg。
 */
@passExtraAtArg1
@passObject
export class FileCardNode extends ConnectableEntity {
  @id
  @serializable
  uuid: string;
  @serializable
  title: string;
  /** 相对工作区 .prg 所在文件夹的 POSIX 路径；草稿还没存盘时是绝对路径 */
  @serializable
  sourcePath: string;
  @serializable
  fileKind: FileKind;
  /** 缩略图（webp）附件 id，没有时为 ""。字段名必须是 attachmentId，附件窗口的「清理未使用」靠它识别引用 */
  @serializable
  attachmentId: string;
  /** Markdown 开头文字或 PDF 前几页文字，最多 4000 字 */
  @serializable
  excerpt: string;
  /** PDF 页数，其他类型为 0 */
  @serializable
  pageCount: number;
  /**
   * 图片卡片可选的标题，用户自己填，显示在图片左下角的一小块里；空串表示不显示。
   * 和文件名、title 无关：改文件名不影响它，名字奇怪的图也不用为了好看去改名。
   */
  @serializable
  caption: string;
  @serializable
  color: Color;
  @serializable
  public collisionBox: CollisionBox;

  static width: number = 280;
  static height: number = 200;
  static readonly maxExcerptLength = 4000;
  /** 图片卡片按图片比例定大小：长边这么长，短边至少 imageMinSide */
  static readonly imageLongSide = 300;
  static readonly imageMinSide = 60;

  /** 新建图片卡片的大小：整张图铺满卡片 */
  static imageCardSize(width: number, height: number): Vector {
    if (!(width > 0 && height > 0)) return new Vector(FileCardNode.width, FileCardNode.height);
    const long = FileCardNode.imageLongSide;
    const min = FileCardNode.imageMinSide;
    return width >= height
      ? new Vector(long, Math.max(min, Math.round((long * height) / width)))
      : new Vector(Math.max(min, Math.round((long * width) / height)), long);
  }

  /** 在 box 里按图片比例放下的最大矩形，居中；短边不小于 imageMinSide（box 本身更小时以 box 为准） */
  static fitImageInBox(box: Rectangle, width: number, height: number): Rectangle {
    if (!(width > 0 && height > 0)) return box.clone();
    const scale = Math.min(box.size.x / width, box.size.y / height);
    const size = new Vector(
      Math.min(box.size.x, Math.max(FileCardNode.imageMinSide, Math.round(width * scale))),
      Math.min(box.size.y, Math.max(FileCardNode.imageMinSide, Math.round(height * scale))),
    );
    return new Rectangle(box.center.subtract(size.multiply(0.5)), size);
  }

  isHiddenBySectionCollapse: boolean = false;

  /** 运行时：从缩略图附件解码出来的位图，不序列化 */
  bitmap: ImageBitmap | undefined;
  /** 运行时：bitmap 对应的附件 id；和 attachmentId 不一致时（粘贴换了 id）会重新解码 */
  private bitmapAttachmentId: string | null = null;
  /** 运行时：原文件不见了（被移走、改名或删除） */
  missing: boolean = false;
  /** 运行时：上次检查原文件是否存在的时间（performance.now()），由 FileCardFactory 维护 */
  missingCheckedAt: number = Number.NEGATIVE_INFINITY;

  get geometryCenter(): Vector {
    return this.collisionBox.getRectangle().center;
  }

  /**
   * 只读，获取节点的矩形
   * 若要修改节点的矩形，请使用 moveTo等 方法
   */
  public get rectangle(): Rectangle {
    return this.collisionBox.shapes[0] as Rectangle;
  }

  move(delta: Vector): void {
    const newRectangle = this.rectangle.clone();
    newRectangle.location = newRectangle.location.add(delta);
    this.collisionBox.shapes[0] = newRectangle;
    this.updateFatherSectionByMove();
    this.updateOtherEntityLocationByMove();
  }

  moveTo(location: Vector): void {
    const newRectangle = this.rectangle.clone();
    newRectangle.location = location.clone();
    this.collisionBox.shapes[0] = newRectangle;
    this.updateFatherSectionByMove();
  }

  /**
   * 渲染时调用：按需把缩略图附件解码成位图。
   * 放在渲染时而不是构造时做，是因为粘贴会在反序列化之后才改 attachmentId，撤销也会重建实例。
   */
  ensureThumbnail(): void {
    if (this.bitmapAttachmentId === this.attachmentId) return;
    const attachmentId = this.attachmentId;
    this.bitmapAttachmentId = attachmentId;
    const blob = this.project.attachments.get(attachmentId);
    if (!blob || typeof createImageBitmap === "undefined") {
      this.bitmap?.close();
      this.bitmap = undefined;
      return;
    }
    createImageBitmap(blob).then(
      (bitmap) => {
        if (this.attachmentId !== attachmentId) {
          bitmap.close();
          return;
        }
        this.bitmap?.close();
        this.bitmap = bitmap;
        this.fitLegacyImageCard(bitmap.width, bitmap.height);
      },
      (error) => window.dispatchEvent(new ErrorEvent("error", { error })),
    );
  }

  /**
   * 2026-11-08 以前建的图片卡片一律是默认的 280×200，图片四周空着一圈。
   * 按图片比例收进原来的框里（居中、只会变小），不会压到旁边的卡片；新建的图片卡片不会正好是这个大小。
   */
  private fitLegacyImageCard(width: number, height: number) {
    const rect = this.rectangle;
    if (this.fileKind !== "image" || rect.size.x !== FileCardNode.width || rect.size.y !== FileCardNode.height) return;
    const fitted = FileCardNode.fitImageInBox(rect, width, height);
    if (fitted.size.x === rect.size.x && fitted.size.y === rect.size.y) return;
    this.collisionBox.shapes[0] = fitted;
  }

  dispose(): void {
    this.bitmap?.close();
    this.bitmap = undefined;
    this.bitmapAttachmentId = null;
  }

  constructor(
    protected readonly project: Project,
    {
      uuid = crypto.randomUUID() as string,
      title = "",
      details = [] as Value,
      sourcePath = "",
      fileKind = "pdf" as FileKind,
      attachmentId = "",
      excerpt = "",
      pageCount = 0,
      caption = "",
      collisionBox = new CollisionBox([
        new Rectangle(Vector.getZero(), new Vector(FileCardNode.width, FileCardNode.height)),
      ]),
      color = Color.Transparent,
    },
  ) {
    super();
    this.uuid = uuid;
    this.details = details;
    this.title = title;
    this.sourcePath = sourcePath;
    this.fileKind = fileKind;
    this.attachmentId = attachmentId;
    this.excerpt = excerpt.slice(0, FileCardNode.maxExcerptLength);
    this.pageCount = pageCount;
    this.caption = caption;
    this.color = color;
    this.collisionBox = collisionBox;
  }
}
