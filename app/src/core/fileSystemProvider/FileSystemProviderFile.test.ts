import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-fs", () => ({
  exists: vi.fn(async () => true),
  mkdir: vi.fn(),
  readDir: vi.fn(),
  readFile: vi.fn(),
  remove: vi.fn(),
  rename: vi.fn(),
  writeFile: vi.fn(),
}));

import { exists, remove, rename, writeFile } from "@tauri-apps/plugin-fs";
import { URI } from "vscode-uri";
import { FileSystemProviderFile } from "./FileSystemProviderFile";

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("FileSystemProviderFile.write", () => {
  const target = URI.file("/research/综述.prg");
  const content = new Uint8Array([1, 2, 3]);

  it("writes a hidden temporary file in the same folder, then renames it over the target", async () => {
    await new FileSystemProviderFile().write(target, content);
    const [temporaryPath, written] = vi.mocked(writeFile).mock.calls[0];
    expect(temporaryPath).toMatch(/^\/research\/\.综述\.prg\.[0-9a-f-]{36}\.tmp$/);
    expect(written).toBe(content);
    expect(rename).toHaveBeenCalledExactlyOnceWith(temporaryPath, target.fsPath);
    expect(remove).not.toHaveBeenCalled();
  });

  it("removes the temporary file and rethrows when the rename fails", async () => {
    vi.mocked(rename).mockRejectedValueOnce(new Error("rename denied"));
    await expect(new FileSystemProviderFile().write(target, content)).rejects.toThrow("rename denied");
    const temporaryPath = vi.mocked(writeFile).mock.calls[0][0];
    expect(exists).toHaveBeenCalledWith(temporaryPath);
    expect(remove).toHaveBeenCalledWith(temporaryPath);
  });

  it("writes in place outside the research shell", async () => {
    vi.stubEnv("LR_RESEARCH_SHELL", "false");
    await new FileSystemProviderFile().write(target, content);
    expect(writeFile).toHaveBeenCalledExactlyOnceWith(target.fsPath, content);
    expect(rename).not.toHaveBeenCalled();
  });
});
