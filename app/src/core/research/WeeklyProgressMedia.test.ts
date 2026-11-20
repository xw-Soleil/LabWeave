import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  open: vi.fn(),
  readImage: vi.fn(),
  lstat: vi.fn(),
  readFile: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: mocks.open }));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ readImage: mocks.readImage }));
vi.mock("@tauri-apps/plugin-fs", () => ({ lstat: mocks.lstat, readFile: mocks.readFile }));

import { importWeeklyImages, loadWeeklyImagePreview, pasteWeeklyImage } from "./WeeklyProgressMedia";
import type { WeeklyRecord } from "./WeeklyProgress";

const png = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB1sAAAAASUVORK5CYII="),
  (char) => char.charCodeAt(0),
);
const webp = Uint8Array.from(atob("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA"), (char) =>
  char.charCodeAt(0),
);
const record: WeeklyRecord = {
  weekStart: "2026-11-16",
  path: "进展记录/周进展/2026-11-16.md",
  markdown: "",
  revision: "",
  links: [],
  items: [],
};
const stored = "进展记录/周进展/附件/2026-11-16/content-hash.png";
const root = "D:/project";
let decode: ReturnType<typeof vi.fn>;
let closed: ReturnType<typeof vi.fn>;
let canvas: {
  width: number;
  height: number;
  getContext: () => { drawImage: ReturnType<typeof vi.fn>; putImageData: ReturnType<typeof vi.fn> };
  toBlob: ReturnType<typeof vi.fn>;
};
let drawing: { drawImage: ReturnType<typeof vi.fn>; putImageData: ReturnType<typeof vi.fn> };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.open.mockResolvedValue(null);
  mocks.lstat.mockResolvedValue({ isFile: true, isSymlink: false, size: png.length });
  mocks.readFile.mockResolvedValue(png);
  mocks.invoke.mockImplementation(async (name: string) =>
    name === "save_weekly_progress_image" ? stored : Array.from(png),
  );
  closed = vi.fn();
  decode = vi.fn(async () => ({ width: 1, height: 1, close: closed }));
  vi.stubGlobal("createImageBitmap", decode);
  drawing = { drawImage: vi.fn(), putImageData: vi.fn() };
  canvas = {
    width: 0,
    height: 0,
    getContext: () => drawing,
    toBlob: vi.fn((callback: (blob: Blob) => void) => callback(new Blob([png], { type: "image/png" }))),
  };
  vi.stubGlobal("document", { createElement: () => canvas });
  vi.stubGlobal(
    "ImageData",
    class {
      constructor(
        public data: Uint8ClampedArray,
        public width: number,
        public height: number,
      ) {}
    },
  );
  vi.stubGlobal(
    "FileReader",
    class {
      result = "data:image/png;base64,thumbnail";
      onload?: () => void;
      readAsDataURL() {
        this.onload?.();
      }
    },
  );
});
afterEach(() => vi.unstubAllGlobals());

