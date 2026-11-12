import { quoteCardHeight } from "@/core/render/canvas2d/entityRenderer/FileCardRenderer";
import { CollisionBox } from "@/core/stage/stageObject/collisionBox/collisionBox";
import { FileCardNode } from "@/core/stage/stageObject/entity/FileCardNode";
import { TabWorkspace } from "@/core/TabWorkspace";
import { Vector } from "@graphif/data-structures";
import { Rectangle } from "@graphif/shapes";
import { toast } from "sonner";
import { documentText as t } from "./DocumentTab";
import { toStoredSourcePath } from "./FileCardFactory";
import { nudgeEntitiesOutOfOverlap } from "./OverlapResolver";
import { findMainProject } from "./ResearchSession";

export interface PdfExcerpt {
  /** PDF 的绝对路径 */
  path: string;
  title: string;
  /** 从 1 数 */
  page: number;
  /** 印在页上的页码，和侧栏批注卡片上写的一致 */
  pageLabel: string;
  pageCount: number;
  annotationId: string;
  /** 圈的字；框的图给 image */
  text?: string;
  image?: { blob: Blob; width: number; height: number };
}

/**
 * 把 PDF 里圈的一段话或框的一块图，放到主编辑区正在显示的白板上，摆在当前视野中间、挤开压住的卡片。
 * 卡片指向这份 PDF，双击跳回原处；图存成白板文件里的附件，不在研究文件夹里另放图片文件。
 */
export function sendPdfExcerpt(excerpt: PdfExcerpt): void {
  const project = findMainProject();
  if (!project) {
    toast.warning(t("toBoard.noBoard"));
    return;
  }
  const text = excerpt.text?.trim() ?? "";
  const size = excerpt.image
    ? FileCardNode.imageCardSize(excerpt.image.width, excerpt.image.height)
    : new Vector(FileCardNode.width, quoteCardHeight(project, text));
  const card = new FileCardNode(project, {
    title: excerpt.title,
    sourcePath: toStoredSourcePath(project, excerpt.path),
    fileKind: "pdf",
    attachmentId: excerpt.image ? project.addAttachment(excerpt.image.blob) : "",
    excerpt: text,
    pageCount: excerpt.pageCount,
    caption: t("toBoard.caption", { page: excerpt.pageLabel, title: excerpt.title }),
    pdfPage: excerpt.page,
    pdfAnnotation: excerpt.annotationId,
    collisionBox: new CollisionBox([new Rectangle(project.camera.location.subtract(size.multiply(0.5)), size)]),
  });
  project.stageManager.add(card);
  nudgeEntitiesOutOfOverlap(project, [card]);
  const section = project.sectionMethods.getSectionsByInnerLocation(card.geometryCenter)[0];
  if (section) project.stageManager.goInSection([card], section);
  // 只有 recordStep 会把工程标成未保存，自动保存才会存它
  project.historyManager.recordStep();
  toast.success(t("toBoard.sent", { board: project.title.replace(/\.prg$/i, "") }), {
    action: { label: t("toBoard.show"), onClick: () => TabWorkspace.focus(project.id) },
  });
}
