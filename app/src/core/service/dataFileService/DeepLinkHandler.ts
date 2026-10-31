import { RecentFileManager } from "./RecentFileManager";
import { onOpenFile } from "../GlobalMenu";
import { URI } from "vscode-uri";
import { exists } from "@tauri-apps/plugin-fs";
import i18next from "i18next";
import { toast } from "sonner";
import { Project } from "@/core/Project";
import { isOutsideResearchFolder, ResearchFolder } from "@/core/research/ResearchFolder";
import { isResearchShell } from "@/core/research/ResearchShell";
import { Vector } from "@graphif/data-structures";

interface DeepLinkParams {
  path: string;
  location?: { x: number; y: number };
  zoom?: number;
  target?: string;
}

const handledUrls = new Set<string>();

// 科研工作台注册的是 rwb:// 协议，prg:// 留给可能同时装着的原版
function deepLinkScheme() {
  return isResearchShell() ? "rwb" : "prg";
}

function deepLinkSchemePattern() {
  return isResearchShell() ? "(?:rwb|prg)" : "prg";
}

export function isProjectGraphDeepLink(input: string) {
  return new RegExp(`^${deepLinkSchemePattern()}:(\\/\\/)?`, "i").test(input);
}

function buildProjectGraphUrl(params: DeepLinkParams) {
  const queryEntries: string[] = [];
  queryEntries.push(`path=${encodeReadableQueryValue(params.path)}`);
  if (params.target) {
    queryEntries.push(`target=${encodeReadableQueryValue(params.target)}`);
  }
  if (params.location) {
    queryEntries.push(`location=${encodeReadableQueryValue(`${params.location.x},${params.location.y}`)}`);
  }
  if (params.zoom !== undefined) {
    queryEntries.push(`zoom=${encodeReadableQueryValue(String(params.zoom))}`);
  }
  return `${deepLinkScheme()}://open?${queryEntries.join("&")}`;
}

function encodeReadableQueryValue(value: string) {
  let result = "";
  for (const char of value) {
    if (shouldEncodeQueryChar(char)) {
      result += encodeURIComponent(char);
    } else {
      result += char;
    }
  }
  return result;
}

function shouldEncodeQueryChar(char: string) {
  const charCode = char.charCodeAt(0);
  if (charCode <= 0x1f || charCode === 0x7f) return true;
  return /\s|[%&=+#?]/.test(char);
}

export function createCurrentFileDeepLink(project: Project) {
  return buildProjectGraphUrl({ path: project.uri.fsPath });
}

export function createCurrentViewDeepLink(project: Project) {
  return buildProjectGraphUrl({
    path: project.uri.fsPath,
    location: {
      x: project.camera.location.x,
      y: project.camera.location.y,
    },
    zoom: project.camera.currentScale,
  });
}

export function createSelectedEntityDeepLink(project: Project) {
  const selectedEntities = project.stageManager.getSelectedEntities();
  if (selectedEntities.length !== 1) return null;
  return buildProjectGraphUrl({
    path: project.uri.fsPath,
    target: selectedEntities[0].uuid,
  });
}

async function normalizeFilePath(rawPath: string): Promise<string | null> {
  let path = rawPath;
  try {
    path = decodeURIComponent(path);
  } catch {
    // keep raw
  }

  path = path.replace(/[\\/]+$/, "");

  // Windows: /D:/path → D:/path
  if (/^\/[A-Za-z]:/.test(path)) {
    path = path.slice(1);
  }
  // Windows: missing colon D/path → D:/path
  const missingColon = /^([A-Za-z])\/(.*)$/;
  if (missingColon.test(path)) {
    const match = path.match(missingColon)!;
    path = match[1] + ":" + "/" + match[2];
  }

  if (!path) return null;

  // Absolute path: check existence
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) {
    // 研究文件夹外的路径不去碰磁盘，交给调用方拒绝
    if (isOutsideResearchFolder(path)) return path;
    if (await exists(path)) {
      return path;
    }
    return null;
  }

  const fileName = path.toLowerCase().endsWith(".prg") ? path : path + ".prg";

  // 科研模式下相对路径先按研究文件夹解析
  if (isResearchShell() && ResearchFolder.getRoot()) {
    const insideRoot = ResearchFolder.toAbsolute(fileName);
    if (ResearchFolder.isInside(insideRoot)) {
      await ResearchFolder.ensureRootRegistered().catch((error) =>
        toast.error(i18next.t("files.setRootFailed", { ns: "research", error: String(error) })),
      );
      if (await exists(insideRoot)) return insideRoot;
    }
  }

  // Relative/filename: search recent files
  const recentFiles = await RecentFileManager.getRecentFiles();
  for (const file of recentFiles) {
    if (isOutsideResearchFolder(file.uri.fsPath)) continue;
    const normalizedFsPath = file.uri.fsPath.toLowerCase().replaceAll("\\", "/");
    if (normalizedFsPath.endsWith("/" + fileName.toLowerCase())) {
      return file.uri.fsPath;
    }
  }
  return null;
}

