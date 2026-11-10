import { open, readFile, SeekMode, stat, writeFile } from "@tauri-apps/plugin-fs";
import { URI, Utils } from "vscode-uri";

export function documentPath(path: string): string {
  const normalized = path
    .replace(/\\/g, "/")
    .replace(/^\/\/\?\/UNC\//i, "//")
    .replace(/^\/\/\?\//, "");
  return Utils.resolvePath(URI.file(normalized), ".").fsPath.replace(/\\/g, "/");
}

export function documentKey(path: string): string {
  const normalized = documentPath(path);
  return /^(?:[a-z]:|\/\/)/i.test(normalized) ? normalized.toLowerCase() : normalized;
}

export async function identifyDocument(path: string): Promise<{ path: string; key: string }> {
  const normalized = documentPath(path);
  const info = await stat(normalized);
  if (!info.isFile) throw new Error("notAFile");
  const key = info.ino && info.dev !== null ? `${info.dev}:${info.ino}` : documentKey(normalized);
  return { path: normalized, key };
}

export function resolveDocumentImage(path: string, source: string): string {
  // Local images use the same scoped fs API as the document; no remote tracking images or file URLs.
  if (/^(?:[a-z][a-z\d+.-]*:|[\\/])/i.test(source)) throw new Error("imageNotLocal");
  const decoded = decodeURIComponent(source.split(/[?#]/, 1)[0]);
  if (!decoded || /^(?:[a-z][a-z\d+.-]*:|[\\/])/i.test(decoded)) throw new Error("imageNotLocal");
  const uri = URI.file(documentPath(path));
  return documentPath(Utils.resolvePath(Utils.dirname(uri), decoded.replace(/\\/g, "/")).fsPath);
}

export interface FileSnapshot {
  text: string;
  mtime: number | null;
}

export interface MarkdownFileIO {
  read(path: string): Promise<FileSnapshot>;
  write(path: string, text: string): Promise<void>;
}

export const markdownFileIO: MarkdownFileIO = {
  async read(path) {
    const before = await stat(path);
    const bytes = await readFile(path);
    const after = await stat(path);
    if (before.size !== after.size || before.mtime?.getTime() !== after.mtime?.getTime()) {
      throw new Error("fileChanged");
    }
    // Retain BOM and reject non-UTF-8 instead of silently replacing bytes on save.
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    return { text, mtime: after.mtime?.getTime() ?? null };
  },
  async write(path, text) {
    await writeFile(path, new TextEncoder().encode(text));
  },
};

export function editorText(raw: string): string {
  return raw.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
}

/** Preserve untouched bytes, including mixed line endings, when textarea normalizes newlines. */
export function applyMarkdownEdit(raw: string, next: string): string {
  const previous = editorText(raw);
  if (previous === next) return raw;
  let start = 0;
  while (start < previous.length && start < next.length && previous[start] === next[start]) start++;
  let end = previous.length;
  let nextEnd = next.length;
  while (end > start && nextEnd > start && previous[end - 1] === next[nextEnd - 1]) {
    end--;
    nextEnd--;
  }
  const offsets: number[] = [];
  for (let i = raw.startsWith("\uFEFF") ? 1 : 0; i < raw.length; i++) {
    offsets.push(i);
    if (raw[i] === "\r" && raw[i + 1] === "\n") i++;
  }
  offsets.push(raw.length);
  const newline = /\r\n|\r|\n/.exec(raw)?.[0] ?? "\n";
  return raw.slice(0, offsets[start]) + next.slice(start, nextEnd).replace(/\n/g, newline) + raw.slice(offsets[end]);
}

export class MarkdownDocument {
  text: string;
  private saving: Promise<void> | undefined;

  constructor(
    readonly path: string,
    private snapshot: FileSnapshot,
    private readonly io: MarkdownFileIO = markdownFileIO,
  ) {
    this.text = snapshot.text;
  }

  get dirty() {
    return this.text !== this.snapshot.text;
  }

  edit(text: string) {
    this.text = applyMarkdownEdit(this.text, text);
  }

  save(): Promise<void> {
    if (this.saving) return this.saving;
    if (!this.dirty) return Promise.resolve();
    this.saving = this.write().finally(() => {
      this.saving = undefined;
    });
    return this.saving;
  }

  private async write() {
    const submitted = this.text;
    const disk = await this.io.read(this.path);
    if (disk.mtime !== this.snapshot.mtime || disk.text !== this.snapshot.text) throw new Error("fileChanged");
    await this.io.write(this.path, submitted);
    const saved = await this.io.read(this.path);
    if (saved.text !== submitted) throw new Error("fileChanged");
    this.snapshot = saved;
  }
}

// Local range requests pay a Tauri round trip per read; bound buffers without 64 KiB IPC chatter.
export const PDF_RANGE_CHUNK_SIZE = 256 * 1024;

export interface RangeHandle {
  seek(offset: number, whence: SeekMode): Promise<number>;
  read(buffer: Uint8Array): Promise<number | null>;
  close(): Promise<void>;
}

/** Serialize seek/read pairs on the scoped handle, never allocate the whole file. */
export class DocumentRangeReader {
  private pending: Promise<unknown> = Promise.resolve();
  private closed = false;
  private closing?: Promise<void>;
  private position?: number;
  bytesRead = 0;
  largestRead = 0;

  constructor(
    private readonly handle: RangeHandle,
    readonly size: number,
  ) {}

  static async open(path: string, signal?: AbortSignal) {
    if (signal?.aborted) throw new Error("fileClosed");
    const handle = await open(path, { read: true });
    let abort: (() => void) | undefined;
    try {
      if (signal?.aborted) throw new Error("fileClosed");
      const cancelled = new Promise<never>((_resolve, reject) => {
        abort = () => reject(new Error("fileClosed"));
        signal?.addEventListener("abort", abort, { once: true });
      });
      const { size } = await Promise.race([handle.stat(), cancelled]);
      return new DocumentRangeReader(handle, size);
    } catch (error) {
      await handle.close();
      throw error;
    } finally {
      if (abort) signal?.removeEventListener("abort", abort);
    }
  }

  read(begin: number, end: number): Promise<Uint8Array<ArrayBuffer>> {
    const task = this.pending.then(async () => {
      if (this.closed) throw new Error("fileClosed");
      if (!Number.isSafeInteger(begin) || !Number.isSafeInteger(end) || begin < 0 || end <= begin || end > this.size) {
        throw new Error("invalidRange");
      }
      const bytes = new Uint8Array(end - begin);
      if (this.position !== begin) {
        this.position = undefined;
        await this.handle.seek(begin, SeekMode.Start);
      }
      let offset = 0;
      while (offset < bytes.length) {
        if (this.closed) throw new Error("fileClosed");
        // A failed IPC read may have moved the backend cursor; force seek on retry.
        this.position = undefined;
        const count = await this.handle.read(
          bytes.subarray(offset, Math.min(offset + PDF_RANGE_CHUNK_SIZE, bytes.length)),
        );
        if (this.closed) throw new Error("fileClosed");
        if (!count) throw new Error("fileChanged");
        offset += count;
        this.position = begin + offset;
        this.bytesRead += count;
        this.largestRead = Math.max(this.largestRead, count);
      }
      return bytes;
    });
    // Keep the queue usable after failure; each caller still receives its own rejection.
    this.pending = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  close(): Promise<void> {
    this.closed = true;
    // Closing must reach the backend even when an outstanding seek/read never resolves.
    return (this.closing ??= this.handle.close());
  }
}
