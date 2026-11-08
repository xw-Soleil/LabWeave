import { Settings } from "@/core/service/Settings";
import { DEFAULT_FONT_FAMILY, MAC_DEFAULT_FONT_FAMILY } from "@/core/service/ProjectToolSettingsSchema";
import { MaxSizeCache, Vector } from "@graphif/data-structures";
import { wrapTextByCharacters } from "./textWrapping";

const _canvas = document.createElement("canvas");
const _context = _canvas.getContext("2d");

const _cache = new MaxSizeCache<string, number>(10000);
const _fontDescriptorCache = new MaxSizeCache<string, string>(100);
const REFERENCE_FONT_SIZE = 100;
const canvasFonts = new WeakMap<CanvasRenderingContext2D, { requested: string; actual: string }>();

export function setCanvasFont(context: CanvasRenderingContext2D, font: string): void {
  const previous = canvasFonts.get(context);
  const actual = context.font;
  // Canvas 会将 normal 字重、引号等规范化，不能直接与请求字符串比较。
  // 仍需检查实际状态，因为其他绘制代码和 restore() 都可能改变字体。
  if (previous?.requested === font && previous.actual === actual) return;
  if (actual !== font) context.font = font;
  canvasFonts.set(context, { requested: font, actual: context.font });
}
const isCanvasFontLoaded = () =>
  document.fonts
    ? Array.from(document.fonts).some(
        (face) => face.family.replaceAll('"', "") === "Project Graph Canvas" && face.status === "loaded",
      )
    : false;
let bundledCanvasFontReady = isCanvasFontLoaded();
document.fonts?.addEventListener("loadingdone", () => {
  bundledCanvasFontReady = isCanvasFontLoaded();
});

export function getFontIdentity(fontFamily?: string, fontWeight?: string): string {
  return JSON.stringify([
    fontWeight || "normal",
    fontFamily || Settings.defaultFontFamily,
    isBundledCanvasFont(fontFamily) && bundledCanvasFontReady,
  ]);
}

export function isBundledCanvasFont(fontFamily?: string, fontWeight?: string): boolean {
  // 桌面端不使用 MSDF，也不替换系统字体，避免异步字体加载后节点尺寸与文字脱节。
  if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) return false;
  return (
    !fontFamily &&
    (!fontWeight || fontWeight === "normal" || fontWeight === "400") &&
    (Settings.defaultFontFamily === DEFAULT_FONT_FAMILY || Settings.defaultFontFamily === MAC_DEFAULT_FONT_FAMILY)
  );
}

export function resolveFontFamily(fontFamily?: string, fontWeight?: string): string {
  const cacheKey = getFontIdentity(fontFamily, fontWeight);
  const cached = _fontDescriptorCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const resolvedFamily = fontFamily
    ? `"${fontFamily}"`
    : isBundledCanvasFont(fontFamily, fontWeight)
      ? `"Project Graph Canvas", ${Settings.defaultFontFamily}`
      : Settings.defaultFontFamily;
  _fontDescriptorCache.set(cacheKey, resolvedFamily);
  return resolvedFamily;
}

/**
 * 解析字体字符串，支持自定义字体族和字重
 * @param fontSize 字体大小
 * @param fontFamily 自定义字体族，空字符串或 undefined 时使用全局默认字体
 * @param fontWeight 自定义字重，空字符串或 undefined 时使用 normal
 */
export function resolveFont(fontSize: number, fontFamily?: string, fontWeight?: string): string {
  return `${fontWeight || "normal"} ${fontSize}px ${resolveFontFamily(fontFamily, fontWeight)}`;
}

// eslint-disable-next-line prefer-const
let useCache = true;
/**
 * 测量文本的宽度（高度不测量）
 * 不要在循环中调用，会影响性能
 * @param text
 * @param size
 * @returns
 */
export function getTextSize(text: string, size: number, fontFamily?: string, fontWeight?: string): Vector {
  const cacheKey = JSON.stringify([text, getFontIdentity(fontFamily, fontWeight)]);
  if (useCache) {
    const referenceWidth = _cache.get(cacheKey);
    if (referenceWidth !== undefined) {
      return new Vector((referenceWidth * size) / REFERENCE_FONT_SIZE, size);
    }
  }

  if (!_context) {
    throw new Error("Failed to get canvas context");
  }

  setCanvasFont(_context, resolveFont(REFERENCE_FONT_SIZE, fontFamily, fontWeight));
  const metrics = _context.measureText(text);
  if (useCache) {
    _cache.set(cacheKey, metrics.width);
  }

  return new Vector((metrics.width * size) / REFERENCE_FONT_SIZE, size);
}

