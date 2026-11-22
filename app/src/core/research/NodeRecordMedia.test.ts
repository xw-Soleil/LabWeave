import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CURRENT_RECORD, parseNodeRecord, recordPath } from "./NodeRecord";
import {
  ATTACHMENT_DIRECTORY,
  imageMetadata,
  importRecordImages,
  loadRecordImagePreview,
  storeRecordImage,
  type MediaFiles,
} from "./NodeRecordMedia";

const root = "/research/课题";
const record = parseNodeRecord({ name: CURRENT_RECORD, path: recordPath(CURRENT_RECORD), markdown: "", revision: "" });

/** 一张只有文件头的 PNG：够认格式、量尺寸。tail 用来造出内容不同的两张 */
function png(width = 4, height = 3, tail = 0): Uint8Array {
  const bytes = new Uint8Array(34);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  view.setUint32(12, 0x49484452);
  view.setUint32(16, width);
  view.setUint32(20, height);
  bytes[33] = tail;
  return bytes;
}
function jpeg(width = 4, height = 3): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, height >> 8, height & 255, width >> 8, width & 255]);
  return bytes;
}
function webp(width = 4, height = 3): Uint8Array {
  const bytes = new Uint8Array(30);
  bytes.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x58]);
  bytes.set([(width - 1) & 255, (width - 1) >> 8, 0, (height - 1) & 255, (height - 1) >> 8, 0], 24);
  return bytes;
}

/** 假的磁盘：路径 → 内容 */
function memoryMedia(initial: Record<string, Uint8Array> = {}) {
  const disk = new Map(Object.entries(initial));
  const io: MediaFiles = {
    read: vi.fn(async (path: string) => disk.get(path)),
    write: vi.fn(async (path: string, bytes: Uint8Array) => void disk.set(path, bytes)),
  };
  return { disk, io };
}

describe("recognising a picture from its first bytes", () => {
  it("reads the format and size of PNG, JPEG and WebP", () => {
    expect(imageMetadata(png(640, 480))).toEqual({ type: "image/png", extension: "png", width: 640, height: 480 });
    expect(imageMetadata(jpeg(800, 600))).toEqual({ type: "image/jpeg", extension: "jpg", width: 800, height: 600 });
    expect(imageMetadata(webp(320, 200))).toEqual({ type: "image/webp", extension: "webp", width: 320, height: 200 });
  });

  it("refuses anything else, whatever it is called, and anything too large", () => {
    expect(() => imageMetadata(new TextEncoder().encode("<svg onload='bad'>"))).toThrow("nodeRecord.imageUnsupported");
    expect(() => imageMetadata(new Uint8Array(0))).toThrow("nodeRecord.imageUnsupported");
    expect(() => imageMetadata(png(6000, 6000))).toThrow("nodeRecord.imageTooLarge");
    expect(() => imageMetadata(png(0, 10))).toThrow("nodeRecord.imageTooLarge");
    expect(() => imageMetadata(new Uint8Array(8 * 1024 * 1024 + 1))).toThrow("nodeRecord.imageTooLarge");
  });
});

describe("storing a picture for a record", () => {
  it("stores it once under 进展记录/附件, named after its content, and links to it from the record", async () => {
    const { disk, io } = memoryMedia();
    const link = await storeRecordImage(root, record, png(), "结果.png", io);
    expect(link.label).toBe("结果.png");
    expect(link.href).toMatch(/^%E9%99%84%E4%BB%B6\/[0-9a-f]{32}\.png$/);
    const stored = [...disk.keys()];
    expect(stored).toHaveLength(1);
    expect(stored[0]).toBe(`${root}/${ATTACHMENT_DIRECTORY}/${decodeURIComponent(link.href).split("/")[1]}`);
    expect(disk.get(stored[0])).toEqual(png());

    // 同一张图再存：还是那个文件，不重写
    const again = await storeRecordImage(root, record, png(), "又贴了一次.png", io);
    expect(again.href).toBe(link.href);
    expect(io.write).toHaveBeenCalledTimes(1);

    // 内容不同的另一张：另一个文件
    const other = await storeRecordImage(root, record, png(4, 3, 1), "另一张.png", io);
    expect(other.href).not.toBe(link.href);
    expect(disk.size).toBe(2);
  });

  it("does not write over a file with the same name but other content", async () => {
    const { disk, io } = memoryMedia();
    const link = await storeRecordImage(root, record, png(), "a.png", io);
    const file = [...disk.keys()][0];
    disk.set(file, png(4, 3, 9));
    await expect(storeRecordImage(root, record, png(), "a.png", io)).rejects.toThrow("nodeRecord.imageWriteFailed");
    expect(disk.get(file)).toEqual(png(4, 3, 9));
    expect(link.href).toContain(".png");
  });

  it("refuses what is not a picture before touching the disk", async () => {
    const { io } = memoryMedia();
    await expect(storeRecordImage(root, record, new TextEncoder().encode("hello"), "a.png", io)).rejects.toThrow(
      "nodeRecord.imageUnsupported",
    );
    expect(io.read).not.toHaveBeenCalled();
    expect(io.write).not.toHaveBeenCalled();
  });
});

