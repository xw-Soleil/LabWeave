import { service, type Project } from "@/core/Project";
import { Settings } from "@/core/service/Settings";
import type { TextNode } from "@/core/stage/stageObject/entity/TextNode";
import { getFontIdentity, getTextSize, resolveFont, setCanvasFont } from "@/utils/font";
import { colorInvert, LruCache, Vector } from "@graphif/data-structures";
import { Rectangle } from "@graphif/shapes";
import { splitInlineMath, type MathSegment } from "./InlineMath";
import {
  mathImageCache,
  MathImageCache,
  MATH_REFERENCE_FONT_SIZE,
  type MathImage,
  type MathMetrics,
  type MathImageRequest,
  type MathImageResult,
} from "./MathImage";
import { layoutRichText, type RichTextLayout } from "./RichTextLayout";

interface FormulaUsers {
  nodes: Set<TextNode>;
  version: number;
  metrics?: MathMetrics;
  // 使用者共同持有一张可绘制的图，换色等待期间不闪回源码；最后一个使用者移除后释放。
  image?: MathImage;
}

const formulaKey = ({ source, mode }: Pick<MathImageRequest, "source" | "mode">) => JSON.stringify([source, mode]);

@service("inlineMath")
export class InlineMathService {
  private readonly parsed = new LruCache<string, MathSegment[] | null>(1000);
  private readonly layouts = new LruCache<string, RichTextLayout>(1000);
  private readonly users = new Map<string, FormulaUsers>();
  private readonly nodes = new Map<TextNode, { keys: string[]; painted: Map<string, MathImage> }>();
  private revision = 0;
  private readonly unsubscribe: () => void;
  private readonly unwatchFont: () => void;
  private disposed = false;
  private defaultFont = Settings.defaultFontFamily;
  private readonly fontsLoaded = () => this.refreshFonts(false);

  constructor(
    private readonly project: Project,
    private readonly images: MathImageCache = mathImageCache,
  ) {
    this.unsubscribe = images.subscribe((request, result) => this.imageFinished(request, result));
    this.unwatchFont = Settings.watch("defaultFontFamily", () => {
      // Settings 的直接赋值先通知再写入，延后读取才能量到新字体；同一轮连续修改只重算一次。
      queueMicrotask(() => {
        if (this.disposed || this.defaultFont === Settings.defaultFontFamily) return;
        this.defaultFont = Settings.defaultFontFamily;
        this.refreshFonts(true);
      });
    });
    if (typeof document !== "undefined") document.fonts?.addEventListener("loadingdone", this.fontsLoaded);
  }

  private refreshFonts(defaultOnly: boolean) {
    if (this.disposed) return;
    for (const node of this.project.stageManager.getTextNodes()) {
      if ((defaultOnly && node.fontFamily) || !this.segments(node.text)) continue;
      if (node.sizeAdjust === "manual") node.forceAdjustHeightByText();
      else node.forceAdjustSizeByText();
    }
    this.project.controller.resetCountdownTimer();
  }

  private segments(text: string): MathSegment[] | null {
    const cached = this.parsed.get(text);
    if (cached !== undefined) return cached;
    const segments = typeof text === "string" ? splitInlineMath(text) : [];
    const value = segments.some((segment) => segment.type !== "text") ? segments : null;
    this.parsed.set(text, value);
    return value;
  }

  private color(node: TextNode) {
    return colorInvert(node.color.a === 1 ? node.color : this.project.stageStyleManager.currentStyle.Background);
  }

  private wrapWidth(node: TextNode) {
    return node.sizeAdjust === "manual" ? node.rectangle.width - node.getPadding() * 2 : Infinity;
  }

