import { Project } from "@/core/Project";
import { mathImageCache } from "@/core/research/MathImage";
import { ConnectableEntity } from "@/core/stage/stageObject/abstract/ConnectableEntity";
import { CollisionBox } from "@/core/stage/stageObject/collisionBox/collisionBox";
import { Color, Vector } from "@graphif/data-structures";
import { id, passExtraAtArg1, passObject, serializable } from "@graphif/serializer";
import { Rectangle } from "@graphif/shapes";
import { toast } from "sonner";

/**
 * LaTeX 公式节点
 *
 * 将 LaTeX 字符串渲染为公式图片显示在舞台上。
 * 持久化只存储 LaTeX 字符串，SVG 渲染结果在运行时动态生成。
 * 缩放方式与文本节点一致，使用 fontScaleLevel 指数缩放。
 */
@passExtraAtArg1
@passObject
export class LatexNode extends ConnectableEntity {
  @id
  @serializable
  uuid: string;

  /**
   * LaTeX 源代码字符串（不含 $ 符号），如 "E=mc^2"
   */
  @serializable
  latexSource: string;

  @serializable
  public collisionBox: CollisionBox;

  @serializable
  color: Color = Color.Transparent;

  /**
   * 字体缩放级别，与 TextNode 一致
   * 公式大小缩放公式：scale = 2^(fontScaleLevel / 2)
   */
  @serializable
  public fontScaleLevel: number = 0;

  isHiddenBySectionCollapse: boolean = false;

  // ── 运行时状态（不序列化）──────────────────────────────────
  /** 渲染结果图片 */
  image!: HTMLImageElement;
  /** 渲染后 SVG 的原始像素尺寸 */
  svgOriginalSize: Vector = Vector.getZero();
  /** 渲染状态 */
  state: "loading" | "success" | "error" = "loading";
  /**
   * 当前图片实际渲染时使用的颜色（CSS color 字符串，如 rgba(...) / #rrggbb）。
   * LatexNodeRenderer 在每帧对比"应显示颜色"与此值，不一致时触发重新渲染。
   */
  currentRenderedColorCss: string = "";
  private renderVersion = 0;

  /** 节点是否被选中 */
  _isSelected: boolean = false;

  get isSelected() {
    return this._isSelected;
  }

  set isSelected(value: boolean) {
    this._isSelected = value;
  }

  get rectangle(): Rectangle {
    return this.collisionBox.shapes[0] as Rectangle;
  }

  public get geometryCenter(): Vector {
    return this.collisionBox.getRectangle().center;
  }

  constructor(
    protected readonly project: Project,
    {
      uuid = crypto.randomUUID(),
      details = [],
      latexSource = "",
      collisionBox = new CollisionBox([new Rectangle(Vector.getZero(), Vector.getZero())]),
      color = Color.Transparent.clone(),
      fontScaleLevel = 0,
    }: {
      uuid?: string;
      details?: any;
      latexSource?: string;
      collisionBox?: CollisionBox;
      color?: Color;
      fontScaleLevel?: number;
    },
  ) {
    super();
    this.uuid = uuid;
    this.latexSource = latexSource;
    this.details = details;
    this.collisionBox = collisionBox;
    this.color = color;
    this.fontScaleLevel = fontScaleLevel;

    // 异步渲染 LaTeX 公式，初始颜色：透明色→主题边框色，否则→用户自定义色
    const initColor = color.a === 0 ? this.project.stageStyleManager.currentStyle.StageObjectBorder : color;
    this.renderLatexToImage(latexSource, initColor.toString());
  }

  /**
   * 获取当前缩放倍数
   * 公式：2^(fontScaleLevel / 2)
   */
  public getScale(): number {
    return Math.pow(2, this.fontScaleLevel / 2);
  }

  /**
   * 放大字体（增加 fontScaleLevel）
   */
  public increaseFontSize(anchorRate?: Vector): void {
    this.fontScaleLevel++;
    this.updateCollisionBoxByScale(anchorRate);
  }

