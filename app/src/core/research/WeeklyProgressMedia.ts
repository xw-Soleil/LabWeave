import { invoke } from "@tauri-apps/api/core";
import { readImage } from "@tauri-apps/plugin-clipboard-manager";
import { open } from "@tauri-apps/plugin-dialog";
import { lstat, readFile } from "@tauri-apps/plugin-fs";
import { resolveWeeklyLinkPath, type WeeklyLink, type WeeklyRecord } from "./WeeklyProgress";

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_PIXELS = 25_000_000;
const MAX_IMPORT = 12;
const failure = (code: string, cause?: unknown) => new Error(`weekly.${code}`, { cause });
const aborted = (signal?: AbortSignal) => {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
};

async function command<T>(name: string, args: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(name, args);
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error));
  }
}

function checkSize(width: number, height: number) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || width * height > MAX_PIXELS)
    throw failure("imageTooLarge");
}

function imageMetadata(bytes: Uint8Array): { type: string; width: number; height: number } {
  if (bytes.length > MAX_BYTES) throw failure("imageTooLarge");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let type = "";
  let width = 0;
  let height = 0;
  if (
    bytes.length >= 33 &&
    bytes.slice(0, 8).every((value, index) => value === [137, 80, 78, 71, 13, 10, 26, 10][index]) &&
    view.getUint32(8) === 13 &&
    view.getUint32(12) === 0x49484452
  ) {
    type = "image/png";
    width = view.getUint32(16);
    height = view.getUint32(20);
  } else if (bytes[0] === 255 && bytes[1] === 216) {
    let offset = 2;
    while (offset + 3 < bytes.length) {
      if (bytes[offset] !== 255) break;
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 1 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > bytes.length) break;
      const length = view.getUint16(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if (
        [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) &&
        length >= 8
      ) {
        type = "image/jpeg";
        width = view.getUint16(offset + 5);
        height = view.getUint16(offset + 3);
        break;
      }
      offset += length;
    }
  } else if (bytes.length >= 25 && view.getUint32(0) === 0x52494646 && view.getUint32(8) === 0x57454250) {
    const little24 = (offset: number) => bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
    const chunk = view.getUint32(12);
    if (chunk === 0x56503858 && bytes.length >= 30) {
      width = little24(24) + 1;
      height = little24(27) + 1;
    } else if (chunk === 0x5650384c && bytes[20] === 0x2f) {
      const bits = view.getUint32(21, true);
      width = (bits & 0x3fff) + 1;
      height = ((bits >>> 14) & 0x3fff) + 1;
    } else if (
      chunk === 0x56503820 &&
      bytes.length >= 30 &&
      bytes[23] === 0x9d &&
      bytes[24] === 1 &&
      bytes[25] === 0x2a
    ) {
      width = view.getUint16(26, true) & 0x3fff;
      height = view.getUint16(28, true) & 0x3fff;
    }
    if (width && height) type = "image/webp";
  }
  if (!type) throw failure("imageUnsupported");
  checkSize(width, height);
  return { type, width, height };
}

async function decodeImage(bytes: Uint8Array) {
  const metadata = imageMetadata(bytes);
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: metadata.type }));
  } catch (cause) {
    throw failure("imageUnsupported", cause);
  }
  try {
    checkSize(bitmap.width, bitmap.height);
  } catch (error) {
    bitmap.close();
    throw error;
  }
  return bitmap;
}

function relativeLink(record: WeeklyRecord, target: string, label: string): WeeklyLink {
  const from = record.path.split("/").slice(0, -1);
  const to = target.split("/");
  while (from.length && to.length && from[0].toLowerCase() === to[0].toLowerCase()) {
    from.shift();
    to.shift();
  }
  const href = [...from.map(() => ".."), ...to].map(encodeURIComponent).join("/");
  if (!resolveWeeklyLinkPath(record.path, href)) throw failure("unsafeLink");
  return { label, href };
}

async function projectBytes(root: string, path: string): Promise<Uint8Array> {
  return new Uint8Array(await command<number[]>("read_weekly_progress_image", { root, path }));
}

async function storeImage(
  root: string,
  record: WeeklyRecord,
  bytes: Uint8Array,
  label: string,
  signal?: AbortSignal,
): Promise<WeeklyLink> {
  aborted(signal);
  const path = await command<string>("save_weekly_progress_image", {
    root,
    weekStart: record.weekStart,
    bytes: Array.from(bytes),
  });
  aborted(signal);
  return relativeLink(record, path, label);
}

