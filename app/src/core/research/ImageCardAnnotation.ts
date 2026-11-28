import type { Project } from "@/core/Project";
import { Settings } from "@/core/service/Settings";
import type { FileCardNode } from "@/core/stage/stageObject/entity/FileCardNode";
import { Vector } from "@graphif/data-structures";
import { cardText } from "./FileCardContent";

export const annotationHeaderHeight = 24;
export const annotationPadding = 6;
export const annotationFontSize = 13;
export const annotationLineHeight = 1.4;

export async function editImageCardAnnotation(project: Project, card: FileCardNode) {
  const before = card.annotation;
  const wasExpanded = card.annotationExpanded;
  card.setAnnotation(before, true);
  const footer = card.annotationRectangle!;
  project.camera.stopImmediately();
  project.entityMoveManager.stopImmediately();
  project.controller.isCameraLocked = true;
  try {
    const origin = project.canvas.viewToClient(
      project.renderer.transformWorld2View(footer.location.add(new Vector(0, annotationHeaderHeight))),
    );
    const scale = project.canvas.viewToClientScale().multiply(project.camera.currentScale);
    const width = footer.width * scale.x;
    const style = project.stageStyleManager.currentStyle;
    await project.inputElement.textarea(
      before,
      (value, input) => {
        card.setAnnotation(value, true);
        input.style.height = `${(card.annotationRectangle!.height - annotationHeaderHeight) * scale.y}px`;
      },
      {
        position: "fixed",
        left: `${origin.x}px`,
        top: `${origin.y}px`,
        width: `${width}px`,
        height: `${(footer.height - annotationHeaderHeight) * scale.y}px`,
        boxSizing: "border-box",
        resize: "none",
        padding: `${annotationPadding * scale.y}px ${annotationPadding * scale.x}px`,
        border: "none",
        overflowWrap: "anywhere",
        fontFamily: Settings.defaultFontFamily,
        fontSize: `${annotationFontSize * scale.y}px`,
        lineHeight: String(annotationLineHeight),
        backgroundColor: style.Background.toString(),
        color: style.StageObjectBorder.toString(),
      },
      false,
      true,
      width,
      cardText("annotation"),
    );
  } finally {
    project.controller.isCameraLocked = false;
    if (!card.annotation) card.setAnnotation("", false);
    if (before !== card.annotation || wasExpanded !== card.annotationExpanded) project.historyManager.recordStep();
  }
}