  private textDescent(node: TextNode): number {
    const ctx = this.project.canvas.ctx;
    ctx.save();
    setCanvasFont(ctx, resolveFont(100, node.fontFamily, node.fontWeight));
    // 原文字绘制用 middle 基线；两次测同一字形，把它换算成混排所需的 alphabetic 基线。
    ctx.textBaseline = "middle";
    const middle = ctx.measureText("Mg").actualBoundingBoxDescent;
    ctx.textBaseline = "alphabetic";
    const alphabetic = ctx.measureText("Mg").actualBoundingBoxDescent;
    ctx.restore();
    return node.getFontSize() * (Number.isFinite(middle - alphabetic) ? 0.5 - (middle - alphabetic) / 100 : 0.2);
  }

  private entry(node: TextNode, segments: MathSegment[], width: number): RichTextLayout {
    const color = this.color(node).toString();
    const requests = new Map<string, MathImageRequest>();
    for (const segment of segments) {
      if (segment.type === "text") continue;
      const request = { source: segment.source, mode: segment.type, color };
      requests.set(formulaKey(request), request);
    }
    const keys = [...requests.keys()];
    const tracked = this.nodes.get(node);
    if (!tracked || tracked.keys.length !== keys.length || tracked.keys.some((key, i) => key !== keys[i])) {
      this.forget(node);
      for (const key of keys) {
        let users = this.users.get(key);
        if (!users) {
          const image = this.images.peekAnyColor(requests.get(key)!);
          this.users.set(key, (users = { nodes: new Set(), version: ++this.revision, image, metrics: image?.layout }));
        }
        users.nodes.add(node);
      }
      this.nodes.set(node, {
        keys,
        painted: new Map([...(tracked?.painted ?? [])].filter(([key]) => requests.has(key))),
      });
    }
    const key = JSON.stringify([
      node.text,
      node.getFontSize(),
      getFontIdentity(node.fontFamily, node.fontWeight),
      width,
      keys.map((key) => this.users.get(key)!.version),
    ]);
    for (const request of requests.values()) {
      if (!this.images.peek(request)) this.images.request(request);
    }
    const cached = this.layouts.get(key);
    if (cached) return cached;
    const textDescent = this.textDescent(node);
    const scale = node.getFontSize() / MATH_REFERENCE_FONT_SIZE;
    const layout = layoutRichText({
      segments,
      fontSize: node.getFontSize(),
      lineHeight: 1.5,
      maxWidth: width,
      textDescent,
      measureText: (text) => getTextSize(text, node.getFontSize(), node.fontFamily, node.fontWeight).x,
      getMathMetrics: (segment) => {
        const metrics = this.users.get(formulaKey({ source: segment.source, mode: segment.type }))!.metrics;
        if (!metrics) return null;
        const { width, height, descent } = metrics;
        return { width: width * scale, height: height * scale, descent: descent * scale };
      },
    });
    this.layouts.set(key, layout);
    return layout;
  }

  private applySize(node: TextNode, layout: RichTextLayout, width: number) {
    const padding = node.getPadding() * 2;
    const size = new Vector((Number.isFinite(width) ? width : layout.width) + padding, layout.height + padding);
    if (node.rectangle.size.equals(size)) return;
    node.collisionBox.shapes[0] = new Rectangle(node.rectangle.location.clone(), size);
    this.adjustSections(node);
  }

  private adjustSections(node: TextNode) {
    for (let section = node.parentSection; section; section = section.parentSection) section.adjustLocationAndSize();
  }

  resize(node: TextNode, width = this.wrapWidth(node)): boolean {
    const segments = this.segments(node.text);
    if (!segments || node.isEditing) {
      this.forget(node);
      return false;
    }
    this.applySize(node, this.entry(node, segments, width), width);
    return true;
  }

  editingChanged(node: TextNode) {
    if (!this.segments(node.text)) return;
    if (node.sizeAdjust === "manual") node.forceAdjustHeightByText();
    else node.forceAdjustSizeByText();
    this.adjustSections(node);
  }

