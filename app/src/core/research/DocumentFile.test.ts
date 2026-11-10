import { describe, expect, it, vi } from "vitest";
import {
  applyMarkdownEdit,
  documentKey,
  documentPath,
  DocumentRangeReader,
  editorText,
  MarkdownDocument,
  resolveDocumentImage,
  type MarkdownFileIO,
} from "./DocumentFile";

describe("document paths", () => {
  it.each([
    ["/research/notes/a.md", "../fig/a%20b.png", "/research/fig/a b.png"],
    ["C:\\Research\\notes\\a.md", "..\\fig\\a.png", "c:/Research/fig/a.png"],
    ["\\\\server\\share\\notes\\a.md", "../a.png", "//server/share/a.png"],
    ["/r/笔记/a.md", "%E5%9B%BE.png?x#y", "/r/笔记/图.png"],
  ])("resolves images relative to %s", (path, source, expected) => {
    expect(resolveDocumentImage(path, source)).toBe(expected);
  });
  it.each([
    "https://host/a.png",
    "//host/a.png",
    "data:image/png,xx",
    "file:///private/a.png",
    "javascript:alert(1)",
    "%2F%2Fhost/a.png",
    "/private/a.png",
    "\\private\\a.png",
    "%5C%2Fhost/a.png",
    "%2Fprivate/a.png",
    "C:\\private\\a.png",
  ])("rejects automatic remote or protocol image loads: %s", (source) => {
    expect(() => resolveDocumentImage("/r/a.md", source)).toThrow("imageNotLocal");
  });
  it("normalizes dot segments, Windows case and verbatim prefixes for duplicate tabs", () => {
    expect(documentPath("/r/notes/../a.md")).toBe("/r/a.md");
    expect(documentKey("\\\\?\\C:\\Research\\A.MD")).toBe(documentKey("c:/research/a.md"));
    expect(documentKey("\\\\?\\UNC\\server\\share\\a.md")).toBe("//server/share/a.md");
  });
});

describe("Markdown fidelity", () => {
  const raw =
    "\uFEFF---\r\ntitle: 保真\n---\r\n\r\n# 原文\n\n[引用][1]  \r\n$E=mc^2$\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n[1]: ./图.png\r\n";
  it("does not normalize untouched source including BOM, mixed newlines and references", () => {
    expect(applyMarkdownEdit(raw, editorText(raw))).toBe(raw);
  });
  it("changes exactly one character without rewriting the rest", () => {
    expect(applyMarkdownEdit(raw, editorText(raw).replace("原文", "新文"))).toBe(raw.replace("原文", "新文"));
  });
  it("preserves BOM and newline convention when inserting and deleting lines", () => {
    expect(applyMarkdownEdit("\uFEFFa\r\nb\r\n", "a\nb\nc\n")).toBe("\uFEFFa\r\nb\r\nc\r\n");
    expect(applyMarkdownEdit("a\r\nb\r\n", "b\n")).toBe("b\r\n");
    expect(applyMarkdownEdit("\uFEFF", "新\n")).toBe("\uFEFF新\n");
  });
});

function disk() {
  let snapshot = { text: "# original\r\n", mtime: 1 };
  const io: MarkdownFileIO = {
    read: vi.fn(async () => ({ ...snapshot })),
    write: vi.fn(async (_path, text) => {
      snapshot = { text, mtime: snapshot.mtime + 1 };
    }),
  };
  const document = new MarkdownDocument("/allowed/opened.md", { ...snapshot }, io);
  return {
    document,
    io,
    change: (next: typeof snapshot) => {
      snapshot = next;
    },
  };
}

