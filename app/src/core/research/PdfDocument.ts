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

export async function pdfWithTimeout<T>(promise: Promise<T>, ms = 20000, signal?: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("pdfTimeout")), ms);
        abort = () => reject(new Error("fileClosed"));
        if (signal?.aborted) abort();
        else signal?.addEventListener("abort", abort, { once: true });
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (abort) signal?.removeEventListener("abort", abort);
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
  const controller = new AbortController();
  let reader: DocumentRangeReader | undefined;
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
    if (!signal?.aborted && !(error instanceof Error && error.message === "fileClosed")) onError(error);
  });
  const destroy = (): Promise<void> => {
    if (closing) return closing;
    stopped = true;
    signal?.removeEventListener("abort", abort);
    controller.abort();
    rejectFailure(new Error("fileClosed"));
    closing = (async () => {
      const closeReader = reader ? pdfWithTimeout(reader.close(), 1000).catch(onError) : Promise.resolve();
      try {
        if (loadingTask) await pdfWithTimeout(loadingTask.destroy(), 1000);
      } catch (error) {
        // Forced termination below also handles WKWebView workers that never acknowledge destruction.
        if (!(error instanceof Error && error.message === "pdfTimeout")) onError(error);
      } finally {
        try {
          worker?.destroy();
        } finally {
          nativeWorker?.removeEventListener("error", workerFailed);
          nativeWorker?.removeEventListener("messageerror", workerFailed);
          nativeWorker?.terminate();
          await closeReader;
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
  const workerFailed = () => fail(new Error("pdfWorkerFailed"));
  signal?.addEventListener("abort", abort, { once: true });
  const run = async <T>(promise: Promise<T>, ms?: number): Promise<T> => {
    try {
      return await pdfWithTimeout(Promise.race([promise, failure]), ms);
    } catch (error) {
      if (error instanceof Error && error.message === "pdfTimeout") fail(error);
      throw error;
    }
  };
  try {
    if (signal?.aborted) throw new Error("fileClosed");
    const opening = DocumentRangeReader.open(path, controller.signal)
      .then(async (opened) => {
        if (stopped) {
          await opened.close();
          throw new Error("fileClosed");
        }
        reader = opened;
        return opened;
      })
      .catch((error) => {
        if (stopped && !(error instanceof Error && error.message === "fileClosed")) onError(error);
        throw error;
      });
    const openedReader = await run(opening);
    const pdfjs = await run(loadPdfJs());
    const workerUrl = await run(import("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url"));
    if (signal?.aborted || stopped) throw new Error("fileClosed");
    nativeWorker = new Worker(workerUrl.default, { type: "module" });
    nativeWorker.addEventListener("error", workerFailed);
    nativeWorker.addEventListener("messageerror", workerFailed);
    worker = pdfjs.PDFWorker.create({ port: nativeWorker });
    const range = await run(createPdfRangeTransport(pdfjs, openedReader, fail, () => stopped));
    if (stopped) throw new Error("fileClosed");
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
    return { document, reader: openedReader, run, destroy, signal: controller.signal };
  } catch (error) {
    await destroy();
    throw error;
  }
}

export type OpenPdfDocument = Awaited<ReturnType<typeof openPdfDocument>>;
