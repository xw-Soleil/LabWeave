import { beforeEach, describe, expect, it, vi } from "vitest";
import { Color, Vector } from "@graphif/data-structures";
import { Rectangle } from "@graphif/shapes";
const settings = vi.hoisted(() => ({ protectingPrivacy: false, ignoreTextNodeTextRenderLessThanFontSize: 0 }));
vi.mock("@/core/service/Settings", () => ({ Settings: settings }));
vi.mock("@/core/research/FileCardFactory", () => ({
  fileNameOf: (path: string) => path.split("/").at(-1),
  resolveFileCardPath: (_project: unknown, card: { sourcePath: string }) => card.sourcePath,
  scheduleFileCardMissingCheck: vi.fn(),
}));
vi.mock("@/core/research/ResearchFolder", () => ({
  ResearchFolder: { getRoot: () => "/r", isInside: (path: string) => !path.startsWith("../") },
}));
vi.mock("@/core/research/FileCardContent", () => ({
  cardText: (key: string, options?: { name: string }) => (options ? `${options.name} · ${key}` : key),
  stripExtension: (name: string) => name.replace(/\.[^.]+$/, ""),
  joinPdfLines: (text: string) => text.replace(/\n/g, " "),
}));
vi.mock("@/core/service/controlService/MouseLocation", () => ({ MouseLocation: { vector: () => Vector.getZero() } }));
vi.mock("@/utils/font", () => ({ getTextSize: (text: string) => new Vector(text.length * 6, 12) }));
vi.mock("@/utils/superellipse", () => ({ superellipseRect: vi.fn() }));
import { renderFileCard } from "./FileCardRenderer";

function fixture(
  kind: "pdf" | "markdown" | "image",
  bitmap: { width: number; height: number } | undefined = { width: 200, height: 300 },
) {
  const project = {
    camera: { currentScale: 1 },
    renderer: { transformWorld2View: (value: unknown) => value, transformView2World: (value: unknown) => value },
    stageStyleManager: {
      currentStyle: {
        Background: new Color(25, 25, 25),
        StageObjectBorder: new Color(240, 240, 240),
        CollideBoxSelected: new Color(80, 160, 255, 0.35),
      },
    },
    textRenderer: {
      layoutClampedLines: () => ["Paper title"],
      renderClampedMultiLineText: vi.fn(),
      renderTextFromCenter: vi.fn(),
      renderFittedText: vi.fn(),
    },
    shapeRenderer: { renderRect: vi.fn(), renderResizeArrow: vi.fn() },
    collisionBoxRenderer: { render: vi.fn() },
    imageRenderer: { renderImageElement: vi.fn() },
    canvas: {
      element: { matches: vi.fn(() => true) },
      ctx: { save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), clip: vi.fn(), fill: vi.fn() },
    },
  };
  const card = {
    fileKind: kind,
    title: "Paper title",
    sourcePath: "a.pdf",
    excerpt: "AI-only excerpt",
    pageCount: 99,
    bitmap: bitmap as { width: number; height: number } | undefined,
    ensureThumbnail: vi.fn(),
    rectangle: new Rectangle(Vector.getZero(), new Vector(240, 340)),
    color: Color.Transparent,
    collisionBox: { isContainsPoint: vi.fn(() => false) },
  };
  return { project, card };
}

