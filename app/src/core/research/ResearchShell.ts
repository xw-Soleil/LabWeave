// 这个模块不能 import Settings / FeatureFlags 等服务：它会被 ProjectToolSettingsSchema（命令行也会加载）引用，引入服务会造成循环依赖。

/**
 * 是否处于「科研工作台」模式。
 * 只有显式设置 LR_RESEARCH_SHELL=false 才会关闭；命令行和 vitest 没有 LR_ 前缀的环境变量，按默认开启处理。
 * 写成函数而不是常量，测试里可以用 vi.stubEnv 切换。
 * 命令行用 tsx 直接加载源码时 import.meta.env 是 undefined，所以要用可选链。
 */
export function isResearchShell(): boolean {
  return import.meta.env?.LR_RESEARCH_SHELL !== "false";
}

export const WORKBENCH_DIR = ".workbench";
export const SIDECAR_JSON_SUFFIX = ".ai.json";
export const SIDECAR_MD_SUFFIX = ".ai.md";

export type FileKind = "pdf" | "image" | "markdown";

export const FILE_KIND_EXTENSIONS: Record<FileKind, string[]> = {
  pdf: ["pdf"],
  image: ["png", "jpg", "jpeg", "webp", "gif"],
  markdown: ["md", "markdown"],
};

export function fileKindOf(path: string): FileKind | null {
  const name = path.split(/[\\/]/).pop() ?? "";
  const dotIndex = name.lastIndexOf(".");
  if (dotIndex <= 0) return null;
  const extension = name.slice(dotIndex + 1).toLowerCase();
  for (const kind of Object.keys(FILE_KIND_EXTENSIONS) as FileKind[]) {
    if (FILE_KIND_EXTENSIONS[kind].includes(extension)) return kind;
  }
  return null;
}

export const RESEARCH_EVENTS = {
  toggleFiles: "research:toggle-files",
  toggleAI: "research:toggle-ai",
  focusWorkspace: "research:focus-workspace",
  newWorkspace: "research:new-workspace",
  chooseFolder: "research:choose-folder",
} as const;

export type ResearchEventName = keyof typeof RESEARCH_EVENTS;

export function emitResearchEvent(name: ResearchEventName, detail?: unknown): void {
  window.dispatchEvent(new CustomEvent(RESEARCH_EVENTS[name], { detail }));
}

export function onResearchEvent(name: ResearchEventName, handler: (detail: unknown) => void): () => void {
  const listener = (event: Event) => handler((event as CustomEvent).detail);
  window.addEventListener(RESEARCH_EVENTS[name], listener);
  return () => window.removeEventListener(RESEARCH_EVENTS[name], listener);
}