  render(node: TextNode): boolean {
    // 无公式的热路径只多一次切分缓存查询，其余绘制继续由原分支完成。
    const segments = this.segments(node.text);
    if (!segments || node.isEditing) return false;
    const width = this.wrapWidth(node);
    const entry = this.entry(node, segments, width);
    let fontSize = node.getFontSize() * this.project.camera.currentScale;
    let origin = this.project.renderer.transformWorld2View(
      node.rectangle.location.add(Vector.same(node.getPadding())).add(new Vector(0, node.getFontSize() / 4)),
    );
    if (Settings.textIntegerLocationAndSizeRender) {
      origin = origin.toInteger();
      fontSize = Math.round(fontSize);
    }
    if (fontSize <= 0 || !Number.isFinite(fontSize)) return true;
    const scale = fontSize / node.getFontSize();
    const imageScale = fontSize / MATH_REFERENCE_FONT_SIZE;
    const color = this.color(node);
    const ctx = this.project.canvas.ctx;
    for (const line of entry.lines) {
      for (const fragment of line.fragments) {
        const location = origin.add(
          new Vector(
            fragment.x * scale,
            (line.y + line.baseline - fragment.height + fragment.descent - node.getFontSize() / 4) * scale,
          ),
        );
        if (fragment.type === "text") {
          this.project.textRenderer.renderText(
            fragment.text,
            location,
            fontSize,
            color,
            node.fontFamily || undefined,
            node.fontWeight || undefined,
          );
        } else if (Settings.protectingPrivacy) {
          const opaque = color.clone();
          opaque.a = 1;
          ctx.fillStyle = opaque.toString();
          const point = Settings.textIntegerLocationAndSizeRender ? location.toInteger() : location;
          ctx.fillRect(point.x, point.y, fragment.width * scale, fragment.height * scale);
        } else {
          const request = { source: fragment.source, mode: fragment.type, color: color.toString() };
          const result = this.images.peek(request);
          const key = formulaKey(request);
          const painted = this.nodes.get(node)!.painted;
          // 同一公式可能还被别的颜色的卡片使用，换色时应保留本卡片上一次画过的图。
          const image = result?.status === "ready" ? result.value : (painted.get(key) ?? this.users.get(key)!.image);
          if (!image) continue;
          let point = location.subtract(new Vector(image.layoutOffset.x, image.layoutOffset.y).multiply(imageScale));
          if (Settings.textIntegerLocationAndSizeRender) point = point.toInteger();
          ctx.drawImage(image.image, point.x, point.y, image.width * imageScale, image.height * imageScale);
          painted.set(key, image);
        }
      }
    }
    return true;
  }

  private imageFinished(request: MathImageRequest, result: MathImageResult) {
    const key = formulaKey(request);
    const users = this.users.get(key);
    if (!users || result.status !== "ready") return;
    const firstMetrics = !users.metrics;
    users.image = result.value;
    // 同一源码和模式的排版尺寸与颜色无关，后续换色只替换图片，不失效排版或改碰撞箱。
    if (firstMetrics) {
      users.metrics = result.value.layout;
      users.version = ++this.revision;
      for (const node of [...users.nodes]) {
        if (!this.resize(node)) this.forget(node);
      }
    }
    this.project.controller.resetCountdownTimer();
  }

  forget(node: TextNode) {
    const tracked = this.nodes.get(node);
    if (!tracked) return;
    for (const key of tracked.keys) {
      const users = this.users.get(key)!;
      users.nodes.delete(node);
      if (!users.nodes.size) this.users.delete(key);
    }
    this.nodes.delete(node);
  }

  syncNodes(nodes: TextNode[]) {
    // 舞台替换、撤销或删除时才核对成员；图片通知沿反向索引定位，不扫描整个白板。
    const current = new Set(nodes);
    for (const node of this.nodes.keys()) if (!current.has(node)) this.forget(node);
    for (const node of nodes) this.resize(node);
  }

  dispose() {
    this.disposed = true;
    this.unsubscribe();
    this.unwatchFont();
    if (typeof document !== "undefined") document.fonts?.removeEventListener("loadingdone", this.fontsLoaded);
    this.nodes.clear();
    this.users.clear();
    this.parsed.clear();
    this.layouts.clear();
  }
}

declare module "@/core/Project" {
  interface Project {
    inlineMath: InlineMathService;
  }
}
