import type { Project } from "@/core/Project";
import { Settings } from "@/core/service/Settings";
import type { FileCardNode } from "@/core/stage/stageObject/entity/FileCardNode";
import { cardText } from "./FileCardContent";

// 图片说明的字号、行高和四周留白，都是世界坐标
export const captionFontSize = 13;
export const captionLineHeight = 1.4;
export const captionPadding = 6;

/**
 * 在图片下面原位写说明：输入框压在说明那一块上，边写卡片边跟着变高。
 * 点别处或按 Esc 结束；清空就是不要说明，图片下面那一块随之消失。
 */
export async function editImageCardCaption(project: Project, card: FileCardNode) {
  const before = card.caption;
  card.setCaption(before, true);
  const area = card.captionRectangle!;
  project.camera.stopImmediately();
  project.entityMoveManager.stopImmediately();
  project.controller.isCameraLocked = true;
  try {
    const origin = project.canvas.viewToClient(project.renderer.transformWorld2View(area.location));
    const scale = project.canvas.viewToClientScale().multiply(project.camera.currentScale);
    const width = area.width * scale.x;
    const style = project.stageStyleManager.currentStyle;
    await project.inputElement.textarea(
      before,
      (value, input) => {
        card.setCaption(value, true);
        input.style.height = `${card.captionRectangle!.height * scale.y}px`;
      },
      {
        position: "fixed",
        left: `${origin.x}px`,
        top: `${origin.y}px`,
        width: `${width}px`,
        height: `${area.height * scale.y}px`,
        boxSizing: "border-box",
        resize: "none",
        padding: `${captionPadding * scale.y}px ${captionPadding * scale.x}px`,
        border: "none",
        overflowWrap: "anywhere",
        fontFamily: Settings.defaultFontFamily,
        fontSize: `${captionFontSize * scale.y}px`,
        lineHeight: String(captionLineHeight),
        backgroundColor: style.Background.toString(),
        color: style.StageObjectBorder.toString(),
      },
      false,
      true,
      width,
      cardText("caption.title"),
    );
  } finally {
    project.controller.isCameraLocked = false;
    card.setCaption(card.caption.trim());
    if (before !== card.caption) project.historyManager.recordStep();
  }
}
