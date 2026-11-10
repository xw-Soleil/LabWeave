import type { PdfPageGeometry, PdfPageObject } from "@embedpdf/models";
import { describe, expect, it } from "vitest";
import {
  annotationColors,
  annotationSortIndex,
  clientToReader,
  eraseInkPaths,
  filterAnnotations,
  newAnnotation,
  parseAnnotations,
  pdfRectToReader,
  pdfToReader,
  readerRectToPdf,
  readerToPdf,
  roundedAnnotationPosition,
  type AnnotationType,
} from "./PdfAnnotations";

const page: PdfPageObject = { index: 2, size: { width: 600, height: 800 }, rotation: 0, objectNumber: 3 };
const geometry: PdfPageGeometry = {
  runs: [
    {
      rect: { x: 30, y: 90, width: 100, height: 12 },
      charStart: 123,
      glyphs: [
        { x: 30, y: 90, width: 10, height: 12, flags: 0 },
        { x: 40, y: 90, width: 10, height: 12, flags: 0 },
      ],
    },
  ],
};
const highlight = () =>
  newAnnotation(
    "highlight",
    annotationColors.yellow,
    { pageIndex: 2, rects: [[30, 698, 50, 710]] },
    page,
    geometry,
    "our example",
  );

describe("Zotero-compatible PDF annotation records", () => {
  it("rounds new and edited position coordinates to three decimals without changing imported records", () => {
    const position = {
      pageIndex: 0,
      rects: [[10.123456, 20.654321, 30.345678, 40.987654]] as [number, number, number, number][],
    };
    expect(roundedAnnotationPosition(position).rects).toEqual([[10.123, 20.654, 30.346, 40.988]]);
    const imported = { ...highlight(), position };
    expect(parseAnnotations([imported])[0].position).toBe(position);
    expect(newAnnotation("highlight", annotationColors.yellow, position, page, geometry).position.rects).toEqual([
      [10.123, 20.654, 30.346, 40.988],
    ]);
  });

  it("uses the eight verified Zotero colors, object tags, ISO dates and eight-character item keys", () => {
    expect(Object.values(annotationColors)).toEqual([
      "#ffd400",
      "#ff6666",
      "#5fb236",
      "#2ea8e5",
      "#a28ae5",
      "#e56eee",
      "#f19837",
      "#aaaaaa",
    ]);
    const item = highlight();
    expect(item.id).toMatch(/^[23456789ABCDEFGHIJKLMNPQRSTUVWXYZ]{8}$/);
    expect(Object.keys(item).sort()).toEqual(
      [
        "id",
        "type",
        "color",
        "sortIndex",
        "pageLabel",
        "position",
        "text",
        "comment",
        "tags",
        "dateCreated",
        "dateModified",
        "authorName",
      ].sort(),
    );
    expect(item.dateCreated).toBe(item.dateModified);
    expect(item.sortIndex).toBe("00002|000123|00090");
    expect(item.position.rects).toEqual([[30, 698, 50, 710]]);
    expect(item.pageLabel).toBe("3");
    expect(item.authorName).toBe("");
  });

  it.each<AnnotationType>(["highlight", "underline", "note", "text", "image", "ink"])(
    "round-trips %s and optional fields present in Zotero's demo",
    (type) => {
      const item = {
        ...highlight(),
        type,
        tags: [{ name: "research", color: "#ff0000" }, { name: "example" }],
        isAuthorNameAuthoritative: true,
        readOnly: true,
      };
      if (type === "ink")
        item.position = {
          pageIndex: 2,
          paths: [
            [10, 20, 30, 40],
            [50, 60],
          ],
          width: 2.5,
        };
      if (type === "text") item.position = { pageIndex: 2, rects: [[10, 20, 100, 40]], fontSize: 14, rotation: 10 };
      delete item.dateCreated;
      delete item.text;
      expect(parseAnnotations(JSON.parse(JSON.stringify([item])))).toEqual([item]);
      expect(parseAnnotations([item])[0]).toBe(item);
    },
  );

  it("keeps nextPageRects and rejects corrupt records without manufacturing empty annotations", () => {
    const item = highlight();
    item.position.nextPageRects = [[10, 700, 50, 712]];
    expect(parseAnnotations([item])[0].position.nextPageRects).toEqual([[10, 700, 50, 712]]);
    for (const bad of [
      {},
      null,
      [item, item],
      [{ ...item, type: "highlight", position: { pageIndex: -1, rects: [[0, 0, 1, 1]] } }],
      [{ ...item, position: { pageIndex: 2, rects: [[0, NaN, 1, 1]] } }],
      [{ ...item, tags: ["plain-string"] }],
      [{ ...item, type: "ink", position: { pageIndex: 2, paths: [[1, 2, 3]], width: 2 } }],
    ]) {
      expect(() => parseAnnotations(bad)).toThrow("annotationCorrupt");
    }
  });

  it("matches the current sort algorithm's anchor, nearest character, padding, floor and nonnegative top", () => {
    const position = {
      pageIndex: 2,
      rects: [
        [30, 698, 50, 710],
        [200, 480, 300, 499.8],
      ] as [number, number, number, number][],
    };
    const chars: PdfPageGeometry = {
      runs: [
        ...geometry.runs,
        {
          rect: { x: 200, y: 300, width: 100, height: 20 },
          charStart: 456,
          glyphs: [{ x: 200, y: 300, width: 10, height: 20, flags: 0 }],
        },
      ],
    };
    expect(annotationSortIndex(page, position, chars)).toBe("00002|000456|00300");
    expect(annotationSortIndex(page, { pageIndex: 0, paths: [[50, 900, 70, 1000]], width: 2 }, { runs: [] })).toBe(
      "00000|000000|00000",
    );
  });

  it("sorts by page, character and margin, and filters comments, tags, text and color", () => {
    const first = highlight();
    const second = {
      ...highlight(),
      color: annotationColors.blue,
      sortIndex: "00003|000001|00001",
      comment: "Useful observation",
      tags: [{ name: "论文" }],
    };
    expect(filterAnnotations([second, first], "", "")).toEqual([first, second]);
    expect(filterAnnotations([first, second], "USEFUL", "")).toEqual([second]);
    expect(filterAnnotations([first, second], "论文", annotationColors.blue)).toEqual([second]);
    expect(filterAnnotations([first, second], "论文", annotationColors.yellow)).toEqual([]);
  });
});

