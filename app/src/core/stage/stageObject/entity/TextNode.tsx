import type { Project } from "@/core/Project";
import { Renderer } from "@/core/render/canvas2d/renderer";
import { Settings } from "@/core/service/Settings";
import { ConnectableEntity } from "@/core/stage/stageObject/abstract/ConnectableEntity";
import type { Entity } from "@/core/stage/stageObject/abstract/StageEntity";
import type { ResizeAble } from "@/core/stage/stageObject/abstract/StageObjectInterface";
import { CollisionBox } from "@/core/stage/stageObject/collisionBox/collisionBox";
import { Section } from "@/core/stage/stageObject/entity/Section";
import { getMultiLineTextSize } from "@/utils/font";
import { Color, Vector } from "@graphif/data-structures";
import { id, passExtraAtArg1, passObject, serializable } from "@graphif/serializer";
import { Rectangle } from "@graphif/shapes";
import type { Value } from "platejs";

export type TextNodeAlign = "left" | "center" | "right";

/**
 *
 * 文字节点类
 * 2024年10月20日：Node 改名为 TextNode，防止与 原生 Node 类冲突
 */
@passExtraAtArg1
@passObject
export class TextNode extends ConnectableEntity implements ResizeAble {
  public override get clipConnectionToBoundary(): boolean {
    return true;
  }

  @id
  @serializable
  uuid: string;
  @serializable
  text: string;
  @serializable
  public collisionBox: CollisionBox;
  @serializable
  color: Color = Color.Transparent;

  /**
   * 字体缩放级别，整数，基准值为0，对应默认字体大小
   * 计算公式：finalFontSize = Renderer.FONT_SIZE * Math.pow(2, fontScaleLevel)
   */
  @serializable
  public fontScaleLevel: number = 0;

  public static enableResizeCharCount = 20;

  /**
   * 调整大小的模式
   * auto：自动缩紧
   * manual：手动调整宽度，高度自动撑开。
   */
  @serializable
  public sizeAdjust: string = "auto";

  /**
   * 自定义字体，空字符串表示使用默认字体
   */
  @serializable
  public fontFamily: string = "";

  /**
   * 自定义字重，空字符串表示使用 normal
   */
  @serializable
  public fontWeight: string = "";

  /**
   * 边框样式：实线、虚线、无边框
   */
  @serializable
  public borderStyle: "solid" | "dashed" | "none" = "solid";

  /**
   * 水平对齐：默认靠左，和旧白板多行排版一致
   */
  @serializable
  public textAlign: TextNodeAlign = "left";

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

  public set isSelected(value: boolean) {
    this._isSelected = value;
  }

  /**
   * 是否在编辑文字，编辑时不渲染文字
   */
  _isEditing: boolean = false;

  public get isEditing() {
    return this._isEditing;
  }

  public set isEditing(value: boolean) {
    this._isEditing = value;
    this.project.inlineMath?.editingChanged(this);
    this.project.textNodeRenderer.renderTextNode(this);
    // 再主动渲染一次，确保即使渲染引擎停止，文字也能显示出来
  }
  isHiddenBySectionCollapse = false;

  constructor(
    protected readonly project: Project,
    {
      uuid = crypto.randomUUID() as string,
      text = "",
      details = [],
      collisionBox = new CollisionBox([new Rectangle(Vector.getZero(), Vector.getZero())]),
      color = Color.Transparent,
      sizeAdjust = "auto",
      fontScaleLevel = 0,
      fontFamily = "",
      fontWeight = "",
      borderStyle = "solid" as "solid" | "dashed" | "none",
      textAlign = "left" as TextNodeAlign,
    }: {
      uuid?: string;
      text?: string;
      details?: Value;
      color?: Color;
      sizeAdjust?: "auto" | "manual";
      collisionBox?: CollisionBox;
      fontScaleLevel?: number;
      fontFamily?: string;
      fontWeight?: string;
      borderStyle?: "solid" | "dashed" | "none";
      textAlign?: TextNodeAlign;
    },
    public unknown = false,
  ) {
    super();
    this.uuid = uuid;
    this.text = text;
    this.details = details;
    this.collisionBox = collisionBox;
    this.color = color;
    this.sizeAdjust = sizeAdjust;
    this.fontScaleLevel = fontScaleLevel;
    this.fontFamily = fontFamily;
    this.fontWeight = fontWeight;
    this.borderStyle = borderStyle;
    this.textAlign = textAlign;
    // 初始化字体大小缓存
    this.updateFontSizeCache();
    // if (this.text.length < TextNode.enableResizeCharCount) {
    //   this.adjustSizeByText();
    // }
    if (this.sizeAdjust === "auto") {
      this.adjustSizeByText();
    } else if (this.sizeAdjust === "manual") {
      this.resizeHandle(Vector.getZero());
    }
  }

  /**
   * 字体大小缓存，避免重复计算
   */
  private fontSizeCache: number = Renderer.FONT_SIZE;

