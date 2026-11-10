import { appendFile, open, readdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DocumentRangeReader, PDF_RANGE_CHUNK_SIZE } from "./DocumentFile";
import { createPdfRangeTransport, loadPdfJs, pdfWithTimeout } from "./PdfDocument";

const samples = process.env.LABWEAVE_SAMPLE_PDFS;

describe.skipIf(!samples)("real PDF range measurement", () => {
  it("renders the cover and reads limited text through the production range transport", async () => {
    const report = process.env.LABWEAVE_PDF_REPORT;
    if (report) await writeFile(report, "");
    const record = async (value: unknown) => {
      const line = JSON.stringify(value);
      console.info(line);
      if (report) await appendFile(report, line + "\n");
    };
    const libraryStart = performance.now();
    const pdfjs = await loadPdfJs();
    await record({ libraryMs: performance.now() - libraryStart, worker: "Node fake worker" });
    const assets = path.dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));
    const files = (
      await Promise.all(
        samples!
          .split(path.delimiter)
          .map(async (folder) =>
            (await readdir(folder)).filter((name) => name.endsWith(".pdf")).map((name) => path.join(folder, name)),
          ),
      )
    ).flat();
    const runs = Number(process.env.LABWEAVE_PDF_RUNS || 1);
    const ipcDelayMs = Number(process.env.LABWEAVE_PDF_IPC_DELAY_MS || 0);
    const measurements = Array.from({ length: runs }, (_, index) =>
      files.map((filename) => ({ run: index + 1, filename })),
    ).flat();
    for (const { run, filename } of measurements) {
      const started = performance.now();
      const file = await open(filename, "r");
      const { size } = await file.stat();
      const openMs = performance.now() - started;
      const operations: { kind: string; offset: number; bytes: number; ms: number }[] = [];
      const delay = async () => {
        if (ipcDelayMs) await new Promise((resolve) => setTimeout(resolve, ipcDelayMs));
      };
      let position = 0;
      const reader = new DocumentRangeReader(
        {
          seek: async (offset) => {
            const start = performance.now();
            await delay();
            position = offset;
            operations.push({ kind: "seek", offset, bytes: 0, ms: performance.now() - start });
            return offset;
          },
          read: async (buffer) => {
            const start = performance.now();
            await delay();
            const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
            operations.push({ kind: "read", offset: position, bytes: bytesRead, ms: performance.now() - start });
            position += bytesRead;
            return bytesRead || null;
          },
          close: () => file.close(),
        },
        size,
      );
      const ranges: { begin: number; end: number; ms: number }[] = [];
      const read = reader.read.bind(reader);
      reader.read = async (begin, end) => {
        const start = performance.now();
        const bytes = await read(begin, end);
        ranges.push({ begin, end, ms: performance.now() - start });
        return bytes;
      };
      const io = () => ({
        bytes: reader.bytesRead,
        ranges: ranges.length,
        seeks: operations.filter((op) => op.kind === "seek").length,
        reads: operations.filter((op) => op.kind === "read").length,
        ms: operations.reduce((sum, op) => sum + op.ms, 0),
      });
      const failures: unknown[] = [];
      const workerStart = performance.now();
      const worker = pdfjs.PDFWorker.create({});
      await worker.promise;
      const workerMs = performance.now() - workerStart;
      const initialStart = performance.now();
      const range = await createPdfRangeTransport(pdfjs, reader, (error) => failures.push(error));
      const initialMs = performance.now() - initialStart;
      const documentStart = performance.now();
      const task = pdfjs.getDocument({
        range,
        worker,
        disableAutoFetch: true,
        disableStream: true,
        rangeChunkSize: PDF_RANGE_CHUNK_SIZE,
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
        const documentMs = performance.now() - documentStart;
        const pageStart = performance.now();
        const first = await pdf.getPage(1);
        const firstPageMs = performance.now() - pageStart;
        const coverBefore = reader.bytesRead;
        const originalViewport = first.getViewport({ scale: 1 });
        const viewport = first.getViewport({ scale: 1024 / originalViewport.width });
        const factory = pdf.canvasFactory as {
          create(width: number, height: number): { canvas: HTMLCanvasElement; context: CanvasRenderingContext2D };
          destroy(output: { canvas: HTMLCanvasElement; context: CanvasRenderingContext2D }): void;
        };
        const output = factory.create(Math.ceil(viewport.width), Math.ceil(viewport.height));
        const renderStart = performance.now();
        try {
          await pdfWithTimeout(first.render({ canvas: output.canvas, viewport }).promise);
        } finally {
          factory.destroy(output);
        }
        const renderMs = performance.now() - renderStart;
        const firstPaintMs = performance.now() - started;
        const afterFirst = process.memoryUsage();
        const firstPaintIO = io();
        const coverRead = reader.bytesRead;
        const turnStart = performance.now();
        const renderAtWidth = async (pageNumber: number, width: number, capturePath?: string) => {
          const page = await pdf.getPage(pageNumber);
          const viewport = page.getViewport({ scale: width / page.getViewport({ scale: 1 }).width });
          const output = factory.create(Math.ceil(viewport.width), Math.ceil(viewport.height));
          try {
            await pdfWithTimeout(page.render({ canvas: output.canvas, viewport }).promise);
            if (capturePath)
              await writeFile(capturePath, Buffer.from(output.canvas.toDataURL("image/png").split(",")[1], "base64"));
          } finally {
            factory.destroy(output);
          }
        };
        await renderAtWidth(Math.min(2, pdf.numPages), 1024);
        const pageTurnMs = performance.now() - turnStart;
        const zoomStart = performance.now();
        await renderAtWidth(1, 2048);
        const zoomPageMs = performance.now() - zoomStart;
        const afterZoom = process.memoryUsage();
        const textStart = performance.now();
        let text = "";
        for (let i = 1; i <= Math.min(3, pdf.numPages) && text.length < 4000; i++) {
          const content = await pdfWithTimeout((await pdf.getPage(i)).getTextContent());
          text += content.items.map((item) => ("str" in item ? item.str : "")).join(" ");
        }
        const textMs = performance.now() - textStart;
        const after = process.memoryUsage();
        expect(failures).toEqual([]);
        expect(reader.largestRead).toBeLessThanOrEqual(PDF_RANGE_CHUNK_SIZE);
        expect(pdf.numPages).toBeGreaterThan(0);
        await record({
          file: path.basename(filename),
          run,
          chunkBytes: PDF_RANGE_CHUNK_SIZE,
          ipcDelayMs,
          openMs,
          workerMs,
          initialMs,
          documentMs,
          firstPageMs,
          renderMs,
          firstPaintMs,
          pageTurnMs,
          zoomPageMs,
          rssAfterFirst: afterFirst.rss,
          rssAfterZoom: afterZoom.rss,
          firstHeapDelta: afterFirst.heapUsed - before.heapUsed,
          firstArrayBuffersDelta: afterFirst.arrayBuffers - before.arrayBuffers,
          firstRssDelta: afterFirst.rss - before.rss,
          firstPaintIO,
          textMs,
          withTextIO: io(),
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
          operations,
          ranges,
        });
        if (report && run === 1)
          await renderAtWidth(1, 1024, path.join(path.dirname(report), `pdfjs-${path.basename(filename)}.png`));
      } finally {
        await task.destroy();
        worker.destroy();
        await reader.close();
      }
    }
  }, 90000);
});
