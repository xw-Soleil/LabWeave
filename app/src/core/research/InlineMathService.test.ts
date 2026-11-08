import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "@/core/Project";
import { Color, colorInvert, Vector } from "@graphif/data-structures";
import { Rectangle } from "@graphif/shapes";

vi.mock("@/core/Project", () => ({ Project: class {}, service: () => (value: unknown) => value }));
const fontSettings = vi.hoisted(() => ({ listeners: new Set<(value: string) => void>() }));
vi.mock("@/core/service/Settings", () => {
  let defaultFont = "sans-serif";
  return {
    Settings: {
      protectingPrivacy: false,
      textIntegerLocationAndSizeRender: false,
      get defaultFontFamily() {
        return defaultFont;
      },
      set defaultFontFamily(value: string) {
        fontSettings.listeners.forEach((listener) => listener(value));
        defaultFont = value;
      },
      watch: (_key: string, listener: (value: string) => void) => {
        fontSettings.listeners.add(listener);
        listener(defaultFont);
        return () => {
          fontSettings.listeners.delete(listener);
        };
      },
    },
  };
});
vi.mock("@/core/render/canvas2d/renderer", () => ({ Renderer: { FONT_SIZE: 24, NODE_PADDING: 10 } }));
vi.mock("@/core/stage/stageObject/tools/entityDetailsManager", () => ({ DetailsManager: class {} }));
vi.mock("@/core/stage/stageObject/entity/Section", () => ({ Section: class {} }));
vi.mock("@/core/render/canvas2d/utilsRenderer/SyncAssociationRenderer", () => ({ SyncAssociationRenderer: class {} }));
vi.mock("@/core/service/controlService/shortcutKeysEngine/KeyBindsUI", () => ({ KeyBindsUI: class {} }));
vi.mock("@/utils/keyDisplay", () => ({ formatKeyBindSequenceToString: () => "" }));
vi.mock("@/core/render/canvas2d/basicRenderer/msdfTextAtlas", () => ({
  MsdfTextAtlasRenderer: class {
    drawLine() {
      return false;
    }
  },
}));
vi.mock("@/utils/font", async () => {
  const { wrapTextByCharacters } = await import("@/utils/textWrapping");
  const width = (text: string, size: number, family?: string, weight?: string) =>
    ((Array.from(text).length * size) / 2) *
    ((family || Settings.defaultFontFamily) === "wide" ? 2 : 1) *
    (weight === "bold" ? 1.5 : 1);
  return {
    getFontIdentity: (family: string, weight: string) => JSON.stringify([family || Settings.defaultFontFamily, weight]),
    getTextSize: vi.fn(
      (text: string, size: number, family?: string, weight?: string) =>
        new Vector(width(text, size, family, weight), size),
    ),
    getMultiLineTextSize: (
      text: string,
      size: number,
      height: number,
      _limitWidth?: number,
      family?: string,
      weight?: string,
    ) =>
      new Vector(
        Math.max(...text.split("\n").map((line) => width(line, size, family, weight))),
        text.split("\n").length * size * height,
      ),
    textToTextArray: (text: string, size: number, limitWidth: number, family?: string, weight?: string) =>
      text
        .split("\n")
        .flatMap((line) => wrapTextByCharacters(line, limitWidth, (text) => width(text, size, family, weight))),
    isBundledCanvasFont: () => false,
    replaceTextWhenProtect: vi.fn((text: string) => text.replace(/[^\s]/g, "#")),
    resolveFont: (size: number, family: string, weight: string) =>
      `${weight || "normal"} ${size}px ${family || Settings.defaultFontFamily}`,
    setCanvasFont: (ctx: CanvasRenderingContext2D, font: string) => {
      ctx.font = font;
    },
  };
});

