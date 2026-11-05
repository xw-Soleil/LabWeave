import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));
import { fetch } from "@tauri-apps/plugin-http";
import { AssetsRepository } from "./AssetsRepository";

afterEach(() => {
  vi.mocked(fetch).mockReset();
});

describe("asset downloads", () => {
  it("refuses to download anything", async () => {
    await expect(AssetsRepository.fetchFile("sfx/a.mp3")).rejects.toThrow("不会联网");
    expect(fetch).not.toHaveBeenCalled();
  });
});
