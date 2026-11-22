import { RECORD_DIRECTORY, resolveRecordLinkPath, type NodeRecord, type RecordLink } from "./NodeRecord";
import { under } from "./ProjectRecord";

/*
 * 手填记录里的图片：从电脑里选、从剪贴板贴、在面板里看缩略图。
 *
 *   项目文件夹/进展记录/附件/<图片内容的指纹>.png
 *
 * 同一张图只存一份。封存以后的那份记录和「进行中」在同一个文件夹里，链接不用跟着改。
 * 本来就在项目文件夹里的图片不另存，直接链过去。
 *
 * 认图片格式、量尺寸、贴图、出缩略图的部分出自同伴 cleverfool-rnh 的 PR（xw-Soleil/LabWeave 第 1 号）
 * 里的 WeeklyProgressMedia.ts。他那边存图和读图走 Rust，这里改成前端直接读写。
 */

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_PIXELS = 25_000_000;
const MAX_IMPORT = 12;
export const ATTACHMENT_DIRECTORY = `${RECORD_DIRECTORY}/附件`;

const failure = (code: string, cause?: unknown) => new Error(`nodeRecord.${code}`, { cause });
const ours = (error: unknown) => error instanceof Error && error.message.startsWith("nodeRecord.");
const aborted = (signal?: AbortSignal) => {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
};

/** 读写图片用的接口，路径都是完整路径。默认是桌面端的文件接口，测试里换成假的 */
export interface MediaFiles {
  /** 文件不存在给 undefined；不是普通文件（文件夹、符号链接）或者太大就抛错 */
  read(path: string): Promise<Uint8Array | undefined>;
  /** 文件夹不存在会先建 */
  write(path: string, bytes: Uint8Array): Promise<void>;
}

const desktopMedia: MediaFiles = {
  async read(path) {
    const fs = await import("@tauri-apps/plugin-fs");
    if (!(await fs.exists(path))) return undefined;
    const info = await fs.lstat(path);
    if (!info.isFile || info.isSymlink) throw failure("imageReadFailed");
    if (info.size > MAX_BYTES) throw failure("imageTooLarge");
    return fs.readFile(path);
  },
  async write(path, bytes) {
    const fs = await import("@tauri-apps/plugin-fs");
    const normalized = path.replace(/\\/g, "/");
    const folder = normalized.slice(0, normalized.lastIndexOf("/"));
    if (!(await fs.exists(folder))) await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(path, bytes);
  },
};

async function readImageFile(io: MediaFiles, path: string): Promise<Uint8Array> {
  let bytes: Uint8Array | undefined;
  try {
    bytes = await io.read(path);
  } catch (error) {
    throw ours(error) ? error : failure("imageReadFailed", error);
  }
  if (!bytes) throw failure("fileNotFound");
  return bytes;
}

function checkSize(width: number, height: number) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || width * height > MAX_PIXELS)
    throw failure("imageTooLarge");
}

