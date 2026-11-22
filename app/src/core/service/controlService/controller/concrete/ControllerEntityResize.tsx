import { Vector } from "@graphif/data-structures";
import { ControllerClass } from "@/core/service/controlService/controller/ControllerClass";
import { Entity } from "@/core/stage/stageObject/abstract/StageEntity";
import type { StageObject } from "@/core/stage/stageObject/abstract/StageObject";
import type { ResizeAble } from "@/core/stage/stageObject/abstract/StageObjectInterface";
import { FileCardNode } from "@/core/stage/stageObject/entity/FileCardNode";
import { ImageNode } from "@/core/stage/stageObject/entity/ImageNode";
import { MediaNode } from "@/core/stage/stageObject/entity/MediaNode";
import { ReferenceBlockNode } from "@/core/stage/stageObject/entity/ReferenceBlockNode";
import { SvgNode } from "@/core/stage/stageObject/entity/SvgNode";
import { TextNode } from "@/core/stage/stageObject/entity/TextNode";

export function isResizableEntity(entity: StageObject): entity is Entity & ResizeAble {
  if (entity instanceof TextNode) {
    return entity.sizeAdjust !== "auto";
  }
  if (entity instanceof FileCardNode) {
    return entity.canResize;
  }
  return (
    entity instanceof ImageNode ||
    entity instanceof SvgNode ||
    entity instanceof MediaNode ||
    entity instanceof ReferenceBlockNode
  );
}

export class ControllerEntityResizeClass extends ControllerClass {
  private changeSizeEntity: (Entity & ResizeAble) | null = null;
  private sizeBefore: Vector | null = null;

  private finishResize() {
    const entity = this.changeSizeEntity;
    const sizeBefore = this.sizeBefore;
    this.changeSizeEntity = null;
    this.sizeBefore = null;
    if (entity && sizeBefore && !entity.collisionBox.getRectangle().size.equals(sizeBefore)) {
      this.project.historyManager.recordStep();
    }
  }

  public mousedown: (event: MouseEvent) => void = (event) => {
    if (!(event.button == 0)) {
      return;
    }
    // 检查是否有选中的物体
    const selectedEntities = this.project.stageManager.getSelectedEntities();
    if (selectedEntities.length === 0) {
      return;
    }
    const pressWorldLocation = this.project.renderer.transformView2World(new Vector(event.clientX, event.clientY));
    this.lastMoveLocation = pressWorldLocation.clone();
    for (const selectedEntity of selectedEntities) {
      if (!isResizableEntity(selectedEntity)) {
        continue;
      }
      const resizeRect = selectedEntity.getResizeHandleRect();
      if (resizeRect.isPointIn(pressWorldLocation)) {
        this.changeSizeEntity = selectedEntity;
        this.sizeBefore = selectedEntity.collisionBox.getRectangle().size.clone();
        break;
      }
    }
  };

  public mousemove: (event: MouseEvent) => void = (event) => {
    if (this.changeSizeEntity === null) {
      return;
    }
    const pressWorldLocation = this.project.renderer.transformView2World(new Vector(event.clientX, event.clientY));
    const diff = pressWorldLocation.subtract(this.lastMoveLocation);
    this.changeSizeEntity.resizeHandle(diff);
    this.lastMoveLocation = pressWorldLocation.clone();
  };

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public mouseup: (event: MouseEvent) => void = (_event) => {
    if (this.changeSizeEntity === null) {
      return;
    }
    this.finishResize();
  };

  public mouseMoveOutWindowForcedShutdown(_outsideLocation: Vector) {
    super.mouseMoveOutWindowForcedShutdown(_outsideLocation);
    this.finishResize();
  }
}
