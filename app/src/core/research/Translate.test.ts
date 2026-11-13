// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  generateText: vi.fn(),
  settings: {
    translateService: "google",
    translateProxy: "system",
    aiApiFormat: "openai",
    aiApiBaseUrl: "http://localhost:1234/v1",
    aiApiKey: "",
    aiModel: "local",
    aiCustomHeaders: "",
  },
}));
vi.mock("@/core/service/Settings", () => ({ Settings: mocks.settings }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: mocks.fetch }));
vi.mock("ai", () => ({ generateText: mocks.generateText }));
let translateText: typeof import("./Translate").translateText;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const google = () =>
  json({
    src: "en",
    sentences: [{ trans: "研究" }, { src_translit: "/rɪˈsɜːtʃ/" }],
    dict: [{ pos: "noun", terms: ["研究", "调查"] }],
  });
const token = () =>
  new Response(
    'IG:"ABC123" data-iid="translator.1" params_AbusePreventionHelper = [123,"token",3600000]; <link rel="canonical" href="https://cn.bing.com/translator">',
  );
const bing = () => json([{ detectedLanguage: { language: "en" }, translations: [{ text: "译文" }] }]);

beforeEach(async () => {
  vi.resetModules();
  mocks.fetch.mockReset();
  mocks.generateText.mockReset();
  Object.assign(mocks.settings, {
    translateService: "google",
    translateProxy: "system",
    aiModel: "local",
    aiApiKey: "",
    aiCustomHeaders: "",
  });
  ({ translateText } = await import("./Translate"));
});