/**
 * 获取多行文本的宽度和高度
 * @param text
 * @param fontSize
 * @param lineHeight 行高，是一个比率
 * @returns
 */
export function getMultiLineTextSize(
  text: string,
  fontSize: number,
  lineHeight: number,
  _limitWidth?: number,
  fontFamily?: string,
  fontWeight?: string,
): Vector {
  const lines = text.split("\n");
  let width = 0;
  let height = 0;
  for (const line of lines) {
    const size = getTextSize(line, fontSize, fontFamily, fontWeight);
    width = Math.max(width, size.x);
    height += size.y * lineHeight;
  }
  return new Vector(width, height);
}

/**
 * 隐私保护文本替换
 * 根据设置的保护模式进行不同的替换
 * @param text
 */
export function replaceTextWhenProtect(text: string) {
  // 检查是否设置了保护模式，如果没有，默认为secretWord
  const mode = Settings.protectingPrivacyMode || "secretWord";

  if (mode === "caesar") {
    // 凯撒移位加密：所有字符往后移动一位
    return text
      .split("")
      .map((char) => {
        const code = char.charCodeAt(0);

        // 对于可打印ASCII字符进行移位
        if (code >= 32 && code <= 126) {
          // 特殊处理：'z' 移到 'a'，'Z' 移到 'A'，'9' 移到 '0'
          if (char === "z") return "a";
          if (char === "Z") return "A";
          if (char === "9") return "0";
          // 其他字符直接 +1
          return String.fromCharCode(code + 1);
        }

        // 对于中文字符，进行移位加密
        if (code >= 0x4e00 && code <= 0x9fa5) {
          // 中文字符在Unicode范围内循环移位
          // 0x4e00是汉字起始，0x9fa5是汉字结束，总共约20902个汉字
          const shiftedCode = code + 1;
          // 如果超过汉字范围，则回到起始位置
          return String.fromCharCode(shiftedCode <= 0x9fa5 ? shiftedCode : 0x4e00);
        }

        // 其他字符保持不变
        return char;
      })
      .join("");
  }

  // 默认的secretWord模式
  return text
    .replace(/[\u4e00-\u9fa5]/g, "㊙")
    .replace(/[a-z]/g, "a")
    .replace(/[A-Z]/g, "A")
    .replace(/\d/g, "6");
}

export function camelCaseToDashCase(text: string) {
  return text.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase();
}

/**
 * 将文本按宽度限制分割成多行数组
 * 遇到宽度限制或换行符时进行换行
 * @param text 原始文本
 * @param fontSize 字体大小
 * @param limitWidth 宽度限制
 * @returns 分割后的行数组
 */
export function textToTextArray(
  text: string,
  fontSize: number,
  limitWidth: number,
  fontFamily?: string,
  fontWeight?: string,
): string[] {
  return wrapTextByCharacters(text, limitWidth, (part) => getTextSize(part, fontSize, fontFamily, fontWeight).x);
}

/** 量一段文字的宽度；排版函数不直接依赖 Canvas，测试里可以换成假的 */
export type MeasureText = (text: string) => number;

export const ELLIPSIS = "…";

/** 不能出现在行首的标点：跟着前一个字走 */
const NO_LINE_START = new Set(Array.from("，。、；：？！）》」』】〕〉…,.;:?!)]}%’”"));
/** 不能出现在行尾的标点：跟着后一个字走 */
const NO_LINE_END = new Set(Array.from("（《「『【〔〈([{‘“"));
/** 中日韩文字和全角标点：任意两个字之间都能换行 */
const CJK_CHARACTER =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u{3000}-\u{303f}\u{ff00}-\u{ffef}]/u;

function isOpeningOnly(text: string): boolean {
  return text.length > 0 && Array.from(text).every((character) => NO_LINE_END.has(character));
}

/**
 * 把一段（不含换行）切成不可再分的小块，块与块之间可以换行：
 * 拉丁文在空格、「_」「-」之后断开，中日韩文字每个字一块。
 */
function splitIntoBreakableTokens(paragraph: string): string[] {
  const tokens: string[] = [];
  let current = "";
  const flush = () => {
    if (current) tokens.push(current);
    current = "";
  };
  for (const character of paragraph) {
    if (NO_LINE_START.has(character)) {
      if (current) current += character;
      else if (tokens.length > 0) tokens[tokens.length - 1] += character;
      else current = character;
      if (CJK_CHARACTER.test(character)) flush();
    } else if (NO_LINE_END.has(character)) {
      if (!isOpeningOnly(current)) flush();
      current += character;
    } else if (character === " " || character === "\t" || character === "-" || character === "_") {
      current += character;
      flush();
    } else if (CJK_CHARACTER.test(character)) {
      if (!isOpeningOnly(current)) flush();
      current += character;
      flush();
    } else {
      current += character;
    }
  }
  flush();
  return tokens;
}

