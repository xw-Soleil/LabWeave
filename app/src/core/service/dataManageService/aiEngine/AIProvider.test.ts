import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createAnthropic: vi.fn(),
  createOpenAICompatible: vi.fn(),
  anthropicLanguageModel: vi.fn((modelId: string) => ({ provider: "anthropic", modelId })),
  openAIChatModel: vi.fn((modelId: string) => ({ provider: "openai", modelId })),
}));

vi.mock("@ai-sdk/anthropic", () => ({
  createAnthropic: mocks.createAnthropic.mockImplementation(() => ({ languageModel: mocks.anthropicLanguageModel })),
}));
vi.mock("@ai-sdk/openai-compatible", () => ({
  createOpenAICompatible: mocks.createOpenAICompatible.mockImplementation(() => ({ chatModel: mocks.openAIChatModel })),
}));

import {
  createChatModel,
  DEFAULT_ANTHROPIC_BASE_URL,
  getAIConfigProblems,
  getEffectiveAIBaseUrl,
  mergeAIRequestHeaders,
} from "./AIProvider";

const wireFetch = vi.fn() as unknown as typeof globalThis.fetch;

describe("createChatModel", () => {
  beforeEach(() => {
    mocks.createAnthropic.mockClear();
    mocks.createOpenAICompatible.mockClear();
  });

  it("keeps the OpenAI-compatible provider for the openai format", () => {
    const model = createChatModel(
      { aiApiFormat: "openai", aiApiBaseUrl: "https://example.com/v1", aiApiKey: "sk-test", aiModel: "gpt-x" },
      wireFetch,
    );

    expect(model).toEqual({ provider: "openai", modelId: "gpt-x" });
    expect(mocks.createAnthropic).not.toHaveBeenCalled();
    expect(mocks.createOpenAICompatible).toHaveBeenCalledWith({
      name: "project-graph",
      baseURL: "https://example.com/v1",
      apiKey: "sk-test",
      fetch: wireFetch,
      includeUsage: true,
    });
  });

  it("uses the Anthropic provider with the official URL when the base URL is empty", () => {
    const model = createChatModel(
      { aiApiFormat: "anthropic", aiApiBaseUrl: "  ", aiApiKey: "sk-ant", aiModel: "claude-x" },
      wireFetch,
    );

    expect(model).toEqual({ provider: "anthropic", modelId: "claude-x" });
    expect(mocks.createOpenAICompatible).not.toHaveBeenCalled();
    expect(mocks.createAnthropic).toHaveBeenCalledWith({
      baseURL: DEFAULT_ANTHROPIC_BASE_URL,
      apiKey: "sk-ant",
      headers: { "anthropic-dangerous-direct-browser-access": "true" },
      fetch: wireFetch,
    });
  });

  it("passes a custom Anthropic base URL through and omits an empty key", () => {
    createChatModel(
      { aiApiFormat: "anthropic", aiApiBaseUrl: "https://proxy.example.com/v1", aiApiKey: "", aiModel: "claude-x" },
      wireFetch,
    );

    expect(mocks.createAnthropic).toHaveBeenCalledWith(
      expect.objectContaining({ baseURL: "https://proxy.example.com/v1", apiKey: undefined }),
    );
  });
});

describe("AI provider settings helpers", () => {
  it("only defaults the base URL for the anthropic format", () => {
    expect(getEffectiveAIBaseUrl({ aiApiFormat: "anthropic", aiApiBaseUrl: "" })).toBe(DEFAULT_ANTHROPIC_BASE_URL);
    expect(getEffectiveAIBaseUrl({ aiApiFormat: "openai", aiApiBaseUrl: "" })).toBe("");
  });

  it("lists what still has to be filled in", () => {
    expect(getAIConfigProblems({ aiApiFormat: "openai", aiApiBaseUrl: "", aiApiKey: "", aiModel: "" })).toEqual([
      "baseUrl",
      "model",
      "apiKey",
    ]);
    expect(
      getAIConfigProblems({ aiApiFormat: "anthropic", aiApiBaseUrl: "", aiApiKey: "k", aiModel: "claude-x" }),
    ).toEqual([]);
    expect(
      getAIConfigProblems({
        aiApiFormat: "openai",
        aiApiBaseUrl: "http://localhost:11434/v1",
        aiApiKey: "",
        aiModel: "m",
      }),
    ).toEqual([]);
  });

  it("lets user headers override SDK headers", () => {
    expect(
      mergeAIRequestHeaders(new Headers({ "x-api-key": "sdk", accept: "json" }), "x-api-key: mine\n# comment"),
    ).toEqual({ "x-api-key": "mine", accept: "json" });
    expect(mergeAIRequestHeaders({ a: "1" }, "")).toEqual({ a: "1" });
    expect(mergeAIRequestHeaders(undefined, "b: 2")).toEqual({ b: "2" });
  });
});