describe("image card annotations and hover labels", () => {
  it.each(["image", "pdf"] as const)("keeps the note below the %s image and shows its source only on hover", (kind) => {
    settings.protectingPrivacy = false;
    const { project, card } = fixture(kind, { width: 240, height: 340 });
    const footer = new Rectangle(card.rectangle.leftBottom, new Vector(card.rectangle.width, 75));
    Object.assign(card, {
      pdfPage: kind === "pdf" ? 1 : 0,
      attachmentId: "thumbnail",
      sourcePath: "../figure.png",
      caption: "Figure",
      annotation: "First line\nSecond line",
      annotationExpanded: true,
      annotationRectangle: footer,
    });
    const draw = () => {
      project.textRenderer.renderFittedText.mockClear();
      renderFileCard(project as never, card as never);
      return project.textRenderer.renderFittedText.mock.calls;
    };
    expect(draw().map(([label]) => label)).toEqual(["▾ annotation"]);
    const [[note, at]] = project.textRenderer.renderClampedMultiLineText.mock.calls;
    expect(note).toBe("First line\nSecond line");
    expect(at.y).toBeGreaterThan(footer.top);
    expect(project.imageRenderer.renderImageElement).toHaveBeenCalledWith(card.bitmap, card.rectangle.location, 1);

    card.collisionBox.isContainsPoint.mockReturnValue(true);
    const [, caption, hint] = draw();
    expect(caption[0]).toBe("Figure");
    expect(hint[0]).toMatchObject({ head: "external · ", body: "figure", tail: ".png · openHint" });
    for (const [, location] of [caption, hint]) expect(location.y).toBeGreaterThan(footer.bottom);
    card.rectangle.location = new Vector(0, 100);
    footer.location = card.rectangle.leftBottom;
    for (const [, location, size] of draw().slice(1)) expect(location.y + size).toBeLessThan(card.rectangle.top);
    card.collisionBox.isContainsPoint.mockReturnValue(false);
    expect(draw()).toHaveLength(1);

    card.collisionBox.isContainsPoint.mockReturnValue(true);
    project.canvas.element.matches.mockReturnValue(false);
    expect(draw()).toHaveLength(1);
    project.canvas.element.matches.mockReturnValue(true);
    settings.protectingPrivacy = true;
    project.textRenderer.renderClampedMultiLineText.mockClear();
    expect(draw()).toHaveLength(0);
    expect(project.textRenderer.renderClampedMultiLineText).not.toHaveBeenCalled();
  });
});

describe("PDF cover cards", () => {
  beforeEach(() => {
    settings.protectingPrivacy = false;
  });
  it("draws only the title and a centered proportional cover on white paper even in a dark theme", () => {
    const { project, card } = fixture("pdf");
    renderFileCard(project as never, card as never);
    expect(project.textRenderer.renderClampedMultiLineText.mock.calls.map(([text]) => text)).toEqual(["Paper title"]);
    expect(project.textRenderer.renderFittedText).not.toHaveBeenCalled();
    const [, location, scale] = project.imageRenderer.renderImageElement.mock.calls[0];
    expect(scale).toBeCloseTo(244 / 300);
    expect(location.x + (200 * scale) / 2).toBeCloseTo(120);
    expect(
      project.shapeRenderer.renderRect.mock.calls.some(([, color]) => color.equals(new Color(255, 255, 255))),
    ).toBe(true);
  });
  it("does not expose excerpts when the cover is missing", () => {
    const { project, card } = fixture("pdf");
    card.bitmap = undefined;
    renderFileCard(project as never, card as never);
    expect(project.textRenderer.renderClampedMultiLineText.mock.calls.map(([text]) => text)).toEqual(["Paper title"]);
  });
  it("keeps Markdown excerpts and respects privacy mode for PDFs", () => {
    const markdown = fixture("markdown");
    markdown.card.bitmap = undefined;
    renderFileCard(markdown.project as never, markdown.card as never);
    expect(markdown.project.textRenderer.renderClampedMultiLineText.mock.calls.map(([text]) => text)).toContain(
      "AI-only excerpt",
    );
    settings.protectingPrivacy = true;
    const pdf = fixture("pdf");
    renderFileCard(pdf.project as never, pdf.card as never);
    expect(pdf.project.imageRenderer.renderImageElement).not.toHaveBeenCalled();
    expect(pdf.project.textRenderer.renderClampedMultiLineText).not.toHaveBeenCalled();
  });
});

