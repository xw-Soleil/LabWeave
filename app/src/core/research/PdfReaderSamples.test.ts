import { PdfEngine, PdfiumNative, browserImageDataToBlobConverter } from "@embedpdf/engines/pdfium";
import { init } from "@embedpdf/pdfium";
import { FontCharset } from "@embedpdf/models";
import { appendFile, open, readdir, readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { DocumentRangeReader } from "./DocumentFile";

const samples = process.env.LABWEAVE_SAMPLE_PDFS;

describe.skipIf(!samples)("EmbedPDF real local samples", () => {
  it("measures complete-buffer open, page turn, visible zoom tiles and memory without network fonts", async () => {
    const report = process.env.LABWEAVE_EMBEDPDF_REPORT;
    if (report) await writeFile(report, "");
    const record = async (value: unknown) => {
      const line = JSON.stringify(value);
      console.info(line);
      if (report) await appendFile(report, line + "\n");
    };
    const wasmBinary = await readFile(createRequire(import.meta.url).resolve("@embedpdf/pdfium/pdfium.wasm"));
    const fontOption = process.env.LABWEAVE_EMBEDPDF_FALLBACK_FONT;
    const fallbackFont =
      fontOption === "none"
        ? undefined
        : (fontOption ?? fileURLToPath(new URL("../../assets/fonts/NotoSansSC-Regular.otf", import.meta.url)));
    const files = (
      await Promise.all(
        samples!
          .split(path.delimiter)
          .map(async (folder) =>
            (await readdir(folder)).filter((name) => name.endsWith(".pdf")).map((name) => path.join(folder, name)),
          ),
      )
    ).flat();
    const network = vi.fn(() => {
      throw new Error("Unexpected network request");
    });
    vi.stubGlobal("fetch", network);
    vi.stubGlobal(
      "XMLHttpRequest",
      class {
        constructor() {
          network();
        }
      },
    );
    try {
      for (let run = 1; run <= Number(process.env.LABWEAVE_PDF_RUNS || 1); run++) {
        for (const filename of files) {
          const before = process.memoryUsage();
          const started = performance.now();
          const wasm = await init({ wasmBinary });
          const wasmCapacity = () => (wasm.pdfium as typeof wasm.pdfium & { HEAPU8: Uint8Array }).HEAPU8.byteLength;
          let fontReadBytes = 0;
          const fontFailures: unknown[] = [];
          const native = new PdfiumNative(wasm, {
            fontFallback: fallbackFont
              ? {
                  fonts: { [FontCharset.GB2312]: fallbackFont },
                  fontLoader: () => {
                    try {
                      const bytes = readFileSync(fallbackFont);
                      fontReadBytes += bytes.byteLength;
                      return bytes;
                    } catch (error) {
                      fontFailures.push(error);
                      return null;
                    }
                  },
                }
              : null,
          });
          const engine = new PdfEngine(native, { imageConverter: browserImageDataToBlobConverter });
          const engineMs = performance.now() - started;
          const file = await open(filename, "r");
          let position = 0;
          const size = (await file.stat()).size;
          const reader = new DocumentRangeReader(
            {
              seek: async (offset) => (position = offset),
              read: async (bytes) => {
                const { bytesRead } = await file.read(bytes, 0, bytes.length, position);
                position += bytesRead;
                return bytesRead || null;
              },
              close: () => file.close(),
            },
            size,
          );
          try {
            const reading = performance.now();
            const bytes = await reader.read(0, size);
            const readMs = performance.now() - reading;
            const opening = performance.now();
            const pdf = await engine
              .openDocumentBuffer({ id: filename, content: bytes.buffer }, { normalizeRotation: true })
              .toPromise();
            const documentMs = performance.now() - opening;
            const wasmAfterOpenBytes = wasmCapacity();
            const first = pdf.pages[0];
            const scale = 1024 / first.size.width;
            const rendering = performance.now();
            const image = await engine
              .renderPage(pdf, first, {
                scaleFactor: scale,
                dpr: 1,
                imageType: "image/bmp",
                withAnnotations: true,
                withForms: true,
              })
              .toPromise();
            expect(image.size).toBeGreaterThan(1024);
            const renderMs = performance.now() - rendering;
            const firstPaintMs = performance.now() - started;
            const afterFirst = process.memoryUsage();
            const wasmAfterFirstBytes = wasmCapacity();
            const pageTurn = performance.now();
            const next = pdf.pages[Math.min(1, pdf.pages.length - 1)];
            await engine
              .renderPage(pdf, next, {
                scaleFactor: 1024 / next.size.width,
                dpr: 1,
                imageType: "image/bmp",
                withAnnotations: true,
                withForms: true,
              })
              .toPromise();
            const pageTurnMs = performance.now() - pageTurn;
            const zoom = performance.now();
            // Four 512 px tiles cover a 1024 × 1024 viewport at twice the initial zoom.
            const tileSide = 512 / (scale * 2);
            for (const [x, y] of [
              [0, 0],
              [1, 0],
              [0, 1],
              [1, 1],
            ]) {
              await engine
                .renderPageRect(
                  pdf,
                  first,
                  { origin: { x: x * tileSide, y: y * tileSide }, size: { width: tileSide, height: tileSide } },
                  { scaleFactor: scale * 2, dpr: 1, imageType: "image/bmp", withAnnotations: true, withForms: true },
                )
                .toPromise();
            }
            const zoomTilesMs = performance.now() - zoom;
            const afterZoom = process.memoryUsage();
            const wasmAfterZoomBytes = wasmCapacity();
            const textStart = performance.now();
            const geometry = await engine.getPageGeometry(pdf, first).toPromise();
            const textMs = performance.now() - textStart;
            const bookmarks = await engine.getBookmarks(pdf).toPromise();
            await record({
              file: path.basename(filename),
              run,
              engine: "EmbedPDF 2.15.1 / Node direct, no UI or worker startup",
              fileBytes: size,
              bytesRead: reader.bytesRead,
              pages: pdf.pageCount,
              wasmBytes: wasmBinary.byteLength,
              fontReadBytes,
              wasmAfterOpenBytes,
              wasmAfterFirstBytes,
              wasmAfterZoomBytes,
              engineMs,
              readMs,
              documentMs,
              renderMs,
              firstPaintMs,
              pageTurnMs,
              zoomTilesMs,
              textMs,
              glyphs: geometry.runs.reduce((sum, run) => sum + run.glyphs.length, 0),
              bookmarks: bookmarks.bookmarks.length,
              heapDelta: afterFirst.heapUsed - before.heapUsed,
              arrayBuffersDelta: afterFirst.arrayBuffers - before.arrayBuffers,
              rssDelta: afterFirst.rss - before.rss,
              rssAfterFirst: afterFirst.rss,
              rssAfterZoom: afterZoom.rss,
              bitmapBytes: image.size,
            });
            if (report && run === 1) {
              const raw = await engine
                .renderPageRaw(pdf, first, { scaleFactor: scale, dpr: 1, withAnnotations: true, withForms: true })
                .toPromise();
              await sharp(raw.data, { raw: { width: raw.width, height: raw.height, channels: 4 } })
                .png()
                .toFile(
                  path.join(
                    path.dirname(report),
                    `${fallbackFont ? "embedpdf-fallback" : "embedpdf"}-${path.basename(filename)}.png`,
                  ),
                );
            }
            await engine.closeDocument(pdf).toPromise();
            expect(fontFailures).toEqual([]);
          } finally {
            await reader.close();
            await engine.destroy().toPromise();
          }
        }
      }
      expect(network).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  }, 120000);
});