function parseProjectGraphUrl(url: string): DeepLinkParams | null {
  if (!isProjectGraphDeepLink(url)) return null;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    const normalized = url.replace(/^(prg|rwb):(?!\/\/)/i, "$1://");
    parsed = new URL(normalized);
  }

  const params = new URLSearchParams(parsed.search);
  const queryPath = params.get("path");
  const rawPath =
    queryPath ??
    (parsed.host
      ? parsed.pathname === "/" || parsed.pathname === ""
        ? parsed.host
        : parsed.host + parsed.pathname
      : parsed.pathname);
  const result: DeepLinkParams = { path: rawPath };

  const target = params.get("target");
  if (target) {
    result.target = target;
  }

  const locationStr = params.get("location");
  if (locationStr) {
    const parts = locationStr.split(",");
    if (parts.length === 2) {
      const x = parseFloat(parts[0]);
      const y = parseFloat(parts[1]);
      if (!isNaN(x) && !isNaN(y)) {
        result.location = { x, y };
      }
    }
  }

  const zoomStr = params.get("zoom");
  if (zoomStr) {
    const z = parseFloat(zoomStr);
    if (!isNaN(z)) {
      result.zoom = z;
    }
  }

  return result;
}

function applyCameraParams(project: Project, params: DeepLinkParams) {
  if (params.target) {
    const entity = project.stageManager.getEntities().find((e) => e.uuid === params.target);
    if (entity) {
      const rect = entity.collisionBox.getRectangle();
      project.camera.resetByRectangle(rect);
      return;
    }
    toast.warning("未找到 UUID 为 " + params.target + " 的实体");
    return;
  }

  // 用 applySavedView：直接改 location / scale 会在打开后的前几帧被「适配全部内容」覆盖（critic 35）
  if (params.location) {
    project.camera.applySavedView(new Vector(params.location.x, params.location.y), params.zoom ?? 1);
  } else if (params.zoom !== undefined) {
    project.camera.applySavedView(project.camera.location, params.zoom);
  }
}

export async function handleDeepLink(urls: string[]) {
  for (const url of urls) {
    if (!isProjectGraphDeepLink(url)) continue;
    if (handledUrls.has(url)) continue;
    handledUrls.add(url);

    const params = parseProjectGraphUrl(url);
    if (!params) continue;

    if (!params.path) {
      // Just launch the app, no file to open
      continue;
    }

    const resolvedPath = await normalizeFilePath(params.path);
    if (!resolvedPath) {
      toast.error("文件不存在: " + params.path);
      continue;
    }
    if (isOutsideResearchFolder(resolvedPath)) {
      toast.error(i18next.t("files.outsideFolder", { ns: "research", path: resolvedPath }));
      continue;
    }

    const project = await onOpenFile(URI.file(resolvedPath), "DeepLink");
    if (project) {
      applyCameraParams(project, params);
    }
  }
}