import { Settings } from "@/core/service/Settings";
import { getTextSize, replaceTextWhenProtect } from "@/utils/font";
import * as fonts from "@/utils/font";
import { TextRenderer } from "@/core/render/canvas2d/basicRenderer/textRenderer";
import { TextNodeRenderer } from "@/core/render/canvas2d/entityRenderer/textNode/TextNodeRenderer";
import { TextNode } from "@/core/stage/stageObject/entity/TextNode";
import { CollisionBox } from "@/core/stage/stageObject/collisionBox/collisionBox";
import { InlineMathService } from "./InlineMathService";
import { MathImageCache, renderMathImage, type MathImage, type MathImageRequest } from "./MathImage";
import * as parsing from "./InlineMath";
import * as layout from "./RichTextLayout";

const formula = (source = "x"): MathImage => ({
  image: { source } as unknown as HTMLImageElement,
  width: 48,
  height: 64,
  fontSize: 32,
  layout: { width: 32, height: 20, descent: 4 },
  layoutOffset: { x: 8, y: 20 },
});
const services: InlineMathService[] = [];
beforeEach(() => {
  Settings.protectingPrivacy = false;
  Settings.textIntegerLocationAndSizeRender = false;
  Settings.defaultFontFamily = "sans-serif";
});
afterEach(() => {
  services.splice(0).forEach((service) => service.dispose());
  vi.restoreAllMocks();
});

function setup(
  render: (request: MathImageRequest) => Promise<MathImage | null> = async (request) => formula(request.source),
) {
  const ctx = {
    save: vi.fn(),
    restore: vi.fn(),
    translate: vi.fn(),
    scale: vi.fn(),
    fillText: vi.fn(),
    drawImage: vi.fn(),
    fillRect: vi.fn(),
    font: "",
    textBaseline: "middle",
    fillStyle: "",
    measureText: vi.fn(() => ({ actualBoundingBoxDescent: ctx.textBaseline === "middle" ? 35 : 5 })),
  };
  const project = {
    canvas: { ctx },
    stage: [] as TextNode[],
    stageManager: { getTextNodes: () => project.stage },
    camera: { currentScale: 1 },
    renderer: { w: 2000, h: 2000, transformWorld2View: (point: Vector) => point.multiply(project.camera.currentScale) },
    stageStyleManager: { currentStyle: { Background: Color.White } },
    autoComputeUtils: { isNameIsLogicNode: () => false },
    controller: { resetCountdownTimer: vi.fn() },
    syncAssociationManager: { syncFrom: vi.fn() },
    textNodeRenderer: { renderTextNode: vi.fn() },
    textRenderer: undefined as unknown as TextRenderer,
    inlineMath: undefined as unknown as InlineMathService,
  };
  project.textRenderer = new TextRenderer(project as unknown as Project);
  const cache = new MathImageCache(render);
  const subscribe = vi.spyOn(cache, "subscribe");
  const service = new InlineMathService(project as unknown as Project, cache);
  project.inlineMath = service;
  services.push(service);
  const renderer = new TextNodeRenderer(project as unknown as Project);
  const add = (text: string, sizeAdjust: "auto" | "manual" = "auto") => {
    const node = new TextNode(project as unknown as Project, {
      text,
      sizeAdjust,
      collisionBox: new CollisionBox([new Rectangle(new Vector(10.2, 20.3), new Vector(75, 100))]),
    });
    project.stage.push(node);
    return node;
  };
  const finish = (
    source = "x",
    mode: "inline" | "display" = "inline",
    color = colorInvert(project.stageStyleManager.currentStyle.Background).toString(),
  ) => cache.load({ source, mode, color });
  const draw = (node: TextNode) => renderer["renderTextNodeTextLayer"](node);
  return { ctx, project, service, cache, subscribe, add, finish, draw };
}