describe("choosing pictures from the computer", () => {
  beforeEach(() => {
    // 桌面端是真去解一遍图；这里只要它不报错
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => ({ width: 4, height: 3, close: vi.fn() })),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it("links a picture already in the project where it is, and copies one from outside", async () => {
    const { disk, io } = memoryMedia({
      [`${root}/图片/曲线 1.png`]: png(),
      "/Users/me/Desktop/截图.jpg": jpeg(),
    });
    const links = await importRecordImages(root, record, undefined, io, async () => [
      `${root}/图片/曲线 1.png`,
      "/Users/me/Desktop/截图.jpg",
    ]);
    expect(links[0]).toEqual({ label: "曲线 1.png", href: "../%E5%9B%BE%E7%89%87/%E6%9B%B2%E7%BA%BF%201.png" });
    expect(links[1].label).toBe("截图.jpg");
    expect(links[1].href).toMatch(/^%E9%99%84%E4%BB%B6\/[0-9a-f]{32}\.jpg$/);
    // 只多存了外面那一张
    expect(io.write).toHaveBeenCalledTimes(1);
    expect(disk.size).toBe(3);
  });

  it("stores nothing when one of the chosen files will not do", async () => {
    const { io } = memoryMedia({
      "/Users/me/a.png": png(),
      "/Users/me/b.png": new TextEncoder().encode("改了后缀的文本文件"),
    });
    await expect(
      importRecordImages(root, record, undefined, io, async () => ["/Users/me/a.png", "/Users/me/b.png"]),
    ).rejects.toThrow("nodeRecord.imageUnsupported");
    expect(io.write).not.toHaveBeenCalled();
    await expect(importRecordImages(root, record, undefined, io, async () => ["/Users/me/程序.exe"])).rejects.toThrow(
      "nodeRecord.imageUnsupported",
    );
    await expect(importRecordImages(root, record, undefined, io, async () => ["/Users/me/没有.png"])).rejects.toThrow(
      "nodeRecord.fileNotFound",
    );
  });

  it("takes at most twelve at a time, and nothing when the choice is cancelled", async () => {
    const { io } = memoryMedia();
    const many = Array.from({ length: 13 }, (_, index) => `/Users/me/${index}.png`);
    await expect(importRecordImages(root, record, undefined, io, async () => many)).rejects.toThrow(
      "nodeRecord.tooManyImages",
    );
    expect(await importRecordImages(root, record, undefined, io, async () => [])).toEqual([]);
    expect(io.read).not.toHaveBeenCalled();
  });

  it("stops without storing when the request was cancelled", async () => {
    const { io } = memoryMedia({ "/Users/me/a.png": png() });
    const controller = new AbortController();
    controller.abort();
    await expect(
      importRecordImages(root, record, controller.signal, io, async () => ["/Users/me/a.png"]),
    ).rejects.toThrow("Aborted");
    expect(io.write).not.toHaveBeenCalled();
  });
});

describe("showing a picture of an item", () => {
  it("only reads pictures inside the project", async () => {
    const { io } = memoryMedia();
    for (const href of ["../../别的项目/a.png", "https://example.com/a.png", "/etc/a.png", "../a.png#page=1"]) {
      await expect(loadRecordImagePreview(root, record, { label: "图", href }, io)).rejects.toThrow(
        "nodeRecord.unsafeLink",
      );
    }
    expect(io.read).not.toHaveBeenCalled();
    await expect(loadRecordImagePreview(root, record, { label: "图", href: "附件/没有.png" }, io)).rejects.toThrow(
      "nodeRecord.fileNotFound",
    );
    expect(io.read).toHaveBeenCalledWith(`${root}/进展记录/附件/没有.png`);
  });
});
