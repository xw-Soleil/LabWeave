import { Project } from "@/core/Project";
import { captionFontSize, captionLineHeight, captionPadding } from "@/core/research/ImageCardCaption";
import type { FileKind } from "@/core/research/ResearchShell";
import { ConnectableEntity } from "@/core/stage/stageObject/abstract/ConnectableEntity";
import type { ResizeAble } from "@/core/stage/stageObject/abstract/StageObjectInterface";
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
export class FileCardNode extends ConnectableEntity implements ResizeAble {
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
   * 图片卡片可选的说明（标题、图注、自己的理解都写在这），显示在图片下面，可以多行；空串表示没有。
   * 和文件名、title 无关：改文件名不影响它，名字奇怪的图也不用为了好看去改名。
   * 要改它用 setCaption，图片下面那一块的大小才会跟着变。
   */
  @serializable
  caption: string;
  /**
   * PDF 摘录卡片：从 PDF 里圈一段话或框一块图发上来的，记着第几页（从 1 数）和对应的那条批注，
   * 双击跳回原处。普通文件卡片是 0 和 ""。圈的字放在 excerpt，框的图放在 attachmentId。
   */
  @serializable
  pdfPage: number;
  @serializable
  pdfAnnotation: string;
  @serializable
  color: Color;
  @serializable
  public collisionBox: CollisionBox;

  static width: number = 280;
  static height: number = 200;
  static readonly pdfWidth = 240;
  static readonly pdfHeight = 340;
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
   * 卡片本身（图片卡片就是那张图）的矩形。图片卡片写了说明时，说明在它下面另占一个矩形，
   * 两个合起来才是整张卡片的外框；原图的缩放和连线端点始终以这个矩形为准。
   */
  public get rectangle(): Rectangle {
    return this.collisionBox.shapes[0] as Rectangle;
  }

  /** 图片下面放说明的那一块；没写说明（也不在编辑）时没有 */
  get captionRectangle(): Rectangle | undefined {
    return this.collisionBox.shapes[1] as Rectangle | undefined;
  }

  /** 连线只认图片本身：加了说明、说明变长，箭头指的位置都不变 */
  override get connectionRectangle(): Rectangle {
    return this.rectangle;
  }

  /** 能带说明的卡片：图片，和从 PDF 里框下来的图 */
  get canCaption(): boolean {
    return this.fileKind === "image" || this.canResize;
  }

  /**
   * 按现在的说明重排图片下面那一块：没有说明就去掉，有就按字数和卡片宽度定高度
   * @param keepOpen 正在编辑时，说明是空的也留出一行
   */
  private layoutCaption(keepOpen = false) {
    if (!this.canCaption || (!this.caption && !keepOpen)) {
      this.collisionBox.shapes.length = 1;
      return;
    }
    const rect = this.rectangle;
    const lines = this.caption
      ? this.project.textRenderer.layoutClampedLines(
          this.caption,
          captionFontSize,
          rect.width - 2 * captionPadding,
          Infinity,
        ).length
      : 1;
    const height = Math.ceil(2 * captionPadding + lines * captionFontSize * captionLineHeight);
    this.collisionBox.shapes[1] = new Rectangle(rect.leftBottom, new Vector(rect.width, height));
  }

  /** 图片挪了位置：说明那一块跟着走，高度不变 */
  private captionFollowsImage() {
    const caption = this.captionRectangle;
    if (!caption) return;
    const rect = this.rectangle;
    this.collisionBox.shapes[1] = new Rectangle(rect.leftBottom, new Vector(rect.width, caption.height));
  }

  /** 改说明。空串表示不要说明，图片下面那一块随之消失 */
  setCaption(text: string, keepOpen = false) {
    this.caption = text;
    this.layoutCaption(keepOpen);
    this.updateFatherSectionByMove();
  }

  /**
   * 渲染时调用：旧文件里的图片标题只有文字、没有下面那一块，第一次画的时候补上。
   * 量文字要用到渲染器，构造时还没有，所以放在这里。
   */
  ensureCaptionLayout(): void {
    if (!this.canCaption || !this.caption || this.captionRectangle) return;
    this.setCaption(this.caption);
  }

  move(delta: Vector): void {
    this.moveTo(this.rectangle.location.add(delta));
    this.updateOtherEntityLocationByMove();
  }

  moveTo(location: Vector): void {
    const newRectangle = this.rectangle.clone();
    newRectangle.location = location.clone();
    this.collisionBox.shapes[0] = newRectangle;
    this.captionFollowsImage();
    this.updateFatherSectionByMove();
  }

  /** 只有从 PDF 框选截图发上来的摘录卡片可以拖右下角调大小；圈字的摘录卡片和普通文件卡片不能调 */
  get canResize(): boolean {
    return this.pdfPage > 0 && Boolean(this.attachmentId);
  }

  resizeHandle(delta: Vector): void {
    if (!this.canResize) return;
    const rect = this.rectangle;
    if (!(rect.size.x > 0 && rect.size.y > 0)) return;
    const aspectRatio = rect.size.x / rect.size.y;
    const minWidth = aspectRatio >= 1 ? FileCardNode.imageMinSide * aspectRatio : FileCardNode.imageMinSide;
    const newWidth = Math.max(rect.size.x + delta.x, minWidth);
    const newHeight = newWidth / aspectRatio;
    this.collisionBox.shapes[0] = new Rectangle(rect.location.clone(), new Vector(newWidth, newHeight));
    this.layoutCaption();
    this.updateFatherSectionByMove();
  }

  getResizeHandleRect(): Rectangle {
    const rect = this.rectangle;
    return new Rectangle(new Vector(rect.right - 25, rect.bottom - 25), new Vector(25, 25));
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
        if (this.attachmentId !== attachmentId || this.bitmapAttachmentId !== attachmentId) {
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
    this.layoutCaption();
    this.updateFatherSectionByMove();
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
      pdfPage = 0,
      pdfAnnotation = "",
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
    this.pdfPage = pdfPage;
    this.pdfAnnotation = pdfAnnotation;
    this.color = color;
    this.collisionBox = collisionBox;
  }
}
