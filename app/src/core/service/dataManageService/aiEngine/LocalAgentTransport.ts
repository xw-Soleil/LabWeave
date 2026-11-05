/* eslint-disable @typescript-eslint/no-unused-vars -- 第 0 步保留参数契约，函数体在第 2 步实现后移除此豁免。 */
import type { Project } from "@/core/Project";
import type { ContentBlock } from "@agentclientprotocol/sdk";
import type { ChatTransport, UIMessage, UIMessageChunk } from "ai";
import type { AIMessageMetadata } from "./AIEngine";
import type { AIObjectReferenceRegistry } from "./AIObjectReferenceRegistry";
import type { LocalAgentId, LocalAgentPermissionRequest, LocalAgentStatus } from "./LocalAgent";

export type { LocalAgentPermissionRequest, LocalAgentStatus } from "./LocalAgent";

export type LocalAgentTransportOptions = {
  project: Project;
  references: AIObjectReferenceRegistry;
  agentId: LocalAgentId;
  pathOverride?: string;
};

export type LocalAgentPromptContext = {
  firstPrompt: boolean;
  workspace: string;
  researchContext?: string;
  recentHistory?: string;
};

export function buildLocalAgentPrompt(
  _message: UIMessage<AIMessageMetadata>,
  _context: LocalAgentPromptContext,
): ContentBlock[] {
  throw new Error("not implemented");
}

export function formatLocalAgentHistory(_messages: UIMessage<AIMessageMetadata>[]): string {
  throw new Error("not implemented");
}

export class LocalAgentTransport implements ChatTransport<UIMessage<AIMessageMetadata>> {
  constructor(_options: LocalAgentTransportOptions) {
    throw new Error("not implemented");
  }

  async sendMessages(
    _options: Parameters<ChatTransport<UIMessage<AIMessageMetadata>>["sendMessages"]>[0],
  ): Promise<ReadableStream<UIMessageChunk>> {
    throw new Error("not implemented");
  }

  async reconnectToStream(
    _options: Parameters<ChatTransport<UIMessage<AIMessageMetadata>>["reconnectToStream"]>[0],
  ): Promise<null> {
    throw new Error("not implemented");
  }

  onStatus(_listener: (status: LocalAgentStatus) => void): () => void {
    throw new Error("not implemented");
  }

  onPermissionRequest(_listener: (request: LocalAgentPermissionRequest | null) => void): () => void {
    throw new Error("not implemented");
  }

  respondPermission(_requestId: string, _optionId: string | null): void {
    throw new Error("not implemented");
  }

  async dispose(): Promise<void> {
    throw new Error("not implemented");
  }
}
