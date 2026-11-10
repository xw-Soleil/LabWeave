import { PdfEngine, PdfiumNative, browserImageDataToBlobConverter } from "@embedpdf/engines/pdfium";
import { PdfAnnotationSubtype } from "@embedpdf/models";
import { init } from "@embedpdf/pdfium";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
import {
  annotationColors,
  filterAnnotations,
  newAnnotation,
  parseAnnotations,
  readerRectToPdf,
} from "./PdfAnnotations";
import { PdfAnnotationStore } from "./PdfAnnotationStore";

function coordinateFixture() {
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  const kids: string[] = [];
  for (const rotation of [0, 90, 180, 270]) {
    const id = objects.length + 1;
    kids.push(`${id} 0 R`);
    const content = "BT /F1 12 Tf 75 700 Td (Coordinate fixture) Tj ET";
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [10 20 610 820] /CropBox [30 50 570 780] /Rotate ${rotation} /Resources << /Font << /F1 3 0 R >> >> /Contents ${id + 1} 0 R /Annots [${id + 2} 0 R] >>`,
      `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
      "<< /Type /Annot /Subtype /Highlight /Rect [70 690 110 720] /QuadPoints [70 720 110 720 70 690 110 690] /C [1 1 0] /Contents (External comment) /T (Original author) >>",
    );
  }
  objects[1] = `<< /Type /Pages /Count 4 /Kids [${kids.join(" ")}] >>`;
  let pdf = "%PDF-1.7\n";
  const offsets = [0];
  for (const [i, object] of objects.entries()) {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = pdf.length;
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  pdf += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  pdf += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}

describe("annotation coordinates against the installed PDFium engine", () => {
  it("matches real rotated/cropped page coordinates and leaves embedded annotations and original PDF bytes intact", async () => {
    const wasmBinary = await readFile(createRequire(import.meta.url).resolve("@embedpdf/pdfium/pdfium.wasm"));
    const network = vi.fn(() => {
      throw new Error("network forbidden");
    });
    vi.stubGlobal("fetch", network);
    const bytes = coordinateFixture();
    const before = bytes.slice();
    const wasm = await init({ wasmBinary });
    const engine = new PdfEngine(new PdfiumNative(wasm, { fontFallback: null }), {
      imageConverter: browserImageDataToBlobConverter,
    });
    try {
      const pdf = await engine
        .openDocumentBuffer({ id: "coordinates", content: bytes.buffer }, { normalizeRotation: true })
        .toPromise();
      expect(pdf.pages.map((page) => page.rotation)).toEqual([0, 1, 2, 3]);
      for (const page of pdf.pages) {
        expect(page.size).toEqual({ width: 540, height: 730 });
        const external = (await engine.getPageAnnotations(pdf, page).toPromise()).find(
          (item) => item.type === PdfAnnotationSubtype.HIGHLIGHT,
        )!;
        expect(external.contents).toBe("External comment");
        expect(readerRectToPdf(page, external.rect)).toEqual([70, 690, 110, 720]);
        const geometry = await engine.getPageGeometry(pdf, page).toPromise();
        const first = geometry.runs[0].glyphs[0];
        const box = readerRectToPdf(page, {
          origin: { x: first.x, y: first.y },
          size: { width: first.width, height: first.height },
        });
        expect(box[0]).toBeCloseTo(75, 0);
        expect(box[1]).toBeLessThan(701);
        expect(box[3]).toBeGreaterThan(705);
        const annotation = newAnnotation(
          "highlight",
          annotationColors.yellow,
          { pageIndex: page.index, rects: [box] },
          page,
          geometry,
          "C",
        );
        expect(parseAnnotations([annotation])[0].sortIndex).toMatch(
          new RegExp(`^0000${page.index}\\|000000\\|\\d{5}$`),
        );
      }
      expect(bytes).toEqual(before);
      expect(network).not.toHaveBeenCalled();
      await engine.closeDocument(pdf).toPromise();
    } finally {
      await engine.destroy().toPromise();
      vi.unstubAllGlobals();
    }
  });
});

describe.skipIf(!process.env.LABWEAVE_ANNOTATION_REPORT)("annotation model performance probe", () => {
  it("measures 1000 annotations, JSON loading, filtering, edits, undo and memory without disk or UI claims", async () => {
    const baseline = process.memoryUsage();
    const start = performance.now();
    const page = { index: 0, size: { width: 600, height: 800 }, rotation: 0 as const, objectNumber: 1 };
    const annotations = Array.from({ length: 1000 }, (_, i) =>
      newAnnotation(
        "highlight",
        Object.values(annotationColors)[i % 8],
        { pageIndex: i % 20, rects: [[20, 600, 400, 620]] },
        { ...page, index: i % 20 },
        { runs: [] },
        `Synthetic annotation ${i}: a short paragraph for measurement.`,
      ),
    );
    const createMs = performance.now() - start;
    const json = JSON.stringify(annotations);
    const loading = performance.now();
    const model = new PdfAnnotationStore(
      { kind: "external", pathKey: "a".repeat(64) },
      { annotations: parseAnnotations(JSON.parse(json)), revision: null },
    );
    const loadMs = performance.now() - loading;
    const filtering = performance.now();
    expect(filterAnnotations(model.annotations, "paragraph", annotationColors.yellow)).toHaveLength(125);
    const filterMs = performance.now() - filtering;
    const editing = performance.now();
    for (let i = 0; i < 100; i++)
      model.change(model.annotations.map((item, index) => (index === i ? { ...item, comment: `Comment ${i}` } : item)));
    const edit100Ms = performance.now() - editing;
    const undoing = performance.now();
    for (let i = 0; i < 100; i++) model.undo();
    const undo100Ms = performance.now() - undoing;
    const after = process.memoryUsage();
    await writeFile(
      process.env.LABWEAVE_ANNOTATION_REPORT!,
      JSON.stringify(
        {
          count: annotations.length,
          jsonBytes: new TextEncoder().encode(json).length,
          createMs,
          loadMs,
          filterMs,
          edit100Ms,
          undo100Ms,
          heapUsedDelta: after.heapUsed - baseline.heapUsed,
          rssDelta: after.rss - baseline.rss,
          arrayBuffersDelta: after.arrayBuffers - baseline.arrayBuffers,
          note: "Node process deltas; includes test runner and GC timing; no WebView, filesystem IPC or rendering.",
        },
        null,
        2,
      ),
    );
  });
});
