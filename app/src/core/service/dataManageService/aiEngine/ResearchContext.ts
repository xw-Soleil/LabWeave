import type { Project } from "@/core/Project";
import { buildAiSidecar, type ResearchSidecar } from "@/core/research/AiSidecarBuilder";
import { ResearchFolder, type ResearchFileEntry } from "@/core/research/ResearchFolder";
import { serialize } from "@graphif/serializer";

export const DEFAULT_RESEARCH_CONTEXT_CHARS = 60_000;
const MAX_RESEARCH_CONTEXT_CHARS = 400_000;
const MAX_LISTED_FILES = 500;
// 中文差不多一个字一个 token，按中文算预算；英文会富余一些
const CHARS_PER_TOKEN = 1;
// 白板和文件清单最多占上下文窗口的四分之一，其余留给对话和工具结果；小窗口也不设下限，免得挤爆
const CONTEXT_WINDOW_SHARE = 0.25;
const WHITEBOARD_SHARE = 0.7;

export function getResearchContextCharBudget(contextWindowTokens?: number): number {
  if (!contextWindowTokens || contextWindowTokens <= 0) return DEFAULT_RESEARCH_CONTEXT_CHARS;
  const chars = Math.floor(contextWindowTokens * CONTEXT_WINDOW_SHARE * CHARS_PER_TOKEN);
  return Math.min(MAX_RESEARCH_CONTEXT_CHARS, Math.max(0, chars));
}

/** 和会话记忆的估算一致：UTF-8 字节数 / 3，中文约一字一 token，英文约三字符一 token */
export function estimateResearchContextTokens(context: string): number {
  return Math.ceil(new TextEncoder().encode(context).length / 3);
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

// dump_workspace 的结果会留在会话里、每轮都重发：每张卡片的文字只给开头，总长度也封顶
const DUMP_CARD_TEXT_CHARS = 500;
export const DUMP_WORKSPACE_MAX_CHARS = 60_000;

function takeWithinBudget<T>(items: readonly T[], budget: number): { kept: T[]; used: number } {
  const kept: T[] = [];
  let used = 0;
  for (const item of items) {
    const size = JSON.stringify(item).length + 1;
    if (used + size > budget) break;
    kept.push(item);
    used += size;
  }
  return { kept, used };
}

/** 卡片文字和备注截到开头 500 字；总长度超出上限时丢掉后面的卡片和连线，并标出 truncated */
export function capWorkspaceDump(sidecar: ResearchSidecar, maxChars = DUMP_WORKSPACE_MAX_CHARS) {
  let clipped = false;
  const clip = (value: string) => {
    if (value.length <= DUMP_CARD_TEXT_CHARS) return value;
    clipped = true;
    return `${value.slice(0, DUMP_CARD_TEXT_CHARS)}…`;
  };
  const cards = sidecar.cards.map((card) => ({ ...card, text: clip(card.text), notes: clip(card.notes) }));
  const sections = sidecar.sections.map((section) => ({ ...section, notes: clip(section.notes) }));
  const remaining = Math.max(0, maxChars - JSON.stringify({ ...sidecar, sections, cards: [], edges: [] }).length);
  const keptCards = takeWithinBudget(cards, remaining);
  const keptEdges = takeWithinBudget(sidecar.edges, remaining - keptCards.used);
  const omittedCards = cards.length - keptCards.kept.length;
  const omittedEdges = sidecar.edges.length - keptEdges.kept.length;
  const result = { ...sidecar, sections, cards: keptCards.kept, edges: keptEdges.kept };
  if (!clipped && omittedCards === 0 && omittedEdges === 0) return result;
  const omittedText =
    omittedCards || omittedEdges ? `，另有 ${omittedCards} 张卡片、${omittedEdges} 条连线因为总长度上限没有列出` : "";
  return {
    ...result,
    truncated: true,
    truncatedNote: `卡片文字和备注只保留前 ${DUMP_CARD_TEXT_CHARS} 个字符${omittedText}。`,
    omittedCards,
    omittedEdges,
  };
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
  return composeResearchContext({
    whiteboardMarkdown: markdown,
    filesText: await readResearchFilesText(),
    budget: getResearchContextCharBudget(contextWindowTokens),
  });
}

// 文件夹被移走、外接盘没插或没有权限时，只是少了文件清单，不能让整条 AI 请求失败；启动时已经弹过提示
async function readResearchFilesText(): Promise<string> {
  if (!ResearchFolder.getRoot()) return "";
  let files: ResearchFileEntry[];
  try {
    files = await ResearchFolder.listFiles();
  } catch (error) {
    return `（研究文件夹现在读不了，文件清单没有放进来：${error instanceof Error ? error.message : String(error)}）`;
  }
  return formatResearchFiles(files);
}
