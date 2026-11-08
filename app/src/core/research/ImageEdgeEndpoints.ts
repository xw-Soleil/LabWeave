import type { Project } from "@/core/Project";
import { Settings } from "@/core/service/Settings";
import type { ConnectableEntity } from "@/core/stage/stageObject/abstract/ConnectableEntity";
import { LineEdge } from "@/core/stage/stageObject/association/LineEdge";
import { FileCardNode } from "@/core/stage/stageObject/entity/FileCardNode";
import { ImageNode } from "@/core/stage/stageObject/entity/ImageNode";
import { Color, Vector } from "@graphif/data-structures";
import { Line, Rectangle } from "@graphif/shapes";

/**
 * 连线默认停在卡片边框上。端点连着图片（粘进来的图、图片卡片）时，选中连线后可以把端点拖到图里任意一处，
 * 让箭头指着图里的某个位置；拖回默认位置附近就吸回去。端点只能在它连着的那张图里和边框上移动。
 */

export type EdgeEnd = "source" | "target";

/** 以下都是屏幕像素，换成世界坐标要除以镜头缩放 */
export const ENDPOINT_HANDLE_RADIUS = 5;
const HANDLE_HIT_RADIUS = 9;
const SNAP_TO_DEFAULT = 14;
const SNAP_TO_BORDER = 8;

const CENTER_RATE = Vector.same(0.5);

export function canAimInside(entity: ConnectableEntity): boolean {
  if (entity instanceof ImageNode) return !entity.isBackground;
  return entity instanceof FileCardNode && entity.fileKind === "image";
}

function entityOf(edge: LineEdge, end: EdgeEnd): ConnectableEntity {
  return end === "source" ? edge.source : edge.target;
}

export function rateOf(edge: LineEdge, end: EdgeEnd): Vector {
  return end === "source" ? edge.sourceRectangleRate : edge.targetRectangleRate;
}

function setRate(edge: LineEdge, end: EdgeEnd, rate: Vector) {
  if (end === "source") edge.sourceRectangleRate = rate;
  else edge.targetRectangleRate = rate;
}

/** 选中这条线时，这一头画能拖的端点圆点（只读模式下不画） */
export function hasEndpointHandle(edge: LineEdge, end: EdgeEnd): boolean {
  if (Settings.viewerMode) return false;
  const entity = entityOf(edge, end);
  // 自己连自己的线画成一个圈，没有两个端点
  return edge.source !== edge.target && !entity.isHiddenBySectionCollapse && canAimInside(entity);
}

export function endpointLocation(edge: LineEdge, end: EdgeEnd): Vector {
  return end === "source" ? edge.bodyLine.start : edge.bodyLine.end;
}

/** 端点的默认位置：从这头卡片的中心朝另一头瞄准的点画线，和边框的交点 */
export function defaultEndpointLocation(edge: LineEdge, end: EdgeEnd): Vector {
  const rect = entityOf(edge, end).collisionBox.getRectangle();
  const otherAim = end === "source" ? edge.targetLocation : edge.sourceLocation;
  return rect.getLineIntersectionPoint(new Line(rect.center, otherAim));
}

/**
 * 端点拖到 point 时该存的比例：离默认位置近就回到默认（中心比例，画的时候自动停在边框上）；
 * 否则夹进图片里，离边框近就贴到边框上。
 */
export function rateForDrag(rect: Rectangle, defaultLocation: Vector, point: Vector, scale: number): Vector {
  if (point.distance(defaultLocation) <= SNAP_TO_DEFAULT / scale) return CENTER_RATE.clone();
  let x = Math.min(Math.max(point.x, rect.left), rect.right);
  let y = Math.min(Math.max(point.y, rect.top), rect.bottom);
  const snap = SNAP_TO_BORDER / scale;
  const toBorder = [
    { distance: x - rect.left, apply: () => (x = rect.left) },
    { distance: rect.right - x, apply: () => (x = rect.right) },
    { distance: y - rect.top, apply: () => (y = rect.top) },
    { distance: rect.bottom - y, apply: () => (y = rect.bottom) },
  ];
  const nearest = toBorder.reduce((a, b) => (b.distance < a.distance ? b : a));
  if (nearest.distance <= snap) nearest.apply();
  const rate = new Vector((x - rect.left) / rect.size.x, (y - rect.top) / rect.size.y);
  // 正好落在中心会被当成「默认」，往旁边挪一点点
  return rate.equals(CENTER_RATE) ? new Vector(0.5, 0.5001) : rate;
}

export interface EndpointHandle {
  edge: LineEdge;
  end: EdgeEnd;
}

export function findEndpointHandle(project: Project, worldLocation: Vector): EndpointHandle | null {
  const hitRadius = HANDLE_HIT_RADIUS / project.camera.currentScale;
  for (const association of project.stageManager.getSelectedAssociations()) {
    if (!(association instanceof LineEdge)) continue;
    for (const end of ["target", "source"] as const) {
      if (!hasEndpointHandle(association, end)) continue;
      if (endpointLocation(association, end).distance(worldLocation) <= hitRadius) return { edge: association, end };
    }
  }
  return null;
}

export function dragEndpointTo(project: Project, handle: EndpointHandle, worldLocation: Vector) {
  const { edge, end } = handle;
  const rect = entityOf(edge, end).collisionBox.getRectangle();
  setRate(edge, end, rateForDrag(rect, defaultEndpointLocation(edge, end), worldLocation, project.camera.currentScale));
}

/** 端点在图里面（不在边框上） */
export function pointsInside(edge: LineEdge, end: EdgeEnd): boolean {
  const rect = entityOf(edge, end).collisionBox.getRectangle();
  const point = endpointLocation(edge, end);
  const margin = 0.5;
  return (
    point.x > rect.left + margin &&
    point.x < rect.right - margin &&
    point.y > rect.top + margin &&
    point.y < rect.bottom - margin
  );
}

export function renderEndpointHandle(project: Project, edge: LineEdge, end: EdgeEnd) {
  const style = project.stageStyleManager.currentStyle;
  const inside = pointsInside(edge, end);
  project.shapeRenderer.renderCircle(
    project.renderer.transformWorld2View(endpointLocation(edge, end)),
    ENDPOINT_HANDLE_RADIUS,
    // 指着图里某一处时填满，画在图上也看得清；停在边框上时是空心的
    inside ? style.CollideBoxSelected : style.Background,
    inside ? Color.White : style.CollideBoxSelected,
    1.5,
  );
}
