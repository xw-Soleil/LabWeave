import { quoteCardSize } from "@/core/render/canvas2d/entityRenderer/FileCardRenderer";
import { CollisionBox } from "@/core/stage/stageObject/collisionBox/collisionBox";
import { FileCardNode } from "@/core/stage/stageObject/entity/FileCardNode";
import { TabWorkspace } from "@/core/TabWorkspace";
import { Color } from "@graphif/data-structures";
import { Rectangle } from "@graphif/shapes";
import { toast } from "sonner";
import { boardName, resolveBoard, type BoardChoice } from "./BoardPicker";
import { documentText as t } from "./DocumentTab";
import { encodePixels, joinPdfLines } from "./FileCardContent";
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
  /** 那条批注的颜色（#rrggbb），摘录卡片左边的竖线和底色跟着它 */
  color?: string;
  /** 圈的字；框的图给 image：引擎画出来的原始像素，width / height 是它在页面上的大小 */
  text?: string;
  image?: {
    pixels: { data: Uint8ClampedArray<ArrayBuffer>; width: number; height: number };
    width: number;
    height: number;
  };
}

/**
 * 把 PDF 里圈的一段话或框的一块图放到用户在菜单里选的那块白板上，摆在当前视野中间、挤开压住的卡片。
 * 那块白板还没打开的话先在后台打开，不把用户从 PDF 带走。
 * 卡片指向这份 PDF，双击跳回原处；图存成白板文件里的附件，不在研究文件夹里另放图片文件。
 */
export async function sendPdfExcerpt(excerpt: PdfExcerpt, board: BoardChoice): Promise<void> {
  const [project, image] = await Promise.all([
    resolveBoard(board),
    excerpt.image && encodePixels(excerpt.image.pixels),
  ]);
  // 打不开；或者打开、压图的这一会儿它被关掉了
  if (!project || project.closing) {
    toast.warning(t("toBoard.boardGone", { board: board.name }));
    return;
  }
  // 圈下来的字按页面上的行断开，接回一段话再存
  const text = joinPdfLines(excerpt.text ?? "");
  const size = excerpt.image
    ? FileCardNode.imageCardSize(excerpt.image.width, excerpt.image.height)
    : quoteCardSize(project, text);
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
    // 只给摘录的字上色：图片卡片的颜色是垫在透明图下面的底色
    ...(!excerpt.image && /^#[\da-f]{6}$/i.test(excerpt.color ?? "") && { color: Color.fromHex(excerpt.color!) }),
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
