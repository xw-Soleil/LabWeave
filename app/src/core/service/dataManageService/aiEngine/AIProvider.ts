import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { parseAIRequestHeaders } from "./AIRequestHeaders";

export type AIApiFormat = "openai" | "anthropic";

export type AIProviderSettings = {
  aiApiFormat: AIApiFormat;
  aiApiBaseUrl: string;
  aiApiKey: string;
  aiModel: string;
};

export type AIWireFetch = typeof globalThis.fetch;

export const DEFAULT_ANTHROPIC_BASE_URL = "https://api.anthropic.com/v1";

/**
 * Claude 兼容服务的文档常给不带 /v1 的地址（如 https://api.deepseek.com/anthropic），
 * SDK 只会在后面拼 /messages，所以这里统一补成以 /v1 结尾；粘贴了完整的 …/v1/messages 也认。
 */
function normalizeAnthropicBaseUrl(baseUrl: string): string {
  const withoutSuffix = baseUrl.replace(/\/+$/, "").replace(/\/messages$/, "");
  return /\/v\d+$/.test(withoutSuffix) ? withoutSuffix : `${withoutSuffix}/v1`;
}

/** 留空时 Claude 格式走官方地址，OpenAI 兼容格式没有默认地址 */
export function getEffectiveAIBaseUrl(settings: Pick<AIProviderSettings, "aiApiFormat" | "aiApiBaseUrl">): string {
  const baseUrl = settings.aiApiBaseUrl.trim();
  if (settings.aiApiFormat === "anthropic") {
    return baseUrl ? normalizeAnthropicBaseUrl(baseUrl) : DEFAULT_ANTHROPIC_BASE_URL;
  }
  return baseUrl;
}

export type AIConfigProblem = "baseUrl" | "model" | "apiKey";

function isLocalBaseUrl(baseUrl: string): boolean {
  if (!URL.canParse(baseUrl)) return false;
  const hostname = new URL(baseUrl).hostname;
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

/** 返回还没填好的设置项；空数组表示可以发请求。本机模型服务（localhost）可以不填 Key */
export function getAIConfigProblems(settings: AIProviderSettings): AIConfigProblem[] {
  const problems: AIConfigProblem[] = [];
  const baseUrl = getEffectiveAIBaseUrl(settings);
  if (!baseUrl) problems.push("baseUrl");
  if (!settings.aiModel.trim()) problems.push("model");
  if (!settings.aiApiKey.trim() && !isLocalBaseUrl(baseUrl)) problems.push("apiKey");
  return problems;
}

/** 把 SDK 生成的请求头和用户自定义请求头合并；用户填的优先 */
export function mergeAIRequestHeaders(
  initHeaders: HeadersInit | undefined,
  customHeaders: string,
): Record<string, string> {
  const base =
    initHeaders instanceof Headers
      ? Object.fromEntries(initHeaders.entries())
      : Array.isArray(initHeaders)
        ? Object.fromEntries(initHeaders)
        : (initHeaders ?? {});
  return { ...base, ...parseAIRequestHeaders(customHeaders) };
}

function withoutEmptyHeader(wireFetch: AIWireFetch, name: string): AIWireFetch {
  return (input, init) => {
    if (!init?.headers) return wireFetch(input, init);
    const headers = new Headers(init.headers);
    if (headers.get(name)?.trim() === "") headers.delete(name);
    return wireFetch(input, { ...init, headers: Object.fromEntries(headers.entries()) });
  };
}

/**
 * 按 aiApiFormat 创建聊天模型。wireFetch 负责真正发请求（走 tauri-plugin-http，并合并自定义请求头）。
 */
export function createChatModel(settings: AIProviderSettings, wireFetch: AIWireFetch) {
  if (settings.aiApiFormat === "anthropic") {
    const apiKey = settings.aiApiKey.trim();
    const provider = createAnthropic({
      baseURL: getEffectiveAIBaseUrl(settings),
      // SDK 拿不到 Key 会去读环境变量，webview 里没有，直接抛错；本机服务不填 Key 时传空串，再把空的 x-api-key 去掉
      apiKey,
      // 请求经 tauri-plugin-http 发出时可能带上 Origin，Anthropic 会把它当成浏览器直连而拒绝
      headers: { "anthropic-dangerous-direct-browser-access": "true" },
      fetch: apiKey ? wireFetch : withoutEmptyHeader(wireFetch, "x-api-key"),
    });
    return provider.languageModel(settings.aiModel);
  }
  const provider = createOpenAICompatible({
    name: "project-graph",
    baseURL: settings.aiApiBaseUrl,
    apiKey: settings.aiApiKey || undefined,
    fetch: wireFetch,
    includeUsage: true,
  });
  return provider.chatModel(settings.aiModel);
}