describe("PDF user-space coordinates", () => {
  it("round-trips rects with non-zero CropBox/MediaBox origins and fractional page sizes", () => {
    const cropped = {
      ...page,
      size: { width: 280.5, height: 350.25 },
      boxes: {
        media: { left: -20, bottom: 30, right: 600, top: 900 },
        crop: { left: 40, bottom: 70, right: 601, top: 770.5 },
      },
    };
    const point = readerToPdf(cropped, [0, 0]);
    expect(point).toEqual([40, 770.5]);
    const rectangle = { origin: { x: 25.5, y: 41.25 }, size: { width: 62.125, height: 18.5 } };
    const restored = pdfRectToReader(cropped, readerRectToPdf(cropped, rectangle));
    expect(restored.origin.x).toBeCloseTo(rectangle.origin.x);
    expect(restored.origin.y).toBeCloseTo(rectangle.origin.y);
    expect(restored.size.width).toBeCloseTo(rectangle.size.width);
    expect(restored.size.height).toBeCloseTo(rectangle.size.height);
    expect(pdfToReader(cropped, point)).toEqual([0, 0]);
  });

  it.each([0, 1, 2, 3] as const)("undoes CSS page rotation %s before saving, independently of zoom", (rotation) => {
    const rotated = { ...page, rotation };
    for (const scale of [0.25, 1, 4]) {
      const width = (rotation % 2 ? 800 : 600) * scale,
        height = (rotation % 2 ? 600 : 800) * scale;
      const [x, y] = [
        [120, 240],
        [560, 120],
        [480, 560],
        [240, 480],
      ][rotation];
      const point = clientToReader(rotated, { left: 50, top: 100, width, height }, 50 + x * scale, 100 + y * scale);
      expect(point[0]).toBeCloseTo(120);
      expect(point[1]).toBeCloseTo(240);
    }
  });

  it("erases only ink under the swept cursor, splitting paths and preserving distant points", () => {
    const paths = [
      [0, 0, 100, 0],
      [0, 100, 20, 100],
    ];
    const erased = eraseInkPaths(paths, [50, -10], [50, 10], 5);
    expect(erased).toHaveLength(3);
    expect(erased[0].at(-2)).toBeLessThan(45);
    expect(erased[1][0]).toBeGreaterThan(55);
    expect(erased[2]).toBe(paths[1]);
    expect(eraseInkPaths([[50, 0]], [50, 0], [50, 0], 5)).toEqual([]);
    expect(eraseInkPaths(paths, [500, 500], [501, 501], 5)).toEqual(paths);
  });
});