  /**
   * 获取当前字体大小
   */
  public getFontSize(): number {
    return this.fontSizeCache;
  }

  /**
   * 动态内边距，与字体大小等比缩放
   */
  public getPadding(): number {
    return (this.fontSizeCache / Renderer.FONT_SIZE) * Renderer.NODE_PADDING;
  }

  /**
   * 动态边框粗细，与字体大小等比缩放，基准为 2px
   */
  public getBorderWidth(): number {
    return (this.fontSizeCache / Renderer.FONT_SIZE) * 2;
  }

  /**
   * 与其他节点共用圆角半径，避免字号改变外框风格。
   */
  public getBorderRadius(): number {
    return Renderer.NODE_ROUNDED_RADIUS;
  }

  /**
   * 更新字体大小缓存
   * fontScaleLevel 存储的是"半个级别"，所以计算时要除以 2
   * 这样步长就是 0.5，避免了浮点数精度问题
   */
  private updateFontSizeCache(): void {
    this.fontSizeCache = Renderer.FONT_SIZE * 2 ** (this.fontScaleLevel / 2);
    if (this.fontSizeCache >= 2) {
      // 确保指数变化的过程中字体不会变小到0。
      // 加一点零头再取整：由字号反推出来的 fontScaleLevel 算回去可能是 27.9999…，不加就成了 27
      this.fontSizeCache = Math.floor(this.fontSizeCache + 1e-6);
    }
  }

  /** 常用字号：放大、缩小按这张表一档一档走（照 Word），也是右键菜单里列出来的那几个 */
  static readonly FONT_SIZES = [8, 10, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 64, 72, 96, 128, 192, 256];

  /**
   * 把字号定成 size。文件里存的仍是 fontScaleLevel（旧文件不用动），所以它可以不是整数
   * @param anchorRate 可选。缩放时保持固定的锚点（矩形内比例，如 (0.5,0.5) 为中心）。不传则保持左上角不变。
   */
  public setFontSize(size: number, anchorRate?: Vector): void {
    this.fontScaleLevel = 2 * Math.log2(size / Renderer.FONT_SIZE);
    this.updateFontSizeCache();
    if (this.sizeAdjust === "auto") {
      const oldRect = this.rectangle.clone();
      this.adjustSizeByText();
      if (anchorRate) {
        this._adjustLocationToKeepAnchor(oldRect, anchorRate);
      }
    } else if (this.sizeAdjust === "manual") {
      this.resizeHandle(Vector.getZero());
      if (anchorRate) {
        const oldRect = this.rectangle.clone();
        this._adjustLocationToKeepAnchor(oldRect, new Vector(anchorRate.x, 0));
      }
    }
  }

  public setFontScaleLevel(level: number) {
    this.fontScaleLevel = level;
    this.updateFontSizeCache();
    if (this.sizeAdjust === "auto") {
      this.adjustSizeByText();
    } else if (this.sizeAdjust === "manual") {
      this.resizeHandle(Vector.getZero());
    }
  }

  public setTextAlign(align: TextNodeAlign): void {
    this.textAlign = align;
  }

  public isBold(): boolean {
    const weight = this.fontWeight.trim().toLowerCase();
    if (!weight || weight === "normal") return false;
    if (weight === "bold") return true;
    const numeric = Number(weight);
    return Number.isFinite(numeric) && numeric >= 600;
  }

  public setBold(bold: boolean): void {
    const next = bold ? "bold" : "";
    if (this.fontWeight === next) return;
    this.fontWeight = next;
    if (this.sizeAdjust === "auto") {
      this.adjustSizeByText();
      this.updateFatherSectionByMove();
    } else if (this.sizeAdjust === "manual") {
      this.adjustHeightByText();
    }
  }

  /** 放大到常用字号里的下一档；已经是最大一档就不动 */
  public increaseFontSize(anchorRate?: Vector): void {
    const next = TextNode.FONT_SIZES.find((size) => size > this.getFontSize());
    if (next) this.setFontSize(next, anchorRate);
  }

  /** 缩小到常用字号里的上一档；已经是最小一档就不动 */
  public decreaseFontSize(anchorRate?: Vector): void {
    const previous = TextNode.FONT_SIZES.filter((size) => size < this.getFontSize()).at(-1);
    if (previous) this.setFontSize(previous, anchorRate);
  }

  /**
   * 在尺寸已变更后，根据旧矩形和锚点比例调整 location，使锚点在世界坐标中保持不变
   */
  private _adjustLocationToKeepAnchor(oldRect: Rectangle, anchorRate: Vector): void {
    const newSize = this.rectangle.size;
    const locationDelta = new Vector(
      (oldRect.size.x - newSize.x) * anchorRate.x,
      (oldRect.size.y - newSize.y) * anchorRate.y,
    );
    this.moveTo(oldRect.location.clone().add(locationDelta));
  }