describe("weekly images", () => {
  it("cancels before opening native input and after a late picker result without writing attachments", async () => {
    await expect(importWeeklyImages(root, record, AbortSignal.abort())).rejects.toMatchObject({ name: "AbortError" });
    await expect(pasteWeeklyImage(root, record, AbortSignal.abort())).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.readImage).not.toHaveBeenCalled();
    const controller = new AbortController();
    let finish!: (paths: string[]) => void;
    mocks.open.mockImplementation(
      () =>
        new Promise<string[]>((resolve) => {
          finish = resolve;
        }),
    );
    const pending = importWeeklyImages(root, record, controller.signal);
    controller.abort();
    finish(["C:/selected.png"]);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.readFile).not.toHaveBeenCalled();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("cancels after decoding or clipboard reads, releasing image handles before any attachment write", async () => {
    const controller = new AbortController();
    mocks.open.mockResolvedValue(["C:/selected.png"]);
    decode.mockImplementation(async () => {
      controller.abort();
      return { width: 1, height: 1, close: closed };
    });
    await expect(importWeeklyImages(root, record, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(closed).toHaveBeenCalledOnce();
    expect(mocks.invoke).not.toHaveBeenCalled();
    const clipboard = new AbortController();
    const close = vi.fn();
    mocks.readImage.mockImplementation(async () => {
      clipboard.abort();
      return { size: vi.fn(), rgba: vi.fn(), close };
    });
    await expect(pasteWeeklyImage(root, record, clipboard.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(close).toHaveBeenCalledOnce();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("does nothing after picker cancellation and rejects excessive selections before reading", async () => {
    expect(await importWeeklyImages(root, record)).toEqual([]);
    expect(mocks.invoke).not.toHaveBeenCalled();
    mocks.open.mockResolvedValue(Array.from({ length: 13 }, (_, index) => `C:/images/${index}.png`));
    await expect(importWeeklyImages(root, record)).rejects.toThrow("weekly.tooManyImages");
    expect(mocks.readFile).not.toHaveBeenCalled();
  });

  it("references existing project images in place, using the scoped native read", async () => {
    mocks.open.mockResolvedValue(["D:\\project\\实验\\结果.png", "D:\\project\\实验\\结果.png"]);
    const links = await importWeeklyImages(root, record);
    expect(links).toEqual([
      { label: "结果.png", href: `../../${encodeURIComponent("实验")}/${encodeURIComponent("结果.png")}` },
    ]);
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith("read_weekly_progress_image", { root, path: "实验/结果.png" });
    expect(mocks.readFile).not.toHaveBeenCalled();
    expect(closed).toHaveBeenCalledOnce();
  });

  it("stores only selected external image bytes without resizing or applying canvas compression settings", async () => {
    mocks.open.mockResolvedValue(["C:/selected/result.webp"]);
    mocks.readFile.mockResolvedValue(webp);
    const links = await importWeeklyImages(root, record);
    expect(mocks.readFile).toHaveBeenCalledExactlyOnceWith("C:/selected/result.webp");
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith("save_weekly_progress_image", {
      root,
      weekStart: record.weekStart,
      bytes: Array.from(webp),
    });
    expect(links).toEqual([
      { label: "result.webp", href: `${encodeURIComponent("附件")}/2026-11-16/content-hash.png` },
    ]);
    expect(canvas.toBlob).not.toHaveBeenCalled();
  });

  it("validates an entire selected batch before writing, rejects unsupported and oversized images", async () => {
    mocks.open.mockResolvedValue(["C:/one.png", "C:/two.png"]);
    mocks.readFile.mockResolvedValueOnce(png).mockResolvedValueOnce(new TextEncoder().encode("<svg/>"));
    await expect(importWeeklyImages(root, record)).rejects.toThrow("weekly.imageUnsupported");
    expect(mocks.invoke).not.toHaveBeenCalled();
    mocks.open.mockResolvedValue(["C:/large.png"]);
    mocks.lstat.mockResolvedValue({ isFile: true, isSymlink: false, size: 8 * 1024 * 1024 + 1 });
    await expect(importWeeklyImages(root, record)).rejects.toThrow("weekly.imageTooLarge");
    expect(mocks.readFile).toHaveBeenCalledTimes(2);
  });

  it("rejects excessive image dimensions before browser decoding and handles malformed decoders", async () => {
    mocks.open.mockResolvedValue(["C:/large.png"]);
    const huge = new Uint8Array(png);
    new DataView(huge.buffer).setUint32(16, 50_000_000);
    mocks.readFile.mockResolvedValue(huge);
    await expect(importWeeklyImages(root, record)).rejects.toThrow("weekly.imageTooLarge");
    expect(decode).not.toHaveBeenCalled();
    mocks.readFile.mockResolvedValue(png);
    decode.mockRejectedValue(new Error("decode failed"));
    await expect(importWeeklyImages(root, record)).rejects.toThrow("weekly.imageUnsupported");
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("deduplicates imported references returned for identical content", async () => {
    mocks.open.mockResolvedValue(["C:/one.png", "C:/two.png"]);
    expect(await importWeeklyImages(root, record)).toHaveLength(1);
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
  });

  it("creates bounded preview data URLs without writing or exposing external paths", async () => {
    decode.mockResolvedValue({ width: 1600, height: 800, close: closed });
    expect(await loadWeeklyImagePreview(root, record, { label: "Result", href: "../../results.png" })).toBe(
      "data:image/png;base64,thumbnail",
    );
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith("read_weekly_progress_image", { root, path: "results.png" });
    expect(drawing.drawImage).toHaveBeenCalledWith(expect.any(Object), 0, 0, 640, 320);
    expect(closed).toHaveBeenCalledOnce();
    expect(canvas.width).toBe(0);
    await expect(
      loadWeeklyImagePreview(root, record, { label: "Outside", href: "../../../outside.png" }),
    ).rejects.toThrow("weekly.unsafeLink");
    await expect(
      loadWeeklyImagePreview(root, record, { label: "Remote", href: "https://example.com/image.png" }),
    ).rejects.toThrow("weekly.unsafeLink");
    expect(mocks.invoke).toHaveBeenCalledOnce();
  });

  it("returns no attachment for empty clipboard but surfaces actual clipboard access failures", async () => {
    mocks.readImage.mockRejectedValue(
      "The clipboard contents were not available in the requested format or the clipboard is empty.",
    );
    expect(await pasteWeeklyImage(root, record)).toBeUndefined();
    mocks.readImage.mockRejectedValue("native permission denied");
    await expect(pasteWeeklyImage(root, record)).rejects.toThrow("weekly.clipboardImageFailed");
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("encodes pasted RGBA losslessly as PNG and closes the native image handle", async () => {
    const close = vi.fn();
    mocks.readImage.mockResolvedValue({
      size: async () => ({ width: 1, height: 1 }),
      rgba: async () => new Uint8Array([10, 20, 30, 255]),
      close,
    });
    expect(await pasteWeeklyImage(root, record)).toEqual({
      label: "clipboard.png",
      href: `${encodeURIComponent("附件")}/2026-11-16/content-hash.png`,
    });
    expect(drawing.putImageData).toHaveBeenCalledWith(
      expect.objectContaining({ data: new Uint8ClampedArray([10, 20, 30, 255]) }),
      0,
      0,
    );
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith("save_weekly_progress_image", {
      root,
      weekStart: record.weekStart,
      bytes: Array.from(png),
    });
    expect(close).toHaveBeenCalledOnce();
    expect(canvas.width).toBe(0);
  });

  it("checks clipboard dimensions before allocating its RGBA buffer and always releases its handle", async () => {
    const close = vi.fn();
    const rgba = vi.fn();
    mocks.readImage.mockResolvedValue({ size: async () => ({ width: 6000, height: 6000 }), rgba, close });
    await expect(pasteWeeklyImage(root, record)).rejects.toThrow("weekly.imageTooLarge");
    expect(rgba).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});