describe("inline math on text cards", () => {
  it.each(["auto", "manual"] as const)(
    "uses source dimensions on entering/editing and math dimensions on leaving (%s)",
    async (mode) => {
      const { add, finish } = setup();
      const node = add("a$x$b", mode);
      await finish();
      expect(node.rectangle.size).toEqual(new Vector(mode === "auto" ? 68 : 75, 56));
      const location = node.rectangle.location.clone();
      node.isEditing = true;
      expect(node.rectangle.size).toEqual(new Vector(mode === "auto" ? 80 : 75, mode === "auto" ? 56 : 92));
      node.rename("a$longer$b");
      expect(node.rectangle.size).toEqual(new Vector(mode === "auto" ? 140 : 75, mode === "auto" ? 56 : 128));
      await finish("longer");
      expect(node.rectangle.height).toBe(mode === "auto" ? 56 : 128);
      node.isEditing = false;
      expect(node.rectangle.size).toEqual(new Vector(mode === "auto" ? 68 : 75, 56));
      expect(node.rectangle.location).toEqual(location);
    },
  );

  it("resizes manual cards from the same wrapping layout and preserves their requested width", async () => {
    const { add, finish, service } = setup();
    const node = add("aa$x$bbb", "manual");
    await finish();
    expect(node.rectangle.size).toEqual(new Vector(75, 92));
    node.resizeWidthTo(140);
    expect(node.rectangle.size).toEqual(new Vector(140, 56));
    const before = node.rectangle.clone();
    service.render(node);
    expect(node.rectangle).toEqual(before);
  });

  it("uses tall layout boxes for line height and centers display math within the manual width", async () => {
    const { add, finish, draw, ctx } = setup(async () => ({
      ...formula(),
      height: 104,
      layout: { width: 32, height: 72, descent: 16 },
    }));
    const inline = add("a$x$b");
    const display = add("a$$x$$b", "manual");
    await finish();
    await finish("x", "display");
    expect(inline.rectangle.height).toBe(54 + 20);
    expect(display.rectangle.height).toBe(36 + 54 + 36 + 20);
    draw(display);
    const [, left, , width, height] = ctx.drawImage.mock.calls[0];
    expect(left).toBeCloseTo(10.2 + 10 + (55 - 24) / 2 - 8 * 0.75);
    expect(width).toBe(36);
    expect(height).toBe(78);
  });

  it("draws the full image at the layout offset, without reserving image whitespace between text runs", async () => {
    const { add, finish, draw, ctx } = setup();
    const node = add("a$x$b");
    await finish();
    draw(node);
    expect(ctx.drawImage).toHaveBeenCalledExactlyOnceWith(formula().image, expect.closeTo(26.2), 28.5, 36, 48);
    expect(ctx.translate).toHaveBeenNthCalledWith(1, 20.2, 48.3);
    expect(ctx.translate).toHaveBeenNthCalledWith(2, 56.2, 48.3);
    expect(node.rectangle.height).toBe(56);
  });

  it("keeps the same layout in privacy mode, masks text and paints opaque formula boxes", async () => {
    const { add, finish, draw, ctx } = setup();
    const node = add("a$x$b");
    await finish();
    const before = node.rectangle.clone();
    Settings.protectingPrivacy = true;
    draw(node);
    expect(ctx.drawImage).not.toHaveBeenCalled();
    expect(ctx.fillText.mock.calls.map(([text]) => text)).toEqual(["#", "#"]);
    expect(replaceTextWhenProtect).toHaveBeenCalledWith("a");
    expect(ctx.fillRect).toHaveBeenCalledExactlyOnceWith(32.2, 43.5, 24, 15);
    expect(ctx.fillStyle).toBe(colorInvert(Color.White).toString());
    expect(node.rectangle).toEqual(before);
  });

  it.each([false, true])("scales images by card font size / 32 and honors integer rendering (%s)", async (integer) => {
    const { add, finish, draw, ctx, project } = setup();
    const node = add("a$x$b");
    await finish();
    node.increaseFontSize();
    project.camera.currentScale = 1.37;
    Settings.textIntegerLocationAndSizeRender = integer;
    draw(node);
    const size = integer ? Math.round(node.getFontSize() * 1.37) : node.getFontSize() * 1.37;
    const [, x, y, width, height] = ctx.drawImage.mock.calls[0];
    expect(width).toBe((48 * size) / 32);
    expect(height).toBe((64 * size) / 32);
    if (integer) {
      expect(Number.isInteger(x)).toBe(true);
      expect(Number.isInteger(y)).toBe(true);
      expect(ctx.translate.mock.calls.every(([x, y]) => Number.isInteger(x) && Number.isInteger(y - size / 2))).toBe(
        true,
      );
    }
  });

  it.each([
    ["auto", "card"],
    ["manual", "card"],
    ["auto", "theme"],
    ["manual", "theme"],
  ] as const)("keeps geometry and the old image through color changes (%s, %s)", async (mode, change) => {
    const jobs = new Map<string, (image: MathImage) => void>();
    const { add, finish, draw, ctx, project, service } = setup(
      (request) => new Promise((resolve) => jobs.set(request.color, resolve)),
    );
    const node = add("aa$x$bb", mode);
    const black = Color.Black.toString();
    const white = Color.White.toString();
    const first = finish("x", "inline", black);
    await Promise.resolve();
    jobs.get(black)!(formula("black"));
    await first;
    const rectangle = node.rectangle;
    const layoutSpy = vi.spyOn(layout, "layoutRichText");
    const applySize = vi.spyOn(service as never, "applySize");
    const assertImage = (image: string) => {
      ctx.drawImage.mockClear();
      draw(node);
      expect(node.rectangle).toBe(rectangle);
      expect(ctx.drawImage).toHaveBeenCalledOnce();
      expect(ctx.drawImage.mock.calls[0][0]).toEqual(formula(image).image);
    };
    if (change === "card") node.color = Color.Black;
    else project.stageStyleManager.currentStyle.Background = Color.Black;
    expect(node.rectangle).toBe(rectangle);
    assertImage("black");
    const next = finish("x", "inline", white);
    await Promise.resolve();
    assertImage("black");
    jobs.get(white)!(formula("white"));
    await next;
    assertImage("white");
    node.color = Color.Transparent;
    project.stageStyleManager.currentStyle.Background = Color.White;
    assertImage("black");
    project.stageStyleManager.currentStyle.Background = Color.Black;
    assertImage("white");
    expect(layoutSpy).not.toHaveBeenCalled();
    expect(applySize).not.toHaveBeenCalled();
  });

  it("keeps the previous image while a theme color is pending, including metrics from another color's cache", async () => {
    let finishWhite!: (image: MathImage) => void;
    const { add, finish, draw, ctx, project } = setup((request) =>
      request.color === Color.Black.toString()
        ? Promise.resolve(formula("black"))
        : new Promise((resolve) => {
            finishWhite = resolve;
          }),
    );
    await finish();
    project.stageStyleManager.currentStyle.Background = Color.Black;
    const node = add("a$x$b");
    expect(node.rectangle.width).toBe(68);
    const rectangle = node.rectangle;
    draw(node);
    expect(ctx.drawImage.mock.calls.at(-1)![0]).toEqual(formula("black").image);
    await Promise.resolve();
    const next = finish();
    finishWhite(formula("white"));
    await next;
    draw(node);
    expect(ctx.drawImage.mock.calls.at(-1)![0]).toEqual(formula("white").image);
    expect(node.rectangle).toBe(rectangle);
  });

  it("never repairs card or section geometry while drawing", async () => {
    const { add, finish, draw } = setup();
    const node = add("a$x$b");
    await finish();
    const adjust = vi.fn();
    node.parentSection = { adjustLocationAndSize: adjust, parentSection: null } as never;
    const rectangle = node.rectangle;
    node.fontFamily = "wide";
    draw(node);
    expect(node.rectangle).toBe(rectangle);
    expect(adjust).not.toHaveBeenCalled();
    node.forceAdjustSizeByText();
    expect(node.rectangle.width).toBeGreaterThan(rectangle.width);
    expect(adjust).toHaveBeenCalledOnce();
  });

  it("keeps this card's previous image when another colored card completes the same formula", async () => {
    let finishWhite!: (image: MathImage) => void;
    const { add, finish, draw, ctx } = setup((request) =>
      request.color === Color.White.toString()
        ? new Promise((resolve) => {
            finishWhite = resolve;
          })
        : Promise.resolve(formula(request.color)),
    );
    const node = add("a$$x$$b");
    await finish("x", "display");
    draw(node);
    const rectangle = node.rectangle;
    await finish("x", "display", "red");
    node.color = Color.Black;
    draw(node);
    expect(ctx.drawImage.mock.calls.at(-1)![0]).toEqual(formula(Color.Black.toString()).image);
    expect(node.rectangle).toBe(rectangle);
    const pending = finish("x", "display", Color.White.toString());
    await Promise.resolve();
    finishWhite(formula("white"));
    await pending;
    draw(node);
    expect(ctx.drawImage.mock.calls.at(-1)![0]).toEqual(formula("white").image);
    expect(node.rectangle).toBe(rectangle);
  });

  it.each(["auto", "manual"] as const)(
    "resizes at font, weight, scale, source and width changes before drawing (%s)",
    async (mode) => {
      const { add, finish, draw } = setup();
      const node = add("ab$x$cd", mode);
      await finish();
      const resizeAfterFontEdit = () =>
        mode === "auto" ? node.forceAdjustSizeByText() : node.forceAdjustHeightByText();
      const check = (change: () => void) => {
        const before = node.rectangle.size.clone();
        change();
        expect(node.rectangle.size).not.toEqual(before);
        const resized = node.rectangle;
        draw(node);
        expect(node.rectangle).toBe(resized);
      };
      check(() => {
        node.fontFamily = "wide";
        resizeAfterFontEdit();
      });
      check(() => {
        node.fontWeight = "bold";
        resizeAfterFontEdit();
      });
      check(() => node.setFontScaleLevel(2));
      check(() => node.rename("abcdef$x$ghijkl"));
      if (mode === "manual") check(() => node.resizeWidthTo(500));
    },
  );

  it.each(["auto", "manual"] as const)(
    "recomputes default-font users and editing source dimensions on the settings event (%s)",
    async (mode) => {
      const { add, finish, draw, service } = setup();
      const node = add("ab$x$cd", mode);
      const editing = add("ab$x$cd", mode);
      const custom = add("ab$x$cd", mode);
      custom.fontFamily = "serif";
      service.resize(custom);
      const plain = add("plain", mode);
      await finish();
      editing.isEditing = true;
      const previous = node.rectangle;
      const previousEditing = editing.rectangle;
      const previousCustom = custom.rectangle;
      const previousPlain = plain.rectangle;
      Settings.defaultFontFamily = "wide";
      expect(node.rectangle).toBe(previous);
      await Promise.resolve();
      expect(node.rectangle.size).not.toEqual(previous.size);
      expect(editing.rectangle.size).not.toEqual(previousEditing.size);
      expect(custom.rectangle).toBe(previousCustom);
      expect(plain.rectangle).toBe(previousPlain);
      const resized = node.rectangle;
      draw(node);
      expect(node.rectangle).toBe(resized);
      expect(fontSettings.listeners.size).toBe(1);
      Settings.defaultFontFamily = "sans-serif";
      service.dispose();
      await Promise.resolve();
      expect(node.rectangle).toBe(resized);
      expect(fontSettings.listeners.size).toBe(0);
    },
  );

  it("resizes on font loading completion and removes that listener when disposed", async () => {
    const addEventListener = vi.fn();
    const removeEventListener = vi.fn();
    vi.stubGlobal("document", { fonts: { addEventListener, removeEventListener } });
    const originalMeasure = vi.mocked(getTextSize).getMockImplementation()!;
    try {
      const { add, finish, draw, service } = setup();
      const node = add("a$x$b");
      await finish();
      const previous = node.rectangle;
      vi.spyOn(fonts, "getFontIdentity").mockReturnValue("loaded bundled font");
      vi.mocked(getTextSize).mockImplementation((text, size) => new Vector(text.length * size, size));
      expect(addEventListener).toHaveBeenCalledExactlyOnceWith("loadingdone", expect.any(Function));
      const listener = addEventListener.mock.calls[0][1];
      listener();
      expect(node.rectangle.width).toBeGreaterThan(previous.width);
      const resized = node.rectangle;
      draw(node);
      expect(node.rectangle).toBe(resized);
      service.dispose();
      expect(removeEventListener).toHaveBeenCalledExactlyOnceWith("loadingdone", listener);
      listener();
      expect(node.rectangle).toBe(resized);
    } finally {
      vi.mocked(getTextSize).mockImplementation(originalMeasure);
      vi.unstubAllGlobals();
    }
  });

  it("uses source text for failed, pending and DOM-less images without repeated requests", async () => {
    const render = vi.fn(renderMathImage);
    const { add, finish, draw, ctx } = setup(render);
    const node = add("a$x$b");
    expect(node.rectangle.width).toBe(80);
    expect((await finish()).status).toBe("unavailable");
    for (let i = 0; i < 5; i++) draw(node);
    expect(ctx.drawImage).not.toHaveBeenCalled();
    expect(ctx.fillText).toHaveBeenCalledWith("a$x$b", 0, 0);
    expect(render).toHaveBeenCalledOnce();
    const bad = setup(async () => {
      throw new Error("bad formula");
    });
    const badNode = bad.add("a$bad$b");
    expect((await bad.finish("bad")).status).toBe("failed");
    bad.draw(badNode);
    expect(bad.ctx.fillText).toHaveBeenCalledWith("a$bad$b", 0, 0);
  });
});

