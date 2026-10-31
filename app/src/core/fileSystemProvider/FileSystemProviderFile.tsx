import { FileSystemProvider } from "@/core/interfaces/Service";
import { isResearchShell } from "@/core/research/ResearchShell";
import { exists, lstat, mkdir, readDir, readFile, remove, rename, writeFile } from "@tauri-apps/plugin-fs";
import type { FileInfo } from "@tauri-apps/plugin-fs";
import { URI } from "vscode-uri";

/**
 * 同一文件夹下的临时文件名。点开头，文件面板会把它当隐藏文件跳过；
 * 和命令行版（ClosedProjectFileSystemProvider）用同一种命名。
 * 不导出：命令行打包时这个模块会被整个换成 ClosedProjectFileSystemProvider。
 */
function temporaryPathFor(path: string): string {
  const separatorIndex = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const directory = path.slice(0, separatorIndex + 1);
  const fileName = path.slice(separatorIndex + 1);
  return `${directory}.${fileName}.${crypto.randomUUID()}.tmp`;
}

const WRITE_PERMISSION_BITS = 0o222;
const PERMISSION_BITS = 0o7777;

/**
 * 原子写入前看一眼目标：不存在时直接原子写；是符号链接、只读，或者文件在却查不了时就地写。
 * mode 是要沿用到临时文件上的权限位，Windows 上没有。
 */
async function atomicWriteTarget(path: string): Promise<"write-in-place" | { mode?: number }> {
  let info: FileInfo;
  try {
    // lstat 不跟随链接，失效的符号链接也能认出来
    info = await lstat(path);
  } catch {
    // 文件还不存在时 lstat 会失败，照常原子写。
    // 文件在却查不了（比如没有权限）就不冒险改名替换；就地写入失败时调用方会看到真正的错误
    return (await exists(path)) ? "write-in-place" : {};
  }
  if (info.isSymlink || info.readonly) return "write-in-place";
  if (info.mode === null) return {};
  if ((info.mode & WRITE_PERMISSION_BITS) === 0) return "write-in-place";
  return { mode: info.mode & PERMISSION_BITS };
}

export class FileSystemProviderFile implements FileSystemProvider {
  async read(uri: URI) {
    return await readFile(uri.fsPath);
  }
  async readDir(uri: URI) {
    return await readDir(uri.fsPath);
  }
  async write(uri: URI, content: Uint8Array) {
    if (!isResearchShell()) return await writeFile(uri.fsPath, content);
    const target = await atomicWriteTarget(uri.fsPath);
    // 改名会把符号链接换成普通文件，也会绕过只读权限（只要文件夹可写）。
    // 这两种情况以及查不清楚的时候都退回原版的就地写入：沿链接写到真正的文件，只读时照常报错。
    if (target === "write-in-place") return await writeFile(uri.fsPath, content);
    // 先写临时文件再改名：写到一半崩溃或断电时，原文件还是完整的旧版本
    const temporaryPath = temporaryPathFor(uri.fsPath);
    try {
      // 新建的临时文件沿用原文件的权限位（仍受 umask 限制）
      await writeFile(temporaryPath, content, target.mode === undefined ? undefined : { mode: target.mode });
      await rename(temporaryPath, uri.fsPath);
    } catch (error) {
      try {
        if (await exists(temporaryPath)) await remove(temporaryPath);
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], `写入失败，临时文件也没能删掉：${temporaryPath}`, {
          cause: cleanupError,
        });
      }
      throw error;
    }
  }
  async remove(uri: URI) {
    return await remove(uri.fsPath, {
      recursive: true,
    });
  }
  async exists(uri: URI) {
    return await exists(uri.fsPath);
  }
  async mkdir(uri: URI) {
    return await mkdir(uri.fsPath);
  }
  async rename(oldUri: URI, newUri: URI) {
    return await rename(oldUri.fsPath, newUri.fsPath);
  }
}
