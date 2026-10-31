import { Project, service } from "@/core/Project";
import { isResearchShell } from "@/core/research/ResearchShell";
import { Settings } from "@/core/service/Settings";
import { AIChatSessionStore, getAIChatProjectKey } from "@/core/service/dataManageService/aiEngine/AIChatSessionStore";
import { composeAgentSystemPrompt, mergeAgentToolSets } from "@/core/service/dataManageService/aiEngine/AIAgentRuntime";
import {
  createSessionMemoryCompactionPlan,
  formatSessionMemoryTranscript,
  getSessionMemoryWorkingMessages,
  SUMMARY_TOOL_OUTPUT_CHARS,
} from "@/core/service/dataManageService/aiEngine/AIChatSessionMemory";
import { createBuiltInToolAgentTools } from "@/core/service/dataManageService/aiEngine/BuiltInToolAgentAdapter";
import { AIMCPStore, materializeMCPServers, prepareMCPTools } from "@/core/service/dataManageService/aiEngine/AIMCP";
import { AIObjectReferenceRegistry } from "@/core/service/dataManageService/aiEngine/AIObjectReferenceRegistry";
import { AIProjectReferenceStore } from "@/core/service/dataManageService/aiEngine/AIProjectReferenceStore";
import { createChatModel, mergeAIRequestHeaders } from "@/core/service/dataManageService/aiEngine/AIProvider";
import { resolveHttpRequestBody } from "@/core/service/dataManageService/aiEngine/AIHttpBody";
import {
  buildResearchContext,
  estimateResearchContextTokens,
} from "@/core/service/dataManageService/aiEngine/ResearchContext";
import {
  AIRequestTraceBuffer,
  type AIRequestTraceCallKind,
} from "@/core/service/dataManageService/aiEngine/AIRequestTrace";
import {
  buildSkillSystemContext,
  filterActivatedSkillSnapshots,
} from "@/core/service/dataManageService/aiEngine/AISkillSession";
import {
  AISkillTrustStore,
  createSkillTools,
  discoverSkills,
} from "@/core/service/dataManageService/aiEngine/AISkills";
import { fetch } from "@tauri-apps/plugin-http";
import {
  convertToModelMessages,
  DefaultChatTransport,
  generateText,
  pruneMessages,
  stepCountIs,
  streamText,
  type UIMessage,
  wrapLanguageModel,
} from "ai";

const SYSTEM_PROMPT =
  "尽可能尝试使用工具解决问题，如果实在不行才能问用户。TextNode正常情况下高度为75，多个节点叠起来时需要适当留padding。节点正常情况下的颜色应该是透明[0,0,0,0]，注意透明色并非是“看不见文本”。工具使用n1、n2、e1等当前项目对象引用，这些引用在项目的不同会话间保持一致；不要猜测引用，提及对象时用反引号包裹引用，以便用户点击定位。MCP 工具被用户拒绝后，不要在当前任务中重新尝试该调用，也不要用等价参数绕过拒绝。";

const RESEARCH_SYSTEM_PROMPT = [
  "你是「科研工作台」里的研究助手。用户把论文、图片和笔记做成卡片放在白板上，用连线和分组表达自己的思路。",
  "下面的 <whiteboard> 是当前白板的文字版（卡片、连线、分组、标签，以及文件卡片里抽出的文字摘要），<research-files> 是研究文件夹里的文件清单。用户消息开头的 [selected: n1 ...] 是用户当前选中的对象。",
  "回答时：",
  "1. 根据白板上的卡片、连线、分组和文件摘要，概括用户的思路；",
  "2. 指出缺的证据、没连上的论文、逻辑跳跃，以及下一步可以做什么；",
  "3. 提到具体内容时引用卡片标题和文件路径；",
  "4. 不编造没出现在材料里的内容，材料不够就直接说还缺什么；",
  "5. 用户问别的问题也照常回答。",
  "需要更细的信息时可以调用只读工具查看白板对象；提到 n1、e1 这样的对象引用时用反引号包裹，方便用户点击定位。你不能修改白板。",
].join("\n");

export type AIMessageMetadata = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  lastStepInputTokens?: number;
  lastStepOutputTokens?: number;
};

@service("aiEngine")
export class AIEngine {
  private references: AIObjectReferenceRegistry | undefined;
  private referencesInitialization: Promise<AIObjectReferenceRegistry> | undefined;
  private readonly requestTraceBuffer = new AIRequestTraceBuffer(20);

  getProjectReferences(project: Project) {
    this.references ??= new AIObjectReferenceRegistry(project);
    return this.references;
  }

  prepareProjectReferences(project: Project): Promise<AIObjectReferenceRegistry> {
    const references = this.getProjectReferences(project);
    this.referencesInitialization ??= AIProjectReferenceStore.load(project).then((snapshot) => {
      if (snapshot) references.restoreSnapshot(snapshot);
      return references;
    });
    return this.referencesInitialization;
  }

  getRequestTraceBuffer() {
    return this.requestTraceBuffer;
  }