export async function importWeeklyImages(
  root: string,
  record: WeeklyRecord,
  signal?: AbortSignal,
): Promise<WeeklyLink[]> {
  aborted(signal);
  const chosen = await open({
    directory: false,
    multiple: true,
    filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp"] }],
  });
  aborted(signal);
  if (!chosen) return [];
  const paths = [...new Set(Array.isArray(chosen) ? chosen : [chosen])];
  if (paths.length > MAX_IMPORT) throw failure("tooManyImages");
  const normalizedRoot = root.replace(/\\/g, "/").replace(/\/+$/, "");
  const prepared: { bytes: Uint8Array; path?: string; label: string }[] = [];
  for (const source of paths) {
    aborted(signal);
    if (!/\.(png|jpe?g|webp)$/i.test(source)) throw failure("imageUnsupported");
    const normalized = source.replace(/\\/g, "/");
    const internal = normalized.toLowerCase().startsWith(`${normalizedRoot.toLowerCase()}/`);
    const path = internal ? normalized.slice(normalizedRoot.length + 1) : undefined;
    let bytes: Uint8Array;
    if (path) bytes = await projectBytes(root, path);
    else {
      try {
        const info = await lstat(source);
        aborted(signal);
        if (!info.isFile || info.isSymlink) throw failure("imageReadFailed");
        if (info.size > MAX_BYTES) throw failure("imageTooLarge");
        bytes = await readFile(source);
      } catch (error) {
        aborted(signal);
        if (error instanceof Error && error.message.startsWith("weekly.")) throw error;
        throw failure("imageReadFailed", error);
      }
    }
    aborted(signal);
    const bitmap = await decodeImage(bytes);
    bitmap.close();
    aborted(signal);
    prepared.push({ bytes, path, label: normalized.split("/").at(-1) || "Image" });
  }
  const links: WeeklyLink[] = [];
  // Validate every selected file before creating attachments, so an unsupported selection does not partly import.
  for (const item of prepared) {
    aborted(signal);
    links.push(
      item.path
        ? relativeLink(record, item.path, item.label)
        : await storeImage(root, record, item.bytes, item.label, signal),
    );
  }
  return links.filter((link, index) => links.findIndex((other) => other.href === link.href) === index);
}

function pngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(failure("imageUnsupported"))), "image/png"),
  );
}

export async function pasteWeeklyImage(
  root: string,
  record: WeeklyRecord,
  signal?: AbortSignal,
): Promise<WeeklyLink | undefined> {
  aborted(signal);
  let image: Awaited<ReturnType<typeof readImage>>;
  try {
    image = await readImage();
  } catch (cause) {
    aborted(signal);
    if (/clipboard.*(?:empty|not available|does not contain)|requested format|no image/i.test(String(cause)))
      return undefined;
    throw failure("clipboardImageFailed", cause);
  }
  const canvas = document.createElement("canvas");
  try {
    aborted(signal);
    const { width, height } = await image.size();
    aborted(signal);
    if (width <= 0 || height <= 0) return undefined;
    checkSize(width, height);
    const bytes = await image.rgba();
    aborted(signal);
    if (bytes.length !== width * height * 4) throw failure("clipboardImageFailed");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw failure("clipboardImageFailed");
    context.putImageData(new ImageData(new Uint8ClampedArray(bytes), width, height), 0, 0);
    const png = new Uint8Array(await (await pngBlob(canvas)).arrayBuffer());
    aborted(signal);
    imageMetadata(png);
    return await storeImage(root, record, png, "clipboard.png", signal);
  } finally {
    canvas.width = canvas.height = 0;
    await image.close();
  }
}

/** Returns a bounded PNG data URL; callers do not need to manage object URL lifetimes. */
export async function loadWeeklyImagePreview(root: string, record: WeeklyRecord, link: WeeklyLink): Promise<string> {
  const resolved = resolveWeeklyLinkPath(record.path, link.href);
  if (!resolved || resolved.fragment) throw failure("unsafeLink");
  const bytes = await projectBytes(root, resolved.path);
  const bitmap = await decodeImage(bytes);
  const canvas = document.createElement("canvas");
  try {
    const scale = Math.min(1, 640 / Math.max(bitmap.width, bitmap.height));
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw failure("imageReadFailed");
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await pngBlob(canvas);
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(failure("imageReadFailed", reader.error));
      reader.readAsDataURL(blob);
    });
  } finally {
    bitmap.close();
    canvas.width = canvas.height = 0;
  }
}
