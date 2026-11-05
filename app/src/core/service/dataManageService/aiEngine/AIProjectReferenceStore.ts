import type { Project } from "@/core/Project";
import type { AIObjectReferenceSnapshot } from "@/core/service/dataManageService/aiEngine/AIObjectReferenceRegistry";
import { getAIChatProjectKey } from "@/core/service/dataManageService/aiEngine/AIChatSessionStore";
import { invoke } from "@tauri-apps/api/core";
import { URI } from "vscode-uri";

type ProjectReferenceStoreProject = Pick<Project, "canonicalProjectPath" | "uri"> & { metadata?: unknown };

const writeQueues = new Map<string, Promise<void>>();

function projectIdentity(project: ProjectReferenceStoreProject) {
  const legacyProjectUri = project.uri.toString();
  const pathProjectUri = project.canonicalProjectPath
    ? URI.file(project.canonicalProjectPath).toString()
    : legacyProjectUri;
  // 和聊天记录用同一个工作区 id：改名、移动后对象引用还对得上，不会把旧对话里的 n3 指到别的卡片
  const chatKey = getAIChatProjectKey(project);
  const projectUri = chatKey.startsWith("workbench:") ? chatKey : pathProjectUri;
  const fallbackUri = projectUri === pathProjectUri ? legacyProjectUri : pathProjectUri;
  return {
    projectUri,
    ...(projectUri === fallbackUri ? {} : { legacyProjectUri: fallbackUri }),
  };
}

export namespace AIProjectReferenceStore {
  export function load(project: ProjectReferenceStoreProject): Promise<AIObjectReferenceSnapshot | null> {
    return invoke<AIObjectReferenceSnapshot | null>("load_project_reference_snapshot", projectIdentity(project));
  }

  export function save(project: ProjectReferenceStoreProject, references: AIObjectReferenceSnapshot): Promise<void> {
    const { projectUri } = projectIdentity(project);
    const previousWrite = writeQueues.get(projectUri) ?? Promise.resolve();
    const persist = () => invoke<void>("save_project_reference_snapshot", { projectUri, references });
    const write = previousWrite.then(persist, persist);
    writeQueues.set(projectUri, write);
    const removeCompletedWrite = () => {
      if (writeQueues.get(projectUri) === write) writeQueues.delete(projectUri);
    };
    void write.then(removeCompletedWrite, removeCompletedWrite);
    return write;
  }
}