describe("Markdown saving", () => {
  it("never writes or even rereads when nothing was edited", async () => {
    const { document, io } = disk();
    await document.save();
    expect(io.read).not.toHaveBeenCalled();
    expect(io.write).not.toHaveBeenCalled();
  });
  it.each([
    { text: "# external\r\n", mtime: 1 },
    { text: "# original\r\n", mtime: 2 },
  ])("rejects a content or timestamp conflict: %j", async (snapshot) => {
    const { document, io, change } = disk();
    document.edit("# edited\n");
    change(snapshot);
    await expect(document.save()).rejects.toThrow("fileChanged");
    expect(io.write).not.toHaveBeenCalled();
    expect(document.dirty).toBe(true);
  });
  it("saves only the opened file and clears the dirty marker", async () => {
    const { document, io } = disk();
    document.edit("# edited\n");
    await document.save();
    expect(io.write).toHaveBeenCalledWith("/allowed/opened.md", "# edited\r\n");
    expect(document.dirty).toBe(false);
  });
  it("coalesces concurrent saves and keeps edits made during saving dirty", async () => {
    const { document, io } = disk();
    const originalRead = io.read;
    let release!: () => void;
    io.read = vi.fn(async (path) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return originalRead(path);
    });
    document.edit("# submitted\n");
    const saving = document.save();
    expect(document.save()).toBe(saving);
    document.edit("# newer\n");
    release();
    await vi.waitFor(() => expect(io.write).toHaveBeenCalledOnce());
    release();
    await saving;
    expect(document.dirty).toBe(true);
    expect(document.text).toBe("# newer\r\n");
  });
  it("retains edits after a write failure", async () => {
    const { document, io } = disk();
    document.edit("# edit\n");
    io.write = vi.fn().mockRejectedValue(new Error("denied"));
    await expect(document.save()).rejects.toThrow("denied");
    expect(document.dirty).toBe(true);
  });
});