describe("translation services", () => {
  it("uses Google dictionary fields for one English word and returns an isolated cached value", async () => {
    mocks.fetch.mockResolvedValueOnce(google());
    const result = await translateText("research");
    expect(result).toEqual({
      text: "研究",
      service: "google",
      from: "en",
      to: "zh-CN",
      word: { phonetic: "/rɪˈsɜːtʃ/", meanings: [{ pos: "noun", terms: ["研究", "调查"] }] },
    });
    expect(new URL(mocks.fetch.mock.calls[0][0]).searchParams.getAll("dt")).toEqual(["t", "bd", "rm"]);
    result.word!.meanings[0].terms.push("changed");
    expect((await translateText("research")).word!.meanings[0].terms).toEqual(["研究", "调查"]);
    expect(mocks.fetch).toHaveBeenCalledOnce();
  });

  it("cleans PDF line breaks and translates mainly Chinese text to English", async () => {
    mocks.fetch.mockResolvedValueOnce(json({ src: "zh-CN", sentences: [{ trans: "Research method" }] }));
    expect(await translateText("研究的\n方法")).toEqual({
      text: "Research method",
      service: "google",
      from: "zh-CN",
      to: "en",
    });
    mocks.fetch.mockResolvedValueOnce(google());
    await translateText("inter-\n national\nresearch");
    expect(new URL(mocks.fetch.mock.calls[1][0]).searchParams.get("q")).toBe("international research");
  });

  it("falls back to Bing, uses its token host and remembers the actual service", async () => {
    mocks.fetch
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValueOnce(token())
      .mockResolvedValueOnce(bing());
    expect(await translateText("some text")).toMatchObject({ service: "bing", to: "zh-CN", from: "en" });
    expect(mocks.fetch.mock.calls[2][0]).toMatch(/^https:\/\/cn\.bing\.com\/ttranslatev3/);
    expect(mocks.fetch.mock.calls[2][1].body).toContain("token=token");
    expect((await translateText("some text")).service).toBe("bing");
    expect(mocks.fetch).toHaveBeenCalledTimes(3);
  });

  it("goes through the system proxy unless the setting says to connect directly", async () => {
    mocks.fetch.mockImplementation(async () => google());
    await translateText("research");
    // 不写代理：联网组件自己去读系统代理
    expect(mocks.fetch.mock.calls[0][1]).not.toHaveProperty("proxy");
    mocks.settings.translateProxy = "direct";
    await translateText("another word");
    // 直连：声明所有地址都不经过代理
    expect(mocks.fetch.mock.calls[1][1].proxy).toEqual({ all: { url: "http://127.0.0.1:9", noProxy: "*" } });
  });

  it("tries a service that could not be reached last for five minutes, separately for each network route", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const urls = () => mocks.fetch.mock.calls.map(([url]) => new URL(url).hostname);
    mocks.fetch.mockImplementation(async (url: string) => {
      if (url.includes("googleapis")) throw new TypeError("unreachable");
      return url.includes("ttranslatev3") ? bing() : token();
    });
    expect((await translateText("first text")).service).toBe("bing");
    expect(urls()[0]).toBe("translate.googleapis.com");
    mocks.fetch.mockClear();
    // 第二次不再先去碰 Google
    expect((await translateText("second text")).service).toBe("bing");
    expect(urls()).not.toContain("translate.googleapis.com");
    // 换一种联网方式要重新试；过了五分钟也重新试
    mocks.fetch.mockClear();
    mocks.settings.translateProxy = "direct";
    await translateText("third text");
    expect(urls()[0]).toBe("translate.googleapis.com");
    mocks.settings.translateProxy = "system";
    vi.setSystemTime(Date.now() + 5 * 60 * 1000 + 1);
    mocks.fetch.mockClear();
    await translateText("fourth text");
    expect(urls()[0]).toBe("translate.googleapis.com");
    vi.useRealTimers();
  });

  it("reverses fallback order for Bing and refreshes a rejected token only once", async () => {
    mocks.settings.translateService = "bing";
    mocks.fetch
      .mockResolvedValueOnce(token())
      .mockResolvedValueOnce(json({}, 403))
      .mockResolvedValueOnce(token())
      .mockResolvedValueOnce(json({}, 403))
      .mockResolvedValueOnce(google());
    expect((await translateText("some text")).service).toBe("google");
    expect(mocks.fetch.mock.calls.filter(([url]) => url === "https://www.bing.com/translator")).toHaveLength(2);
  });

  it("gets Bing word meanings and pronunciation without asking Google", async () => {
    mocks.settings.translateService = "bing";
    mocks.fetch
      .mockResolvedValueOnce(token())
      .mockResolvedValueOnce(bing())
      .mockResolvedValueOnce(
        json([
          {
            translations: [
              { posTag: "NOUN", displayTarget: "研究" },
              { posTag: "NOUN", displayTarget: "调查" },
              { posTag: "VERB", displayTarget: "探究" },
            ],
          },
        ]),
      )
      .mockResolvedValueOnce(new Response('<div class="hd_prUS">[rɪˈsɜːrtʃ]</div>'));
    expect((await translateText("research")).word).toEqual({
      phonetic: "[rɪˈsɜːrtʃ]",
      meanings: [
        { pos: "NOUN", terms: ["研究", "调查"] },
        { pos: "VERB", terms: ["探究"] },
      ],
    });
    expect(mocks.fetch.mock.calls[2][0]).toContain("/tlookupv3?");
    expect(mocks.fetch.mock.calls[3][0]).toContain("/dict/SerpHoverTrans?");
  });

  it("rejects a forged canonical host", async () => {
    mocks.settings.translateService = "bing";
    mocks.fetch
      .mockResolvedValueOnce(
        new Response(
          'IG:"ABC" data-iid="id" params_AbusePreventionHelper = [1,"t",3600000]; <link rel="canonical" href="https://untrusted.example/">',
        ),
      )
      .mockResolvedValueOnce(bing());
    await translateText("some text");
    expect(mocks.fetch.mock.calls[1][0]).toMatch(/^https:\/\/www\.bing\.com\//);
  });

  it.each([
    [429, "translate.rateLimited"],
    [500, "translate.network"],
  ])("reports HTTP %s and does not cache failures", async (status, code) => {
    mocks.fetch.mockImplementation(async () => json({}, Number(status)));
    await expect(translateText("some text")).rejects.toThrow(String(code));
    mocks.fetch.mockReset().mockResolvedValueOnce(google());
    await expect(translateText("some text")).resolves.toMatchObject({ service: "google" });
  });

  it("reports malformed responses and rejects empty input without a request", async () => {
    mocks.fetch.mockImplementation(async () => json({}));
    await expect(translateText("some text")).rejects.toThrow("translate.failed");
    mocks.fetch.mockClear();
    await expect(translateText(" \n ")).rejects.toThrow("translate.failed");
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("keeps only 300 entries, with separate entries for each preferred service", async () => {
    mocks.fetch.mockImplementation(async () => google());
    await translateText("entry 0");
    for (let i = 1; i <= 300; i++) await translateText(`entry ${i}`);
    await translateText("entry 0");
    expect(mocks.fetch).toHaveBeenCalledTimes(302);
    mocks.settings.translateService = "bing";
    mocks.fetch.mockReset().mockResolvedValueOnce(token()).mockResolvedValueOnce(bing());
    expect((await translateText("entry 0")).service).toBe("bing");
  });

  it("aborts an in-flight request without fallback, even with a custom abort reason", async () => {
    const controller = new AbortController();
    mocks.fetch.mockImplementation(
      (_url, { signal }) =>
        new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason))),
    );
    const result = translateText("some text", { signal: controller.signal });
    controller.abort(new Error("user cancelled"));
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.fetch).toHaveBeenCalledOnce();
    await expect(translateText("some text", { signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(mocks.fetch).toHaveBeenCalledOnce();
  });
});

describe("AI translation", () => {
  beforeEach(() => {
    mocks.settings.translateService = "ai";
  });
  it("uses the configured provider with fixed JSON output and no automatic retries", async () => {
    mocks.generateText.mockResolvedValue({
      text: '```json\n{"text":"研究","from":"en","word":{"phonetic":"/r/","meanings":[{"pos":"n.","terms":["研究"]}]}}\n```',
    });
    expect(await translateText("research")).toMatchObject({ text: "研究", service: "ai", word: { phonetic: "/r/" } });
    expect(mocks.generateText.mock.calls[0][0]).toMatchObject({
      prompt: "research",
      maxRetries: 0,
      abortSignal: expect.any(AbortSignal),
    });
    expect(mocks.generateText.mock.calls[0][0].model.modelId).toBe("local");
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it("reports incomplete configuration without switching to a web service", async () => {
    mocks.settings.aiModel = "";
    await expect(translateText("some text")).rejects.toThrow("translate.aiNotConfigured");
    expect(mocks.generateText).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it("keeps the translation when the model leaves out dictionary fields, and never adds them to phrases", async () => {
    mocks.generateText.mockResolvedValue({ text: '{"text":"翻译","word":{"meanings":[]}}' });
    expect(await translateText("research")).toMatchObject({ text: "翻译", service: "ai" });
    expect((await translateText("research")).word).toBeUndefined();
    expect((await translateText("some text")).word).toBeUndefined();
  });
});
