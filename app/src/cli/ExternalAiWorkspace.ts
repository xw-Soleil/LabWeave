// 外部 AI（MCP）用到的：读程序的设置、权限开关、列出和定位研究文件夹里的工作区。
// 只用 Node 自带模块，不依赖程序界面。

import { spawn } from "node:child_process";
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { isHiddenResearchName, SIDECAR_MD_SUFFIX, WORKBENCH_DIR } from "../core/research/ResearchShell";
import type { BuiltInToolDefinition } from "../core/service/dataManageService/aiEngine/BuiltInToolRegistry";
import { resolveProjectGraphAppDataDirectories } from "./ProjectGraphAppDataPath";

/** 程序的 settings.json；还没有时当作空设置 */
export function readAppSettings(): Record<string, unknown> {
  for (const directory of resolveProjectGraphAppDataDirectories()) {
    try {
      const value: unknown = JSON.parse(readFileSync(join(directory, "settings.json"), "utf8"));
      if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
    } catch {
      // 没有或读不了就看下一个
    }
  }
  return {};
}

export function researchFolderOf(settings: Record<string, unknown>): string | null {
  const folder = settings.researchFolderPath;
  return typeof folder === "string" && folder !== "" ? folder : null;
}

export type ExternalAiPermissions = {
  allowEdits: boolean;
  allowDelete: boolean;
  allowNetwork: boolean;
};

/** 设置里没写过的开关按默认值：都允许 */
export function readExternalAiPermissions(settings: Record<string, unknown>): ExternalAiPermissions {
  return {
    allowEdits: settings.mcpAllowEdits !== false,
    allowDelete: settings.mcpAllowDelete !== false,
    allowNetwork: settings.mcpAllowNetwork !== false,
  };
}

export function describeToolEffects(definition: BuiltInToolDefinition) {
  const deletes = definition.capabilities.includes("delete");
  return {
    modifies: deletes || definition.persistence === "project" || definition.persistence === "project-and-references",
    deletes,
    // 联网搜图、调用户配置的 AI 接口识图：会联网，可能花钱
    network: definition.capabilities.includes("network") || definition.capabilities.includes("model"),
  };
}

export function isToolAllowedForExternalAi(
  definition: BuiltInToolDefinition,
  permissions: ExternalAiPermissions,
): boolean {
  const effects = describeToolEffects(definition);
  return (
    (!effects.modifies || permissions.allowEdits) &&
    (!effects.deletes || permissions.allowDelete) &&
    (!effects.network || permissions.allowNetwork)
  );
}

export type WorkspaceFile = { relPath: string; absPath: string; mtimeMs: number };

const MAX_SCAN_DEPTH = 6;

/** 和文件面板同样的规则：跳过点开头的、备份、临时文件、符号链接；深度 ≤6 */
export function listWorkspaceFiles(root: string, limit = 500): { workspaces: WorkspaceFile[]; truncated: boolean } {
  const workspaces: WorkspaceFile[] = [];
  let truncated = false;
  const walk = (directory: string, depth: number) => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (truncated || isHiddenResearchName(entry.name) || entry.isSymbolicLink()) continue;
      const absPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (depth < MAX_SCAN_DEPTH) walk(absPath, depth + 1);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".prg")) {
        if (workspaces.length >= limit) {
          truncated = true;
          return;
        }
        let mtimeMs = 0;
        try {
          mtimeMs = statSync(absPath).mtimeMs;
        } catch {
          // 刚被删掉也照样列出，调用时会报找不到
        }
        workspaces.push({ relPath: relative(root, absPath).split("\\").join("/"), absPath, mtimeMs });
      }
    }
  };
  walk(root, 1);
  workspaces.sort((a, b) => a.relPath.localeCompare(b.relPath, undefined, { numeric: true, sensitivity: "base" }));
  return { workspaces, truncated };
}

function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

