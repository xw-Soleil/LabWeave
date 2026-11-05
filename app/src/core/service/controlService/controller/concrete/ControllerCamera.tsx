/**
 * 存放具体的控制器实例
 */

import { decideWheelAction, wheelDeltaInPixels, WheelSourceTracker } from "@/core/research/WheelGesture";
import { Settings } from "@/core/service/Settings";
import { ControllerClass } from "@/core/service/controlService/controller/ControllerClass";
import { MouseTipFeedbackEffect } from "@/core/service/feedbackService/effectEngine/concrete/MouseTipFeedbackEffect";
import { CursorNameEnum } from "@/types/cursors";
import { openBrowserOrFileByEntity } from "@/utils/externalOpen";
import { isMac } from "@/utils/platform";
import { Vector } from "@graphif/data-structures";

/**
 *
 * 处理键盘按下事件
 * @param event - 键盘事件
 */
export class ControllerCameraClass extends ControllerClass {
  protected get allowViewerModeInteraction(): boolean {
    return true;
  }

  // 是否正在使用
  public isUsingMouseGrabMove = false;
  private dragButton: number | null = null;
  private lastDragPoint = Vector.getZero();
  /**
   * 是否正在使用空格+左键 拖动视野
   */
  public isPreGrabbingWhenSpace = false;

  private previousPinchPoint: Vector | null = null;

  public keydown: (event: KeyboardEvent) => void = (event: KeyboardEvent) => {
    if (this.project.controller.isCameraLocked) {
      return;
    }
    const key = event.key.toLowerCase();

    if (key === " " && Settings.enableSpaceKeyMouseLeftDrag) {
      if (!this.isPreGrabbingWhenSpace) {
        this.isPreGrabbingWhenSpace = true;
        this.project.controller.setCursorName(CursorNameEnum.Grab);
      }
    }
  };

  /**
   * 处理键盘松开事件
   * @param event - 键盘事件
   */
  public keyup: (event: KeyboardEvent) => void = (event: KeyboardEvent) => {
    if (this.project.controller.isCameraLocked) {
      return;
    }
    const key = event.key.toLowerCase();

    if (key === " ") {
      if (this.isPreGrabbingWhenSpace) {
        this.isPreGrabbingWhenSpace = false;
        if (!this.isUsingMouseGrabMove) this.project.controller.setCursorName(CursorNameEnum.Default);
      }
    }
  };

  public mousedown = (event: MouseEvent) => {
    if (this.project.controller.isCameraLocked) {
      return;
    }
    const point = new Vector(event.clientX, event.clientY);
    const spaceDrag =
      event.button === 0 && this.project.controller.pressingKeySet.has(" ") && Settings.enableSpaceKeyMouseLeftDrag;
    // 中键拖动始终移动视野,不让给斩断,免得鼠标用户误删东西
    const middleDrag = event.button === 1 && !event.ctrlKey;
    const rightDrag =
      event.button === 2 &&
      Settings.mouseRightDragBackground === "moveCamera" &&
      this.project.stageManager.findEntityByLocation(this.project.renderer.transformView2World(point)) === null;
    if (spaceDrag || middleDrag || rightDrag) {
      this.dragButton = event.button;
      this.lastDragPoint = point;
      this.isUsingMouseGrabMove = true;
      this.project.camera.stopImmediately();
      this.project.controller.setCursorName(CursorNameEnum.Grabbing);
    }

    if (this.isUsingMouseGrabMove && Settings.autoRefreshStageByMouseAction) {
      // 开始刷新舞台
      this.project.stageManager.refreshAllStageObjects();
    }

    // 2025年4月28日：实验性内容
    if (event.button === 4) {
      // 前侧键按下
      this.project.camera.resetBySelected();
    } else if (event.button === 3) {
      // 后侧键按下
      this.project.camera.reset();
    }
  };

  /**
   * 处理鼠标移动事件
   * @param event - 鼠标事件
   */
  public mousemove: (event: MouseEvent) => void = (event: MouseEvent) => {
    if (this.project.controller.isCameraLocked) {
      return;
    }
    if (!this.isUsingMouseGrabMove) {
      return;
    }
    if (this.dragButton === null || !this.project.controller.isMouseDown[this.dragButton]) return;
    if (this.dragButton === 2 && this.project.controller.nodeConnection.isUsing) return;
    const point = new Vector(event.clientX, event.clientY);
    this.project.camera.panByViewDelta(this.lastDragPoint.subtract(point));
    this.lastDragPoint = point;
  };

  public mouseMoveOutWindowForcedShutdown(vectorObject: Vector) {
    super.mouseMoveOutWindowForcedShutdown(vectorObject);
    this.isUsingMouseGrabMove = false;
    this.dragButton = null;
    this.project.controller.setCursorName(CursorNameEnum.Default);
  }

  /**
   * 处理鼠标松开事件
   * @param event - 鼠标事件
   */
  public mouseup = (event: MouseEvent) => {
    if (event.button !== this.dragButton) return;
    if (!this.isUsingMouseGrabMove) {
      return;
    }
    if (event.button === 0 && this.project.controller.pressingKeySet.has(" ")) {
      if (this.isPreGrabbingWhenSpace) {
        this.project.controller.setCursorName(CursorNameEnum.Grab);
      }
    }
    if (event.button === 1) {
      // 中键松开
      this.project.controller.setCursorName(CursorNameEnum.Default);
    }
    if (event.button === 4) {
      this.project.controller.setCursorName(CursorNameEnum.Default);
    }
    if (event.button === 2) {
      this.project.controller.setCursorName(CursorNameEnum.Default);
    }
    this.isUsingMouseGrabMove = false;
    this.dragButton = null;
  };

