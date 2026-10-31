import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));
import { fetch } from "@tauri-apps/plugin-http";
import { AssetsRepository } from "./AssetsRepository";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.mocked(fetch).mockReset();
});

describe("asset downloads", () => {
  it("downloads from the asset repository outside research mode", async () => {
    vi.stubEnv("LR_RESEARCH_SHELL", "false");
    vi.mocked(fetch).mockResolvedValue(new Response(new Uint8Array([1, 2, 3])));
    expect(await AssetsRepository.fetchFile("sfx/a.mp3")).toEqual(new Uint8Array([1, 2, 3]));
    expect(fetch).toHaveBeenCalledWith("https://assets.graphif.dev/sfx/a.mp3");
  });

  it("refuses to download anything in research mode", async () => {
    await expect(AssetsRepository.fetchFile("sfx/a.mp3")).rejects.toThrow("不会联网");
    expect(fetch).not.toHaveBeenCalled();
  });
});