export type ResolvedWorkspace = { ok: true; absPath: string; relPath: string } | { ok: false; message: string };

/**
 * workspace 可以是：名字（「测试」或「测试.prg」）、相对研究文件夹的路径（「项目A/实验.prg」）、
 * 或研究文件夹里的绝对路径。研究文件夹外的一律不认。
 */
export function resolveWorkspace(root: string, workspace: unknown): ResolvedWorkspace {
  if (typeof workspace !== "string" || workspace.trim() === "") {
    return {
      ok: false,
      message: "缺少 workspace 参数：填工作区名字或相对研究文件夹的路径，可以先调用 list_workspaces",
    };
  }
  let realRoot: string;
  try {
    realRoot = realpathSync.native(root);
  } catch {
    return { ok: false, message: `研究文件夹打不开：${root}` };
  }
  let wanted = workspace.trim().split("\\").join("/");
  if (!wanted.toLowerCase().endsWith(".prg")) wanted += ".prg";

  const direct = isAbsolute(wanted) ? wanted : join(realRoot, wanted);
  try {
    const realPath = realpathSync.native(direct);
    if (statSync(realPath).isFile()) {
      if (!isInside(realRoot, realPath)) return { ok: false, message: "只能操作研究文件夹里的工作区" };
      return { ok: true, absPath: realPath, relPath: relative(realRoot, realPath).split("\\").join("/") };
    }
  } catch {
    // 不是现成的路径，下面按名字找
  }

  const { workspaces } = listWorkspaceFiles(realRoot);
  if (!wanted.includes("/")) {
    const byName = workspaces.filter(({ relPath }) => basename(relPath).toLowerCase() === wanted.toLowerCase());
    if (byName.length === 1) return { ok: true, absPath: byName[0].absPath, relPath: byName[0].relPath };
    if (byName.length > 1) {
      return {
        ok: false,
        message: `有 ${byName.length} 个工作区都叫这个名字，请用相对路径指明：${byName.map((w) => w.relPath).join("、")}`,
      };
    }
  }
  const known = workspaces.slice(0, 20).map((w) => w.relPath);
  return {
    ok: false,
    message: `研究文件夹里没有工作区「${workspace}」。${known.length ? `现有的：${known.join("、")}` : "研究文件夹里还没有工作区"}`,
  };
}

/** 保存时写出的文字版：<工作区所在文件夹>/.workbench/<名字>.ai.md */
export function sidecarMarkdownPath(workspaceAbsPath: string): string {
  return join(
    dirname(workspaceAbsPath),
    WORKBENCH_DIR,
    basename(workspaceAbsPath).replace(/\.prg$/i, "") + SIDECAR_MD_SUFFIX,
  );
}

/**
 * 工作区是不是正开在程序里：问一下归属助手，被可连接的程序占着就是开着。
 * 助手不在或出错时返回 null（不知道）。
 */
export function probeWorkspaceOpen(absPath: string): Promise<boolean | null> {
  const helperPath = process.env.PROJECT_GRAPH_OWNERSHIP_HELPER_PATH;
  if (!helperPath) return Promise.resolve(null);
  return new Promise((resolve) => {
    let stdout = "";
    let child;
    try {
      child = spawn(helperPath, ["try-hold-project", absPath], {
        stdio: ["pipe", "pipe", "ignore"],
        windowsHide: true,
      });
    } catch {
      resolve(null);
      return;
    }
    const timeout = setTimeout(() => child.kill(), 5000);
    child.once("error", () => resolve(null));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.once("close", () => {
      clearTimeout(timeout);
      try {
        const response = JSON.parse(stdout.split("\n")[0]) as { status?: string; owner?: { kind?: string } };
        if (response.status === "acquired") resolve(false);
        else if (response.status === "busy") resolve(response.owner?.kind === "connectable");
        else resolve(null);
      } catch {
        resolve(null);
      }
    });
    // 拿到就立刻放掉
    child.stdin.end();
  });
}
