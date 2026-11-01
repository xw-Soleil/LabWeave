/**
 * 科研模式下的滚轮处理:判断滚轮事件来自鼠标还是触控板,并把滚动量换算成像素。
 *
 * 原版按「deltaY 是不是整数」逐个事件猜设备。macOS 会给鼠标滚轮加速,快慢滚出来的数值不一样,
 * 同一个鼠标慢滚被当成触控板(平移)、快滚被当成滚轮(缩放),一次滚动中途还会来回切。
 * 这里只认确定的证据,拿不准时沿用这次滚动开头的判断。思路参考 Analog Canvas
 * (cascode-ai/analog-canvas 的 canvas-gesture-controller.ts),代码是重写的。
 */

export type WheelSource = "mouse" | "trackpad";

/** 滚轮怎么用:总是移动 / 总是缩放 / 鼠标缩放、触控板移动 */
export type ResearchWheelBehavior = "pan" | "zoom" | "auto";

export interface WheelSignal {
  deltaMode: number;
  deltaX: number;
  deltaY: number;
  /** 非标准字段,WebKit 和 Chromium 有,Firefox 没有 */
  wheelDeltaY?: number;
  timeStamp: number;
}

const DOM_DELTA_PIXEL = 0;
const DOM_DELTA_LINE = 1;
/** 按行报告的滚动,一行按多少像素算(和浏览器的默认值一致) */
const LINE_HEIGHT_PX = 16;

/**
 * 只看能确定设备的证据,确定不了返回 null:
 * - 按「行 / 页」报告的一定是鼠标滚轮;
 * - WebKit / Chromium 里,触控板的 wheelDeltaY 永远正好是 deltaY 的 3 倍;
 *   鼠标滚一格是 120 的整数倍,系统怎么加速都不会变;
 * - 同时有横向和纵向分量,或者 deltaY 带小数(惯性滑动)的,是触控板。
 * 不按数值大小判断:高精度滚轮或者慢慢转的滚轮,数值和触控板一样小。
 */
export function wheelSourceEvidence(event: WheelSignal): WheelSource | null {
  if (event.deltaMode !== DOM_DELTA_PIXEL) return "mouse";
  const raw = event.wheelDeltaY;
  if (typeof raw === "number" && raw !== 0) {
    if (Math.abs(raw) === 3 * Math.abs(event.deltaY)) return "trackpad";
    if (raw % 120 === 0) return "mouse";
  }
  if (event.deltaX !== 0 && event.deltaY !== 0) return "trackpad";
  if (!Number.isInteger(event.deltaY)) return "trackpad";
  return null;
}

/** 两个事件间隔超过这么久,算新的一次滚动 */
const GESTURE_GAP_MS = 250;
/** 手指离开触控板后,惯性滑动的事件可能还会持续这么久 */
const TRACKPAD_MOMENTUM_MS = 1500;

/**
 * 记住最近的判断。没有证据的事件:
 * 同一次滚动里沿用开头的判断;新的一次滚动,如果刚见过触控板,当作惯性尾巴(触控板),否则当作鼠标滚轮。
 */
export class WheelSourceTracker {
  private gestureSource: WheelSource | null = null;
  private lastEventAt = Number.NEGATIVE_INFINITY;
  private lastTrackpadAt = Number.NEGATIVE_INFINITY;

  resolve(event: WheelSignal): WheelSource {
    const now = event.timeStamp;
    const evidence = wheelSourceEvidence(event);
    const sameGesture = now - this.lastEventAt <= GESTURE_GAP_MS;
    let source: WheelSource;
    if (evidence) {
      source = evidence;
    } else if (sameGesture && this.gestureSource) {
      source = this.gestureSource;
    } else {
      source = now - this.lastTrackpadAt <= TRACKPAD_MOMENTUM_MS ? "trackpad" : "mouse";
    }
    this.gestureSource = source;
    this.lastEventAt = now;
    this.lastTrackpadAt = source === "trackpad" ? now : this.lastTrackpadAt;
    return source;
  }
}

/** 把滚动量换算成像素:按行的乘 16,按页的乘可视区域高度 */
export function wheelDeltaInPixels(event: WheelSignal, pageHeight: number): { x: number; y: number } {
  const unit =
    event.deltaMode === DOM_DELTA_PIXEL ? 1 : event.deltaMode === DOM_DELTA_LINE ? LINE_HEIGHT_PX : pageHeight;
  return { x: event.deltaX * unit, y: event.deltaY * unit };
}

/** 双指捏合、Ctrl / Cmd + 滚轮:每像素对应的缩放速度 */
const MODIFIER_ZOOM_RATE = 0.01;
/** 「总是缩放」或「自动」判成鼠标时,滚轮每像素对应的缩放速度 */
const WHEEL_ZOOM_RATE = 0.002;
/** 单个事件最多缩放到 2 倍或 1/2,防止某些鼠标一格报很大的数值时一下跳太多 */
const MAX_STEP_FACTOR = 2;

/** 向下滚(deltaY > 0)缩小,向上滚放大,倍数随滚动量连续变化 */
export function wheelZoomFactor(deltaYPixels: number, byModifier: boolean): number {
  const rate = byModifier ? MODIFIER_ZOOM_RATE : WHEEL_ZOOM_RATE;
  const factor = Math.exp(-deltaYPixels * rate);
  return Math.min(MAX_STEP_FACTOR, Math.max(1 / MAX_STEP_FACTOR, factor));
}

export type WheelAction = { kind: "pan"; dx: number; dy: number } | { kind: "zoom"; factor: number } | { kind: "none" };

/**
 * 决定这个滚轮事件做什么。
 * @param pinchOrModifier 双指捏合(系统按 Ctrl+滚轮 发来)或者按着 Ctrl / Cmd
 * @param shift 按着 Shift:竖向滚动改成横向移动
 */
export function decideWheelAction(
  behavior: ResearchWheelBehavior,
  source: WheelSource,
  pixels: { x: number; y: number },
  pinchOrModifier: boolean,
  shift: boolean,
): WheelAction {
  if (pinchOrModifier) {
    return pixels.y === 0 ? { kind: "none" } : { kind: "zoom", factor: wheelZoomFactor(pixels.y, true) };
  }
  const pan = behavior === "pan" || (behavior === "auto" && source === "trackpad");
  if (pan) {
    const dx = shift && pixels.x === 0 ? pixels.y : pixels.x;
    const dy = shift && pixels.x === 0 ? 0 : pixels.y;
    return dx === 0 && dy === 0 ? { kind: "none" } : { kind: "pan", dx, dy };
  }
  return pixels.y === 0 ? { kind: "none" } : { kind: "zoom", factor: wheelZoomFactor(pixels.y, false) };
}
