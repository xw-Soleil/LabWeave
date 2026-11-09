import { realpathSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";

/** CLI 传入已规范化的文件路径；研究文件夹也解析符号链接后再比较。 */
export function externalWorkspaceAccessError(root: string | null, canonicalPath: string) {
  if (!root) return null;
  let canonicalRoot: string;
  try {
    canonicalRoot = realpathSync.native(root);
  } catch {
    return { code: "RESEARCH_FOLDER_UNAVAILABLE", message: "RESEARCH_FOLDER_UNAVAILABLE" } as const;
  }
  const path = relative(canonicalRoot, canonicalPath);
  if (path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) {
    return { code: "TEMPORARY_WORKSPACE_FORBIDDEN", message: "TEMPORARY_WORKSPACE_FORBIDDEN" } as const;
  }
  return null;
}
