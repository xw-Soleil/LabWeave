import type { getKatexFontFace as FindKatexFontFace, KatexFontFace } from "@/utils/katexEmbeddedCss";

export const MATH_REFERENCE_FONT_SIZE = 32;

export interface MathMetrics {
  width: number;
  height: number;
  descent: number;
}

export interface MathImage {
  image: HTMLImageElement;
  width: number;
  height: number;
  fontSize: number;
  layout: MathMetrics;
  layoutOffset: { x: number; y: number };
}

export interface MathImageRequest {
  source: string;
  mode: "inline" | "display";
  color: string;
}

export type MathImageResult =
  | { status: "ready"; value: MathImage }
  | { status: "failed"; error: unknown }
  | { status: "unavailable" };

export type MathImageState = MathImageResult | { status: "pending"; finished: Promise<MathImageResult> };

const mathLayoutCss = ".katex-display{margin:0}";
let measurement: { frame: HTMLIFrameElement; document: Document; fontsLoaded: Promise<void> } | undefined;
let renderQueue: Promise<void> = Promise.resolve();

async function getMeasurementDocument(owner: Document, css: string, fonts: KatexFontFace[]): Promise<Document> {
  if (
    measurement?.frame.ownerDocument === owner &&
    measurement.frame.isConnected &&
    measurement.frame.contentDocument === measurement.document &&
    measurement.document.body?.isConnected
  ) {
    await measurement.fontsLoaded;
    return measurement.document;
  }
  measurement?.frame.remove();
  const frame = owner.createElement("iframe");
  frame.style.cssText =
    "position:fixed;left:-100000px;top:0;width:4096px;height:4096px;border:0;visibility:hidden;pointer-events:none;";
  frame.setAttribute("aria-hidden", "true");
  frame.tabIndex = -1;
  owner.body.appendChild(frame);
  const doc = frame.contentDocument!;
  // 空白 iframe 是怪异模式，文字少的行内盒不撑行高；SVG 图片按标准模式排版，矮公式在图里会比量出的基线低。
  doc.open();
  doc.write("<!DOCTYPE html><html><head></head><body></body></html>");
  doc.close();
  const style = doc.createElement("style");
  style.textContent = css + mathLayoutCss;
  doc.head.appendChild(style);
  // 显式加载不依赖隐藏文档先触发布局；所有字体解码成功并加入该文档后才能开始测量。
  const fontsLoaded = Promise.all(
    fonts.map(async ({ family, source, weight, style }) => {
      const face = await new doc.defaultView!.FontFace(family, source, { weight, style }).load();
      doc.fonts.add(face);
    }),
  ).then(
    () => undefined,
    (error) => {
      // 失败公式仍由图片缓存记账，但下一条公式需要一份可重新加载字体的测量文档。
      frame.remove();
      if (measurement?.frame === frame) measurement = undefined;
      throw error;
    },
  );
  measurement = { frame, document: doc, fontsLoaded };
  await fontsLoaded;
  return doc;
}

