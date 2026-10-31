import type { Project } from "@/core/Project";
import { cardText } from "@/core/research/FileCardContent";
import { scheduleFileCardMissingCheck } from "@/core/research/FileCardFactory";
import type { FileKind } from "@/core/research/ResearchShell";
import { MouseLocation } from "@/core/service/controlService/MouseLocation";
import { Settings } from "@/core/service/Settings";
import { FileCardNode } from "@/core/stage/stageObject/entity/FileCardNode";
import { getTextSize } from "@/utils/font";
import { Color, colorInvert, Vector } from "@graphif/data-structures";
import { Rectangle } from "@graphif/shapes";

// 以下尺寸都是世界坐标，按 280x200 的卡片排版
const PADDING = 12;
const CORNER_RADIUS = 10;
const BADGE_TOP = 10;
const BADGE_HEIGHT = 20;
const BADGE_FONT_SIZE = 12;
const META_FONT_SIZE = 11;
const TITLE_TOP = 38;
const TITLE_FONT_SIZE = 15;
const TITLE_LINE_HEIGHT = 1.25;
const BODY_TOP = 84;
const EXCERPT_FONT_SIZE = 11;
const EXCERPT_LINE_HEIGHT = 1.3;
const EXCERPT_PREVIEW_LENGTH = 600;
/** PDF 缩略图宽度，按 A4 纵向比例配 BODY 高度 */
const PDF_THUMBNAIL_WIDTH = 74;
const HINT_FONT_SIZE = 11;

const KIND_COLORS: Record<FileKind, Color> = {
  pdf: new Color(214, 69, 65),
  image: new Color(46, 150, 96),
  markdown: new Color(59, 113, 214),
};
const MISSING_COLOR = new Color(220, 38, 38);

function renderBadge(
  project: Project,
  text: string,
  worldLocation: Vector,
  color: Color,
  alignRight: boolean = false,
): number {
  const scale = project.camera.currentScale;
  const width = getTextSize(text, BADGE_FONT_SIZE).x + 12;
  const location = alignRight ? worldLocation.subtract(new Vector(width, 0)) : worldLocation;
  const rect = new Rectangle(location, new Vector(width, BADGE_HEIGHT));
  project.shapeRenderer.renderRect(
    project.renderer.transformWorld2View(rect),
    color,
    Color.Transparent,
    0,
    (BADGE_HEIGHT / 2) * scale,
  );
  project.textRenderer.renderTextFromCenter(
    text,
    project.renderer.transformWorld2View(rect.center),
    BADGE_FONT_SIZE * scale,
    Color.White,
  );
  return width;
}

function renderThumbnail(project: Project, card: FileCardNode, box: Rectangle) {
  const bitmap = card.bitmap;
  if (!bitmap || bitmap.width === 0 || bitmap.height === 0) return;
  const scale = Math.min(box.size.x / bitmap.width, box.size.y / bitmap.height);
  const size = new Vector(bitmap.width * scale, bitmap.height * scale);
  const location = box.center.subtract(size.multiply(0.5));
  const cameraScale = project.camera.currentScale;
  project.imageRenderer.renderImageElement(
    bitmap,
    project.renderer.transformWorld2View(location),
    scale,
    4 * cameraScale,
  );
  project.shapeRenderer.renderRect(
    project.renderer.transformWorld2View(new Rectangle(location, size)),
    Color.Transparent,
    project.stageStyleManager.currentStyle.StageObjectBorder.toNewAlpha(0.25),
    1 * cameraScale,
    4 * cameraScale,
  );
}

/**
 * 文件卡片：上面是类型标签和标题，下面是缩略图和开头文字。
 * 原文件不见了时整张卡片描红，右上角显示「文件不见了」。
 */
