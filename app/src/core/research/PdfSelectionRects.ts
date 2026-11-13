import { boundingRect, type PdfPageGeometry, type Rect } from "@embedpdf/models";

/**
 * 选中文字的框，按行自己算。
 *
 * 引擎（PDFium）给每个字两个框：贴着字形的「紧框」，和按字体自己声明的上下高度算的「松框」。
 * 选区插件拿松框拼选区，可有的字体声明的高度是字号的三四倍（比如 Elsevier 用的 Charis SIL），
 * 选出来的蓝块就比字高出一大截，相邻几行还叠在一起。引擎报的字号也不能全信：有的 PDF 写的是
 * 「字号 1，再整体放大」。
 *
 * 这里的办法：同一种字体里，基线和字顶在松框里的位置是固定的。把这一页上同一种字的松框和紧框
 * 一比，就知道基线在松框底往上多少、字顶在松框顶往下多少；于是每段文字都能从自己的松框定出
 * 「基线 + 字高」，行框按字高留固定比例的余量。同一行统一成一个框，相邻行不重叠。
 * Zotero 的思路一样（按字号比例取、同一行统一），只是它能直接拿到真实字号。
 */

type Run = PdfPageGeometry["runs"][number];
type Glyph = Run["glyphs"][number];

interface Band {
  top: number;
  bottom: number;
}
/** 一页的行：lineOf 是每一段文字属于第几行，bands 是每行的上下边（算不出来的行留空，用松框） */
interface Layout {
  lineOf: number[];
  bands: (Band | undefined)[];
}

const layouts = new WeakMap<PdfPageGeometry, Layout>();

/** flags：0 是普通的字，1 是空格，2 是不占位置的空字符 */
const isInk = (glyph: Glyph) => glyph.flags === 0;
const hasTight = (glyph: Glyph) => glyph.tightY !== undefined && glyph.tightHeight !== undefined;
const inkTop = (glyph: Glyph) => glyph.tightY ?? glyph.y;
const inkBottom = (glyph: Glyph) => inkTop(glyph) + (glyph.tightHeight ?? glyph.height);
const ascending = (values: number[]) => values.sort((a, b) => a - b);
/** 排好序的一组数里，排在第 share 成位置上的那个 */
const at = (sorted: number[], share: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))];
/** 排好序的一组数里，从第 from 成到第 to 成那一段的平均。框是取整到 1pt 的，平均一下比取一个数准 */
const middle = (sorted: number[], from: number, to: number) => {
  const part = sorted.slice(Math.floor(sorted.length * from), Math.max(1, Math.ceil(sorted.length * to)));
  return part.reduce((sum, value) => sum + value, 0) / part.length;
};
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
/** 按宽度投票：占了一半宽度的那个值 */
function majority(votes: { value: number; weight: number }[]) {
  votes.sort((a, b) => a.value - b.value);
  let left = votes.reduce((sum, vote) => sum + vote.weight, 0) / 2;
  for (const vote of votes) if ((left -= vote.weight) <= 0) return vote.value;
  return votes.at(-1)!.value;
}

// 行框相对字高（基线到 b、d、大写字母顶）的余量：顶上多留两成，底下盖住 g、p 的尾巴再多一点
const ABOVE = 1.22;
const BELOW_EXTRA = 0.15;
const BELOW_MIN = 0.25;
const BELOW_MAX = 0.48;
// 相邻两行的框离得这么近（或叠了这么多）就在中间对半分，连成一片。
// 单倍到 1.4 倍行距都会连上；1.5 倍行距以上隔得远，各画各的
const JOIN = 0.35;
const SPLIT = 0.35;
// 这种字在这一页上出现得够多，才信从它身上学到的位置
const ENOUGH = 12;

