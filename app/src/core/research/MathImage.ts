import type { getKatexFontFace as FindKatexFontFace } from "@/utils/katexEmbeddedCss";

export const MATH_REFERENCE_FONT_SIZE = 32;

export interface MathMetrics {
  width: number;
  height: number;
  descent: number;
}

export interface MathImage extends MathMetrics {
  image: HTMLImageElement;
  fontSize: number;
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
let measurement: { frame: HTMLIFrameElement; document: Document } | undefined;
let renderQueue: Promise<void> = Promise.resolve();

function getMeasurementDocument(owner: Document, css: string): Document {
  if (
    measurement?.frame.ownerDocument === owner &&
    measurement.frame.isConnected &&
    measurement.frame.contentDocument === measurement.document &&
    measurement.document.body?.isConnected
  ) {
    return measurement.document;
  }
  measurement?.frame.remove();
  const frame = owner.createElement("iframe");
  frame.style.cssText = "position:fixed;left:0;top:0;width:0;height:0;border:0;visibility:hidden;pointer-events:none;";
  frame.setAttribute("aria-hidden", "true");
  frame.tabIndex = -1;
  owner.body.appendChild(frame);
  const doc = frame.contentDocument!;
  const style = doc.createElement("style");
  style.textContent = css + mathLayoutCss;
  doc.head.appendChild(style);
  measurement = { frame, document: doc };
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
  const [{ default: katex }, { katexEmbeddedCss, katexStyleCss, getKatexFontFace }] = await Promise.all([
    import("katex"),
    import("@/utils/katexEmbeddedCss"),
  ]);
  const html = katex.renderToString(source, { throwOnError: true, displayMode: mode === "display", output: "html" });
  const measurementDocument = getMeasurementDocument(owner, katexEmbeddedCss);
  const root = measurementDocument.createElement("div");
  let url: string | undefined;
  try {
    // 页面全局样式和块公式的 margin 折叠都不能参与测量，SVG 内也只保留同一套样式。
    root.style.cssText = `display:inline-block;box-sizing:border-box;font-size:${MATH_REFERENCE_FONT_SIZE}px;line-height:1.2;white-space:nowrap;counter-reset:katexEqnNo mmlEqnNo;`;
    root.style.color = color;
    root.innerHTML = html;
    measurementDocument.body.appendChild(root);
    const mathHtml = root.querySelector<HTMLElement>(".katex-html")!;
    const baseline = measurementDocument.createElement("span");
    baseline.style.cssText = "display:inline-block;width:0;height:0;padding:0;border:0;vertical-align:baseline;";
    mathHtml.appendChild(baseline);

    // 先触发布局，确保 fonts.ready 等待的是本次公式实际用到的内嵌字体。
    root.getBoundingClientRect();
    await measurementDocument.fonts.ready;
    for (const tag of root.querySelectorAll<HTMLElement>(".tag")) {
      if (tag.parentElement) {
        tag.parentElement.style.paddingRight = `${tag.getBoundingClientRect().width + MATH_REFERENCE_FONT_SIZE}px`;
      }
    }
    const { width, height, x, y, layout, fontFaces } = measureMathContents(root, getKatexFontFace);
    const descent = height - (y + baseline.getBoundingClientRect().top - layout.top);

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("width", String(width));
    svg.setAttribute("height", String(height));
    const foreignObject = document.createElementNS("http://www.w3.org/2000/svg", "foreignObject");
    foreignObject.setAttribute("x", String(x));
    foreignObject.setAttribute("y", String(y));
    foreignObject.setAttribute("width", String(Math.max(1, layout.width)));
    foreignObject.setAttribute("height", String(Math.max(1, layout.height)));
    foreignObject.setAttribute("overflow", "visible");
    foreignObject.appendChild(root);
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
    return { image, width, height, descent, fontSize: MATH_REFERENCE_FONT_SIZE };
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

  request(request: MathImageRequest): MathImageState {
    const key = JSON.stringify([request.source, request.mode, request.color]);
    const existing = this.entries.get(key);
    if (existing) {
      this.entries.delete(key);
      this.entries.set(key, existing);
      return existing;
    }
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
