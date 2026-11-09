/**
 * 白板点阵背景的间距：分粗细两层，细的一层间距是粗的一半。
 * 缩放时细的一层按屏幕上的间距慢慢淡入淡出，粗的一层一直显示，
 * 所以不会像原版那样到某个缩放比例一下子变疏或变密。
 */

/** 世界坐标里最小的点间距 */
export const DOT_GRID_BASE_GAP = 24;
/** 细的一层在屏幕上间距到这么多像素时完全看不见，到两倍时完全显示；粗的一层因此总在 48～96 像素之间 */
export const DOT_GRID_MIN_SPACING = 24;

export interface DotGridLevels {
  /** 细的一层的世界坐标间距；粗的一层是它的两倍 */
  fineGap: number;
  /** 细的一层的不透明度，0～1 */
  fineAlpha: number;
}

/** 缩放比例无效时（还没算好视野）返回 null，不画 */
export function dotGridLevels(scale: number): DotGridLevels | null {
  if (!Number.isFinite(scale) || scale <= 0) return null;
  let fineGap = DOT_GRID_BASE_GAP;
  while (fineGap * scale < DOT_GRID_MIN_SPACING) fineGap *= 2;
  const t = Math.min(1, (fineGap * scale - DOT_GRID_MIN_SPACING) / DOT_GRID_MIN_SPACING);
  // smoothstep：两头慢、中间快，淡入淡出不显得突兀
  return { fineGap, fineAlpha: t * t * (3 - 2 * t) };
}

/** 落在 [from, to] 里的网格序号范围 */
export function gridIndexRange(from: number, to: number, gap: number): [number, number] {
  return [Math.ceil(from / gap), Math.floor(to / gap)];
}

/** 序号都是偶数的点也在粗的一层上 */
export function isCoarseDot(i: number, j: number): boolean {
  return i % 2 === 0 && j % 2 === 0;
}