/** 二分找最长的前缀（按码点），使 measure(前缀) 不超过 limitWidth；一个字都放不下时返回 0 */
function longestFittingPrefix(characters: string[], limitWidth: number, measure: (length: number) => number): number {
  let low = 0;
  let high = characters.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (measure(middle) <= limitWidth) low = middle;
    else high = middle - 1;
  }
  return low;
}

/**
 * 按词折行：拉丁文优先在空格、「_」「-」处换行，中日韩文字可以在任意两个字之间换行；
 * 单个词比一整行还长时才按字符硬断。行首空格去掉，行尾空格不计宽度。
 * @param maxLines 最多排这么多行，排满还有剩余时 truncated 为 true（剩下的不再排，省去测量）
 */
export function wrapTextByWords(
  text: string,
  limitWidth: number,
  measure: MeasureText,
  maxLines: number = Infinity,
): { lines: string[]; truncated: boolean } {
  const lines: string[] = [];
  /** 再放一行就超过 maxLines 时返回 false */
  const push = (line: string): boolean => {
    if (lines.length >= maxLines) return false;
    lines.push(line.trimEnd());
    return true;
  };
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const token of splitIntoBreakableTokens(paragraph)) {
      const candidate = line + token;
      if (measure(candidate.trimEnd()) <= limitWidth) {
        line = candidate;
        continue;
      }
      if (line.trim() && !push(line)) return { lines, truncated: true };
      let rest = token.trimStart();
      while (rest && measure(rest.trimEnd()) > limitWidth) {
        const characters = Array.from(rest);
        const length = Math.max(
          1,
          longestFittingPrefix(characters, limitWidth, (n) => measure(characters.slice(0, n).join(""))),
        );
        if (!push(characters.slice(0, length).join(""))) return { lines, truncated: true };
        rest = characters.slice(length).join("").trimStart();
      }
      line = rest;
    }
    if (!push(line)) return { lines, truncated: true };
  }
  return { lines, truncated: false };
}

/**
 * 放不下时截短并在末尾加「…」，保证 `结果` 的宽度不超过 limitWidth。
 * @param force 为 true 时即使放得下也加「…」（后面还有被截掉的行）
 */
export function ellipsizeEnd(text: string, limitWidth: number, measure: MeasureText, force: boolean = false): string {
  if (!force && measure(text) <= limitWidth) return text;
  const characters = Array.from(text);
  const withEllipsis = (length: number) => characters.slice(0, length).join("").trimEnd() + ELLIPSIS;
  const length = longestFittingPrefix(characters, limitWidth, (n) => measure(withEllipsis(n)));
  if (length > 0) return withEllipsis(length);
  return measure(ELLIPSIS) <= limitWidth ? ELLIPSIS : "";
}

/**
 * 按词折行，最多 maxLines 行；后面还有内容时，最后一行截短到加上「…」也放得下。
 */
export function clampTextLines(text: string, limitWidth: number, maxLines: number, measure: MeasureText): string[] {
  if (maxLines <= 0) return [];
  const { lines, truncated } = wrapTextByWords(text, limitWidth, measure, maxLines);
  if (truncated && lines.length > 0) {
    lines[lines.length - 1] = ellipsizeEnd(lines[lines.length - 1], limitWidth, measure, true);
  }
  return lines;
}

export interface MiddleEllipsisParts {
  /** 原样保留在最前面，比如提示语里文件名前面的话 */
  head?: string;
  /** 放不下时从中间删字 */
  body: string;
  /** 原样保留在最后面，比如扩展名 */
  tail?: string;
}

/**
 * 中间省略：head、tail 原样保留，只删 body 中间的字换成「…」（前面多留一点）。
 * 连「head…tail」都放不下时，整段从末尾截短。
 */
export function ellipsizeMiddle(
  { head = "", body, tail = "" }: MiddleEllipsisParts,
  limitWidth: number,
  measure: MeasureText,
): string {
  const full = head + body + tail;
  if (measure(full) <= limitWidth) return full;
  const characters = Array.from(body);
  const build = (keep: number) => {
    const front = Math.ceil(keep / 2);
    const back = keep - front;
    return (
      head +
      characters.slice(0, front).join("").trimEnd() +
      ELLIPSIS +
      characters
        .slice(characters.length - back)
        .join("")
        .trimStart() +
      tail
    );
  };
  if (measure(build(0)) > limitWidth) return ellipsizeEnd(full, limitWidth, measure);
  const searchable = characters.slice(0, -1);
  return build(longestFittingPrefix(searchable, limitWidth, (n) => measure(build(n))));
}