export function renderFileCard(project: Project, card: FileCardNode): void {
  card.ensureThumbnail();
  scheduleFileCardMissingCheck(project, card);

  const style = project.stageStyleManager.currentStyle;
  const cameraScale = project.camera.currentScale;
  const rect = card.rectangle;
  const origin = rect.location;

  if (card.isSelected) {
    project.collisionBoxRenderer.render(card.collisionBox, style.CollideBoxSelected);
  }
  const fillColor = card.color.a > 0 ? card.color : style.Background;
  const textColor = card.color.a === 1 ? colorInvert(card.color) : style.StageObjectBorder;
  project.shapeRenderer.renderRect(
    project.renderer.transformWorld2View(rect),
    fillColor,
    card.missing ? MISSING_COLOR : style.StageObjectBorder,
    (card.missing ? 3 : 2) * cameraScale,
    CORNER_RADIUS * cameraScale,
  );

  const showText = TITLE_FONT_SIZE * cameraScale > Settings.ignoreTextNodeTextRenderLessThanFontSize;
  const hideContent = Settings.protectingPrivacy;
  const innerWidth = rect.size.x - PADDING * 2;
  const bodyHeight = rect.size.y - BODY_TOP - PADDING;

  if (showText) {
    const badgeWidth = renderBadge(
      project,
      cardText(`kind.${card.fileKind}`),
      origin.add(new Vector(PADDING, BADGE_TOP)),
      KIND_COLORS[card.fileKind] ?? KIND_COLORS.pdf,
    );
    if (card.fileKind === "pdf" && card.pageCount > 0) {
      project.textRenderer.renderText(
        cardText("pages", { count: card.pageCount }),
        project.renderer.transformWorld2View(
          origin.add(new Vector(PADDING + badgeWidth + 8, BADGE_TOP + (BADGE_HEIGHT - META_FONT_SIZE) / 2)),
        ),
        META_FONT_SIZE * cameraScale,
        textColor.toNewAlpha(0.6),
      );
    }
    if (card.missing) {
      renderBadge(
        project,
        cardText("missing"),
        origin.add(new Vector(rect.size.x - PADDING, BADGE_TOP)),
        MISSING_COLOR,
        true,
      );
    }
    if (!hideContent) {
      project.textRenderer.renderMultiLineText(
        card.title,
        project.renderer.transformWorld2View(origin.add(new Vector(PADDING, TITLE_TOP))),
        TITLE_FONT_SIZE * cameraScale,
        innerWidth * cameraScale,
        textColor,
        TITLE_LINE_HEIGHT,
        2,
      );
    }
  }

  if (hideContent) {
    renderHoverState(project, card);
    return;
  }

  let excerptLeft = PADDING;
  if (card.bitmap) {
    if (card.fileKind === "pdf") {
      renderThumbnail(
        project,
        card,
        new Rectangle(origin.add(new Vector(PADDING, BODY_TOP)), new Vector(PDF_THUMBNAIL_WIDTH, bodyHeight)),
      );
      excerptLeft = PADDING + PDF_THUMBNAIL_WIDTH + 10;
    } else {
      renderThumbnail(
        project,
        card,
        new Rectangle(origin.add(new Vector(PADDING, BODY_TOP)), new Vector(innerWidth, bodyHeight)),
      );
      excerptLeft = rect.size.x;
    }
  }
  const excerptWidth = rect.size.x - PADDING - excerptLeft;
  if (showText && card.excerpt && excerptWidth > 40) {
    project.textRenderer.renderMultiLineText(
      // 卡片只放得下几行；整段 4000 字每帧拿去折行和算缓存键太浪费
      card.excerpt.slice(0, EXCERPT_PREVIEW_LENGTH),
      project.renderer.transformWorld2View(origin.add(new Vector(excerptLeft, BODY_TOP))),
      EXCERPT_FONT_SIZE * cameraScale,
      excerptWidth * cameraScale,
      textColor.toNewAlpha(0.75),
      EXCERPT_LINE_HEIGHT,
      Math.max(1, Math.floor(bodyHeight / (EXCERPT_FONT_SIZE * EXCERPT_LINE_HEIGHT))),
    );
  }
  renderHoverState(project, card);
}

function renderHoverState(project: Project, card: FileCardNode) {
  const mouseLocation = project.renderer.transformView2World(MouseLocation.vector());
  if (!card.collisionBox.isContainsPoint(mouseLocation)) return;
  const style = project.stageStyleManager.currentStyle;
  const cameraScale = project.camera.currentScale;
  if (!card.isSelected) {
    project.collisionBoxRenderer.render(card.collisionBox, style.CollideBoxPreSelected);
  }
  if (HINT_FONT_SIZE * cameraScale > Settings.ignoreTextNodeTextRenderLessThanFontSize) {
    project.textRenderer.renderText(
      card.missing ? cardText("missingHint") : cardText("openHint"),
      project.renderer.transformWorld2View(card.rectangle.location.add(new Vector(0, -HINT_FONT_SIZE - 8))),
      HINT_FONT_SIZE * cameraScale,
      card.missing ? MISSING_COLOR : style.StageObjectBorder,
    );
  }
}
