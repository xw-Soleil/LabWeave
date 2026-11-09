import { beforeEach, describe, expect, it, vi } from "vitest";
import { Color, Vector } from "@graphif/data-structures";
import { Rectangle } from "@graphif/shapes";
const settings = vi.hoisted(() => ({ protectingPrivacy: false, ignoreTextNodeTextRenderLessThanFontSize: 0 }));
vi.mock("@/core/service/Settings", () => ({ Settings: settings }));
vi.mock("@/core/research/FileCardFactory", () => ({
  fileNameOf: (path: string) => path.split("/").at(-1),
  resolveFileCardPath: () => "/r/a.pdf",
  scheduleFileCardMissingCheck: vi.fn(),
}));
vi.mock("@/core/research/ResearchFolder", () => ({ ResearchFolder: { getRoot: () => "/r", isInside: () => true } }));
vi.mock("@/core/research/FileCardContent", () => ({
  cardText: (key: string) => key,
  stripExtension: (name: string) => name.replace(/\.[^.]+$/, ""),
}));
vi.mock("@/core/service/controlService/MouseLocation", () => ({ MouseLocation: { vector: () => Vector.getZero() } }));
vi.mock("@/utils/font", () => ({ getTextSize: (text: string) => new Vector(text.length * 6, 12) }));
vi.mock("@/utils/superellipse", () => ({ superellipseRect: vi.fn() }));
import { renderFileCard } from "./FileCardRenderer";

function fixture(
  kind: "pdf" | "markdown",
  bitmap: { width: number; height: number } | undefined = { width: 200, height: 300 },
) {
  const project = {
    camera: { currentScale: 1 },
    renderer: { transformWorld2View: (value: unknown) => value, transformView2World: (value: unknown) => value },
    stageStyleManager: {
      currentStyle: { Background: new Color(25, 25, 25), StageObjectBorder: new Color(240, 240, 240) },
    },
    textRenderer: {
      layoutClampedLines: () => ["Paper title"],
      renderClampedMultiLineText: vi.fn(),
      renderTextFromCenter: vi.fn(),
      renderFittedText: vi.fn(),
    },
    shapeRenderer: { renderRect: vi.fn() },
    imageRenderer: { renderImageElement: vi.fn() },
    canvas: { ctx: { save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), clip: vi.fn() } },
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
    collisionBox: { isContainsPoint: () => false },
  };
  return { project, card };
}

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
