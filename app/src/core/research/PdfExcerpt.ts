import { quoteCardHeight } from "@/core/render/canvas2d/entityRenderer/FileCardRenderer";
import { CollisionBox } from "@/core/stage/stageObject/collisionBox/collisionBox";
import { FileCardNode } from "@/core/stage/stageObject/entity/FileCardNode";
import { TabWorkspace } from "@/core/TabWorkspace";
import { Vector } from "@graphif/data-structures";
import { Rectangle } from "@graphif/shapes";
import { toast } from "sonner";
import { boardName, chooseBoard, openBoards } from "./BoardPicker";
import { documentText as t } from "./DocumentTab";
import { encodePixels } from "./FileCardContent";
import { toStoredSourcePath } from "./FileCardFactory";
import { nudgeEntitiesOutOfOverlap } from "./OverlapResolver";

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
  /** 圈的字；框的图给 image：引擎画出来的原始像素，width / height 是它在页面上的大小 */
  text?: string;
  image?: {
    pixels: { data: Uint8ClampedArray<ArrayBuffer>; width: number; height: number };
    width: number;
    height: number;
  };
}

/**
 * 把 PDF 里圈的一段话或框的一块图放到白板上，摆在当前视野中间、挤开压住的卡片。
 * 只开着一块白板就放那块，开着几块先问放哪块。
 * 卡片指向这份 PDF，双击跳回原处；图存成白板文件里的附件，不在研究文件夹里另放图片文件。
 */
export async function sendPdfExcerpt(excerpt: PdfExcerpt): Promise<void> {
  if (!openBoards().length) {
    toast.warning(t("toBoard.noBoard"));
    return;
  }
  const project = await chooseBoard();
  if (!project) return;
  const image = excerpt.image && (await encodePixels(excerpt.image.pixels));
  // 选白板、压图都要等，这期间白板可能被关掉了
  if (project.closing) {
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
    attachmentId: image ? project.addAttachment(image) : "",
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
  toast.success(t("toBoard.sent", { board: boardName(project) }), {
    action: { label: t("toBoard.show"), onClick: () => TabWorkspace.focus(project.id) },
  });
}
