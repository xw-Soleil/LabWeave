import { isResearchShell } from "@/core/research/ResearchShell";
import type { TreeValidationResult } from "@/core/stage/stageManager/basicMethods/GraphMethods";
import type { ConnectableEntity } from "@/core/stage/stageObject/abstract/ConnectableEntity";
import { FileCardNode } from "@/core/stage/stageObject/entity/FileCardNode";
import { Section } from "@/core/stage/stageObject/entity/Section";
import { TextNode } from "@/core/stage/stageObject/entity/TextNode";
import { UrlNode } from "@/core/stage/stageObject/entity/UrlNode";
import { toast } from "sonner";

function truncateName(text: string, maxLength: number): string {
  return text.length > maxLength ? text.slice(0, maxLength) + "..." : text;
}

/**
 * 树形结构提示里节点的名字。原版只认文本节点（最多 5 个字），其他一律叫「节点」；
 * 科研模式下文件卡片、网页节点用标题，分组框用框名，长度放宽到 16 个字，不然论文标题只剩开头一个词。
 */
export function getNodeDisplayName(node: ConnectableEntity): string {
  if (!isResearchShell()) {
    return node instanceof TextNode ? truncateName(node.text || "未命名", 5) : "节点";
  }
  let name: string;
  if (node instanceof TextNode || node instanceof Section) {
    name = node.text;
  } else if (node instanceof FileCardNode) {
    name = node.title || node.sourcePath.split(/[\\/]/).pop() || "";
  } else if (node instanceof UrlNode) {
    name = node.title || node.url;
  } else {
    return "节点";
  }
  return truncateName(name.replace(/\s+/g, " ").trim() || "未命名", 16);
}

/**
 * 显示树形结构验证错误信息
 * @param result 树形结构验证结果
 * @param type 提示类型："error" | "warning"
 */
export function showTreeValidationErrors(result: TreeValidationResult, type: "error" | "warning" = "error"): void {
  if (result.issues.length === 0) return;

  // 按类型分组问题
  const issuesByType = new Map<string, typeof result.issues>();
  for (const issue of result.issues) {
    if (!issuesByType.has(issue.type)) {
      issuesByType.set(issue.type, []);
    }
    issuesByType.get(issue.type)!.push(issue);
  }

  // 构建错误消息
  const messages: string[] = [];
  messages.push("当前结构不符合树形结构:");

  // 1. 自环问题
  const selfLoopIssues = issuesByType.get("selfLoop");
  if (selfLoopIssues && selfLoopIssues.length > 0) {
    messages.push("");
    messages.push("• 存在自环:");
    for (const issue of selfLoopIssues) {
      messages.push(`  - ${issue.message}`);
    }
  }

  // 2. 边重叠问题
  const overlappingIssues = issuesByType.get("overlappingEdges");
  if (overlappingIssues && overlappingIssues.length > 0) {
    messages.push("");
    messages.push("• 存在重叠的边:");
    for (const issue of overlappingIssues) {
      messages.push(`  - ${issue.message}`);
    }
  }

  // 3. 环路问题
  const cycleIssues = issuesByType.get("cycle");
  if (cycleIssues && cycleIssues.length > 0) {
    messages.push("");
    messages.push("• 存在环路:");
    for (const issue of cycleIssues) {
      messages.push(`  - ${issue.message}`);
    }
  }

  // 4. 菱形结构问题
  const diamondIssues = issuesByType.get("diamond");
  if (diamondIssues && diamondIssues.length > 0) {
    messages.push("");
    messages.push("• 存在菱形结构（一个节点有多个父节点）:");
    for (const issue of diamondIssues) {
      messages.push(`  - ${issue.message}`);
    }
  }

  messages.push("");
  messages.push("请修复上述问题后再进行树形格式化。");

  const message = messages.join("\n");
  const options = { duration: 10000 };

  if (type === "error") {
    toast.error(message, options);
  } else {
    toast.warning(message, options);
  }
}