function layout(geo: PdfPageGeometry): Layout {
  const cached = layouts.get(geo);
  if (cached) return cached;

  const runs = geo.runs.map((run) => {
    const ink = run.glyphs.filter(isInk);
    const tops = ink.map((glyph) => glyph.y);
    const bottoms = ink.map((glyph) => glyph.y + glyph.height);
    return {
      ink,
      // 横排的一段，每个字的松框上下边是同一条线。竖排、斜排的不是，这种不动，仍用松框
      level:
        ink.length > 0 &&
        ink.every(hasTight) &&
        Math.max(...tops) - Math.min(...tops) <= 1 &&
        Math.max(...bottoms) - Math.min(...bottoms) <= 1,
      // 同一种字：引擎报的字号和松框高度都一样。只看字号不够，「字号 1 再放大」的 PDF 里所有字都是 1
      style: `${run.fontSize ?? 0}:${ink[0]?.height ?? 0}`,
      width: ink.reduce((sum, glyph) => sum + glyph.width, 0),
    };
  });

  // 一、每种字：基线在松框底往上多少（descent），字高多少（rise），尾巴多深（depth）
  const samples = new Map<string, { below: number[]; above: number[]; height: number }>();
  for (const run of runs) {
    if (!run.level) continue;
    const sample = samples.get(run.style) ?? { below: [], above: [], height: run.ink[0].height };
    samples.set(run.style, sample);
    for (const glyph of run.ink) {
      sample.below.push(glyph.y + glyph.height - inkBottom(glyph));
      sample.above.push(inkTop(glyph) - glyph.y);
    }
  }
  const metrics = new Map<string, { descent: number; rise: number; depth: number }>();
  for (const [name, { below, above, height }] of samples) {
    if (below.length < ENOUGH) continue;
    ascending(below);
    ascending(above);
    // 多数字的底边落在基线上；g、p 的尾巴更低，撇号、连字符更高，都是少数
    const descent = middle(below, 0.3, 0.7);
    // 最高的那批字（b、d、大写、数字），英文里占三成上下；括号还要高一点，排在最前面百分之几里
    const rise = height - descent - middle(above, 0.05, 0.18);
    if (rise >= 1) metrics.set(name, { descent, rise, depth: Math.max(0, descent - at(below, 0.03)) });
  }
  const own = runs.map((run): Band | undefined => {
    const metric = run.level ? metrics.get(run.style) : undefined;
    if (!metric) return undefined;
    const baseline = run.ink[0].y + run.ink[0].height - metric.descent;
    return {
      top: baseline - ABOVE * metric.rise,
      bottom:
        baseline + clamp(metric.depth + BELOW_EXTRA * metric.rise, BELOW_MIN * metric.rise, BELOW_MAX * metric.rise),
    };
  });

  // 二、归行：一段文字的字有一半落在前面那一行的范围里，就是同一行（上下标跟着正文那一行）。
  // 范围用上面算的框，没有才用字本身：整行没有 g、p 时字的底边就是基线，下标会落到外面去
  const lineOf: number[] = [];
  const lines: { runs: number[]; top: number; bottom: number; from: number; to: number }[] = [];
  runs.forEach(({ ink }, index) => {
    const current = lines.at(-1);
    if (ink.length) {
      const top = Math.min(...ink.map(inkTop));
      const bottom = Math.max(...ink.map(inkBottom));
      const from = Math.min(top, own[index]?.top ?? top);
      const to = Math.max(bottom, own[index]?.bottom ?? bottom);
      const shared = current ? Math.min(bottom, current.to) - Math.max(top, current.from) : -1;
      if (current && shared >= 0.5 * Math.min(bottom - top, current.to - current.from)) {
        current.runs.push(index);
        current.top = Math.min(current.top, top);
        current.bottom = Math.max(current.bottom, bottom);
        current.from = Math.min(current.from, from);
        current.to = Math.max(current.to, to);
      } else lines.push({ runs: [index], top, bottom, from, to });
    }
    // 只有空格的一段跟着前面那一行
    lineOf[index] = lines.length - 1;
  });

  // 三、每行一个框：各段按宽度投票（正文压过上下标和夹在里面的别的字体），再保证盖住这一行所有的字
  const bands = lines.map((line): Band | undefined => {
    if (line.runs.some((index) => !runs[index].level)) return undefined;
    const voters = line.runs.filter((index) => own[index]);
    if (!voters.length) {
      // 这一行的字体在这一页上太少，学不出位置（图里的刻度、页码）：贴着字留一点边
      const pad = Math.max(1, 0.2 * (line.bottom - line.top));
      return { top: line.top - pad, bottom: line.bottom + pad };
    }
    const vote = (side: "top" | "bottom") =>
      majority(voters.map((index) => ({ value: own[index]![side], weight: runs[index].width })));
    return { top: Math.min(vote("top"), line.top - 0.5), bottom: Math.max(vote("bottom"), line.bottom + 0.5) };
  });

  // 四、上下相邻的两行：离得近或稍微叠着，就在中间对半分。分界线不切进任何一行的字里；
  // 两行的字本身上下交错的（大括号、积分号伸到了下一行）就不分，让两个框叠着
  for (let index = 1; index < bands.length; index++) {
    const above = bands[index - 1];
    const below = bands[index];
    if (!above || !below || below.top <= above.top || below.bottom <= above.bottom) continue;
    const gap = below.top - above.bottom;
    const height = Math.min(above.bottom - above.top, below.bottom - below.top);
    const inkEnd = lines[index - 1].bottom;
    const inkStart = lines[index].top;
    if (gap > JOIN * height || -gap > SPLIT * height || inkEnd > inkStart) continue;
    above.bottom = below.top = clamp((above.bottom + below.top) / 2, inkEnd, inkStart);
  }

  const result = { lineOf, bands };
  layouts.set(geo, result);
  return result;
}

interface Piece {
  left: number;
  right: number;
  top: number;
  bottom: number;
  /** 属于第几行；这一行没算出框（用的是松框）时是 -1 */
  line: number;
  count: number;
}