function measureMathContents(root: HTMLElement, findFont: typeof FindKatexFontFace) {
  const doc = root.ownerDocument;
  const layout = root.getBoundingClientRect();
  let { left, top, right, bottom } = layout;
  let largestFontSize = MATH_REFERENCE_FONT_SIZE;
  const fontFaces = new Set<string>();
  const styles = new Map<Element, CSSStyleDeclaration>();
  const styleOf = (element: Element) => {
    let style = styles.get(element);
    if (!style) {
      style = doc.defaultView!.getComputedStyle(element);
      styles.set(element, style);
    }
    return style;
  };
  const includeFont = (element: Element) => {
    const style = styleOf(element);
    const face = findFont(style.fontFamily, style.fontWeight, style.fontStyle);
    if (face) fontFaces.add(face.css);
    largestFontSize = Math.max(largestFontSize, parseFloat(style.fontSize) || 0);
  };
  const includeBounds = (element: Element, rect: DOMRect) => {
    if (rect.width <= 0 || rect.height <= 0) return;
    let { left: x1, right: x2, top: y1, bottom: y2 } = rect;
    for (let parent = element.parentElement; parent && root.contains(parent); parent = parent.parentElement) {
      const style = styleOf(parent);
      const clips = (overflow: string) => /^(hidden|clip|scroll|auto)$/.test(overflow);
      const clipX = clips(style.overflowX) || clips(style.overflow);
      const clipY = clips(style.overflowY) || clips(style.overflow);
      if (!clipX && !clipY) continue;
      // 根号等伸缩 SVG 有刻意藏在 .hide-tail 中的长尾，不能把它算进图片尺寸。
      const bounds = parent.getBoundingClientRect();
      if (clipX) {
        x1 = Math.max(x1, bounds.left);
        x2 = Math.min(x2, bounds.right);
      }
      if (clipY) {
        y1 = Math.max(y1, bounds.top);
        y2 = Math.min(y2, bounds.bottom);
      }
    }
    if (x2 <= x1 || y2 <= y1) return;
    left = Math.min(left, x1);
    top = Math.min(top, y1);
    right = Math.max(right, x2);
    bottom = Math.max(bottom, y2);
  };
  const walker = doc.createTreeWalker(root, 4);
  const range = doc.createRange();
  for (let text = walker.nextNode(); text; text = walker.nextNode()) {
    if (!text.textContent?.trim() || !text.parentElement) continue;
    includeFont(text.parentElement);
    range.selectNodeContents(text);
    includeBounds(text.parentElement, range.getBoundingClientRect());
  }
  for (const element of root.querySelectorAll("*")) {
    // 自动编号由 ::before 的 counter 产生，没有 Text 节点，但仍使用继承的字体。
    if (element.classList.contains("eqn-num")) includeFont(element);
    if (element.namespaceURI === "http://www.w3.org/2000/svg") {
      if (element.localName === "svg") includeBounds(element, element.getBoundingClientRect());
      continue;
    }
    const style = styleOf(element);
    if (
      [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth].some(
        (w) => parseFloat(w) > 0,
      )
    ) {
      includeBounds(element, element.getBoundingClientRect());
    }
  }
  // strut 是排版度量，不是墨迹边界；正常行框和外伸范围之外再留四分之一 em，容纳斜体侧承和抗锯齿。
  const padding = Math.max(4, largestFontSize / 4);
  const width = Math.ceil(right - left + padding * 2);
  const height = Math.ceil(bottom - top + padding * 2);
  return {
    layout,
    width,
    height,
    x: layout.left - left + (width - (right - left)) / 2,
    y: layout.top - top + (height - (bottom - top)) / 2,
    fontFaces,
  };
}

export function renderMathImage(request: MathImageRequest): Promise<MathImage | null> {
  if (typeof document === "undefined" || !document.body || typeof Image === "undefined") return Promise.resolve(null);
  const owner = document;
  const input = { ...request };
  const result = renderQueue.then(() => renderQueuedMathImage(input, owner));
  // 原始失败仍交给调用方记账；队列只解除等待，不能让一条坏公式堵住后续请求。
  renderQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

async function renderQueuedMathImage(
  { source, mode, color }: MathImageRequest,
  owner: Document,
): Promise<MathImage | null> {
  if (owner !== document || !owner.body?.isConnected) return null;
  // Node/CLI 不加载 Vite 的 CSS、字体资源，也不创建任何 DOM。
  const [{ default: katex }, { katexFontFaces, katexStyleCss, getKatexFontFace }] = await Promise.all([
    import("katex"),
    import("@/utils/katexEmbeddedCss"),
  ]);
  const html = katex.renderToString(source, { throwOnError: true, displayMode: mode === "display", output: "html" });
  const measurementDocument = await getMeasurementDocument(owner, katexStyleCss, katexFontFaces);
  const root = measurementDocument.createElement("div");
  let url: string | undefined;
  try {
    // 页面全局样式和块公式的 margin 折叠都不能参与测量，SVG 内也只保留同一套样式。
    root.style.cssText = `display:block;width:max-content;box-sizing:border-box;font-size:${MATH_REFERENCE_FONT_SIZE}px;line-height:1.2;white-space:nowrap;counter-reset:katexEqnNo mmlEqnNo;`;
    root.style.color = color;
    root.innerHTML = html;
    measurementDocument.body.appendChild(root);
    const mathHtml = root.querySelector<HTMLElement>(".katex-html")!;
    const baseline = measurementDocument.createElement("span");
    baseline.style.cssText = "display:inline-block;width:0;height:0;padding:0;border:0;vertical-align:baseline;";
    mathHtml.appendChild(baseline);

    // 字体已显式加载；ready 只作为插入内容后的布局屏障，不负责启动字体加载。
    await measurementDocument.fonts.ready;
    for (const tag of root.querySelectorAll<HTMLElement>(".tag")) {
      if (tag.parentElement) {
        tag.parentElement.style.paddingRight = `${tag.getBoundingClientRect().width + MATH_REFERENCE_FONT_SIZE}px`;
      }
    }
    const { width, height, x, y, layout, fontFaces } = measureMathContents(root, getKatexFontFace);
    const baselineY = baseline.getBoundingClientRect().top;
    let ascent = 0;
    let descent = 0;
    // 顶层 strut 只有 KaTeX 的高度和深度；取实际位置也能涵盖公式内部的显式换行。
    for (const strut of mathHtml.querySelectorAll<HTMLElement>(":scope > .base > .strut, :scope > .tag > .strut")) {
      const bounds = strut.getBoundingClientRect();
      ascent = Math.max(ascent, baselineY - bounds.top);
      descent = Math.max(descent, bounds.bottom - baselineY);
    }
    const mathBounds = mathHtml.getBoundingClientRect();
    const mathLayout = { width: mathBounds.width, height: ascent + descent, descent };
    const layoutOffset = { x: x + mathBounds.left - layout.left, y: y + baselineY - ascent - layout.top };

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("width", String(width));
    svg.setAttribute("height", String(height));
    const foreignObject = document.createElementNS("http://www.w3.org/2000/svg", "foreignObject");
    foreignObject.setAttribute("x", "0");
    foreignObject.setAttribute("y", "0");
    foreignObject.setAttribute("width", String(width));
    foreignObject.setAttribute("height", String(height));
    // 防裁切余量必须在 foreignObject 内；用内边距定位，避免依赖 WebKit 的 SVG 溢出绘制。
    const content = measurementDocument.createElement("div");
    content.style.cssText = `box-sizing:border-box;width:${width}px;height:${height}px;padding-left:${x}px;padding-top:${y}px;`;
    root.style.width = `${layout.width}px`;
    root.style.height = `${layout.height}px`;
    content.appendChild(root);
    foreignObject.appendChild(content);
    svg.appendChild(foreignObject);
    const style = measurementDocument.createElement("style");
    style.textContent = [...fontFaces].join("") + katexStyleCss + mathLayoutCss;
    root.prepend(style);
    // HTML 实体和命名空间必须经 XML 序列化后才能装进 SVG。
    const svgContent = new XMLSerializer().serializeToString(svg);
    url = URL.createObjectURL(new Blob([svgContent], { type: "image/svg+xml;charset=utf-8" }));
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("MATH_IMAGE_LOAD_FAILED"));
      image.src = url!;
    });
    return { image, width, height, layout: mathLayout, layoutOffset, fontSize: MATH_REFERENCE_FONT_SIZE };
  } finally {
    root.remove();
    if (url) URL.revokeObjectURL(url);
  }
}