describe("PDF quote cards", () => {
  const yellow = new Color(255, 212, 0);
  function quote(overrides: Record<string, unknown> = {}) {
    const { project, card } = fixture("pdf");
    project.textRenderer.renderClampedMultiLineText.mockReturnValue(3);
    Object.assign(project.canvas.ctx, { fill: vi.fn() });
    Object.assign(card, {
      // 圈下来的字没有图
      bitmap: undefined,
      pdfPage: 4,
      attachmentId: "",
      excerpt: "first line\nsecond line",
      caption: "Paper · p. 4",
      rectangle: new Rectangle(new Vector(100, 50), new Vector(320, 120)),
      ...overrides,
    });
    return { project, card };
  }
  beforeEach(() => {
    settings.protectingPrivacy = false;
  });

  it("draws the passage as the body with its line breaks joined, and the source as one small line at the bottom", () => {
    const { project, card } = quote();
    renderFileCard(project as never, card as never);
    const [text, location, size, width, , , lines] = project.textRenderer.renderClampedMultiLineText.mock.calls[0];
    expect(text).toBe("first line second line");
    expect(size).toBe(13);
    expect([location.x, location.y]).toEqual([130, 65]);
    expect(width).toBe(274);
    // 120 高的卡片放得下 3 行
    expect(lines).toBe(3);
    const [source, sourceAt, sourceSize] = project.textRenderer.renderFittedText.mock.calls[0];
    expect(source).toBe("Paper · p. 4");
    expect(sourceSize).toBe(11);
    expect(sourceAt.x).toBe(130);
    expect(sourceAt.y).toBeGreaterThan(65 + 3 * 13 * 1.55);
    // 没有「PDF」小标签和大标题
    expect(project.textRenderer.renderTextFromCenter).not.toHaveBeenCalled();
  });

  it("draws a bar beside the passage in the highlight colour over a faint tint of it", () => {
    const blue = new Color(46, 168, 229);
    for (const [color, accent] of [
      [Color.Transparent, yellow],
      [blue, blue],
    ]) {
      const { project, card } = quote({ color });
      renderFileCard(project as never, card as never);
      const fills = project.shapeRenderer.renderRect.mock.calls.map(([rect, fill]) => ({ rect, fill }));
      // 先铺不透明的底，再盖一层淡淡的高亮色，最后是竖线
      expect(fills[0].fill.equals(new Color(25, 25, 25))).toBe(true);
      expect(fills[1].fill.equals(accent.toNewAlpha(0.1))).toBe(true);
      const bar = fills.at(-1)!;
      expect(bar.fill.equals(accent)).toBe(true);
      expect(bar.rect.size.x).toBe(3);
      expect(bar.rect.location.x).toBe(116);
      expect(bar.rect.size.y).toBeCloseTo(3 * 13 * 1.55 - 4);
    }
  });

  it("hides the passage in privacy mode and keeps drawing a boxed region as a picture", () => {
    settings.protectingPrivacy = true;
    const hidden = quote();
    renderFileCard(hidden.project as never, hidden.card as never);
    expect(hidden.project.textRenderer.renderClampedMultiLineText).not.toHaveBeenCalled();
    expect(hidden.project.textRenderer.renderFittedText).not.toHaveBeenCalled();
    settings.protectingPrivacy = false;
    const region = quote({ attachmentId: "img", excerpt: "", bitmap: { width: 300, height: 200 } });
    renderFileCard(region.project as never, region.card as never);
    expect(region.project.imageRenderer.renderImageElement).toHaveBeenCalledOnce();
    expect(region.project.textRenderer.renderClampedMultiLineText).not.toHaveBeenCalled();
  });

  it("draws a corner resize handle only on selected PDF boxed-region cards", () => {
    const regionRect = new Rectangle(new Vector(100, 50), new Vector(300, 200));
    const region = quote({
      attachmentId: "img",
      excerpt: "",
      bitmap: { width: 300, height: 200 },
      isSelected: true,
      canResize: true,
      rectangle: regionRect,
      getResizeHandleRect: () =>
        new Rectangle(new Vector(regionRect.right - 25, regionRect.bottom - 25), new Vector(25, 25)),
    });
    renderFileCard(region.project as never, region.card as never);
    expect(region.project.shapeRenderer.renderResizeArrow).toHaveBeenCalledOnce();

    const ordinaryImage = quote({
      fileKind: "image",
      pdfPage: 0,
      attachmentId: "img",
      excerpt: "",
      bitmap: { width: 300, height: 200 },
      isSelected: true,
      canResize: false,
    });
    renderFileCard(ordinaryImage.project as never, ordinaryImage.card as never);
    expect(ordinaryImage.project.shapeRenderer.renderResizeArrow).not.toHaveBeenCalled();
  });
});
