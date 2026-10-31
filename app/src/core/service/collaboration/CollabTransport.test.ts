import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveCollabHttpBase, resolveCollabWsUrl } from "./CollabTransport";

afterEach(() => vi.unstubAllEnvs());

describe("collaboration service address", () => {
  it("derives the collab host from LR_API_BASE_URL outside research mode", () => {
    vi.stubEnv("LR_RESEARCH_SHELL", "false");
    vi.stubEnv("LR_API_BASE_URL", "https://hub.example.com");
    expect(resolveCollabHttpBase()).toBe("https://collab.example.com");
  });

  it("has no address in research mode even when the build configures one", () => {
    vi.stubEnv("LR_API_BASE_URL", "https://hub.example.com");
    vi.stubEnv("LR_COLLAB_BASE_URL", "https://collab.example.com");
    expect(resolveCollabHttpBase()).toBe("");
    expect(() => resolveCollabWsUrl("token")).toThrow("COLLAB_BASE_URL_MISSING");
  });
});
