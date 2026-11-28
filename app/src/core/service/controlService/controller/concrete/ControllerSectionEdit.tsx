import { Dialog } from "@/components/ui/dialog";
import { Project } from "@/core/Project";
import { findEndpointHandle } from "@/core/research/ImageEdgeEndpoints";

import { ControllerClass } from "@/core/service/controlService/controller/ControllerClass";
import { Section } from "@/core/stage/stageObject/entity/Section";
import { Vector } from "@graphif/data-structures";
import { toast } from "sonner";

/**
 * 包含编辑节点文字，编辑详细信息等功能的控制器
 *
 * 当有节点编辑时，会把摄像机锁定住
 */
export class ControllerSectionEditClass extends ControllerClass {
  private resize: ReturnType<Section["beginResize"]> = null;

  get isResizing() {
    return this.resize !== null;
  }

  tryStartResize(event: MouseEvent) {
    if (event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false;
    const location = this.project.renderer.transformView2World(new Vector(event.clientX, event.clientY));
    for (const entity of this.project.stageManager.getSelectedEntities()) {
      if (!(entity instanceof Section)) continue;
      const resize = entity.beginResize(location);
      if (!resize) continue;
      if (findEndpointHandle(this.project, location)) return false;
      this.resize = resize;
      return true;
    }
    return false;
  }

  constructor(protected readonly project: Project) {
    super(project);
  }

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
    if (this.resize) this.resize.update(worldLocation);
    else this.project.mouseInteraction.updateByMouseMove(worldLocation);
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
