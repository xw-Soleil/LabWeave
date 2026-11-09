// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getKatexFontFace, katexFontFaces } from "@/utils/katexEmbeddedCss";
import { MathImageCache, renderMathImage } from "./MathImage";
import { splitInlineMath } from "./InlineMath";
import { layoutRichText } from "./RichTextLayout";

let serialized: SVGSVGElement;
let autoLoad: boolean;
let fontsReady: () => Promise<void>;
let loadFont: (face: MockFontFace) => Promise<void>;
let textBounds: () => DOMRect;
let extraBounds: (element: Element) => DOMRect | undefined;
const images: { onload: () => void; onerror: () => void }[] = [];
const frames: HTMLIFrameElement[] = [];
const measured: string[] = [];
const fontLoads: MockFontFace[] = [];
const globalFontFace = vi.fn();
const geometryReads = vi.fn();
const revoke = vi.fn();

class MockFontFace {
  status = "unloaded";
  constructor(
    readonly family: string,
    readonly source: string,
    readonly descriptors: FontFaceDescriptors,
  ) {}
  async load() {
    fontLoads.push(this);
    this.status = "loading";
    await loadFont(this);
    this.status = "loaded";
    return this;
  }
}

beforeEach(() => {
  autoLoad = true;
  images.length = frames.length = measured.length = fontLoads.length = 0;
  revoke.mockClear();
  globalFontFace.mockClear();
  geometryReads.mockClear();
  fontsReady = () => Promise.resolve();
  loadFont = () => Promise.resolve();
  vi.stubGlobal(
    "FontFace",
    class {
      constructor() {
        globalFontFace();
        throw new Error("FontFace must be created in the measurement iframe");
      }
    },
  );
  textBounds = () => new DOMRect(12, 12, 20, 20);
  extraBounds = () => undefined;
  vi.stubGlobal(
    "URL",
    class extends URL {
      static createObjectURL = () => "blob:math-test";
      static revokeObjectURL = revoke;
    },
  );
  vi.stubGlobal(
    "Image",
    class {
      onload = () => {};
      onerror = () => {};
      set src(_value: string) {
        images.push(this);
        if (autoLoad) queueMicrotask(() => this.onload());
      }
    },
  );
  const serialize = XMLSerializer.prototype.serializeToString;
  vi.spyOn(XMLSerializer.prototype, "serializeToString").mockImplementation(function (this: XMLSerializer, node) {
    serialized = node.cloneNode(true) as SVGSVGElement;
    return serialize.call(this, node);
  });
  const append = document.body.appendChild.bind(document.body);
  vi.spyOn(document.body, "appendChild").mockImplementation((node) => {
    const result = append(node);
    if (node instanceof HTMLIFrameElement) {
      frames.push(node);
      const doc = node.contentDocument!;
      class FrameFontFace extends MockFontFace {}
      Object.defineProperty(doc.defaultView!, "FontFace", { value: FrameFontFace });
      const loaded = new Set<MockFontFace>();
      Object.defineProperty(doc, "fonts", {
        value: {
          add: (face: MockFontFace) => {
            expect(face).toBeInstanceOf(FrameFontFace);
            expect(face.status).toBe("loaded");
            loaded.add(face);
          },
          get ready() {
            measured.push(doc.body.textContent!);
            return fontsReady();
          },
        },
      });
      const computedStyle = doc.defaultView!.getComputedStyle.bind(doc.defaultView);
      vi.spyOn(doc.defaultView!, "getComputedStyle").mockImplementation((element) => {
        const style = computedStyle(element);
        // jsdom 不做真实字体排版；只固定尺寸，字体族、字重、字形仍来自真正的 KaTeX CSS。
        Object.defineProperty(style, "fontSize", { value: "32px" });
        return style;
      });
      vi.spyOn(doc, "createRange").mockReturnValue({
        selectNodeContents: () => {},
        getBoundingClientRect: () => textBounds(),
      } as unknown as Range);
      const createElement = doc.createElement.bind(doc);
      vi.spyOn(doc, "createElement").mockImplementation((tag) => {
        const element = createElement(tag);
        vi.spyOn(element, "getBoundingClientRect").mockImplementation(() => {
          geometryReads(loaded.size);
          return tag === "div" ? new DOMRect(10, 10, 101.25, 32.5) : new DOMRect(10, 35, 0, 0);
        });
        if (tag === "div") {
          const querySelector = element.querySelector.bind(element);
          vi.spyOn(element, "querySelector").mockImplementation((selector) => {
            const child = querySelector(selector);
            if (selector === ".katex-html" && child) {
              vi.spyOn(child, "getBoundingClientRect").mockReturnValue(new DOMRect(10, 10, 81.25, 32.5));
            }
            return child;
          });
          const querySelectorAll = element.querySelectorAll.bind(element);
          vi.spyOn(element, "querySelectorAll").mockImplementation((selector) => {
            const elements = querySelectorAll(selector);
            for (const child of elements) {
              let rect = child.classList.contains("tag") ? new DOMRect(10, 10, 20, 30) : extraBounds(child);
              if (!rect && child.classList.contains("strut")) {
                const style = (child as HTMLElement).style;
                const height = parseFloat(style.height) * 32;
                const depth = -(parseFloat(style.verticalAlign) || 0) * 32;
                rect = new DOMRect(10, 35 - height + depth, 0, height);
              }
              if (rect) vi.spyOn(child, "getBoundingClientRect").mockReturnValue(rect);
            }
            return elements;
          });
        }
        return element;
      });
    }
    return result;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

const request = (source: string) => ({ source, mode: "display" as const, color: "#123456" });
const imageCss = () => serialized.querySelector("style")!.textContent!;

describe("shared math measurement", () => {
  it("constructs fonts in the iframe window instead of the main window", async () => {
    expect(await renderMathImage(request("x"))).not.toBeNull();
    expect(globalFontFace).not.toHaveBeenCalled();
    expect(fontLoads).toHaveLength(20);
    for (const face of fontLoads) {
      expect(face).toBeInstanceOf(frames[0].contentDocument!.defaultView!.FontFace);
    }
  });

  it("creates one iframe and stylesheet, and serializes concurrent requests in submission order", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    fontsReady = () => (measured.length === 1 ? blocked : Promise.resolve());
    const results = ["1", "2", "3"].map((source) => renderMathImage(request(source)));
    await vi.waitFor(() => expect(measured).toEqual(["1"]));
    expect(frames).toHaveLength(1);
    const doc = frames[0].contentDocument!;
    const style = doc.head.querySelector("style")!;
    expect(style.textContent).not.toContain("@font-face");
    expect(fontLoads).toHaveLength(20);
    expect(doc.body.children).toHaveLength(1);
    expect(images).toHaveLength(0);
    release();
    await Promise.all(results);
    expect(measured).toEqual(["1", "2", "3"]);
    expect(frames).toHaveLength(1);
    expect(doc.head.querySelectorAll("style")).toHaveLength(1);
    expect(doc.head.querySelector("style")).toBe(style);
    expect(doc.body.children).toHaveLength(0);
    expect(fontLoads).toHaveLength(20);
  });

  it("waits for every explicit font load before the first measurement even when fonts.ready is already resolved", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    loadFont = (face) =>
      face.family === "KaTeX_Main" && face.descriptors.style === "normal" && face.descriptors.weight === "400"
        ? blocked
        : Promise.resolve();
    const result = renderMathImage(request("x"));
    await vi.waitFor(() => expect(fontLoads).toHaveLength(20));
    await frames[0].contentDocument!.fonts.ready;
    expect(geometryReads).not.toHaveBeenCalled();
    expect(images).toHaveLength(0);
    release();
    await result;
    expect(geometryReads).toHaveBeenCalled();
    expect(geometryReads.mock.calls.every(([count]) => count === 20)).toBe(true);
    for (const face of katexFontFaces) {
      expect(fontLoads).toContainEqual(
        expect.objectContaining({
          family: face.family,
          source: face.source,
          descriptors: { weight: face.weight, style: face.style },
          status: "loaded",
        }),
      );
    }
    await renderMathImage(request("y"));
    expect(fontLoads).toHaveLength(20);
  });

  it("fails instead of measuring fallback fonts when an embedded font cannot load", async () => {
    const error = new Error("bad font");
    loadFont = () => Promise.reject(error);
    expect(await new MathImageCache().load(request("x"))).toEqual({ status: "failed", error });
    expect(geometryReads).not.toHaveBeenCalled();
    expect(images).toHaveLength(0);
    expect(frames[0].isConnected).toBe(false);
    expect(document.querySelectorAll("iframe")).toHaveLength(0);
  });

  it("rebuilds after a font load failure so the next queued formula succeeds without retrying the failed formula", async () => {
    const error = new Error("first font load failed");
    loadFont = () => (frames.length === 1 ? Promise.reject(error) : Promise.resolve());
    const cache = new MathImageCache();
    const first = cache.load(request("x"));
    const second = cache.load(request("y"));
    expect(await first).toEqual({ status: "failed", error });
    expect((await second).status).toBe("ready");
    expect(frames).toHaveLength(2);
    expect(frames[0].isConnected).toBe(false);
    expect(frames[1].isConnected).toBe(true);
    expect(document.querySelectorAll("iframe")).toHaveLength(1);
    expect(fontLoads).toHaveLength(40);
    expect(measured).toEqual(["y"]);
    expect(images).toHaveLength(1);
    expect(await cache.load(request("x"))).toEqual({ status: "failed", error });
    expect(frames).toHaveLength(2);
    expect(fontLoads).toHaveLength(40);
    expect(images).toHaveLength(1);
  });

  it("measures in standards mode, the mode the SVG image is laid out in", async () => {
    await renderMathImage(request("x"));
    expect(frames[0].contentDocument!.compatMode).toBe("CSS1Compat");
    expect(frames[0].contentDocument!.head.querySelectorAll("style")).toHaveLength(1);
  });

  it("uses a large offscreen viewport without making it visible or interactive", async () => {
    await renderMathImage(request("x"));
    const frame = frames[0];
    expect(parseFloat(frame.style.width)).toBeGreaterThanOrEqual(4096);
    expect(parseFloat(frame.style.height)).toBeGreaterThanOrEqual(4096);
    expect(parseFloat(frame.style.left) + parseFloat(frame.style.width)).toBeLessThan(0);
    expect(frame.style.visibility).toBe("hidden");
    expect(frame.style.pointerEvents).toBe("none");
    expect(frame.tabIndex).toBe(-1);
    expect(frame.getAttribute("aria-hidden")).toBe("true");
  });

  it("recreates a removed iframe or replaced measurement document", async () => {
    await renderMathImage(request("x"));
    frames[0].remove();
    await renderMathImage(request("y"));
    expect(frames).toHaveLength(2);
    expect(fontLoads).toHaveLength(40);
    Object.defineProperty(frames[1], "contentDocument", { value: document.implementation.createHTMLDocument() });
    await renderMathImage(request("z"));
    expect(frames).toHaveLength(3);
    expect(fontLoads).toHaveLength(60);
    expect(document.querySelectorAll("iframe")).toHaveLength(1);
    expect(frames[2].contentDocument!.head.querySelectorAll("style")).toHaveLength(1);
  });

  it("keeps the queue usable after a parse failure without creating measurement DOM for it", async () => {
    const cache = new MathImageCache();
    expect((await cache.load(request(String.raw`\frac{`))).status).toBe("failed");
    expect(frames).toHaveLength(0);
    expect((await cache.load(request("x"))).status).toBe("ready");
    expect(frames).toHaveLength(1);
  });

  it("releases each URL and continues the queue after an image loading failure", async () => {
    autoLoad = false;
    const cache = new MathImageCache();
    const first = cache.load(request("1"));
    const second = cache.load(request("2"));
    await vi.waitFor(() => expect(images).toHaveLength(1));
    expect(measured).toEqual(["1"]);
    images[0].onerror();
    expect(await first).toEqual({ status: "failed", error: new Error("MATH_IMAGE_LOAD_FAILED") });
    await vi.waitFor(() => expect(images).toHaveLength(2));
    images[1].onload();
    expect((await second).status).toBe("ready");
    expect(revoke).toHaveBeenCalledTimes(2);
    expect(frames).toHaveLength(1);
    expect(frames[0].contentDocument!.body.children).toHaveLength(0);
  });
});

describe("math image font subset", () => {
  it.each([
    [String.raw`\begin{pmatrix}1&2\\3&4\end{pmatrix}`, "display", ["KaTeX_Main", "KaTeX_Size3"]],
    [String.raw`\int_0^1 f(x)\,dx`, "display", ["KaTeX_Main", "KaTeX_Math", "KaTeX_Size2"]],
    [String.raw`\sum_{i=1}^{n} i`, "display", ["KaTeX_Main", "KaTeX_Math", "KaTeX_Size2"]],
    [String.raw`\int_0^1 f(x)\,dx`, "inline", ["KaTeX_Main", "KaTeX_Math", "KaTeX_Size1"]],
    [String.raw`\sum_{i=1}^{n} i`, "inline", ["KaTeX_Main", "KaTeX_Math", "KaTeX_Size1"]],
    [String.raw`\Biggl(x\Biggr)`, "display", ["KaTeX_Math", "KaTeX_Size4"]],
  ] as const)("includes every glyph font used by %s (%s)", async (source, mode, families) => {
    await renderMathImage({ ...request(source), mode });
    const embedded = katexFontFaces.filter((face) => imageCss().includes(face.css));
    expect(embedded.map((face) => face.family).sort()).toEqual([...families].sort());
    for (const face of embedded) {
      expect(fontLoads).toContainEqual(expect.objectContaining({ source: face.source, status: "loaded" }));
    }
    expect(imageCss()).not.toMatch(/@font-face\{font-family:KaTeX_(AMS|Fraktur)/);
  });

  it("keeps the radical's SVG path and embeds the fonts used by its radicand", async () => {
    await renderMathImage(request(String.raw`\sqrt{x^2+1}`));
    expect(serialized.querySelector(".sqrt svg path")?.getAttribute("d")).toBeTruthy();
    expect(imageCss()).toContain(getKatexFontFace("KaTeX_Main", "400", "normal")!.css);
    expect(imageCss()).toContain(getKatexFontFace("KaTeX_Math", "400", "italic")!.css);
    expect(imageCss()).not.toMatch(/url\((?!"data:)/);
  });

  it.each([
    ["123", "KaTeX_Main", "400", "normal"],
    ["x", "KaTeX_Math", "400", "italic"],
    [String.raw`\mathbf{x}`, "KaTeX_Main", "700", "normal"],
    [String.raw`\boldsymbol{x}`, "KaTeX_Math", "700", "italic"],
    [String.raw`\mathbb{R}`, "KaTeX_AMS", "400", "normal"],
    [String.raw`\mathfrak{x}`, "KaTeX_Fraktur", "400", "normal"],
  ])("embeds only the computed font used by %s", async (source, family, weight, style) => {
    await renderMathImage(request(source));
    const css = imageCss();
    expect(css.match(/@font-face/g)).toHaveLength(1);
    expect(css).toContain(getKatexFontFace(family, weight, style)!.css);
    if (family !== "KaTeX_AMS") expect(css).not.toMatch(/@font-face\{font-family:KaTeX_AMS/);
    if (family !== "KaTeX_Fraktur") expect(css).not.toMatch(/@font-face\{font-family:KaTeX_Fraktur/);
    expect(css).not.toMatch(/url\((?!"data:)/);
  });

  it("includes the inherited Main font for an automatic equation number without a text node", async () => {
    await renderMathImage(request(String.raw`\begin{equation}x\end{equation}`));
    expect(serialized.querySelector(".eqn-num")!.textContent).toBe("");
    expect(imageCss()).toContain(getKatexFontFace("KaTeX_Main", "400", "normal")!.css);
    expect(imageCss()).toContain(getKatexFontFace("KaTeX_Math", "400", "italic")!.css);
    expect(imageCss().match(/@font-face/g)).toHaveLength(2);
  });
});

describe("math image geometry", () => {
  it.each([
    String.raw`\int_0^1 f(x)\,dx`,
    String.raw`\sum_{i=1}^{n} i`,
    String.raw`\sqrt{x^2+1}`,
    String.raw`\hat{x}`,
    String.raw`\frac{a}{b}`,
    String.raw`\begin{pmatrix}1&2\\3&4\end{pmatrix}`,
    String.raw`\TeX`,
    String.raw`E=mc^2 \tag{1}`,
  ])("keeps normal line height, symmetric safety space and measured baseline for %s", async (source) => {
    const result = await renderMathImage(request(source));
    expect(result).toMatchObject({ width: 118, height: 49, fontSize: 32 });
    expect(result!.layout.width).toBe(81.25);
    expect(result!.layoutOffset.x).toBe(8.375);
    expect(result!.layoutOffset.y + result!.layout.height - result!.layout.descent).toBeCloseTo(33.25);
    const object = serialized.querySelector("foreignObject")!;
    expect(object.getAttribute("x")).toBe("0");
    expect(object.getAttribute("y")).toBe("0");
    expect(object.getAttribute("width")).toBe(String(result!.width));
    expect(object.getAttribute("height")).toBe(String(result!.height));
    expect(object.hasAttribute("overflow")).toBe(false);
    const content = object.firstElementChild as HTMLElement;
    expect(content.style.paddingLeft).toBe("8.375px");
    expect(content.style.paddingTop).toBe("8.25px");
    const root = content.firstElementChild as HTMLElement;
    expect(root.style.display).toBe("block");
    expect(root.style.width).toBe("101.25px");
    expect(root.style.height).toBe("32.5px");
    expect(root.style.lineHeight).toBe("1.2");
    expect(root.style.color).toBe("rgb(18, 52, 86)");
    expect(imageCss()).toContain(".katex-display{margin:0}");
    expect(imageCss()).not.toContain(".katex{line-height:0}");
    expect(root.querySelector(".katex-mathml")).toBeNull();
    expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:math-test");
  });

  it("expands for text outside its strut box and adjusts the image baseline with the crop", async () => {
    textBounds = () => new DOMRect(-10, -20, 131.25, 92.5);
    const result = await renderMathImage(request(String.raw`\hat{x}`));
    expect(result).toMatchObject({
      width: 148,
      height: 109,
    });
    expect(result!.layoutOffset.y + result!.layout.height - result!.layout.descent).toBeCloseTo(63.25);
    const object = serialized.querySelector("foreignObject")!;
    expect(object.getAttribute("x")).toBe("0");
    expect(object.getAttribute("y")).toBe("0");
    expect(object.getAttribute("width")).toBe("148");
    expect(object.getAttribute("height")).toBe("109");
    const content = object.firstElementChild as HTMLElement;
    expect(content.style.paddingLeft).toBe("28.375px");
    expect(content.style.paddingTop).toBe("38.25px");
  });

  it("measures fraction rules outside the line box", async () => {
    extraBounds = (element) => (element.classList.contains("frac-line") ? new DOMRect(10, -20, 100, 1) : undefined);
    const result = await renderMathImage(request(String.raw`\frac{a}{b}`));
    expect(result!.height).toBe(79);
  });

  it("clips the intentionally hidden long tail of stretchy SVGs before extending the image", async () => {
    extraBounds = (element) =>
      element.localName === "svg"
        ? new DOMRect(10, 10, 10000, 30)
        : element.classList.contains("hide-tail")
          ? new DOMRect(10, 10, 80, 30)
          : undefined;
    const result = await renderMathImage(request(String.raw`\sqrt{x}`));
    expect(serialized.querySelector("svg")!.parentElement!.className).toBe("hide-tail");
    expect(result).toMatchObject({ width: 118, height: 49 });
  });

  it("preserves inline/display mode and tag spacing", async () => {
    await renderMathImage({ ...request("x"), mode: "inline" });
    expect(serialized.querySelector(".katex-display")).toBeNull();
    await renderMathImage(request(String.raw`x\tag{1}`));
    expect((serialized.querySelector(".tag")!.parentElement as HTMLElement).style.paddingRight).toBe("52px");
    expect(serialized.querySelector(".katex-display")).not.toBeNull();
  });

  it.each(["x", "E=mc^2"])("lays out %s without image padding or an extra-tall ordinary line", async (source) => {
    const image = (await renderMathImage({ ...request(source), mode: "inline" }))!;
    const options = {
      fontSize: 32,
      lineHeight: 1.5,
      maxWidth: Infinity,
      measureText: (text: string) => text.length * 16,
      getMathMetrics: () => image.layout,
    };
    const plain = layoutRichText({ ...options, segments: splitInlineMath("abc") });
    const single = layoutRichText({ ...options, segments: splitInlineMath(`$${source}$`) });
    const mixed = layoutRichText({ ...options, segments: splitInlineMath(`a$${source}$b`) });
    expect(single.height).toBe(plain.height);
    expect(mixed.height).toBe(plain.height);
    expect(mixed.lines[0].fragments.map((fragment) => fragment.x)).toEqual([0, 16, 16 + image.layout.width]);
    expect(mixed.width).toBe(32 + image.layout.width);
    expect(image.width).toBeGreaterThan(image.layout.width);
  });

  it.each([String.raw`\TeX`, String.raw`\int_0^1 f(x)\,dx`, String.raw`\frac{a}{b}`])(
    "centers the actual KaTeX strut box of a sole display formula: %s",
    async (source) => {
      const image = (await renderMathImage(request(source)))!;
      const layout = layoutRichText({
        segments: splitInlineMath(`$$${source}$$`),
        fontSize: 32,
        lineHeight: 1.5,
        maxWidth: Infinity,
        measureText: () => 0,
        getMathMetrics: () => image.layout,
      });
      expect(layout.lines).toHaveLength(1);
      const line = layout.lines[0];
      const top = line.baseline - image.layout.height + image.layout.descent;
      const bottom = line.height - top - image.layout.height;
      expect(Math.abs(top - bottom)).toBeLessThanOrEqual(1);
      expect(line.fragments[0].x).toBe(0);
      expect(layout.width).toBe(image.layout.width);
    },
  );

  it.each([String.raw`\displaystyle\int_0^1 f(x)\,dx`, String.raw`\displaystyle\sum_{i=1}^{n} i`])(
    "grows a tall formula line by its TeX box rather than its padded image: %s",
    async (source) => {
      const image = (await renderMathImage({ ...request(source), mode: "inline" }))!;
      const layout = layoutRichText({
        segments: splitInlineMath(`$${source}$`),
        fontSize: 32,
        lineHeight: 1.5,
        maxWidth: Infinity,
        measureText: () => 0,
        getMathMetrics: () => image.layout,
      });
      expect(image.layout.height).toBeGreaterThan(48);
      expect(layout.height).toBe(image.layout.height);
    },
  );
});
