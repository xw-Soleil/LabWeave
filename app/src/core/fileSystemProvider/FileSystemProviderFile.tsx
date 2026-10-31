import { FileSystemProvider } from "@/core/interfaces/Service";
import { isResearchShell } from "@/core/research/ResearchShell";
import { exists, mkdir, readDir, readFile, remove, rename, writeFile } from "@tauri-apps/plugin-fs";
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

export class FileSystemProviderFile implements FileSystemProvider {
  async read(uri: URI) {
    return await readFile(uri.fsPath);
  }
  async readDir(uri: URI) {
    return await readDir(uri.fsPath);
  }
  async write(uri: URI, content: Uint8Array) {
    if (!isResearchShell()) return await writeFile(uri.fsPath, content);
    // 先写临时文件再改名：写到一半崩溃或断电时，原文件还是完整的旧版本
    const temporaryPath = temporaryPathFor(uri.fsPath);
    try {
      await writeFile(temporaryPath, content);
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