const average = (piece: Piece) => (piece.right - piece.left) / piece.count;
const near = (a: Piece, b: Piece) =>
  a.left - average(a) < b.right + average(b) && a.right + average(a) > b.left - average(b);
/** 松框的两块算不算同一行：上下重叠八成以上（和选区插件原来的判断一样） */
function overlapping(a: Piece, b: Piece) {
  const union = Math.max(a.bottom, b.bottom) - Math.min(a.top, b.top);
  if (union === a.bottom - a.top || union === b.bottom - b.top) return true;
  return (Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)) / union >= 0.8;
}

/** 这一页上第 from 到第 to 个字（两头都算）选中后的框：一行一条 */
export function selectionRects(geo: PdfPageGeometry, from: number, to: number): Rect[] {
  const { lineOf, bands } = layout(geo);
  const pieces: Piece[] = [];
  geo.runs.forEach((run, index) => {
    const start = Math.max(from, run.charStart) - run.charStart;
    const end = Math.min(to, run.charStart + run.glyphs.length - 1) - run.charStart;
    const band = bands[lineOf[index]];
    let piece: Piece | undefined;
    let widths = 0;
    let previousRight = 0;
    for (let i = start; i <= end; i++) {
      const glyph = run.glyphs[i];
      if (glyph.flags === 2) continue;
      // 同一段里隔得远的字（表格的两栏）分成两块，中间的空白不涂
      if (piece && widths > 0 && Math.abs(glyph.x - previousRight) > 2.5 * (widths / piece.count)) piece = undefined;
      if (!piece) {
        piece = {
          left: glyph.x,
          right: glyph.x + glyph.width,
          top: band?.top ?? glyph.y,
          bottom: band?.bottom ?? glyph.y + glyph.height,
          line: band ? lineOf[index] : -1,
          count: 0,
        };
        pieces.push(piece);
        widths = 0;
      }
      piece.left = Math.min(piece.left, glyph.x);
      piece.right = Math.max(piece.right, glyph.x + glyph.width);
      if (!band) {
        piece.top = Math.min(piece.top, glyph.y);
        piece.bottom = Math.max(piece.bottom, glyph.y + glyph.height);
      }
      piece.count++;
      widths += glyph.width;
      previousRight = glyph.x + glyph.width;
    }
  });

  const merged: Piece[] = [];
  let previous: Piece | undefined;
  for (const piece of pieces) {
    const current = merged.at(-1);
    const sameRow =
      previous && (piece.line >= 0 ? piece.line === previous.line : previous.line < 0 && overlapping(previous, piece));
    if (current && previous && sameRow && near(previous, piece)) {
      current.left = Math.min(current.left, piece.left);
      current.right = Math.max(current.right, piece.right);
      current.top = Math.min(current.top, piece.top);
      current.bottom = Math.max(current.bottom, piece.bottom);
      current.count += piece.count;
    } else merged.push({ ...piece });
    previous = piece;
  }
  return merged.map((piece) => ({
    origin: { x: piece.left, y: piece.top },
    size: { width: piece.right - piece.left, height: piece.bottom - piece.top },
  }));
}

/**
 * 选区插件状态里这里用到的几项。以 selection（现在选中的范围）为准：
 * 清空选区时插件只清 selection 和 rects，slices（每页选中第几个到第几个字）会留着上一次的
 */
export interface SelectionGeometry {
  geometry: Record<number, PdfPageGeometry>;
  selection: { start: { page: number; index: number }; end: { page: number; index: number } } | null;
  rects: Record<number, Rect[]>;
}

/** 现在的选区在这一页上的框；这一页没选中东西就是空的 */
export function pageSelectionRects(state: SelectionGeometry, pageIndex: number): Rect[] {
  const range = state.selection;
  if (!range || pageIndex < range.start.page || pageIndex > range.end.page) return [];
  const geometry = state.geometry[pageIndex];
  const last = geometry?.runs.at(-1);
  // 这一页的文字位置还没读到时，先用插件自己的框
  if (!geometry || !last) return state.rects[pageIndex] ?? [];
  return selectionRects(
    geometry,
    pageIndex === range.start.page ? range.start.index : 0,
    pageIndex === range.end.page ? range.end.index : last.charStart + last.glyphs.length - 1,
  );
}

/** 和选区插件的 getFormattedSelection 一个格式，框换成这里算的。划高亮、摆选区菜单都用它 */
export function formattedSelection(
  state: SelectionGeometry,
): { pageIndex: number; rect: Rect; segmentRects: Rect[] }[] {
  const range = state.selection;
  if (!range) return [];
  return Array.from({ length: range.end.page - range.start.page + 1 }, (_, offset) => {
    const pageIndex = range.start.page + offset;
    const segmentRects = pageSelectionRects(state, pageIndex);
    const rect = boundingRect(segmentRects);
    return rect ? [{ pageIndex, rect, segmentRects }] : [];
  }).flat();
}