describe("scoped PDF range reads", () => {
  function range(size = 300000, shortRead = 7) {
    let position = 0;
    const handle = {
      seek: vi.fn(async (offset: number) => {
        position = offset;
        return offset;
      }),
      read: vi.fn(async (buffer: Uint8Array) => {
        await Promise.resolve();
        const length = Math.min(buffer.length, shortRead, size - position);
        for (let i = 0; i < length; i++) buffer[i] = (position + i) % 256;
        position += length;
        return length || null;
      }),
      close: vi.fn(async () => {}),
    };
    return { reader: new DocumentRangeReader(handle, size), handle };
  }
  it("serializes overlapping requests and handles short reads", async () => {
    const { reader, handle } = range();
    const [first, second] = await Promise.all([reader.read(100, 120), reader.read(5, 15)]);
    expect([...first]).toEqual(Array.from({ length: 20 }, (_, i) => 100 + i));
    expect([...second]).toEqual(Array.from({ length: 10 }, (_, i) => 5 + i));
    expect(reader.bytesRead).toBe(30);
    expect(handle.seek).toHaveBeenCalledTimes(2);
    await reader.close();
  });
  it("limits individual IPC reads to 256 KiB and never fetches unused data", async () => {
    const { reader, handle } = range(1000000000, Infinity);
    await reader.read(0, 600000);
    expect(handle.read.mock.calls.map(([buffer]) => buffer.length)).toEqual([262144, 262144, 75712]);
    expect(reader.bytesRead).toBe(600000);
    expect(reader.largestRead).toBe(262144);
    await reader.close();
  });
  it("avoids seek round trips for adjacent queued ranges, but seeks for backward reads", async () => {
    const { reader, handle } = range(1000000, Infinity);
    const [first, next, backward] = await Promise.all([reader.read(5, 15), reader.read(15, 25), reader.read(2, 8)]);
    expect([...first]).toEqual(Array.from({ length: 10 }, (_, i) => 5 + i));
    expect([...next]).toEqual(Array.from({ length: 10 }, (_, i) => 15 + i));
    expect([...backward]).toEqual([2, 3, 4, 5, 6, 7]);
    expect(handle.seek.mock.calls.map(([offset]) => offset)).toEqual([5, 2]);
    await reader.close();
  });
  it("does not reuse an uncertain cursor after a failed read", async () => {
    const { reader, handle } = range(1000000, Infinity);
    await reader.read(0, 10);
    handle.read.mockRejectedValueOnce(new Error("read failed"));
    await expect(reader.read(10, 20)).rejects.toThrow("read failed");
    expect([...(await reader.read(10, 20))]).toEqual(Array.from({ length: 10 }, (_, i) => 10 + i));
    expect(handle.seek.mock.calls.map(([offset]) => offset)).toEqual([0, 10]);
    await reader.close();
  });
  it.each([
    [-1, 2],
    [0, 300001],
    [2, 1],
    [0, NaN],
    [0.1, 4],
  ])("rejects invalid bounds %s..%s", async (begin, end) => {
    const { reader, handle } = range();
    await expect(reader.read(begin, end)).rejects.toThrow("invalidRange");
    expect(handle.read).not.toHaveBeenCalled();
    await reader.close();
  });
  it("reports a truncated file and closes once, rejecting queued or later work", async () => {
    const { reader, handle } = range();
    handle.read.mockResolvedValueOnce(null);
    await expect(reader.read(1, 5)).rejects.toThrow("fileChanged");
    await Promise.all([reader.close(), reader.close()]);
    expect(handle.close).toHaveBeenCalledOnce();
    await expect(reader.read(0, 1)).rejects.toThrow("fileClosed");
  });
  it("closes the handle even while an IPC read has stalled", async () => {
    const { reader, handle } = range();
    let finish!: (count: number) => void;
    handle.read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const reading = reader.read(0, 1);
    await vi.waitFor(() => expect(handle.read).toHaveBeenCalledOnce());
    const closing = reader.close();
    expect(handle.close).toHaveBeenCalledOnce();
    finish(1);
    await expect(reading).rejects.toThrow("fileClosed");
    await closing;
  });

  it.each([262143, 262144, 262145, 600001])(
    "reads the exact EOF across 256 KiB chunks and short reads: %s",
    async (size) => {
      const { reader, handle } = range(size, 100003);
      const bytes = await reader.read(0, size);
      expect(bytes).toEqual(Uint8Array.from({ length: size }, (_, i) => i % 256));
      expect(reader.bytesRead).toBe(size);
      expect(handle.read.mock.calls.every(([buffer]) => buffer.length <= 262144)).toBe(true);
      await reader.close();
    },
  );

  it("seeks again after a failed seek or an EOF short read, including when the cursor moved", async () => {
    const { reader, handle } = range(1000000, Infinity);
    const seek = handle.seek.getMockImplementation()!;
    const read = handle.read.getMockImplementation()!;
    await reader.read(0, 10);
    handle.seek.mockImplementationOnce(async (offset) => {
      await seek(offset + 100);
      throw new Error("seek failed");
    });
    await expect(reader.read(20, 30)).rejects.toThrow("seek failed");
    expect([...(await reader.read(10, 20))]).toEqual(Array.from({ length: 10 }, (_, i) => 10 + i));
    handle.read.mockImplementationOnce(async (buffer) => {
      await read(buffer);
      throw new Error("read failed");
    });
    await expect(reader.read(20, 30)).rejects.toThrow("read failed");
    handle.read.mockResolvedValueOnce(null);
    await expect(reader.read(20, 30)).rejects.toThrow("fileChanged");
    expect([...(await reader.read(20, 30))]).toEqual(Array.from({ length: 10 }, (_, i) => 20 + i));
    await reader.close();
  });

  it.each(["seek", "read"] as const)(
    "close resolves before a hung %s, then rejects queued reads without issuing new I/O",
    async (method) => {
      const { reader, handle } = range(1000000, Infinity);
      let finish!: (count: number) => void;
      handle[method].mockImplementationOnce(
        () =>
          new Promise<number>((resolve) => {
            finish = resolve;
          }),
      );
      const first = reader.read(0, 600000);
      const queued = reader.read(600000, 700000);
      const rejected = Promise.all([
        expect(first).rejects.toThrow("fileClosed"),
        expect(queued).rejects.toThrow("fileClosed"),
      ]);
      await vi.waitFor(() => expect(handle[method]).toHaveBeenCalledOnce());
      await reader.close();
      expect(handle.close).toHaveBeenCalledOnce();
      finish(262144);
      await rejected;
      expect(handle.seek).toHaveBeenCalledOnce();
      expect(handle.read).toHaveBeenCalledTimes(method === "read" ? 1 : 0);
    },
  );
});
