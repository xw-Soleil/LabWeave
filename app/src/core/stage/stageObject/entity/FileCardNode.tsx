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
  @serializable
  color: Color;
  @serializable
  public collisionBox: CollisionBox;

  static width: number = 280;
  static height: number = 200;
  static readonly maxExcerptLength = 4000;

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
      },
      (error) => window.dispatchEvent(new ErrorEvent("error", { error })),
    );
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
    this.color = color;
    this.collisionBox = collisionBox;
  }
}