export class MathImageCache {
  private readonly entries = new Map<string, MathImageState>();
  private readonly listeners = new Set<(request: MathImageRequest, result: MathImageResult) => void>();

  constructor(
    private readonly render: (request: MathImageRequest) => Promise<MathImage | null> = renderMathImage,
    private readonly capacity = 256,
  ) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error("MATH_IMAGE_INVALID_CACHE_CAPACITY");
  }

  peek(request: MathImageRequest): MathImageState | undefined {
    const key = JSON.stringify([request.source, request.mode, request.color]);
    const state = this.entries.get(key);
    if (state) {
      this.entries.delete(key);
      this.entries.set(key, state);
    }
    return state;
  }

  peekAnyColor({ source, mode }: Pick<MathImageRequest, "source" | "mode">): MathImage | undefined {
    for (const [key, state] of this.entries) {
      if (state.status !== "ready") continue;
      const [cachedSource, cachedMode] = JSON.parse(key);
      if (cachedSource === source && cachedMode === mode) return state.value;
    }
  }

  request(request: MathImageRequest): MathImageState {
    const key = JSON.stringify([request.source, request.mode, request.color]);
    const existing = this.peek(request);
    if (existing) return existing;
    const input = { ...request };
    const state: MathImageState = {
      status: "pending",
      finished: Promise.resolve()
        .then(() => this.render(input))
        .then<MathImageResult, MathImageResult>(
          (value) => (value ? { status: "ready", value } : { status: "unavailable" }),
          // 混排中坏公式应原样显示源码；在这里统一记账，缓存存续期间不重试、不弹提示。
          (error) => ({ status: "failed", error }),
        )
        .then((result) => {
          // 已淘汰的异步任务不能重新占据缓存，也不能覆盖同键的新任务。
          if (this.entries.get(key) === state) this.entries.set(key, result);
          for (const listener of this.listeners) {
            queueMicrotask(() => {
              if (this.listeners.has(listener)) listener(input, result);
            });
          }
          return result;
        }),
    };
    this.entries.set(key, state);
    if (this.entries.size > this.capacity) this.entries.delete(this.entries.keys().next().value!);
    return state;
  }

  get(request: MathImageRequest): MathImage | null {
    const state = this.request(request);
    return state.status === "ready" ? state.value : null;
  }

  async load(request: MathImageRequest): Promise<MathImageResult> {
    const state = this.request(request);
    return state.status === "pending" ? state.finished : state;
  }

  subscribe(listener: (request: MathImageRequest, result: MathImageResult) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export const mathImageCache = new MathImageCache();