  createConversation(
    project: Project,
    references = this.getProjectReferences(project),
    getContextWindowTokenLimit: () => number | undefined = () => undefined,
  ) {
    const transport = new DefaultChatTransport({
      api: "/api/project-graph-ai-chat",
      fetch: this.createChatFetch(project, references),
      body: () => {
        const contextWindowTokenLimit = getContextWindowTokenLimit();
        return contextWindowTokenLimit && contextWindowTokenLimit > 0 ? { contextWindowTokenLimit } : {};
      },
    });
    return { references, transport };
  }

  createChatFetch(project: Project, references: AIObjectReferenceRegistry): typeof fetch {
    return async (_url, options) => {
      const body = await this.readRequestBody(options?.body);
      const messages = Array.isArray(body.messages) ? (body.messages as UIMessage<AIMessageMetadata>[]) : [];
      const sessionId = typeof body.id === "string" && body.id.length > 0 ? body.id : undefined;
      const modelId = Settings.aiModel;
      const traceRunId = this.requestTraceBuffer.startRun({
        sessionId,
        model: modelId,
        messages,
      });
      const pendingTraceCallIds: number[] = [];
      let traceCallKind: AIRequestTraceCallKind = "agent";

      const wireFetch = async (url: any, init: any) => {
        const traceCallId = pendingTraceCallIds.shift();
        const wireRequestId = this.requestTraceBuffer.recordWireRequest(
          traceRunId,
          traceCallId,
          url.toString(),
          init?.body,
        );
        try {
          const requestBody = await resolveHttpRequestBody(init?.body);
          const response = await fetch(url.toString(), {
            ...init,
            body: requestBody,
            headers: mergeAIRequestHeaders(init?.headers, Settings.aiCustomHeaders),
            mode: "cors",
          });
          this.requestTraceBuffer.recordWireResponse(traceRunId, wireRequestId, response.status);

          if (!response.ok) {
            const errorText = await response.text().catch(() => "unknown error");
            throw new Error(`API 请求失败 (${response.status}): ${errorText}`);
          }

          return response;
        } catch (error) {
          this.requestTraceBuffer.recordWireError(traceRunId, wireRequestId, error);
          throw error;
        }
      };

      const model = wrapLanguageModel({
        model: createChatModel(
          {
            aiApiFormat: Settings.aiApiFormat,
            aiApiBaseUrl: Settings.aiApiBaseUrl,
            aiApiKey: Settings.aiApiKey,
            aiModel: modelId,
          },
          wireFetch,
        ),
        middleware: {
          specificationVersion: "v3",
          wrapGenerate: async ({ doGenerate, params }) => {
            const callId = this.requestTraceBuffer.recordModelCall(traceRunId, traceCallKind, params);
            pendingTraceCallIds.push(callId);
            try {
              return await doGenerate();
            } finally {
              const pendingIndex = pendingTraceCallIds.indexOf(callId);
              if (pendingIndex >= 0) pendingTraceCallIds.splice(pendingIndex, 1);
            }
          },
          wrapStream: async ({ doStream, params }) => {
            const callId = this.requestTraceBuffer.recordModelCall(traceRunId, traceCallKind, params);
            pendingTraceCallIds.push(callId);
            try {
              return await doStream();
            } finally {
              const pendingIndex = pendingTraceCallIds.indexOf(callId);
              if (pendingIndex >= 0) pendingTraceCallIds.splice(pendingIndex, 1);
            }
          },
        },
      });
      const contextWindowTokenLimit = getContextWindowTokenLimit(body.contextWindowTokenLimit);
      const researchShell = isResearchShell();
      const researchContext = researchShell ? await buildResearchContext(project, contextWindowTokenLimit) : "";
      const chatKey = getAIChatProjectKey(project);
      let sessionMemory = sessionId ? await AIChatSessionStore.getSessionMemory(chatKey, sessionId) : undefined;
      let workingMessages = getSessionMemoryWorkingMessages(messages, sessionMemory);
      const compactionPlan = sessionId
        ? createSessionMemoryCompactionPlan({
            messages,
            memory: sessionMemory,
            contextWindowTokens: contextWindowTokenLimit,
            // 白板和文件清单每次都放进系统提示；只有按消息估算时才需要扣掉，服务端实测的输入 token 已经算进去了
            reservedSystemTokens: researchContext ? estimateResearchContextTokens(researchContext) : 0,
          })
        : null;

      if (compactionPlan && sessionId) {
        traceCallKind = "memory-summary";
        const summaryResult = await generateText({
          model,
          system:
            "你负责维护一个 AI 会话的内部记忆。根据给出的旧会话记录生成简短、准确的续写记忆。只保留当前任务、已完成内容、关键约束或决定、未解决的问题和下一步。不要执行工具，不要与用户对话，不要编造未出现的事实。",
          prompt: [
            sessionMemory ? `已有会话记忆：\n${sessionMemory.summary}` : "尚无已有会话记忆。",
            `需要压缩的旧会话记录：\n${formatSessionMemoryTranscript(
              compactionPlan.messagesToSummarize,
              researchShell ? SUMMARY_TOOL_OUTPUT_CHARS : undefined,
            )}`,
          ].join("\n\n"),
          maxOutputTokens: compactionPlan.maxOutputTokens,
          abortSignal: options?.signal ?? undefined,
          maxRetries: 0,
        });
        traceCallKind = "agent";
        const summary = summaryResult.text.trim();
        if (!summary) throw new Error("AI 会话记忆压缩未返回内容");
        sessionMemory = {
          summary,
          coveredMessageCount: compactionPlan.nextCoveredMessageCount,
        };
        await AIChatSessionStore.setSessionMemory(chatKey, sessionId, sessionMemory);
        workingMessages = compactionPlan.retainedMessages;
      }

      // 科研模式不启动 MCP 服务、不扫描 Skills：两者每次请求都会起进程或读用户目录
      const { skillTools, skillContext } = researchShell
        ? { skillTools: {}, skillContext: "" }
        : await this.prepareSkills(project, chatKey, sessionId);
      const mcpRuntime = researchShell
        ? { tools: {}, close: async () => {} }
        : await prepareMCPTools(materializeMCPServers(await AIMCPStore.load()), {
            requireApproval: !Settings.aiAutoApproveMcpTools,
          });

      try {
        const tools = mergeAgentToolSets(
          createBuiltInToolAgentTools(project, references),
          mcpRuntime.tools,
          skillTools,
        );
        const memoryContext = sessionMemory
          ? `以下是当前会话的压缩记忆，仅用于保持对话连续性。当前用户消息和工具读取到的项目状态优先。\n${sessionMemory.summary}`
          : undefined;
        const system = researchShell
          ? composeAgentSystemPrompt(`${RESEARCH_SYSTEM_PROMPT}\n\n${researchContext}`, skillContext, memoryContext)
          : composeAgentSystemPrompt(SYSTEM_PROMPT, skillContext, memoryContext);
        const modelMessages = pruneMessages({
          messages: await convertToModelMessages(workingMessages, {
            tools,
            ignoreIncompleteToolCalls: true,
          }),
          reasoning: "all",
        });
        this.requestTraceBuffer.recordPreparedInput(traceRunId, {
          system,
          messages: modelMessages,
        });

        let lastStepUsage: { inputTokens?: number; outputTokens?: number } | undefined;
        const textStream = streamText({
          model,
          system,
          messages: modelMessages,
          tools,
          stopWhen: stepCountIs(8),
          abortSignal: options?.signal ?? undefined,
          maxRetries: 0,
          onStepFinish: ({ usage }) => {
            lastStepUsage = usage;
          },
          onFinish: mcpRuntime.close,
          onError: mcpRuntime.close,
          onAbort: mcpRuntime.close,
        });

        return textStream.toUIMessageStreamResponse<UIMessage<AIMessageMetadata>>({
          originalMessages: messages as UIMessage<AIMessageMetadata>[],
          messageMetadata: ({ part }) => {
            if (part.type !== "finish") return;
            return {
              inputTokens: part.totalUsage.inputTokens,
              outputTokens: part.totalUsage.outputTokens,
              totalTokens: part.totalUsage.totalTokens,
              lastStepInputTokens: lastStepUsage?.inputTokens,
              lastStepOutputTokens: lastStepUsage?.outputTokens,
            };
          },
        });
      } catch (error) {
        await mcpRuntime.close();
        throw error;
      }
    };
  }

