import type { PdfPageGeometry, PdfPageObject, Rect } from "@embedpdf/models";
import { z } from "zod";

export const annotationColors = {
  yellow: "#ffd400",
  red: "#ff6666",
  green: "#5fb236",
  blue: "#2ea8e5",
  purple: "#a28ae5",
  magenta: "#e56eee",
  orange: "#f19837",
  gray: "#aaaaaa",
} as const;
export type AnnotationType = "highlight" | "underline" | "note" | "text" | "image" | "ink";
export type PdfRect = [number, number, number, number];
export type PdfPoint = [number, number];

const number = z.number().finite();
const rect = z.tuple([number, number, number, number]).refine(([l, b, r, t]) => l <= r && b <= t);
const rects = z.array(rect).min(1);
const position = z
  .object({
    pageIndex: z.number().int().min(0),
    rects: rects.optional(),
    nextPageRects: rects.optional(),
    paths: z
      .array(
        z
          .array(number)
          .min(2)
          .refine((path) => path.length % 2 === 0),
      )
      .min(1)
      .optional(),
    width: number.positive().optional(),
    fontSize: number.positive().optional(),
    rotation: number.optional(),
  })
  .passthrough();
const annotation = z
  .object({
    id: z.string().min(1),
    type: z.enum(["highlight", "underline", "note", "text", "image", "ink"]),
    color: z.string().regex(/^#[\da-f]{6}$/i),
    sortIndex: z.string().regex(/^\d{5}\|\d{6}\|\d{5}$/),
    pageLabel: z.string(),
    position,
    text: z.string().optional(),
    comment: z.string(),
    tags: z.array(z.object({ name: z.string(), color: z.string().optional() }).passthrough()),
    dateCreated: z.string().datetime().optional(),
    dateModified: z.string().datetime(),
    authorName: z.string().optional(),
    readOnly: z.boolean().optional(),
    isAuthorNameAuthoritative: z.boolean().optional(),
  })
  .passthrough()
  .refine((item) =>
    item.type === "ink"
      ? !!item.position.paths && !!item.position.width && !item.position.rects
      : !!item.position.rects && !item.position.paths,
  );

export type PdfAnnotation = z.infer<typeof annotation>;
export type AnnotationPosition = z.infer<typeof position>;

export function parseAnnotations(value: unknown): PdfAnnotation[] {
  const result = z.array(annotation).safeParse(value);
  if (!result.success || new Set(result.data.map((item) => item.id)).size !== result.data.length)
    throw new Error("annotationCorrupt");
  // Keep optional Zotero fields exactly as supplied instead of stripping future sync metadata.
  return value as PdfAnnotation[];
}

function pageBox(page: PdfPageObject): PdfRect {
  const { crop, media } = page.boxes ?? {};
  return crop && media
    ? [
        Math.max(crop.left, media.left),
        Math.max(crop.bottom, media.bottom),
        Math.min(crop.right, media.right),
        Math.min(crop.top, media.top),
      ]
    : [0, 0, page.size.width, page.size.height];
}

// The reader opens with normalizedRotation: geometry is unrotated, CSS rotates the page afterwards.
export function readerToPdf(page: PdfPageObject, [x, y]: PdfPoint): PdfPoint {
  const [left, bottom, right, top] = pageBox(page);
  return [left + (x * (right - left)) / page.size.width, top - (y * (top - bottom)) / page.size.height];
}

export function pdfToReader(page: PdfPageObject, [x, y]: PdfPoint): PdfPoint {
  const [left, bottom, right, top] = pageBox(page);
  return [((x - left) * page.size.width) / (right - left), ((top - y) * page.size.height) / (top - bottom)];
}

export function readerRectToPdf(page: PdfPageObject, rect: Rect): PdfRect {
  const [left, top] = readerToPdf(page, [rect.origin.x, rect.origin.y]);
  const [right, bottom] = readerToPdf(page, [rect.origin.x + rect.size.width, rect.origin.y + rect.size.height]);
  return [left, bottom, right, top];
}

export function pdfRectToReader(page: PdfPageObject, [left, bottom, right, top]: PdfRect): Rect {
  const [x, y] = pdfToReader(page, [left, top]);
  const [endX, endY] = pdfToReader(page, [right, bottom]);
  return { origin: { x, y }, size: { width: endX - x, height: endY - y } };
}

export function clientToReader(
  page: PdfPageObject,
  bounds: Pick<DOMRect, "left" | "top" | "width" | "height">,
  x: number,
  y: number,
): PdfPoint {
  const u = (x - bounds.left) / bounds.width;
  const v = (y - bounds.top) / bounds.height;
  const [a, b] = (
    [
      [u, v],
      [v, 1 - u],
      [1 - u, 1 - v],
      [1 - v, u],
    ] as PdfPoint[]
  )[page.rotation % 4];
  return [Math.max(0, Math.min(1, a)) * page.size.width, Math.max(0, Math.min(1, b)) * page.size.height];
}

export function annotationBounds(position: AnnotationPosition): PdfRect {
  if (position.rects)
    return [
      Math.min(...position.rects.map((rect) => rect[0])),
      Math.min(...position.rects.map((rect) => rect[1])),
      Math.max(...position.rects.map((rect) => rect[2])),
      Math.max(...position.rects.map((rect) => rect[3])),
    ];
  const bounds: PdfRect = [Infinity, Infinity, -Infinity, -Infinity];
  for (const path of position.paths ?? [])
    for (let i = 0; i < path.length; i += 2) {
      bounds[0] = Math.min(bounds[0], path[i]);
      bounds[1] = Math.min(bounds[1], path[i + 1]);
      bounds[2] = Math.max(bounds[2], path[i]);
      bounds[3] = Math.max(bounds[3], path[i + 1]);
    }
  return bounds;
}

export function annotationSortIndex(
  page: PdfPageObject,
  position: AnnotationPosition,
  geometry: PdfPageGeometry,
): string {
  // Zotero reader's current selection.js chooses the largest x2 (despite its top-most naming).
  const anchor =
    position.rects?.reduce((best, rect) => (rect[2] > best[2] ? rect : best)) ?? annotationBounds(position);
  let offset = 0;
  let distance = Infinity;
  for (const run of geometry.runs)
    for (const [index, glyph] of run.glyphs.entries()) {
      if (glyph.flags & 2) continue;
      const box = readerRectToPdf(page, {
        origin: { x: glyph.x, y: glyph.y },
        size: { width: glyph.width, height: glyph.height },
      });
      const dx = Math.max(0, box[0] - anchor[2], anchor[0] - box[2]);
      const dy = Math.max(0, box[1] - anchor[3], anchor[1] - box[3]);
      const squared = dx * dx + dy * dy;
      if (squared < distance) {
        distance = squared;
        offset = run.charStart + index;
      }
    }
  const [, bottom, , top] = pageBox(page);
  const fields = [position.pageIndex, offset, Math.floor(Math.max(0, top - bottom - anchor[3]))];
  return fields
    .map((value, i) =>
      String(value)
        .slice(0, i === 1 ? 6 : 5)
        .padStart(i === 1 ? 6 : 5, "0"),
    )
    .join("|");
}

export function newAnnotation(
  type: AnnotationType,
  color: string,
  position: AnnotationPosition,
  page: PdfPageObject,
  geometry: PdfPageGeometry,
  text = "",
): PdfAnnotation {
  const alphabet = "23456789ABCDEFGHIJKLMNPQRSTUVWXYZ";
  const id = Array.from(crypto.getRandomValues(new Uint8Array(8)), (value) => alphabet[value % alphabet.length]).join(
    "",
  );
  const date = new Date().toISOString();
  return {
    id,
    type,
    color,
    position: roundedAnnotationPosition(position),
    sortIndex: annotationSortIndex(page, position, geometry),
    pageLabel: String(page.index + 1),
    text,
    comment: "",
    tags: [],
    dateCreated: date,
    dateModified: date,
    authorName: "",
  };
}

export function roundedAnnotationPosition(position: AnnotationPosition): AnnotationPosition {
  const round = (value: number) => Math.round(value * 1000) / 1000;
  return {
    ...position,
    ...(position.rects && { rects: position.rects.map((rect) => rect.map(round) as PdfRect) }),
    ...(position.nextPageRects && { nextPageRects: position.nextPageRects.map((rect) => rect.map(round) as PdfRect) }),
    ...(position.paths && { paths: position.paths.map((path) => path.map(round)) }),
    ...(position.width !== undefined && { width: round(position.width) }),
  };
}

export function sortedAnnotations(items: PdfAnnotation[]) {
  return [...items].sort((a, b) => a.sortIndex.localeCompare(b.sortIndex) || a.id.localeCompare(b.id));
}

export function filterAnnotations(items: PdfAnnotation[], query: string, color: string) {
  const needle = query.trim().toLocaleLowerCase();
  return sortedAnnotations(items).filter(
    (item) =>
      (!color || item.color === color) &&
      (!needle ||
        [item.text, item.comment, item.authorName, item.pageLabel, ...item.tags.map((tag) => tag.name)].some((text) =>
          text?.toLocaleLowerCase().includes(needle),
        )),
  );
}

export function eraseInkPaths(paths: number[][], from: PdfPoint, to: PdfPoint, radius: number): number[][] {
  const [ax, ay] = from;
  const dx = to[0] - ax,
    dy = to[1] - ay;
  const lengthSquared = dx * dx + dy * dy;
  const hit = (x: number, y: number) => {
    const ratio = lengthSquared ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / lengthSquared)) : 0;
    return Math.hypot(x - ax - ratio * dx, y - ay - ratio * dy) <= radius;
  };
  const result: number[][] = [];
  for (const path of paths) {
    let touched = false;
    const start = result.length;
    let segment: number[] = [];
    const append = (x: number, y: number) => {
      if (hit(x, y)) {
        touched = true;
        if (segment.length) result.push(segment);
        segment = [];
      } else segment.push(x, y);
    };
    append(path[0], path[1]);
    for (let i = 2; i < path.length; i += 2) {
      const steps = Math.max(
        1,
        Math.ceil(Math.hypot(path[i] - path[i - 2], path[i + 1] - path[i - 1]) / Math.max(radius / 2, 0.5)),
      );
      for (let step = 1; step <= steps; step++)
        append(
          path[i - 2] + ((path[i] - path[i - 2]) * step) / steps,
          path[i - 1] + ((path[i + 1] - path[i - 1]) * step) / steps,
        );
    }
    if (segment.length) result.push(segment);
    if (!touched) result.splice(start, result.length - start, path);
  }
  return result;
}
