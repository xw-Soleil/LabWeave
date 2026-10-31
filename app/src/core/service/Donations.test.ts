import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));
vi.mock("./AuthClient", () => ({ accountServiceBaseUrl: "https://hub.graphif.dev" }));
import { fetch } from "@tauri-apps/plugin-http";
import { fetchDonations } from "./Donations";

beforeEach(() => vi.mocked(fetch).mockReset());
afterEach(() => vi.unstubAllEnvs());

describe("supporter list loading", () => {
  beforeEach(() => vi.stubEnv("LR_RESEARCH_SHELL", "false"));

  it("loads official records and preserves anonymous supporters and expenses", async () => {
    const records = [
      { user: "", amount: 5 },
      { user: "server", amount: -480, note: "hosting", currency: "CNY" },
    ];
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify(records)));
    const signal = new AbortController().signal;
    expect(await fetchDonations(signal)).toEqual(records);
    expect(fetch).toHaveBeenCalledWith("https://hub.graphif.dev/api/donations", { signal });
  });
  it("rejects failed HTTP responses before rendering", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("unavailable", { status: 503 }));
    await expect(fetchDonations()).rejects.toThrow("HTTP 503");
  });
  it.each([{}, null, [{ user: "a", amount: "5" }], [{ user: "a", amount: 5, note: {} }]])(
    "rejects invalid payload %j",
    async (data) => {
      vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify(data)));
      await expect(fetchDonations()).rejects.toThrow("格式异常");
    },
  );
  it("accepts an empty list", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("[]"));
    expect(await fetchDonations()).toEqual([]);
  });
});

describe("research workbench mode", () => {
  it("returns an empty list without any network request", async () => {
    expect(await fetchDonations()).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });
});
