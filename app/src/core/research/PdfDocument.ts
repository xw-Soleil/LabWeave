import { DocumentRangeReader, PDF_RANGE_CHUNK_SIZE } from "./DocumentFile";

type PdfJs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
export type PdfDocument = Awaited<ReturnType<PdfJs["getDocument"]>["promise"]>;
let library: Promise<PdfJs> | undefined;

export function loadPdfJs(): Promise<PdfJs> {
  return (library ??= import("pdfjs-dist/legacy/build/pdf.mjs").catch((error) => {
    library = undefined;
    throw error;
  }));
}

export function pdfAssetUrls() {
  const base = new URL(`${import.meta.env.BASE_URL}pdfjs/`, window.location.href).href;
  return {
    cMapUrl: `${base}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${base}standard_fonts/`,
    wasmUrl: `${base}wasm/`,
    iccUrl: `${base}iccs/`,
  };
}

export async function pdfWithTimeout<T>(promise: Promise<T>, ms = 20000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("pdfTimeout")), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function createPdfRangeTransport(
  pdfjs: PdfJs,
  reader: DocumentRangeReader,
  onError: (error: unknown) => void,
  isClosed: () => boolean = () => false,
) {
  const initial =
    reader.size > 0 ? await pdfWithTimeout(reader.read(0, Math.min(PDF_RANGE_CHUNK_SIZE, reader.size))) : null;
  const range = new pdfjs.PDFDataRangeTransport(reader.size, initial, true);
  range.requestDataRange = (begin, end) => {
    void pdfWithTimeout(reader.read(begin, end)).then((bytes) => {
      if (!isClosed()) range.onDataRange(begin, bytes);
    }, onError);
  };
  return range;
}

export async function openPdfDocument(path: string, onError: (error: unknown) => void, signal?: AbortSignal) {
  const reader = await DocumentRangeReader.open(path);
  let nativeWorker: Worker | undefined;
  let worker: InstanceType<PdfJs["PDFWorker"]> | undefined;
  let loadingTask: ReturnType<PdfJs["getDocument"]> | undefined;
  let closing: Promise<void> | undefined;
  let stopped = false;
  let rejectFailure!: (error: unknown) => void;
  const failure = new Promise<never>((_resolve, reject) => {
    rejectFailure = reject;
  });
  // Failures also happen after loading, when the viewer asks for another page.
  void failure.catch((error) => {
    if (!signal?.aborted) onError(error);
  });
  const destroy = (): Promise<void> => {
    if (closing) return closing;
    stopped = true;
    signal?.removeEventListener("abort", abort);
    closing = (async () => {
      try {
        if (loadingTask) await pdfWithTimeout(loadingTask.destroy(), 1000);
      } catch (error) {
        // Forced termination below also handles WKWebView workers that never acknowledge destruction.
        if (!(error instanceof Error && error.message === "pdfTimeout")) onError(error);
      } finally {
        try {
          worker?.destroy();
        } finally {
          nativeWorker?.terminate();
          try {
            await pdfWithTimeout(reader.close(), 1000);
          } catch (error) {
            onError(error);
          }
        }
      }
    })();
    return closing;
  };
  const fail = (error: unknown) => {
    if (stopped) return;
    rejectFailure(error);
    void destroy().catch(onError);
  };
  const abort = () => fail(new Error("fileClosed"));
  signal?.addEventListener("abort", abort, { once: true });
  const run = <T>(promise: Promise<T>, ms?: number) => pdfWithTimeout(Promise.race([promise, failure]), ms);
  try {
    if (signal?.aborted) throw new Error("fileClosed");
    const pdfjs = await run(loadPdfJs());
    const workerUrl = await run(import("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url"));
    if (signal?.aborted || stopped) throw new Error("fileClosed");
    nativeWorker = new Worker(workerUrl.default, { type: "module" });
    nativeWorker.addEventListener("error", () => fail(new Error("pdfWorkerFailed")));
    nativeWorker.addEventListener("messageerror", () => fail(new Error("pdfWorkerFailed")));
    worker = pdfjs.PDFWorker.create({ port: nativeWorker });
    const range = await run(createPdfRangeTransport(pdfjs, reader, fail, () => stopped));
    loadingTask = pdfjs.getDocument({
      range,
      worker,
      rangeChunkSize: PDF_RANGE_CHUNK_SIZE,
      disableAutoFetch: true,
      disableStream: true,
      ...pdfAssetUrls(),
      isImageDecoderSupported: false,
      isOffscreenCanvasSupported: false,
    });
    const document = await run(loadingTask.promise);
    return { document, reader, run, destroy };
  } catch (error) {
    await destroy();
    throw error;
  }
}

export type OpenPdfDocument = Awaited<ReturnType<typeof openPdfDocument>>;