  /**
   * 处理鼠标滚轮事件
   * @param event - 滚轮事件
   */
  public mousewheel = (event: WheelEvent) => {
    if (this.dealStealthMode(event)) {
      return;
    }
    if (this.project.controller.isCameraLocked) {
      return;
    }
    // 涂鸦模式下的量角器，禁止滚动
    if (Settings.mouseLeftMode === "draw" && this.project.controller.pressingKeySet.has("shift")) {
      return;
    }
    this.researchMousewheel(event);
  };

  private researchWheelTracker = new WheelSourceTracker();

  /**
   * 滚轮(规则见 core/research/WheelGesture.ts):
   * 移动按滚动的像素直接移动,鼠标和触控板同一个速度,不加缓动动画,顺滑感交给系统自带的滚动惯性;
   * 缩放以鼠标位置为中心连续变化。双指捏合在 macOS 上是带 ctrlKey 的滚轮事件,和按着 Ctrl / Cmd 一样缩放。
   */
  private researchMousewheel(event: WheelEvent) {
    const pixels = wheelDeltaInPixels(event, this.project.renderer.h);
    const source = this.researchWheelTracker.resolve(event);
    const action = decideWheelAction(
      Settings.researchWheelBehavior,
      source,
      pixels,
      event.ctrlKey || event.metaKey,
      event.shiftKey,
    );
    if (action.kind === "pan") {
      this.project.camera.panByViewDelta(new Vector(action.dx, action.dy));
    } else if (action.kind === "zoom") {
      const point = this.project.canvas.clientToView(event.clientX, event.clientY);
      this.project.camera.applyGesture(point, point, action.factor);
    }
  }

  public touchstart = (event: TouchEvent) => {
    this.previousPinchPoint = event.touches.length === 2 ? this.getTouchMidpoint(event.touches) : null;
    this.previousTouchDistance = event.touches.length === 2 ? this.getTouchDistance(event.touches) : 0;
  };

  public cancelGesture() {
    this.previousPinchPoint = null;
    this.previousTouchDistance = 0;
    this.isUsingMouseGrabMove = false;
    this.dragButton = null;
    this.isPreGrabbingWhenSpace = false;
  }

  public touchmove = (event: TouchEvent) => {
    if (event.touches.length !== 2 || this.project.controller.isCameraLocked) return;
    event.preventDefault();
    const midpoint = this.getTouchMidpoint(event.touches);
    const previous = this.previousPinchPoint;
    const distance = this.getTouchDistance(event.touches);
    if (previous && this.previousTouchDistance > 0 && distance > 0) {
      this.project.camera.applyGesture(previous, midpoint, distance / this.previousTouchDistance);
    }
    this.previousPinchPoint = midpoint;
    this.previousTouchDistance = distance;
  };

  public touchend = (event: TouchEvent) => {
    if (event.touches.length !== 2) {
      this.previousPinchPoint = null;
      this.previousTouchDistance = 0;
    }
  };

  private previousTouchDistance = 0;

  private getTouchMidpoint(touches: TouchList): Vector {
    const first = this.project.canvas.clientToView(touches[0].clientX, touches[0].clientY);
    const second = this.project.canvas.clientToView(touches[1].clientX, touches[1].clientY);
    return first.add(second).divide(2);
  }

  private getTouchDistance(touches: TouchList): number {
    const first = this.project.canvas.clientToView(touches[0].clientX, touches[0].clientY);
    const second = this.project.canvas.clientToView(touches[1].clientX, touches[1].clientY);
    return first.distance(second);
  }

  private dealStealthMode(event: WheelEvent) {
    if (Settings.isStealthModeEnabled && this.project.controller.pressingKeySet.has("shift")) {
      console.log(event);
      const delta = isMac ? (event.deltaX > 0 ? -10 : 10) : event.deltaY > 0 ? -10 : 10;
      const newRadius = Math.max(10, Math.min(500, Settings.stealthModeScopeRadius + delta));
      Settings.stealthModeScopeRadius = newRadius;
      this.project.effects.addEffect(MouseTipFeedbackEffect.default(delta > 0 ? "expand" : "shrink"));
      return true;
    }
    return false;
  }

  /**
   * 处理鼠标双击事件
   * @param event - 鼠标事件
   */
  public mouseDoubleClick: (event: MouseEvent) => void = (event: MouseEvent) => {
    if (event.button === 1 && !this.project.controller.isCameraLocked) {
      if (event.ctrlKey) {
        return;
      }

      // 中键双击
      const pressLocation = this.project.renderer.transformView2World(new Vector(event.clientX, event.clientY));
      const clickedEntity = this.project.stageManager.findEntityByLocation(pressLocation);
      if (clickedEntity !== null) {
        // 实体上双击中键：打开 URL / 文件（独立开关）
        if (Settings.doubleClickMiddleMouseButtonOnEntity === "openUrl") {
          openBrowserOrFileByEntity(clickedEntity, this.project);
        }
      } else {
        // 空白处双击中键：重置视野（原设置项控制）
        if (Settings.doubleClickMiddleMouseButton !== "none") {
          this.project.camera.resetBySelected();
        }
      }
    }
  };
}
