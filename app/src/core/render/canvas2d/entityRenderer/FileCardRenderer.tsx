import { splitFileName } from "@/components/ui/file-name";
import type { Project } from "@/core/Project";
import { cardText, stripExtension } from "@/core/research/FileCardContent";
import { fileNameOf, resolveFileCardPath, scheduleFileCardMissingCheck } from "@/core/research/FileCardFactory";
import { ResearchFolder } from "@/core/research/ResearchFolder";
import type { FileKind } from "@/core/research/ResearchShell";
import { MouseLocation } from "@/core/service/controlService/MouseLocation";
import { Settings } from "@/core/service/Settings";
import { FileCardNode } from "@/core/stage/stageObject/entity/FileCardNode";
import { getTextSize } from "@/utils/font";
import { superellipseRect } from "@/utils/superellipse";
import { Color, colorInvert, mixColors, Vector } from "@graphif/data-structures";
import { Rectangle } from "@graphif/shapes";

// 以下尺寸都是世界坐标，按 280x200 的卡片排版
const PADDING = 12;
const CORNER_RADIUS = 10;
const BADGE_TOP = 11;
const BADGE_HEIGHT = 18;
const BADGE_RADIUS = 4;
const BADGE_PADDING_X = 6;
const BADGE_GAP = 8;
const BADGE_FONT_SIZE = 12;
const BADGE_FONT_WEIGHT = "500";
const META_FONT_SIZE = 11;
const TITLE_TOP = 38;
const TITLE_FONT_SIZE = 15;
const TITLE_LINE_HEIGHT = 1.25;
const TITLE_MAX_LINES = 2;
/** 标题取自 PDF 元数据或 Markdown 一级标题时，标题下面再写一行文件名 */
const FILE_NAME_FONT_SIZE = 11;
const FILE_NAME_GAP = 3;
const FILE_NAME_LINE_HEIGHT = 1.25;
const BODY_TOP = 84;
const BODY_GAP = 6;
const EXCERPT_FONT_SIZE = 11;
const EXCERPT_LINE_HEIGHT = 1.3;
const EXCERPT_PREVIEW_LENGTH = 600;
/** PDF 缩略图宽度，按 A4 纵向比例配 BODY 高度 */
const PDF_THUMBNAIL_WIDTH = 74;
const HINT_FONT_SIZE = 11;
const HINT_GAP = 8;
/** 悬停提示文案里文件名的占位，用来把文件名单独拿出来做中间省略 */
const HINT_NAME_SLOT = "\u{e000}";

/** 三种类型的色相，压低了饱和度；实际颜色按主题的文字色和卡片底色调出来 */
const KIND_HUES: Record<FileKind, Color> = {
  pdf: new Color(190, 88, 76),
  image: new Color(72, 140, 102),
  markdown: new Color(82, 116, 178),
};
const MISSING_COLOR = new Color(220, 38, 38);

interface BadgeColors {
  background: Color;
  text: Color;
}

/** 浅色底配同色相的字：字色往主题文字色（浅色主题是黑、深色主题是白）靠，两种主题都看得清 */
function tintedBadge(hue: Color, textColor: Color): BadgeColors {
  return { background: hue.toNewAlpha(0.14), text: mixColors(hue, textColor.toSolid(), 0.3) };
}

function neutralBadge(textColor: Color): BadgeColors {
  return { background: textColor.toNewAlpha(0.08), text: textColor.toNewAlpha(0.7) };
}

/** 卡片直接引用的是研究文件夹外的文件(没复制进来):原文件移动、改名后卡片会断,换台电脑也打不开 */
function isExternalFileCard(project: Project, card: FileCardNode): boolean {
  return ResearchFolder.getRoot() !== "" && !ResearchFolder.isInside(resolveFileCardPath(project, card));
}

/** 标题就是文件名（去不去扩展名都算）时不用再写一遍文件名 */
function titleDiffersFromFileName(title: string, fileName: string): boolean {
  const trimmed = title.trim();
  return trimmed !== "" && trimmed !== fileName && trimmed !== stripExtension(fileName);
}

