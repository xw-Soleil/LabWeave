import { Project } from "@/core/Project";
import { FileCardNode } from "@/core/stage/stageObject/entity/FileCardNode";
import { ImageNode } from "@/core/stage/stageObject/entity/ImageNode";
import { PenStroke } from "@/core/stage/stageObject/entity/PenStroke";
import { Section } from "@/core/stage/stageObject/entity/Section";
import { TabWorkspace } from "@/core/TabWorkspace";
import { activeTabAtom, store, tabsAtom } from "@/state";
import { Vector } from "@graphif/data-structures";
import { toast } from "sonner";
import { trackActivityBoards } from "./ActivityLog";
import { resolveBoard, type BoardChoice } from "./BoardPicker";
import { documentText } from "./DocumentTab";
import { createFileCards } from "./FileCardFactory";
import { findNudgeOffset, type Box } from "./OverlapResolver";

function centerPlacement(project: Project, size: Vector): Vector {
  const origin = project.camera.location.subtract(size.multiply(0.5));
  const moving: Box = {
    left: origin.x,
    top: origin.y,
    right: origin.x + size.x,
    bottom: origin.y + size.y,
  };
  const obstacles: Box[] = project.stageManager
    .getEntities()
    .filter(
      (entity) =>
        !entity.isHiddenBySectionCollapse &&
        !(entity instanceof PenStroke) &&
        !(entity instanceof Section && !entity.isCollapsed) &&
        !(entity instanceof ImageNode && entity.isBackground),
    )
    .map((entity) => {
      const rect = entity.collisionBox.getRectangle();
      return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
    });
  const offset = findNudgeOffset([moving], [obstacles]);
  return offset ? origin.add(new Vector(offset.x, offset.y)) : origin;
}

/**
 * 把文献库里一篇论文的本地 PDF 放到用户选的白板上：
 * 在目标白板当前视野中间生成和文件面板拖过去一样的普通 FileCardNode，并切到那块白板。
 */
export async function sendLibraryPdfToBoard(pdfPath: string, board: BoardChoice): Promise<FileCardNode[]> {
  const project = await resolveBoard(board);
  if (!project || project.closing) {
    toast.warning(documentText("toBoard.boardGone", { board: board.name }));
    return [];
  }
  // 后台刚打开的未打开白板，先让活动记录记下修改前的基准，免得新加的卡片被算进初始状态里漏记
  trackActivityBoards(store.get(tabsAtom).filter((tab): tab is Project => tab instanceof Project && !tab.closing));
  if (store.get(activeTabAtom) !== project) {
    TabWorkspace.focus(project.id);
  }
  const size = new Vector(FileCardNode.pdfWidth, FileCardNode.pdfHeight);
  return createFileCards(project, [pdfPath], centerPlacement(project, size));
}
