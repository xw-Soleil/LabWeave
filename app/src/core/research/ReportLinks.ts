import type { Project } from "@/core/Project";
import { Settings } from "@/core/service/Settings";
import { exists } from "@tauri-apps/plugin-fs";
import i18next from "i18next";
import { toast } from "sonner";
import { URI } from "vscode-uri";
import { ResearchFolder } from "./ResearchFolder";
import { fileKindOf } from "./ResearchShell";

/*
 * 点报告里的链接跳回原处。链接是 ReportTools.ts 的 recordLink 写出来的：
 *
 *   白板上的卡片    rwb://open?project=项目名&path=白板.prg&target=卡片编号
 *   PDF 的批注      rwb://open?project=项目名&path=论文/main.pdf&page=3&annotation=批注编号
 *   文献库里的 PDF   rwb://open?library=1&path=作者2024标题/paper.pdf&page=3&annotation=批注编号
 *   笔记            rwb://open?project=项目名&path=笔记/想法.md
 *
 * 路径相对项目文件夹（或文献库），换一台电脑也能用。只带 path 的白板链接是老写法，
 * 还归 DeepLinkHandler 管。
 */

export interface ReportLink {
  /** 项目文件夹的名字 */
  project?: string;
  library: boolean;
  path: string;
  /** 白板上的卡片编号 */
  target?: string;
  page?: number;
  annotation?: string;
}

const isAbsolute = (path: string) => /^(?:[\\/]|[a-zA-Z]:)/.test(path);
const folderName = (path: string) => path.replace(/\\/g, "/").split("/").filter(Boolean).at(-1) ?? "";
const sameName = (a: string, b: string) => a.normalize("NFC").toLowerCase() === b.normalize("NFC").toLowerCase();

/** 是这里管的链接就拆开；不是（别的网址、老写法的白板链接）给 undefined */
export function parseReportLink(url: string): ReportLink | undefined {
  if (!/^rwb:/i.test(url)) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(url.replace(/^rwb:(?!\/\/)/i, "rwb://"));
  } catch {
    // 不成样子的链接：当作不认识
    return undefined;
  }
  const params = parsed.searchParams;
  const path = params.get("path")?.trim();
  if (!path) return undefined;
  const project = params.get("project") ?? undefined;
  const library = params.get("library") === "1";
  const kind = fileKindOf(path);
  // 老写法只有白板、只带 path；笔记和 PDF 老写法打不开，也归这里
  if (!project && !library && kind !== "markdown" && kind !== "pdf") return undefined;
  const page = Number(params.get("page"));
  return {
    ...(project && { project }),
    library,
    path,
    ...(params.get("target") && { target: params.get("target")! }),
    ...(Number.isInteger(page) && page > 0 && { page }),
    ...(params.get("annotation") && { annotation: params.get("annotation")! }),
  };
}

/** 链接指的文件在这台电脑上的完整路径。找不到时抛错误代码（reportLink.xxx） */
export async function resolveReportLink(link: ReportLink): Promise<string> {
  const root = ResearchFolder.getRoot();
  const library = Settings.literatureLibraryPath;
  const { activeResearchWorkspace, loadResearchWorkspace } = await import("./ResearchWorkspace");
  const projects = activeResearchWorkspace(await loadResearchWorkspace()).projects.map((project) => project.path);
  if (root && !projects.includes(root)) projects.unshift(root);
  let path: string;
  if (isAbsolute(link.path)) {
    // 项目外的文件记的是完整路径。链接可能是别的程序递进来的，只认项目、文献库里面的；
    // 再加上项目旁边的「我的进展」——第一版的阶段小结存在那里，旧记录里的链接还要点得开
    path = ResearchFolder.toAbsolute(link.path);
    const legacy = projects.map((project) => `${project.replace(/[\\/]+$/, "").replace(/[\\/][^\\/]*$/, "")}/我的进展`);
    if (![...projects, library, ...legacy].some((base) => base && ResearchFolder.isInside(path, base))) {
      throw new Error("reportLink.outside");
    }
  } else {
    let base: string | undefined;
    if (link.library) base = library || undefined;
    else if (!link.project) base = root || undefined;
    // 同名的项目里优先当前这个
    else
      base =
        root && sameName(folderName(root), link.project)
          ? root
          : projects.find((candidate) => sameName(folderName(candidate), link.project!));
    if (!base) throw new Error(link.library ? "reportLink.noLibrary" : "reportLink.noProject");
    path = ResearchFolder.toAbsolute(link.path, base);
    // 路径里带 ../ 的不能跑到外面去
    if (!ResearchFolder.isInside(path, base)) throw new Error("reportLink.outside");
  }
  if (!(await exists(path))) throw new Error("reportLink.missing");
  return path;
}

const laidOut = (project: Project) => project.renderer.w > 0 && project.renderer.h > 0;

async function focusCard(project: Project, target: string) {
  const entity = project.stageManager.getEntities().find((candidate) => candidate.uuid === target);
  if (!entity) {
    toast.warning(i18next.t("reportLink.cardGone", { ns: "research" }));
    return;
  }
  // 白板的标签页刚切到前面（或者刚打开）时画布还没排好，宽高是 0，这时算视野会除出 NaN：等它排好再对过去
  for (let waited = 0; waited < 3000 && !laidOut(project); waited += 50) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!laidOut(project)) return;
  project.camera.resetByRectangle(entity.collisionBox.getRectangle());
  // 刚打开的白板几帧后会自动「适配全部内容」，把这次定位盖掉；按恢复视野的办法定住
  project.camera.applySavedView(project.camera.location, project.camera.currentScale);
}

/**
 * 打开一个报告链接。不是这里管的链接返回 false，什么都不做；
 * 打不开时抛错误代码，由调用方提示（reportLinkError 给出文字）。
 */
export async function openReportLink(url: string): Promise<boolean> {
  const link = parseReportLink(url);
  if (!link) return false;
  const path = await resolveReportLink(link);
  if (/\.prg$/i.test(path)) {
    const { onOpenFile } = await import("@/core/service/GlobalMenu");
    const project = await onOpenFile(URI.file(path), "ReportLink");
    if (project && link.target) await focusCard(project, link.target);
    return true;
  }
  const kind = fileKindOf(path);
  if (kind !== "markdown" && kind !== "pdf") throw new Error("reportLink.unsupported");
  const { openDocumentFile } = await import("./DocumentTab");
  await openDocumentFile(
    path,
    kind === "pdf" && link.page ? { pdf: { page: link.page, annotationId: link.annotation } } : undefined,
  );
  return true;
}

/**
 * 在笔记、AI 回答里点了一个链接：是 rwb:// 就由这里打开（打不开时提示一句），返回 true；
 * 别的链接返回 false，调用方照原来的办法处理。
 */
export async function followReportLink(url: string): Promise<boolean> {
  if (!/^rwb:/i.test(url)) return false;
  try {
    if (!(await openReportLink(url))) {
      // 只带 path 的白板链接（「复制当前白板的链接」那种）
      const { handleDeepLink } = await import("@/core/service/dataFileService/DeepLinkHandler");
      await handleDeepLink([url]);
    }
  } catch (error) {
    toast.error(reportLinkError(error));
  }
  return true;
}

/** 打不开时给用户看的话 */
export function reportLinkError(error: unknown): string {
  const code = error instanceof Error ? error.message : String(error);
  return i18next.t(code.startsWith("reportLink.") ? code : "reportLink.failed", {
    ns: "research",
    message: code,
    interpolation: { escapeValue: false },
  });
}
