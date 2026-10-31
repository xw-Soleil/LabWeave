import type { Project } from "@/core/Project";
import { isResearchShell } from "@/core/research/ResearchShell";
import { AIObjectReferenceRegistry } from "@/core/service/dataManageService/aiEngine/AIObjectReferenceRegistry";
import { encode } from "@toon-format/toon";
import { tool, type ToolSet } from "ai";
import {
  builtInToolCatalog,
  classifyBuiltInToolException,
  createLiveProjectBuiltInToolRuntimeHost,
  invokeBuiltInTool,
  type BuiltInToolCapability,
  type BuiltInToolDefinition,
  type BuiltInToolExecutionContext,
} from "./BuiltInToolRegistry";

// 会改白板、联网或再调一次模型的工具都不给科研模式的聊天用
const READ_ONLY_EXCLUDED_CAPABILITIES: readonly BuiltInToolCapability[] = [
  "history",
  "delete",
  "network",
  "model",
  "attachments",
];

export function isReadOnlyBuiltInTool(definition: BuiltInToolDefinition): boolean {
  return !definition.capabilities.some((capability) => READ_ONLY_EXCLUDED_CAPABILITIES.includes(capability));
}

export function getAgentBuiltInToolCatalog(): readonly BuiltInToolDefinition[] {
  return isResearchShell() ? builtInToolCatalog.filter(isReadOnlyBuiltInTool) : builtInToolCatalog;
}

export function createBuiltInToolAgentTools(project: Project, references: AIObjectReferenceRegistry): ToolSet {
  const host = createLiveProjectBuiltInToolRuntimeHost(project, references);
  return Object.fromEntries(
    getAgentBuiltInToolCatalog().map((definition) => [
      definition.name,
      tool({
        description: definition.description,
        inputSchema: definition.inputSchema as any,
        execute: async (data: any, executionOptions?: BuiltInToolExecutionContext) => {
          try {
            const result = await invokeBuiltInTool(definition.name, data, host, {
              abortSignal: executionOptions?.abortSignal,
            });
            return result ? encode(result) : "ok";
          } catch (error) {
            const classified = classifyBuiltInToolException(error);
            if (classified) {
              return encode({
                success: false,
                error: classified,
              });
            }
            throw error;
          }
        },
        ...(definition.toModelOutput
          ? {
              toModelOutput: ({ output }: { output: any }) => definition.toModelOutput!(output),
            }
          : {}),
      }),
    ]),
  ) as ToolSet;
}