describe("inline math caches and lifecycle", () => {
  it("does not split, lay out, measure or request images again on unchanged frames", async () => {
    const split = vi.spyOn(parsing, "splitInlineMath");
    const layoutSpy = vi.spyOn(layout, "layoutRichText");
    const { add, finish, draw, cache, ctx } = setup();
    const request = vi.spyOn(cache, "request");
    const node = add("a$x$b");
    await finish();
    const counts = [
      split.mock.calls.length,
      layoutSpy.mock.calls.length,
      request.mock.calls.length,
      ctx.measureText.mock.calls.length,
    ];
    for (let i = 0; i < 10; i++) draw(node);
    expect([
      split.mock.calls.length,
      layoutSpy.mock.calls.length,
      request.mock.calls.length,
      ctx.measureText.mock.calls.length,
    ]).toEqual(counts);
    node.fontFamily = "serif";
    node.forceAdjustSizeByText();
    draw(node);
    node.fontWeight = "bold";
    node.forceAdjustSizeByText();
    draw(node);
    Settings.defaultFontFamily = "monospace";
    await Promise.resolve();
    node.fontFamily = "";
    node.forceAdjustSizeByText();
    draw(node);
    expect(layoutSpy).toHaveBeenCalledTimes(counts[1] + 3);
  });

  it("bounds both parsing and layout caches at 1000 entries", () => {
    const { add, service } = setup(() => new Promise(() => {}));
    const node = add("a$x$b");
    for (let i = 0; i < 1005; i++) service.resize(node, 100 + i);
    for (let i = 0; i < 1005; i++) {
      node.text = `plain ${i}`;
      service.render(node);
    }
    expect(service["layouts"].size).toBe(1000);
    expect(service["parsed"].size).toBe(1000);
  });

  it("shares dimensions across colors but refreshes only matching source/mode users; removes stale users", async () => {
    const jobs = new Map<string, (image: MathImage) => void>();
    const { add, finish, service, subscribe, project } = setup(
      (request) => new Promise((resolve) => jobs.set(JSON.stringify(request), resolve)),
    );
    const one = add("a$x$b");
    const two = add("b$x$c", "manual");
    const other = add("a$y$b");
    const block = add("a$$x$$b");
    const colored = add("a$x$b");
    colored.color = Color.Black;
    service.resize(colored);
    const removed = add("a$x$b");
    service.forget(removed);
    const old = add("a$x$b");
    old.rename("plain");
    const beforeOther = other.rectangle;
    const beforeBlock = block.rectangle;
    const beforeRemoved = removed.rectangle;
    const beforeOld = old.rectangle;
    await Promise.resolve();
    const completed = finish();
    jobs.get(JSON.stringify({ source: "x", mode: "inline", color: colorInvert(Color.White).toString() }))!(formula());
    await completed;
    expect(one.rectangle.width).toBe(68);
    expect(two.rectangle.height).toBe(56);
    expect(other.rectangle).toBe(beforeOther);
    expect(block.rectangle).toBe(beforeBlock);
    expect(removed.rectangle).toBe(beforeRemoved);
    expect(old.rectangle).toBe(beforeOld);
    expect(colored.rectangle.width).toBe(68);
    expect(subscribe).toHaveBeenCalledOnce();
    expect(project.controller.resetCountdownTimer).toHaveBeenCalledOnce();
    service.syncNodes([one]);
    expect(service["nodes"].size).toBe(1);
    const beforeClose = one.rectangle;
    service.dispose();
    expect(service["users"].size).toBe(0);
    expect(one.rectangle).toBe(beforeClose);
  });

  it("ignores completion after closing the whiteboard", async () => {
    let complete!: (image: MathImage) => void;
    const { add, finish, service, project } = setup(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const node = add("a$x$b");
    const before = node.rectangle;
    const pending = finish();
    await Promise.resolve();
    service.dispose();
    complete(formula());
    await pending;
    expect(node.rectangle).toBe(before);
    expect(project.controller.resetCountdownTimer).not.toHaveBeenCalled();
  });
});

describe("unchanged plain text path", () => {
  it.each(["auto", "manual"] as const)(
    "keeps source sizing and drawing identical with and without the service (%s)",
    (mode) => {
      const { add, project, service, draw, ctx } = setup();
      const node = add("中文 alpha\nbeta", mode);
      node.fontFamily = "serif";
      node.fontWeight = "bold";
      const split = vi.spyOn(parsing, "splitInlineMath");
      const layoutSpy = vi.spyOn(layout, "layoutRichText");
      const parsedGet = vi.spyOn(service["parsed"], "get");
      const size = node.rectangle.size.clone();
      for (const integer of [false, true])
        for (const privacy of [false, true]) {
          Settings.textIntegerLocationAndSizeRender = integer;
          Settings.protectingPrivacy = privacy;
          project.camera.currentScale = 1.37;
          ctx.translate.mockClear();
          ctx.fillText.mockClear();
          ctx.scale.mockClear();
          parsedGet.mockClear();
          draw(node);
          const actual = [
            ctx.translate.mock.calls.slice(),
            ctx.fillText.mock.calls.slice(),
            ctx.scale.mock.calls.slice(),
            ctx.font,
          ];
          expect(parsedGet).toHaveBeenCalledOnce();
          project.inlineMath = undefined as never;
          ctx.translate.mockClear();
          ctx.fillText.mockClear();
          ctx.scale.mockClear();
          draw(node);
          expect([ctx.translate.mock.calls, ctx.fillText.mock.calls, ctx.scale.mock.calls, ctx.font]).toEqual(actual);
          const legacy = add(node.text, mode);
          expect(legacy.rectangle.size).toEqual(size);
          project.inlineMath = service;
        }
      expect(layoutSpy).not.toHaveBeenCalled();
      expect(split).not.toHaveBeenCalled();
      expect(getTextSize).toHaveBeenCalled();
    },
  );
});