  /**
   * 缩小字体（减少 fontScaleLevel）
   */
  public decreaseFontSize(anchorRate?: Vector): void {
    this.fontScaleLevel--;
    this.updateCollisionBoxByScale(anchorRate);
  }

  /**
   * 根据当前 fontScaleLevel 更新碰撞箱大小
   */
  private updateCollisionBoxByScale(anchorRate?: Vector): void {
    if (this.svgOriginalSize.x === 0 || this.svgOriginalSize.y === 0) return;
    const scale = this.getScale();
    const oldRect = this.rectangle.clone();
    const newSize = this.svgOriginalSize.multiply(scale);
    this.collisionBox.shapes[0] = new Rectangle(this.rectangle.location.clone(), newSize);
    if (anchorRate) {
      this._adjustLocationToKeepAnchor(oldRect, anchorRate);
    } else if (!oldRect.size.equals(newSize)) {
      // 异步出图会改变旧卡片尺寸，只重算祖先边框，不能触发移动碰撞求解而挪动卡片。
      let section = this.parentSection;
      while (section) {
        section.adjustLocationAndSize();
        section = section.parentSection;
      }
    }
  }

  private _adjustLocationToKeepAnchor(oldRect: Rectangle, anchorRate: Vector): void {
    const newSize = this.rectangle.size;
    const locationDelta = new Vector(
      (oldRect.size.x - newSize.x) * anchorRate.x,
      (oldRect.size.y - newSize.y) * anchorRate.y,
    );
    this.moveTo(oldRect.location.clone().add(locationDelta));
  }

  /**
   * 更新 LaTeX 源码并重新渲染
   * @param newLatex 新的 LaTeX 字符串
   * @param colorCss 渲染颜色（CSS color 字符串，如 "rgba(255,0,0,0.5)" / "#ffffff"），不传则沿用当前已记录的颜色
   */
  public async updateLatex(newLatex: string, colorCss?: string): Promise<void> {
    this.latexSource = newLatex;
    await this.renderLatexToImage(newLatex, colorCss ?? (this.currentRenderedColorCss || "#000000"));
  }

  /**
   * 以指定颜色重新渲染当前 LaTeX（颜色变化时由 LatexNodeRenderer 调用）
   */
  public async reRenderWithColor(colorCss: string): Promise<void> {
    await this.renderLatexToImage(this.latexSource, colorCss);
  }

  /**
   * 将 LaTeX 字符串渲染为 HTMLImageElement
   * 流程：katex.renderToString → SVG foreignObject → Blob URL → Image
   * @param latex LaTeX 源码
   * @param colorCss 公式颜色（CSS color 字符串，如 "rgba(255,0,0,0.5)" / "#ffffff"）
   */
  private async renderLatexToImage(latex: string, colorCss: string = "#000000"): Promise<void> {
    const version = ++this.renderVersion;
    if (!latex.trim()) {
      this.state = "error";
      return;
    }
    this.state = "loading";
    const result = await mathImageCache.load({ source: latex, mode: "display", color: colorCss });
    if (version !== this.renderVersion) return;
    if (result.status !== "ready") {
      this.state = "error";
      if (result.status === "failed") toast.error(`LaTeX 渲染失败：${String(result.error)}`);
      return;
    }
    const { image, width, height } = result.value;
    this.svgOriginalSize = new Vector(width, height);
    this.image = image;
    this.currentRenderedColorCss = colorCss;
    this.updateCollisionBoxByScale();
    this.state = "success";
  }

  move(delta: Vector): void {
    const newRectangle = this.collisionBox.getRectangle().clone();
    newRectangle.location = newRectangle.location.add(delta);
    this.collisionBox.shapes[0] = newRectangle;
    this.updateFatherSectionByMove();
  }

  moveTo(location: Vector): void {
    const newRectangle = this.collisionBox.getRectangle().clone();
    newRectangle.location = location.clone();
    this.collisionBox.shapes[0] = newRectangle;
    this.updateFatherSectionByMove();
  }
}
