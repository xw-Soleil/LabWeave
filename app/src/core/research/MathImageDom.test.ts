// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getKatexFontFace } from "@/utils/katexEmbeddedCss";
import { MathImageCache, renderMathImage } from "./MathImage";

let serialized: SVGSVGElement;
let autoLoad: boolean;
let fontsReady: () => Promise<void>;
let textBounds: () => DOMRect;
let extraBounds: (element: Element) => DOMRect | undefined;
const images: { onload: () => void; onerror: () => void }[] = [];
const frames: HTMLIFrameElement[] = [];
const measured: string[] = [];
const revoke = vi.fn();

beforeEach(() => {
  autoLoad = true;
  images.length = frames.length = measured.length = 0;
  revoke.mockClear();
  fontsReady = () => Promise.resolve();
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
      Object.defineProperty(doc, "fonts", {
        value: {
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
        vi.spyOn(element, "getBoundingClientRect").mockImplementation(() =>
          tag === "div" ? new DOMRect(10, 10, 101.25, 32.5) : new DOMRect(10, 35, 0, 0),
        );
        if (tag === "div") {
          const querySelectorAll = element.querySelectorAll.bind(element);
          vi.spyOn(element, "querySelectorAll").mockImplementation((selector) => {
            const elements = querySelectorAll(selector);
            for (const child of elements) {
              const rect = child.classList.contains("tag") ? new DOMRect(10, 10, 20, 30) : extraBounds(child);
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
    expect(style.textContent!.match(/@font-face/g)).toHaveLength(20);
    expect(doc.body.children).toHaveLength(1);
    expect(images).toHaveLength(0);
    release();
    await Promise.all(results);
    expect(measured).toEqual(["1", "2", "3"]);
    expect(frames).toHaveLength(1);
    expect(doc.head.querySelectorAll("style")).toHaveLength(1);
    expect(doc.head.querySelector("style")).toBe(style);
    expect(doc.body.children).toHaveLength(0);
  });

  it("recreates a removed iframe or replaced measurement document", async () => {
    await renderMathImage(request("x"));
    frames[0].remove();
    await renderMathImage(request("y"));
    expect(frames).toHaveLength(2);
    Object.defineProperty(frames[1], "contentDocument", { value: document.implementation.createHTMLDocument() });
    await renderMathImage(request("z"));
    expect(frames).toHaveLength(3);
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
    expect(result).toMatchObject({ width: 118, height: 49, descent: 15.75, fontSize: 32 });
    const object = serialized.querySelector("foreignObject")!;
    expect(object.getAttribute("x")).toBe("8.375");
    expect(object.getAttribute("y")).toBe("8.25");
    expect(object.getAttribute("overflow")).toBe("visible");
    const root = object.firstElementChild as HTMLElement;
    expect(root.style.display).toBe("inline-block");
    expect(root.style.lineHeight).toBe("1.2");
    expect(root.style.color).toBe("rgb(18, 52, 86)");
    expect(imageCss()).toContain(".katex-display{margin:0}");
    expect(imageCss()).not.toContain(".katex{line-height:0}");
    expect(root.querySelector(".katex-mathml")).toBeNull();
    expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:math-test");
  });

  it("expands for text outside its strut box and adjusts the image baseline with the crop", async () => {
    textBounds = () => new DOMRect(-10, -20, 131.25, 92.5);
    expect(await renderMathImage(request(String.raw`\hat{x}`))).toMatchObject({
      width: 148,
      height: 109,
      descent: 45.75,
    });
    const object = serialized.querySelector("foreignObject")!;
    expect(Number(object.getAttribute("x"))).toBe(28.375);
    expect(Number(object.getAttribute("y"))).toBe(38.25);
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
});
