/**
 * 滚轮处理:判断滚轮事件来自鼠标还是触控板,把滚动量换算成像素或格数,决定移动还是缩放。
 * 触控板按像素立刻移动;鼠标按格数走固定的距离,再分几帧平滑走完(WheelSmoother)。
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
  wheelDeltaX?: number;
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
 * - WebKit / Chromium 里,触控板的 wheelDeltaY(横向是 wheelDeltaX)永远正好是 deltaY 的 3 倍;
 *   鼠标滚一格是 120 的整数倍,系统怎么加速都不会变;
 * - 同时有横向和纵向分量,或者 deltaY 带小数(惯性滑动)的,是触控板。
 * 不按数值大小判断:高精度滚轮或者慢慢转的滚轮,数值和触控板一样小。
 */
export function wheelSourceEvidence(event: WheelSignal): WheelSource | null {
  if (event.deltaMode !== DOM_DELTA_PIXEL) return "mouse";
  // 先看竖向;只有横向分量时(比如按着 Shift 拨鼠标滚轮,系统会改成横向)看横向
  const axes = [
    [event.wheelDeltaY, event.deltaY],
    [event.wheelDeltaX, event.deltaX],
  ] as const;
  for (const [raw, delta] of axes) {
    if (typeof raw !== "number" || raw === 0) continue;
    if (Math.abs(raw) === 3 * Math.abs(delta)) return "trackpad";
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

/** 浏览器拨一格大多按 3 行或 100 像素报告(没有 wheelDelta 时用来折算格数) */
const LINES_PER_NOTCH = 3;
const PIXELS_PER_NOTCH = 100;

/**
 * 鼠标滚轮拨了几格,带方向(往下、往右为正)。
 * 有 wheelDelta 时按它算:它总是 120 的整数倍,系统加速只会让快拨时一个事件里的格数变多。
 * deltaY 经过 macOS 加速,慢拨一格只有几个像素、快拨一格能上百,不能直接当距离用。
 * 没有 wheelDelta(Firefox)时按「3 行或 100 像素一格」折算。
 */
export function wheelNotches(event: WheelSignal, pixels: { x: number; y: number }): { x: number; y: number } {
  const axis = (raw: number | undefined, px: number) => {
    if (px === 0) return 0;
    if (typeof raw === "number" && raw !== 0 && raw % 120 === 0) return (Math.sign(px) * Math.abs(raw)) / 120;
    if (event.deltaMode === DOM_DELTA_LINE) return px / LINE_HEIGHT_PX / LINES_PER_NOTCH;
    return px / PIXELS_PER_NOTCH;
  };
  return { x: axis(event.wheelDeltaX, pixels.x), y: axis(event.wheelDeltaY, pixels.y) };
}

/** 双指捏合、Ctrl / Cmd + 滚轮:每像素对应的缩放速度 */
const MODIFIER_ZOOM_RATE = 0.01;
/** 「总是缩放」时触控板滑动每像素对应的缩放速度 */
const WHEEL_ZOOM_RATE = 0.002;
/** 单个事件最多缩放到 2 倍或 1/2,防止某些设备一下报很大的数值时跳太多 */
const MAX_STEP_FACTOR = 2;

function clampStepFactor(factor: number): number {
  return Math.min(MAX_STEP_FACTOR, Math.max(1 / MAX_STEP_FACTOR, factor));
}

/** 触控板:向下滚(deltaY > 0)缩小,向上滚放大,倍数随滚动量连续变化 */
export function wheelZoomFactor(deltaYPixels: number, byModifier: boolean): number {
  const rate = byModifier ? MODIFIER_ZOOM_RATE : WHEEL_ZOOM_RATE;
  return clampStepFactor(Math.exp(-deltaYPixels * rate));
}

/** 鼠标滚轮:每格放大或缩小 stepPercent%,往下拨缩小 */
export function mouseZoomFactor(notchesY: number, stepPercent: number): number {
  return clampStepFactor((1 + stepPercent / 100) ** -notchesY);
}

/** 鼠标滚轮每格走多远:来自设置 researchMouseWheelPanStep / researchMouseWheelZoomStep */
export interface MouseWheelSteps {
  /** 每格移动多少屏幕像素 */
  panPx: number;
  /** 每格缩放百分之几 */
  zoomPercent: number;
}

/** smooth:鼠标滚轮的结果分几帧走完(见 WheelSmoother);触控板本来就是一串小事件,立刻生效 */
export type WheelAction =
  | { kind: "pan"; dx: number; dy: number; smooth: boolean }
  | { kind: "zoom"; factor: number; smooth: boolean }
  | { kind: "none" };

/**
 * 决定这个滚轮事件做什么。
 * - pinchOrModifier:双指捏合(系统按 Ctrl+滚轮 发来)或者按着 Ctrl / Cmd
 * - shift:按着 Shift,竖向滚动改成横向移动
 * - notches:wheelNotches 算出的格数,鼠标按格数走,触控板按像素走
 */
export function decideWheelAction(input: {
  behavior: ResearchWheelBehavior;
  source: WheelSource;
  pixels: { x: number; y: number };
  notches: { x: number; y: number };
  pinchOrModifier: boolean;
  shift: boolean;
  mouse: MouseWheelSteps;
}): WheelAction {
  const { behavior, source, pixels, notches, pinchOrModifier, shift, mouse } = input;
  const byMouse = source === "mouse";
  const zoom = pinchOrModifier || behavior === "zoom" || (behavior === "auto" && byMouse);
  if (zoom) {
    if (byMouse) {
      return notches.y === 0
        ? { kind: "none" }
        : { kind: "zoom", factor: mouseZoomFactor(notches.y, mouse.zoomPercent), smooth: true };
    }
    return pixels.y === 0
      ? { kind: "none" }
      : { kind: "zoom", factor: wheelZoomFactor(pixels.y, pinchOrModifier), smooth: false };
  }
  const amount = byMouse ? { x: notches.x * mouse.panPx, y: notches.y * mouse.panPx } : pixels;
  const sideways = shift && amount.x === 0;
  const dx = sideways ? amount.y : amount.x;
  const dy = sideways ? 0 : amount.y;
  return dx === 0 && dy === 0 ? { kind: "none" } : { kind: "pan", dx, dy, smooth: byMouse };
}

/** 平滑过渡的时间常数:一格大约 0.15 秒走完 95% */
const SMOOTH_TIME_CONSTANT_MS = 50;
/** 两帧间隔按这个范围算:卡了一下也不会一步跳完;同一时刻连着调用也能往前走 */
const MIN_FRAME_MS = 4;
const MAX_FRAME_MS = 50;
/** 剩下不到半个像素、缩放差不到万分之五时一次走完 */
const PAN_DONE_PX = 0.5;
const ZOOM_DONE_LOG = 0.0005;

export interface WheelSmoothStep {
  /** 这一帧移动多少屏幕像素 */
  dx: number;
  dy: number;
  /** 这一帧缩放多少倍(1 表示不缩放) */
  factor: number;
  /** 以哪个视野坐标为中心缩放 */
  anchor: { x: number; y: number } | null;
}

/**
 * 鼠标滚轮的平滑过渡:每一格的移动、缩放分到接下来几帧里,先快后慢地走完。
 * 连续拨时,新的一格加到还没走完的路程上,不会像原版 bombMove 那样每来一格就从头开始。
 * 时间由调用方传进来(视野每帧调一次 step),方便测试。
 */
export class WheelSmoother {
  private panX = 0;
  private panY = 0;
  /** 还没走完的缩放,存倍数的对数,几格叠加就是相加 */
  private zoomLog = 0;
  private anchor: { x: number; y: number } | null = null;
  private lastStepAt = 0;

  get active(): boolean {
    return this.panX !== 0 || this.panY !== 0 || this.zoomLog !== 0;
  }

  addPan(dx: number, dy: number, now: number) {
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
    this.wake(now);
    this.panX += dx;
    this.panY += dy;
  }

  addZoom(factor: number, anchor: { x: number; y: number }, now: number) {
    if (!Number.isFinite(factor) || factor <= 0) return;
    this.wake(now);
    this.zoomLog += Math.log(factor);
    this.anchor = anchor;
  }

  cancel() {
    this.panX = 0;
    this.panY = 0;
    this.zoomLog = 0;
    this.anchor = null;
  }

  /** 走一帧,返回这一帧该移动和缩放多少;没有要走的返回 null */
  step(now: number): WheelSmoothStep | null {
    if (!this.active) return null;
    const dt = Math.min(MAX_FRAME_MS, Math.max(MIN_FRAME_MS, now - this.lastStepAt));
    this.lastStepAt = now;
    const share = 1 - Math.exp(-dt / SMOOTH_TIME_CONSTANT_MS);
    const panDone = Math.max(Math.abs(this.panX), Math.abs(this.panY)) * (1 - share) < PAN_DONE_PX;
    const zoomDone = Math.abs(this.zoomLog) * (1 - share) < ZOOM_DONE_LOG;
    const dx = panDone ? this.panX : this.panX * share;
    const dy = panDone ? this.panY : this.panY * share;
    const zoom = zoomDone ? this.zoomLog : this.zoomLog * share;
    this.panX -= dx;
    this.panY -= dy;
    this.zoomLog -= zoom;
    const anchor = this.anchor;
    if (this.zoomLog === 0) this.anchor = null;
    return { dx, dy, factor: Math.exp(zoom), anchor };
  }

  /** 停着的时候来了新的一格,从这一刻开始算时间 */
  private wake(now: number) {
    if (!this.active) this.lastStepAt = now;
  }
}
