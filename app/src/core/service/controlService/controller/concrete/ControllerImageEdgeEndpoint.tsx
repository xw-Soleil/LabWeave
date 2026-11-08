import { dragEndpointTo, findEndpointHandle, rateOf, type EndpointHandle } from "@/core/research/ImageEdgeEndpoints";
import { ControllerClass } from "@/core/service/controlService/controller/ControllerClass";
import { Settings } from "@/core/service/Settings";
import { CursorNameEnum } from "@/types/cursors";
import { Vector } from "@graphif/data-structures";

/**
 * 拖动选中连线连在图片上的那一头。选中/移动卡片、框选、拖连线在按下圆点时都会让开（见 findEndpointHandle 的调用处）。
 */
export class ControllerImageEdgeEndpointClass extends ControllerClass {
  private dragging: (EndpointHandle & { rateBefore: Vector }) | null = null;
  private hovering = false;

  public get isDragging(): boolean {
    return this.dragging !== null;
  }

  private worldLocation(event: MouseEvent): Vector {
    return this.project.renderer.transformView2World(new Vector(event.clientX, event.clientY));
  }

  public mousedown = (event: MouseEvent) => {
    if (event.button !== 0 || Settings.mouseLeftMode !== "selectAndMove") return;
    if (this.project.controller.camera.isPreGrabbingWhenSpace) return;
    const handle = findEndpointHandle(this.project, this.worldLocation(event));
    if (!handle) return;
    this.dragging = { ...handle, rateBefore: rateOf(handle.edge, handle.end).clone() };
    this.project.controller.setCursorName(CursorNameEnum.Move);
  };

  public mousemove = (event: MouseEvent) => {
    const location = this.worldLocation(event);
    if (this.dragging) {
      dragEndpointTo(this.project, this.dragging, location);
      return;
    }
    const hovering = Settings.mouseLeftMode === "selectAndMove" && findEndpointHandle(this.project, location) !== null;
    if (hovering !== this.hovering) {
      this.hovering = hovering;
      this.project.controller.setCursorName(hovering ? CursorNameEnum.Move : CursorNameEnum.Default);
    }
  };

  public mouseup = () => {
    if (!this.dragging) return;
    this.finishDrag();
    this.project.controller.setCursorName(CursorNameEnum.Default);
  };

  public mouseMoveOutWindowForcedShutdown(outsideLocation: Vector) {
    super.mouseMoveOutWindowForcedShutdown(outsideLocation);
    if (this.dragging) this.finishDrag();
    this.hovering = false;
  }

  private finishDrag() {
    const { edge, end, rateBefore } = this.dragging!;
    this.dragging = null;
    if (!rateOf(edge, end).equals(rateBefore)) this.project.historyManager.recordStep();
  }
}
