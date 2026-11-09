import { open, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DocumentRangeReader } from "./DocumentFile";
import { createPdfRangeTransport, loadPdfJs, pdfWithTimeout } from "./PdfDocument";

const samples = process.env.LABWEAVE_SAMPLE_PDFS;

describe.skipIf(!samples)("real PDF range measurement", () => {
  it("renders the cover and reads limited text through the production range transport", async () => {
    const pdfjs = await loadPdfJs();
    const assets = path.dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));
    for (const name of (await readdir(samples!)).filter((name) => name.endsWith(".pdf"))) {
      const file = await open(path.join(samples!, name), "r");
      const { size } = await file.stat();
      let position = 0;
      const reader = new DocumentRangeReader(
        {
          seek: async (offset) => {
            position = offset;
            return offset;
          },
          read: async (buffer) => {
            const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
            position += bytesRead;
            return bytesRead || null;
          },
          close: () => file.close(),
        },
        size,
      );
      const failures: unknown[] = [];
      const range = await createPdfRangeTransport(pdfjs, reader, (error) => failures.push(error));
      const task = pdfjs.getDocument({
        range,
        disableAutoFetch: true,
        disableStream: true,
        rangeChunkSize: 65536,
        isOffscreenCanvasSupported: false,
        isImageDecoderSupported: false,
        cMapUrl: path.join(assets, "cmaps") + path.sep,
        cMapPacked: true,
        standardFontDataUrl: path.join(assets, "standard_fonts") + path.sep,
        wasmUrl: path.join(assets, "wasm") + path.sep,
      });
      const before = process.memoryUsage();
      try {
        const pdf = await pdfWithTimeout(task.promise);
        const first = await pdf.getPage(1);
        const coverBefore = reader.bytesRead;
        const originalViewport = first.getViewport({ scale: 1 });
        const viewport = first.getViewport({ scale: 480 / Math.max(originalViewport.width, originalViewport.height) });
        const factory = pdf.canvasFactory as {
          create(width: number, height: number): { canvas: HTMLCanvasElement; context: CanvasRenderingContext2D };
          destroy(output: { canvas: HTMLCanvasElement; context: CanvasRenderingContext2D }): void;
        };
        const output = factory.create(Math.ceil(viewport.width), Math.ceil(viewport.height));
        try {
          await pdfWithTimeout(first.render({ canvas: output.canvas, viewport }).promise);
        } finally {
          factory.destroy(output);
        }
        const coverRead = reader.bytesRead;
        let text = "";
        for (let i = 1; i <= Math.min(3, pdf.numPages) && text.length < 4000; i++) {
          const content = await pdfWithTimeout((await pdf.getPage(i)).getTextContent());
          text += content.items.map((item) => ("str" in item ? item.str : "")).join(" ");
        }
        const after = process.memoryUsage();
        expect(failures).toEqual([]);
        expect(reader.largestRead).toBeLessThanOrEqual(65536);
        expect(pdf.numPages).toBeGreaterThan(0);
        console.info(
          JSON.stringify({
            file: name,
            fileBytes: size,
            pages: pdf.numPages,
            pageTreeBytes: coverBefore,
            coverBytes: coverRead,
            withTextBytes: reader.bytesRead,
            excerptChars: Math.min(4000, text.length),
            largestRead: reader.largestRead,
            heapDelta: after.heapUsed - before.heapUsed,
            arrayBuffersDelta: after.arrayBuffers - before.arrayBuffers,
            rssDelta: after.rss - before.rss,
          }),
        );
      } finally {
        await task.destroy();
        await reader.close();
      }
    }
  }, 90000);
});
