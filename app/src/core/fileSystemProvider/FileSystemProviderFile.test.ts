import { afterEach, describe, expect, it, vi } from "vitest";

const regularFile = { isSymlink: false, readonly: false, mode: 0o100664 };

vi.mock("@tauri-apps/plugin-fs", () => ({
  exists: vi.fn(async () => true),
  lstat: vi.fn(async () => regularFile),
  mkdir: vi.fn(),
  readDir: vi.fn(),
  readFile: vi.fn(),
  remove: vi.fn(),
  rename: vi.fn(),
  writeFile: vi.fn(),
}));

import { exists, lstat, remove, rename, writeFile } from "@tauri-apps/plugin-fs";
import { URI } from "vscode-uri";
import { FileSystemProviderFile } from "./FileSystemProviderFile";

afterEach(() => {
  vi.clearAllMocks();
});

describe("FileSystemProviderFile.write", () => {
  const target = URI.file("/research/综述.prg");
  const content = new Uint8Array([1, 2, 3]);

  it("writes a hidden temporary file in the same folder, then renames it over the target", async () => {
    await new FileSystemProviderFile().write(target, content);
    const [temporaryPath, written, options] = vi.mocked(writeFile).mock.calls[0];
    expect(temporaryPath).toMatch(/^\/research\/\.综述\.prg\.[0-9a-f-]{36}\.tmp$/);
    expect(written).toBe(content);
    expect(options).toEqual({ mode: 0o664 });
    expect(rename).toHaveBeenCalledExactlyOnceWith(temporaryPath, target.fsPath);
    expect(remove).not.toHaveBeenCalled();
  });

  it("creates a new file atomically without a mode when the target does not exist yet", async () => {
    vi.mocked(lstat).mockRejectedValueOnce(new Error("No such file or directory (os error 2)"));
    vi.mocked(exists).mockResolvedValueOnce(false);
    await new FileSystemProviderFile().write(target, content);
    const [temporaryPath, , options] = vi.mocked(writeFile).mock.calls[0];
    expect(options).toBeUndefined();
    expect(rename).toHaveBeenCalledExactlyOnceWith(temporaryPath, target.fsPath);
  });

  it.each([
    ["a symbolic link", { ...regularFile, isSymlink: true }],
    ["read-only", { ...regularFile, readonly: true }],
    ["without any write permission bit", { ...regularFile, mode: 0o100444 }],
  ])("writes in place when the target is %s, so the link target is updated and EACCES is reported", async (_, info) => {
    vi.mocked(lstat).mockResolvedValueOnce(info as Awaited<ReturnType<typeof lstat>>);
    await new FileSystemProviderFile().write(target, content);
    expect(writeFile).toHaveBeenCalledExactlyOnceWith(target.fsPath, content);
    expect(rename).not.toHaveBeenCalled();
  });

  it("writes in place when the target exists but cannot be inspected", async () => {
    vi.mocked(lstat).mockRejectedValueOnce(new Error("Permission denied (os error 13)"));
    vi.mocked(exists).mockResolvedValueOnce(true);
    await new FileSystemProviderFile().write(target, content);
    expect(writeFile).toHaveBeenCalledExactlyOnceWith(target.fsPath, content);
    expect(rename).not.toHaveBeenCalled();
  });

  it("removes the temporary file and rethrows when the rename fails", async () => {
    vi.mocked(rename).mockRejectedValueOnce(new Error("rename denied"));
    await expect(new FileSystemProviderFile().write(target, content)).rejects.toThrow("rename denied");
    const temporaryPath = vi.mocked(writeFile).mock.calls[0][0];
    expect(exists).toHaveBeenCalledWith(temporaryPath);
    expect(remove).toHaveBeenCalledWith(temporaryPath);
  });
});