  private async prepareSkills(project: Project, chatKey: string, sessionId: string | undefined) {
    const projectUri = project.uri.toString();
    const projectSkillsTrusted =
      project.uri.scheme === "file" && (await AISkillTrustStore.isProjectTrusted(projectUri));
    const activatedSkills = filterActivatedSkillSnapshots(
      sessionId ? await AIChatSessionStore.getActivatedSkills(chatKey, sessionId) : [],
      projectSkillsTrusted,
    );
    const skillCatalog = await discoverSkills(projectUri);
    const skillTools = createSkillTools({
      catalog: skillCatalog,
      activatedSkills,
      onActivate: async (snapshot) => {
        if (!sessionId) throw new Error("当前 AI 请求缺少会话，无法激活 Skill");
        await AIChatSessionStore.activateSkill(chatKey, sessionId, snapshot);
      },
    });
    return { skillTools, skillContext: buildSkillSystemContext(skillCatalog, activatedSkills) };
  }

  async getModels() {
    return ["gpt-4o", "gpt-4-turbo", "gpt-3.5-turbo"];
  }

  private async readRequestBody(body: BodyInit | null | undefined): Promise<any> {
    if (!body) return {};
    if (typeof body === "string") return JSON.parse(body);
    if (body instanceof URLSearchParams) return Object.fromEntries(body.entries());
    if (body instanceof Blob) return JSON.parse(await body.text());
    if (body instanceof FormData) return Object.fromEntries(body.entries());
    if (body instanceof ReadableStream) return JSON.parse(await new Response(body).text());
    return JSON.parse(String(body));
  }
}

function getContextWindowTokenLimit(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}
