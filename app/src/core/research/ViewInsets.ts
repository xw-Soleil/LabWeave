import type { Project } from "@/core/Project";

/** 画布左右两边被浮动面板挡住的宽度，单位是画布的视图像素 */
export interface ViewInsets {
  left: number;
  right: number;
}

export const NO_VIEW_INSETS: ViewInsets = Object.freeze({ left: 0, right: 0 });

let provider: ((project: Project) => ViewInsets) | null = null;

/**
 * 由界面层登记：按面板在屏幕上的位置算出挡住了多少。
 * Camera 只依赖这个小模块，不去引用界面和全局状态，免得循环引用。
 */
export function setViewInsetsProvider(next: ((project: Project) => ViewInsets) | null) {
  provider = next;
}

export function getViewInsets(project: Project): ViewInsets {
  return provider?.(project) ?? NO_VIEW_INSETS;
}
