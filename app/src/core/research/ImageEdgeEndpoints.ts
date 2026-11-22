import type { Project } from "@/core/Project";
import { Settings } from "@/core/service/Settings";
import type { ConnectableEntity } from "@/core/stage/stageObject/abstract/ConnectableEntity";
import { LineEdge } from "@/core/stage/stageObject/association/LineEdge";
import { ConnectPoint } from "@/core/stage/stageObject/entity/ConnectPoint";
import { FileCardNode } from "@/core/stage/stageObject/entity/FileCardNode";
import { ImageNode } from "@/core/stage/stageObject/entity/ImageNode";
import { Color, Vector } from "@graphif/data-structures";
import { Line, Rectangle } from "@graphif/shapes";

/**
 * 选中连线后两头各出一个可拖动的端点把手：
 * - 连着图片（粘进来的图、图片卡片）的那一头，可以把端点拖进图里任意一处或边框上；离默认位置近就吸回去。
 * - 连着其他框（文字框、文件卡片、分组框等）的那一头，拖动时沿着框的四条边走，靠近四条边中点时自动吸附；
 *   拖回框中间或双击把手，就回到自动位置。
 */

export type EdgeEnd = "source" | "target";

/** 以下都是屏幕像素，换成世界坐标要除以镜头缩放 */
export const ENDPOINT_HANDLE_RADIUS = 5;
const HANDLE_HIT_RADIUS = 9;
const SNAP_TO_DEFAULT = 14;
const SNAP_TO_BORDER = 8;
const SNAP_TO_MIDPOINT = 12;
const CENTER_RESET_RATIO = 0.25;

const CENTER_RATE = Vector.same(0.5);

export function canAimInside(entity: ConnectableEntity): boolean {
  if (entity instanceof ImageNode) return !entity.isBackground;
  return entity instanceof FileCardNode && entity.fileKind === "image";
}

export function canDragEndpoint(entity: ConnectableEntity): boolean {
  if (entity instanceof ConnectPoint) return false;
  if (entity instanceof ImageNode) return !entity.isBackground;
  return true;
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

function isVerticalPolyEdge(edge: LineEdge): boolean {
  return edge.pathStyle === "vertical" || (edge.pathStyle === "inherit" && Settings.lineStyle === "vertical");
}

/** 选中这条线时，这一头画能拖的端点圆点（只读模式、自环、多边散开、直角折线、折叠隐藏、连接点不画） */
export function hasEndpointHandle(edge: LineEdge, end: EdgeEnd): boolean {
  if (Settings.viewerMode) return false;
  if (edge.source === edge.target || edge.source.uuid === edge.target.uuid) return false;
  if (edge.shiftingIndex !== 0 || isVerticalPolyEdge(edge)) return false;
  if (edge.source.isHiddenBySectionCollapse || edge.target.isHiddenBySectionCollapse) return false;
  return canDragEndpoint(entityOf(edge, end));
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
 * 图片端点拖到 point 时该存的比例：离默认位置近就回到默认（中心比例，画的时候自动停在边框上）；
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

/**
 * 普通框端点拖到 point 时该存的比例：
 * - 拖进框中间区域就回到自动位置（中心比例）；
 * - 其余位置投影到最近的框边上，靠近四条边中点时吸附过去。
 */
export function rateForBorderDrag(rect: Rectangle, point: Vector, scale: number): Vector {
  if (rect.size.x <= 0 || rect.size.y <= 0) return CENTER_RATE.clone();
  if (
    Math.abs(point.x - rect.center.x) <= rect.size.x * CENTER_RESET_RATIO &&
    Math.abs(point.y - rect.center.y) <= rect.size.y * CENTER_RESET_RATIO
  ) {
    return CENTER_RATE.clone();
  }

  const clampedX = Math.min(Math.max(point.x, rect.left), rect.right);
  const clampedY = Math.min(Math.max(point.y, rect.top), rect.bottom);
  const candidates = [
    new Vector(clampedX, rect.top),
    new Vector(clampedX, rect.bottom),
    new Vector(rect.left, clampedY),
    new Vector(rect.right, clampedY),
  ];
  let projected = candidates[0];
  let bestDistance = projected.distance(point);
  for (let i = 1; i < candidates.length; i++) {
    const dist = candidates[i].distance(point);
    if (dist < bestDistance) {
      bestDistance = dist;
      projected = candidates[i];
    }
  }

  const midpoints = [
    { point: rect.topCenter, rate: new Vector(0.5, 0) },
    { point: rect.bottomCenter, rate: new Vector(0.5, 1) },
    { point: rect.leftCenter, rate: new Vector(0, 0.5) },
    { point: rect.rightCenter, rate: new Vector(1, 0.5) },
  ];
  const snapRadius = SNAP_TO_MIDPOINT / scale;
  let nearestMid = midpoints[0];
  let nearestMidDist = projected.distance(nearestMid.point);
  for (let i = 1; i < midpoints.length; i++) {
    const dist = projected.distance(midpoints[i].point);
    if (dist < nearestMidDist) {
      nearestMidDist = dist;
      nearestMid = midpoints[i];
    }
  }
  if (nearestMidDist <= snapRadius) {
    return nearestMid.rate;
  }

  return new Vector((projected.x - rect.left) / rect.size.x, (projected.y - rect.top) / rect.size.y);
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
  const entity = entityOf(edge, end);
  const rect = entity.collisionBox.getRectangle();
  const rate = canAimInside(entity)
    ? rateForDrag(rect, defaultEndpointLocation(edge, end), worldLocation, project.camera.currentScale)
    : rateForBorderDrag(rect, worldLocation, project.camera.currentScale);
  setRate(edge, end, rate);
}

export function resetEndpoint(handle: EndpointHandle): boolean {
  const current = rateOf(handle.edge, handle.end);
  if (current.equals(CENTER_RATE)) return false;
  setRate(handle.edge, handle.end, CENTER_RATE.clone());
  return true;
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
  const filled = pointsInside(edge, end) || !rateOf(edge, end).equals(CENTER_RATE);
  project.shapeRenderer.renderCircle(
    project.renderer.transformWorld2View(endpointLocation(edge, end)),
    ENDPOINT_HANDLE_RADIUS,
    // 手动定过位置或指着图里某一处时填满，一眼看出不是自动位置；自动停在边框上时是空心的
    filled ? style.CollideBoxSelected : style.Background,
    filled ? Color.White : style.CollideBoxSelected,
    1.5,
  );
}