function renderBadge(
  project: Project,
  text: string,
  worldLocation: Vector,
  colors: BadgeColors,
  alignRight: boolean = false,
): number {
  const scale = project.camera.currentScale;
  const width = getTextSize(text, BADGE_FONT_SIZE, undefined, BADGE_FONT_WEIGHT).x + BADGE_PADDING_X * 2;
  const location = alignRight ? worldLocation.subtract(new Vector(width, 0)) : worldLocation;
  const rect = new Rectangle(location, new Vector(width, BADGE_HEIGHT));
  project.shapeRenderer.renderRect(
    project.renderer.transformWorld2View(rect),
    colors.background,
    Color.Transparent,
    0,
    BADGE_RADIUS * scale,
  );
  project.textRenderer.renderTextFromCenter(
    text,
    project.renderer.transformWorld2View(rect.center),
    BADGE_FONT_SIZE * scale,
    colors.text,
    undefined,
    BADGE_FONT_WEIGHT,
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
 * 文件卡片：上面是类型标签和标题（标题不是文件名时下面再写一行文件名），下面是缩略图和开头文字。
 * 原文件不见了时整张卡片描红，右上角显示「文件不见了」。
 */
export function renderFileCard(project: Project, card: FileCardNode): void {
  card.ensureThumbnail();
  scheduleFileCardMissingCheck(project, card);

  const style = project.stageStyleManager.currentStyle;
  const cameraScale = project.camera.currentScale;
  const rect = card.rectangle;

  if (card.isSelected) {
    project.collisionBoxRenderer.render(card.collisionBox, style.CollideBoxSelected);
  }
  const fillColor = card.color.a > 0 ? card.color : style.Background;
  const textColor = card.color.a === 1 ? colorInvert(card.color) : style.StageObjectBorder;
  const viewRect = project.renderer.transformWorld2View(rect);
  project.shapeRenderer.renderRect(
    viewRect,
    fillColor,
    card.missing ? MISSING_COLOR : style.StageObjectBorder,
    (card.missing ? 3 : 2) * cameraScale,
    CORNER_RADIUS * cameraScale,
  );

  // 排版已经保证文字不出卡片；裁剪兜住取整字号、单个字比一行还宽这类边角情况
  const ctx = project.canvas.ctx;
  ctx.save();
  try {
    ctx.beginPath();
    superellipseRect(
      ctx,
      viewRect.location.x,
      viewRect.location.y,
      viewRect.size.x,
      viewRect.size.y,
      CORNER_RADIUS * cameraScale,
    );
    ctx.clip();
    renderCardContent(project, card, textColor);
  } finally {
    ctx.restore();
  }
  renderHoverState(project, card);
}

function renderCardContent(project: Project, card: FileCardNode, textColor: Color) {
  const cameraScale = project.camera.currentScale;
  const rect = card.rectangle;
  const origin = rect.location;
  const toView = (offset: Vector) => project.renderer.transformWorld2View(origin.add(offset));

  const showText = TITLE_FONT_SIZE * cameraScale > Settings.ignoreTextNodeTextRenderLessThanFontSize;
  const hideContent = Settings.protectingPrivacy;
  const innerWidth = rect.size.x - PADDING * 2;
  const fileName = fileNameOf(card.sourcePath);
  const showFileName = !hideContent && titleDiffersFromFileName(card.title, fileName);
  // 版面按世界坐标排，和缩放无关：放大缩小时缩略图不会跳
  const titleLineCount = hideContent
    ? 0
    : project.textRenderer.layoutClampedLines(card.title, TITLE_FONT_SIZE, innerWidth, TITLE_MAX_LINES).length;
  const fileNameTop = TITLE_TOP + Math.max(1, titleLineCount) * TITLE_FONT_SIZE * TITLE_LINE_HEIGHT + FILE_NAME_GAP;
  const bodyTop = showFileName
    ? Math.max(BODY_TOP, Math.ceil(fileNameTop + FILE_NAME_FONT_SIZE * FILE_NAME_LINE_HEIGHT + BODY_GAP))
    : BODY_TOP;
  const bodyHeight = rect.size.y - bodyTop - PADDING;

  if (showText) {
    let badgeRowLeft = PADDING;
    let badgeRowRight = rect.size.x - PADDING;
    badgeRowLeft +=
      renderBadge(
        project,
        cardText(`kind.${card.fileKind}`),
        new Vector(origin.x + badgeRowLeft, origin.y + BADGE_TOP),
        tintedBadge(KIND_HUES[card.fileKind] ?? KIND_HUES.pdf, textColor),
      ) + BADGE_GAP;
    if (card.missing) {
      badgeRowRight -=
        renderBadge(
          project,
          cardText("missing"),
          new Vector(origin.x + badgeRowRight, origin.y + BADGE_TOP),
          tintedBadge(MISSING_COLOR, textColor),
          true,
        ) + BADGE_GAP;
    } else if (isExternalFileCard(project, card)) {
      badgeRowRight -=
        renderBadge(
          project,
          cardText("external"),
          new Vector(origin.x + badgeRowRight, origin.y + BADGE_TOP),
          neutralBadge(textColor),
          true,
        ) + BADGE_GAP;
    }
    if (card.fileKind === "pdf" && card.pageCount > 0 && badgeRowRight > badgeRowLeft) {
      project.textRenderer.renderFittedText(
        cardText("pages", { count: card.pageCount }),
        toView(new Vector(badgeRowLeft, BADGE_TOP + (BADGE_HEIGHT - META_FONT_SIZE) / 2)),
        META_FONT_SIZE * cameraScale,
        (badgeRowRight - badgeRowLeft) * cameraScale,
        textColor.toNewAlpha(0.6),
      );
    }
    if (!hideContent) {
      project.textRenderer.renderClampedMultiLineText(
        card.title,
        toView(new Vector(PADDING, TITLE_TOP)),
        TITLE_FONT_SIZE * cameraScale,
        innerWidth * cameraScale,
        textColor,
        TITLE_LINE_HEIGHT,
        TITLE_MAX_LINES,
      );
    }
    if (showFileName) {
      const { stem, ext } = splitFileName(fileName);
      project.textRenderer.renderFittedText(
        { body: stem, tail: ext },
        toView(new Vector(PADDING, fileNameTop)),
        FILE_NAME_FONT_SIZE * cameraScale,
        innerWidth * cameraScale,
        textColor.toNewAlpha(0.6),
      );
    }
  }

  if (hideContent) return;

  let excerptLeft = PADDING;
  if (card.bitmap) {
    if (card.fileKind === "pdf") {
      renderThumbnail(
        project,
        card,
        new Rectangle(origin.add(new Vector(PADDING, bodyTop)), new Vector(PDF_THUMBNAIL_WIDTH, bodyHeight)),
      );
      excerptLeft = PADDING + PDF_THUMBNAIL_WIDTH + 10;
    } else {
      renderThumbnail(
        project,
        card,
        new Rectangle(origin.add(new Vector(PADDING, bodyTop)), new Vector(innerWidth, bodyHeight)),
      );
      excerptLeft = rect.size.x;
    }
  }
  const excerptWidth = rect.size.x - PADDING - excerptLeft;
  if (showText && card.excerpt && excerptWidth > 40) {
    project.textRenderer.renderClampedMultiLineText(
      // 卡片只放得下几行；整段 4000 字每帧拿去折行和算缓存键太浪费
      card.excerpt.slice(0, EXCERPT_PREVIEW_LENGTH),
      toView(new Vector(excerptLeft, bodyTop)),
      EXCERPT_FONT_SIZE * cameraScale,
      excerptWidth * cameraScale,
      textColor.toNewAlpha(0.75),
      EXCERPT_LINE_HEIGHT,
      Math.max(1, Math.floor(bodyHeight / (EXCERPT_FONT_SIZE * EXCERPT_LINE_HEIGHT))),
    );
  }
}

/** 「文件名 · 双击打开」：宽度不超过卡片，放不下时省略文件名中间，扩展名和后面的话保留 */
function renderHoverState(project: Project, card: FileCardNode) {
  const mouseLocation = project.renderer.transformView2World(MouseLocation.vector());
  if (!card.collisionBox.isContainsPoint(mouseLocation)) return;
  const style = project.stageStyleManager.currentStyle;
  const cameraScale = project.camera.currentScale;
  if (!card.isSelected) {
    project.collisionBoxRenderer.render(card.collisionBox, style.CollideBoxPreSelected);
  }
  if (HINT_FONT_SIZE * cameraScale <= Settings.ignoreTextNodeTextRenderLessThanFontSize) return;
  const template = cardText(card.missing ? "missingHint" : "openHint", { name: HINT_NAME_SLOT });
  const slot = template.indexOf(HINT_NAME_SLOT);
  const { stem, ext } = splitFileName(fileNameOf(card.sourcePath));
  project.textRenderer.renderFittedText(
    // 文案里没有 {{name}}（比如还没重新生成的繁体文案）时原样显示
    slot < 0
      ? template
      : { head: template.slice(0, slot), body: stem, tail: ext + template.slice(slot + HINT_NAME_SLOT.length) },
    project.renderer.transformWorld2View(card.rectangle.location.add(new Vector(0, -HINT_FONT_SIZE - HINT_GAP))),
    HINT_FONT_SIZE * cameraScale,
    card.rectangle.size.x * cameraScale,
    card.missing ? MISSING_COLOR : style.StageObjectBorder,
  );
}
