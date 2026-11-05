import { afterEach, describe, expect, it, vi } from "vitest";

const createClient = vi.hoisted(() => vi.fn(() => ({})));
vi.mock("better-auth/client", () => ({ createAuthClient: createClient }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  createClient.mockClear();
});

describe("account service", () => {
  it.each([undefined, "https://accounts.example.com"])(
    "has no account service and no cloud features when LR_API_BASE_URL is %s",
    async (value) => {
      vi.stubEnv("LR_API_BASE_URL", value);
      const { accountServiceBaseUrl, authClient } = await import("./AuthClient");
      const { FeatureFlags } = await import("./FeatureFlags");
      expect(accountServiceBaseUrl).toBe("");
      expect(authClient).toBeNull();
      expect(createClient).not.toHaveBeenCalled();
      expect(FeatureFlags.USER).toBe(false);
      expect(FeatureFlags.AI).toBe(false);
      expect(FeatureFlags.TELEMETRY).toBe(false);
    },
  );
});
