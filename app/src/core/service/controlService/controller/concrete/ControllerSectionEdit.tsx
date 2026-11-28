import { Dialog } from "@/components/ui/dialog";
import { Project } from "@/core/Project";
import { findEndpointHandle } from "@/core/research/ImageEdgeEndpoints";

import { ControllerClass } from "@/core/service/controlService/controller/ControllerClass";
import { Section } from "@/core/stage/stageObject/entity/Section";
import { CursorNameEnum } from "@/types/cursors";
import { Vector } from "@graphif/data-structures";
import { toast } from "sonner";

/**
 * 包含编辑节点文字，编辑详细信息等功能的控制器
 *
 * 当有节点编辑时，会把摄像机锁定住
 */
export class ControllerSectionEditClass extends ControllerClass {
  private resize: ReturnType<Section["beginResize"]> = null;
  /** 鼠标样式是不是这里改成双向箭头的：是的话移开时要改回去，别的控制器改的不去动 */
  private showingResizeCursor = false;

  /** 这个位置按在哪个选中分组框的调范围小方块上。连线端点的拖柄和它叠在一起时让给连线 */
  private resizeHandleAt(location: Vector) {
    for (const entity of this.project.stageManager.getSelectedEntities()) {
      if (!(entity instanceof Section)) continue;
      const handle = entity.findResizeHandle(location);
      if (handle) return findEndpointHandle(this.project, location) ? null : { section: entity, handle };
    }
    return null;
  }

  constructor(protected readonly project: Project) {
    super(project);
  }

  // 挪动、框选两个控制器看到按在小方块上会自己让开（ControllerUtils.isClickedResizeRect）
  mousedown = (event: MouseEvent) => {
    if (event.button !== 0) return;
    const location = this.project.renderer.transformView2World(new Vector(event.clientX, event.clientY));
    const hit = this.resizeHandleAt(location);
    if (hit) this.resize = hit.section.beginResize(hit.handle, location);
  };

  mouseDoubleClick = (event: MouseEvent) => {
    if (event.button !== 0) {
      return;
    }
    if (this.project.controller.camera.isPreGrabbingWhenSpace) {
      return;
    }
    const worldLocation = this.project.renderer.transformView2World(new Vector(event.clientX, event.clientY));
    if (findEndpointHandle(this.project, worldLocation)) {
      return;
    }
    // 双击调范围的小方块：回到自动贴合内容（和别处「双击拖动条恢复默认」一个意思），不进标题编辑
    const hit = this.resizeHandleAt(worldLocation);
    if (hit) {
      if (hit.section.fitToContent()) this.project.historyManager.recordStep();
      return;
    }
    const clickedEntity = this.project.stageManager.findEntityByLocation(worldLocation);
    if (clickedEntity instanceof Section && this.project.sectionMethods.isSectionBigTitleActive(clickedEntity)) {
      this.editSectionTitle(clickedEntity);
      return;
    }
    const firstHoverSection = this.project.mouseInteraction.firstHoverSection;
    if (!firstHoverSection) {
      return;
    }

    // 编辑文字
    this.editSectionTitle(firstHoverSection);
    return;
  };

  mousemove = (event: MouseEvent) => {
    const worldLocation = this.project.renderer.transformView2World(new Vector(event.clientX, event.clientY));
    if (this.resize) {
      this.resize.update(worldLocation);
      return;
    }
    this.project.mouseInteraction.updateByMouseMove(worldLocation);
    const hit = this.resizeHandleAt(worldLocation);
    if (hit) {
      const { x, y } = hit.handle;
      this.project.controller.setCursorName(
        x === 0
          ? CursorNameEnum.NsResize
          : y === 0
            ? CursorNameEnum.EwResize
            : x === y
              ? CursorNameEnum.NwseResize
              : CursorNameEnum.NeswResize,
      );
      this.showingResizeCursor = true;
    } else if (this.showingResizeCursor) {
      this.project.controller.setCursorName(CursorNameEnum.Default);
      this.showingResizeCursor = false;
    }
  };

  mouseup = (event: MouseEvent) => {
    if (!this.resize) return;
    this.mousemove(event);
    this.finishResize();
  };

  mouseMoveOutWindowForcedShutdown() {
    this.finishResize();
  }

  private finishResize() {
    const resize = this.resize;
    this.resize = null;
    if (resize?.finish()) this.project.historyManager.recordStep();
  }

  keydown = (event: KeyboardEvent) => {
    if (event.key === "Enter") {
      const selectedSections = this.project.stageManager.getSections().filter((section) => section.isSelected);
      if (selectedSections.length === 0) {
        return;
      }
      // 检查是否有选中的section被锁定（包括祖先section的锁定状态）
      const lockedSections = selectedSections.filter((section) =>
        this.project.sectionMethods.isObjectBeLockedBySection(section),
      );
      if (lockedSections.length > 0) {
        toast.error("无法编辑已锁定的section");
        return;
      }
      Dialog.input("重命名 Section").then((value) => {
        if (value) {
          for (const section of selectedSections) {
            section.rename(value);
          }
        }
      });
    }
  };

  private editSectionTitle(section: Section) {
    this.project.controllerUtils.editSectionTitle(section);
  }
}
