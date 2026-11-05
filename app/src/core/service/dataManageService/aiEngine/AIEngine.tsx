import { Project, service } from "@/core/Project";
import { Settings } from "@/core/service/Settings";
import { AIChatSessionStore, getAIChatProjectKey } from "@/core/service/dataManageService/aiEngine/AIChatSessionStore";
import { composeAgentSystemPrompt } from "@/core/service/dataManageService/aiEngine/AIAgentRuntime";
import {
  createSessionMemoryCompactionPlan,
  formatSessionMemoryTranscript,
  getSessionMemoryWorkingMessages,
  SUMMARY_TOOL_OUTPUT_CHARS,
} from "@/core/service/dataManageService/aiEngine/AIChatSessionMemory";
import { createBuiltInToolAgentTools } from "@/core/service/dataManageService/aiEngine/BuiltInToolAgentAdapter";
import { AIObjectReferenceRegistry } from "@/core/service/dataManageService/aiEngine/AIObjectReferenceRegistry";
import { AIProjectReferenceStore } from "@/core/service/dataManageService/aiEngine/AIProjectReferenceStore";
import { LocalAgentTransport } from "@/core/service/dataManageService/aiEngine/LocalAgentTransport";
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
import { fetch } from "@tauri-apps/plugin-http";
import {
  convertToModelMessages,
  DefaultChatTransport,
  generateText,
  pruneMessages,
  stepCountIs,
  streamText,
  type ChatTransport,
  type UIMessage,
  wrapLanguageModel,
} from "ai";

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

export type AIConversation = {
  references: AIObjectReferenceRegistry;
  transport: ChatTransport<UIMessage<AIMessageMetadata>>;
  localAgent?: LocalAgentTransport;
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
  ): AIConversation {
    if (Settings.aiBackend === "localAgent") {
      const localAgent = new LocalAgentTransport({
        project,
        references,
        agentId: Settings.aiLocalAgent,
        pathOverride: Settings.aiLocalAgentPaths[Settings.aiLocalAgent],
      });
      return { references, transport: localAgent, localAgent };
    }

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
      const researchContext = await buildResearchContext(project, contextWindowTokenLimit);
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
              SUMMARY_TOOL_OUTPUT_CHARS,
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

      const tools = createBuiltInToolAgentTools(project, references);
      const memoryContext = sessionMemory
        ? `以下是当前会话的压缩记忆，仅用于保持对话连续性。当前用户消息和工具读取到的项目状态优先。\n${sessionMemory.summary}`
        : undefined;
      const system = composeAgentSystemPrompt(`${RESEARCH_SYSTEM_PROMPT}\n\n${researchContext}`, "", memoryContext);
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
        // 出错信息随消息流显示在界面上，不另外打到控制台（streamText 默认会 console.error）
        onError: () => {},
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
    };
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
