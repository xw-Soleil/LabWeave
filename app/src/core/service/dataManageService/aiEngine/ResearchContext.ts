import type { Project } from "@/core/Project";
import { buildAiSidecar } from "@/core/research/AiSidecarBuilder";
import { ResearchFolder, type ResearchFileEntry } from "@/core/research/ResearchFolder";
import { serialize } from "@graphif/serializer";

export const DEFAULT_RESEARCH_CONTEXT_CHARS = 60_000;
const MIN_RESEARCH_CONTEXT_CHARS = 8_000;
const MAX_RESEARCH_CONTEXT_CHARS = 400_000;
const MAX_LISTED_FILES = 500;
// 中英文混排时大约 2 个字符一个 token，按偏多估算
const CHARS_PER_TOKEN = 2;
// 白板和文件清单最多占上下文窗口的四分之一，其余留给对话和工具结果
const CONTEXT_WINDOW_SHARE = 0.25;
const WHITEBOARD_SHARE = 0.7;

export function getResearchContextCharBudget(contextWindowTokens?: number): number {
  if (!contextWindowTokens || contextWindowTokens <= 0) return DEFAULT_RESEARCH_CONTEXT_CHARS;
  const chars = Math.floor(contextWindowTokens * CONTEXT_WINDOW_SHARE * CHARS_PER_TOKEN);
  return Math.min(MAX_RESEARCH_CONTEXT_CHARS, Math.max(MIN_RESEARCH_CONTEXT_CHARS, chars));
}

export function estimateResearchContextTokens(context: string): number {
  return Math.ceil(context.length / CHARS_PER_TOKEN);
}

export function truncateToBudget(text: string, budget: number): string {
  if (text.length <= budget) return text;
  const omitted = text.length - budget;
  return `${text.slice(0, Math.max(0, budget))}\n…（后面还有 ${omitted} 个字符没有放进来）`;
}

export function formatResearchFiles(entries: readonly ResearchFileEntry[], limit = MAX_LISTED_FILES): string {
  const lines = entries.slice(0, limit).map((entry) => `- ${entry.relPath} (${entry.kind})`);
  if (entries.length > limit) lines.push(`…（还有 ${entries.length - limit} 个文件没有列出）`);
  return lines.join("\n");
}

/**
 * 白板优先：默认白板占 70%、文件清单占 30%，哪一部分用不完就让给另一部分。
 */
export function composeResearchContext({
  whiteboardMarkdown,
  filesText,
  budget,
}: {
  whiteboardMarkdown: string;
  filesText: string;
  budget: number;
}): string {
  const whiteboardShare = Math.floor(budget * WHITEBOARD_SHARE);
  const filesBudget = Math.max(budget - Math.min(whiteboardMarkdown.length, whiteboardShare), 0);
  const files = truncateToBudget(filesText, filesBudget);
  const whiteboard = truncateToBudget(whiteboardMarkdown, Math.max(budget - files.length, 0));
  return [
    `<whiteboard>\n${whiteboard || "（白板是空的）"}\n</whiteboard>`,
    `<research-files>\n${files || "（还没有选研究文件夹，或文件夹里没有文件）"}\n</research-files>`,
  ].join("\n\n");
}

function getWorkspaceFileName(project: Project): string {
  return project.uri.scheme === "file" ? (project.uri.path.split("/").pop() ?? "") : "";
}

/** 读当前（含未保存改动的）白板和研究文件夹，拼成放进系统提示的上下文 */
export async function buildResearchContext(project: Project, contextWindowTokens?: number): Promise<string> {
  const { markdown } = buildAiSidecar({
    serializedStage: serialize(project.stage),
    tags: project.tags,
    metadata: project.metadata,
    workspaceFile: getWorkspaceFileName(project),
  });
  const files = ResearchFolder.getRoot() ? await ResearchFolder.listFiles() : [];
  return composeResearchContext({
    whiteboardMarkdown: markdown,
    filesText: formatResearchFiles(files),
    budget: getResearchContextCharBudget(contextWindowTokens),
  });
}
