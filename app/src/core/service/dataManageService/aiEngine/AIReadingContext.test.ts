import { beforeEach, expect, it, vi } from "vitest";
import type { Project } from "@/core/Project";
import type { AIObjectReferenceRegistry } from "./AIObjectReferenceRegistry";
const mocks = vi.hoisted(() => ({
  reading: "",
  stream: vi.fn(),
  response: vi.fn(),
  research: vi.fn(async () => "<whiteboard>board</whiteboard>"),
}));
vi.mock("@/core/Project", () => ({ Project: class {}, service: () => (value: unknown) => value }));
vi.mock("@/core/service/Settings", () => ({ Settings: { aiModel: "configured-model" } }));
vi.mock("@/core/research/ReadingContext", () => ({ formatReadingContext: () => mocks.reading }));
vi.mock("./AIChatSessionStore", () => ({ AIChatSessionStore: {}, getAIChatProjectKey: () => "board" }));
vi.mock("./AIObjectReferenceRegistry", () => ({ AIObjectReferenceRegistry: class {} }));
vi.mock("./AIProjectReferenceStore", () => ({ AIProjectReferenceStore: {} }));
vi.mock("./LocalAgentTransport", () => ({ LocalAgentTransport: class {} }));
vi.mock("./BuiltInToolAgentAdapter", () => ({ createBuiltInToolAgentTools: () => ({}) }));
vi.mock("./AIProvider", () => ({ createChatModel: () => ({}), mergeAIRequestHeaders: () => ({}) }));
vi.mock("./ResearchContext", () => ({
  buildResearchContext: mocks.research,
  estimateResearchContextTokens: (text: string) => text.length,
}));
vi.mock("ai", () => ({
  DefaultChatTransport: class {},
  generateText: vi.fn(),
  streamText: mocks.stream,
  convertToModelMessages: async (messages: unknown) => messages,
  pruneMessages: ({ messages }: { messages: unknown }) => messages,
  stepCountIs: () => undefined,
  wrapLanguageModel: ({ model }: { model: unknown }) => model,
}));
import { AIEngine } from "./AIEngine";

beforeEach(() => {
  mocks.reading = "";
  mocks.stream.mockReset().mockReturnValue({ toUIMessageStreamResponse: mocks.response });
  mocks.response.mockReset().mockReturnValue(new Response());
  mocks.research.mockReset().mockResolvedValue("<whiteboard>board</whiteboard>");
});

it("refreshes built-in AI reading context each turn without modifying messages, and snapshots it before async preparation", async () => {
  const engine = new AIEngine();
  const fetch = engine.createChatFetch({} as Project, {} as AIObjectReferenceRegistry);
  const messages = [{ id: "u1", role: "user", parts: [{ type: "text", text: "explain this" }] }];
  mocks.reading = "<reading-context>paper.pdf page 2 selection</reading-context>";
  mocks.research.mockImplementationOnce(async () => {
    mocks.reading = "<reading-context>different.pdf page 8</reading-context>";
    return "<whiteboard>board</whiteboard>";
  });
  await fetch("/chat", { body: JSON.stringify({ messages }) });
  expect(mocks.stream.mock.calls[0][0].system).toContain("paper.pdf page 2 selection");
  expect(mocks.stream.mock.calls[0][0].system).not.toContain("different.pdf");
  expect(mocks.stream.mock.calls[0][0].messages).toEqual(messages);
  expect(mocks.response.mock.calls[0][0].originalMessages).toEqual(messages);
  await fetch("/chat", { body: JSON.stringify({ messages }) });
  expect(mocks.stream.mock.calls[1][0].system).toContain("different.pdf page 8");
  mocks.reading = "";
  await fetch("/chat", { body: JSON.stringify({ messages }) });
  expect(mocks.stream.mock.calls[2][0].system).not.toContain("reading-context");
});