  /**
   * 调整后的矩形是当前文字加了一圈padding之后的大小
   */
  private adjustSizeByText() {
    if (this.project.inlineMath?.resize(this, Infinity)) return;
    this.collisionBox.shapes[0] = new Rectangle(
      this.rectangle.location.clone(),
      getMultiLineTextSize(this.text, this.getFontSize(), 1.5, undefined, this.fontFamily, this.fontWeight).add(
        Vector.same(this.getPadding()).multiply(2),
      ),
    );
  }
  private adjustHeightByText() {
    const wrapWidth = this.rectangle.size.x - this.getPadding() * 2;
    if (this.project.inlineMath?.resize(this, wrapWidth)) return;
    const newTextSize = this.project.textRenderer.measureMultiLineTextSize(
      this.text,
      this.getFontSize(),
      wrapWidth,
      1.5,
      this.fontFamily,
      this.fontWeight,
    );
    this.collisionBox.shapes[0] = new Rectangle(
      this.rectangle.location.clone(),
      new Vector(this.rectangle.size.x, newTextSize.y + this.getPadding() * 2),
    );
    this.updateFatherSectionByMove();
  }
  /**
   * 强制触发自动调整大小
   */
  public forceAdjustSizeByText() {
    this.adjustSizeByText();
  }

  /**
   * 强制触发手动模式下的高度调整
   */
  public forceAdjustHeightByText() {
    this.adjustHeightByText();
  }

  // private adjustSizeByTextWidthLimitWidth(width: number) {
  //   const currentSize = this.project.textRenderer.measureMultiLineTextSize(this.text, Renderer.FONT_SIZE, width, 1.5);
  //   this.collisionBox.shapes[0] = new Rectangle(
  //     this.rectangle.location.clone(),
  //     currentSize.clone().add(Vector.same(Renderer.NODE_PADDING).multiply(2)),
  //   );
  // }

  rename(text: string) {
    this.text = text;
    // if (this.text.length < TextNode.enableResizeCharCount) {
    //   this.adjustSizeByText();
    // }
    if (this.sizeAdjust === "auto") {
      this.adjustSizeByText();
    } else if (this.sizeAdjust === "manual") {
      this.adjustHeightByText();
    }
    // 向孪生兄弟同步 text（_isSyncing 为 true 时说明自己正在被同步写入，跳过避免循环）
    if (!this._isSyncing) {
      this.project.syncAssociationManager.syncFrom(this, "text");
    }
  }

  resizeHandle(delta: Vector) {
    const currentRect: Rectangle = this.collisionBox.shapes[0] as Rectangle;
    const newRectangle = currentRect.clone();
    // todo：宽度能自定义控制，但是高度不能
    const newSize = newRectangle.size.add(delta);
    newSize.x = Math.max(75, newSize.x);
    if (this.project.inlineMath?.resize(this, newSize.x - this.getPadding() * 2)) return;
    const newTextSize = this.project.textRenderer.measureMultiLineTextSize(
      this.text,
      this.getFontSize(),
      newSize.x - this.getPadding() * 2,
      1.5,
    );
    newSize.y = newTextSize.y + this.getPadding() * 2;
    newRectangle.size = newSize;

    this.collisionBox.shapes[0] = newRectangle;
    this.updateFatherSectionByMove();
  }

  resizeWidthTo(width: number) {
    const currentWidth = this.rectangle.size.x;
    this.resizeHandle(new Vector(width - currentWidth, 0));
  }

  getResizeHandleRect(): Rectangle {
    const rect = this.collisionBox.getRectangle();
    return new Rectangle(rect.rightTop, new Vector(25, rect.size.y));
  }

  /**
   * 将某个物体移动一小段距离
   * @param delta
   */
  move(delta: Vector) {
    const newRectangle = this.rectangle.clone();
    newRectangle.location = newRectangle.location.add(delta);
    this.collisionBox.shapes[0] = newRectangle;

    // 移动雪花特效
    if (!this.isHiddenBySectionCollapse) {
      this.project.effects.addMoveShadow(this.rectangle, delta);
    }
    this.updateFatherSectionByMove();
    // 移动其他实体，递归碰撞
    this.updateOtherEntityLocationByMove();
  }

  protected override collideWithOtherEntity(other: Entity): void {
    if (!Settings.isEnableEntityCollision) {
      return;
    }
    if (other instanceof Section) {
      // 如果碰撞的东西是一个section
      // 如果自己是section的子节点，则不移动
      if (this.project.sectionMethods.isEntityInSection(this, other)) {
        return;
      }
    }
    super.collideWithOtherEntity(other);
  }

  /**
   * 将某个物体 的最小外接矩形的左上角位置 移动到某个位置
   * @param location
   */
  moveTo(location: Vector) {
    const newRectangle = this.rectangle.clone();
    newRectangle.location = location.clone();
    this.collisionBox.shapes[0] = newRectangle;
    this.updateFatherSectionByMove();
  }
}