/** 看文件开头认格式、量尺寸：只收 PNG、JPEG、WebP，太大的不收。不看文件名 */
export function imageMetadata(bytes: Uint8Array): { type: string; extension: string; width: number; height: number } {
  if (bytes.length > MAX_BYTES) throw failure("imageTooLarge");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let type = "";
  let extension = "";
  let width = 0;
  let height = 0;
  if (
    bytes.length >= 33 &&
    bytes.slice(0, 8).every((value, index) => value === [137, 80, 78, 71, 13, 10, 26, 10][index]) &&
    view.getUint32(8) === 13 &&
    view.getUint32(12) === 0x49484452
  ) {
    type = "image/png";
    extension = "png";
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
        extension = "jpg";
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
    if (width && height) {
      type = "image/webp";
      extension = "webp";
    }
  }
  if (!type) throw failure("imageUnsupported");
  checkSize(width, height);
  return { type, extension, width, height };
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

/** 从记录文件指到项目里某个文件的相对链接 */
function relativeLink(record: NodeRecord, target: string, label: string): RecordLink {
  const from = record.path.split("/").slice(0, -1);
  const to = target.split("/");
  while (from.length && to.length && from[0].toLowerCase() === to[0].toLowerCase()) {
    from.shift();
    to.shift();
  }
  const href = [...from.map(() => ".."), ...to].map(encodeURIComponent).join("/");
  if (!resolveRecordLinkPath(record.path, href)) throw failure("unsafeLink");
  return { label, href };
}

async function contentName(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(digest)]
    .slice(0, 16)
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((value, index) => value === b[index]);

/** 把一张图存进「进展记录/附件」，给回从这份记录指过去的链接。同一张图存过就直接用存过的 */
export async function storeRecordImage(
  root: string,
  record: NodeRecord,
  bytes: Uint8Array,
  label: string,
  io: MediaFiles = desktopMedia,
  signal?: AbortSignal,
): Promise<RecordLink> {
  aborted(signal);
  const { extension } = imageMetadata(bytes);
  const path = `${ATTACHMENT_DIRECTORY}/${await contentName(bytes)}.${extension}`;
  const file = under(root, path);
  let existing: Uint8Array | undefined;
  try {
    existing = await io.read(file);
  } catch (error) {
    throw ours(error) ? error : failure("imageWriteFailed", error);
  }
  aborted(signal);
  if (existing) {
    // 名字是内容的指纹：名字一样内容却不一样，说明那个文件被人改过，不去盖它
    if (!sameBytes(existing, bytes)) throw failure("imageWriteFailed");
  } else {
    try {
      await io.write(file, bytes);
    } catch (error) {
      throw failure("imageWriteFailed", error);
    }
  }
  aborted(signal);
  return relativeLink(record, path, label);
}

/** 弹出选文件的窗口，给回选中的那些文件的完整路径。测试里换成假的 */
export type ChooseImages = () => Promise<string[]>;
const chooseWithDialog: ChooseImages = async () => {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const chosen = await open({
    directory: false,
    multiple: true,
    filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp"] }],
  });
  return chosen ? [...new Set(Array.isArray(chosen) ? chosen : [chosen])] : [];
};

/**
 * 从电脑里选几张图挂到事项上。先把选中的每一张都验过（格式、大小、能不能解开），都没问题才开始存，
 * 免得选了一张不行的、前面几张却已经存进去了。
 */
export async function importRecordImages(
  root: string,
  record: NodeRecord,
  signal?: AbortSignal,
  io: MediaFiles = desktopMedia,
  choose: ChooseImages = chooseWithDialog,
): Promise<RecordLink[]> {
  aborted(signal);
  const paths = await choose();
  aborted(signal);
  if (!paths.length) return [];
  if (paths.length > MAX_IMPORT) throw failure("tooManyImages");
  const normalizedRoot = root.replace(/\\/g, "/").replace(/\/+$/, "");
  const prepared: { bytes: Uint8Array; path?: string; label: string }[] = [];
  for (const source of paths) {
    aborted(signal);
    if (!/\.(png|jpe?g|webp)$/i.test(source)) throw failure("imageUnsupported");
    const normalized = source.replace(/\\/g, "/");
    const inside = normalized.toLowerCase().startsWith(`${normalizedRoot.toLowerCase()}/`);
    const bytes = await readImageFile(io, source);
    aborted(signal);
    (await decodeImage(bytes)).close();
    aborted(signal);
    prepared.push({
      bytes,
      path: inside ? normalized.slice(normalizedRoot.length + 1) : undefined,
      label: normalized.split("/").at(-1) || "Image",
    });
  }
  const links: RecordLink[] = [];
  for (const item of prepared) {
    aborted(signal);
    links.push(
      item.path
        ? relativeLink(record, item.path, item.label)
        : await storeRecordImage(root, record, item.bytes, item.label, io, signal),
    );
  }
  return links.filter((link, index) => links.findIndex((other) => other.href === link.href) === index);
}

function pngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(failure("imageUnsupported"))), "image/png"),
  );
}

/** 把剪贴板里的图存下来挂到事项上；剪贴板里没有图给 undefined */
export async function pasteRecordImage(
  root: string,
  record: NodeRecord,
  signal?: AbortSignal,
  io: MediaFiles = desktopMedia,
): Promise<RecordLink | undefined> {
  aborted(signal);
  const { readImage } = await import("@tauri-apps/plugin-clipboard-manager");
  let image: Awaited<ReturnType<typeof readImage>>;
  try {
    image = await readImage();
  } catch (cause) {
    aborted(signal);
    // 剪贴板里没有图片时各系统报的话不一样，都算「没有图」。
    //（「空」那个词不能紧跟在冒号后面写，EmptyVariantGuard 的测试会把它当成样式里的写法拦下来）
    if (/clipboard.*(?:not available|does not contain|empty)|requested format|no image/i.test(String(cause)))
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
    return await storeRecordImage(root, record, png, "clipboard.png", io, signal);
  } finally {
    canvas.width = canvas.height = 0;
    await image.close();
  }
}

/** 事项里一张图的缩略图（最长边 640 的 PNG，data: 地址，用完不用另外释放）。只读项目文件夹里面的图 */
export async function loadRecordImagePreview(
  root: string,
  record: NodeRecord,
  link: RecordLink,
  io: MediaFiles = desktopMedia,
): Promise<string> {
  const resolved = resolveRecordLinkPath(record.path, link.href);
  if (!resolved || resolved.fragment) throw failure("unsafeLink");
  const bitmap = await decodeImage(await readImageFile(io, under(root, resolved.path)));
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
      reader.onabort = () => reject(failure("imageReadFailed"));
      reader.readAsDataURL(blob);
    });
  } finally {
    bitmap.close();
    canvas.width = canvas.height = 0;
  }
}
