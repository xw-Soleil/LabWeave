import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));
vi.mock("@/core/service/FeatureFlags", () => ({ FeatureFlags: { TELEMETRY: true } }));
vi.mock("./Settings", () => ({ Settings: { telemetry: true } }));
vi.mock("@/utils/otherApi", () => ({ getDeviceId: vi.fn(async () => "device") }));
import { getDeviceId } from "@/utils/otherApi";
import { fetch } from "@tauri-apps/plugin-http";
import { Telemetry } from "./Telemetry";

beforeEach(() => {
  vi.stubEnv("DEV", false);
  vi.mocked(fetch).mockResolvedValue(new Response("{}"));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.mocked(fetch).mockReset();
  vi.mocked(getDeviceId).mockClear();
});

describe("telemetry", () => {
  it("sends nothing, even when every other switch is on", async () => {
    await Telemetry.event("opened");
    expect(fetch).not.toHaveBeenCalled();
    expect(getDeviceId).not.toHaveBeenCalled();
  });
});
