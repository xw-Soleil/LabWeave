import type { Project } from "@/core/Project";
import { ResearchFolder } from "./ResearchFolder";
import type { URI } from "vscode-uri";

export type WorkspaceOpenOrigin = "file-dialog" | "file-drop" | "file-paste" | "os-file";

/** 每次按当前 URI 和研究文件夹判断，另存为或换文件夹后无需更新标记。 */
export function isTemporaryWorkspace(project: Pick<Project, "uri">): boolean {
  return project.uri.scheme === "file" && !!ResearchFolder.getRoot() && !ResearchFolder.isInside(project.uri.fsPath);
}

export function canOpenWorkspace(uri: URI, origin?: WorkspaceOpenOrigin): boolean {
  return (
    !isTemporaryWorkspace({ uri }) ||
    origin === "file-dialog" ||
    origin === "file-drop" ||
    origin === "file-paste" ||
    origin === "os-file"
  );
}
