import { WebWorkerEngine, WorkerTask } from "@embedpdf/engines/worker";
import { PdfActionType, PdfErrorCode, type PdfErrorReason, type PdfBookmarkObject } from "@embedpdf/models";
import { DocumentRangeReader } from "./DocumentFile";
import { pdfWithTimeout } from "./PdfDocument";

export const PDF_READER_TIMEOUT = 25000;

export function pdfReaderError(error: unknown): Error {
  if (error instanceof Error) return error;
  const reason = (error as { reason?: PdfErrorReason })?.reason ?? (error as PdfErrorReason);
  if (reason?.code === PdfErrorCode.Password) return new Error("pdfLocked");
  return new Error(reason?.message || "pdfWorkerFailed");
}

export function bookmarkDestination(bookmark: PdfBookmarkObject) {
  const target = bookmark.target;
  if (target?.type === "destination") return target.destination;
  if (target?.type === "action" && target.action.type === PdfActionType.Goto) return target.action.destination;
  return undefined;
}

export function pdfPageNumber(value: string | number, pages: number): number | undefined {
  if (typeof value === "string" && !/^\d+$/.test(value.trim())) return undefined;
  const page = Number(value);
  return Number.isInteger(page) && page >= 1 && page <= pages ? page : undefined;
}

export function pdfPageTransform(rotation: number, width: number, height: number) {
  return [
    "none",
    `translateX(${height}px) rotate(90deg)`,
    `translate(${width}px, ${height}px) rotate(180deg)`,
    `translateY(${width}px) rotate(270deg)`,
  ][rotation % 4];
}

export class PdfReaderEngine extends WebWorkerEngine {
  private stopped = false;
  private pending = new Set<WorkerTask<unknown>>();

  constructor(
    private readonly nativeWorker: Worker,
    private readonly report: (error: Error) => void,
  ) {
    super(nativeWorker);
    nativeWorker.addEventListener("error", this.workerFailed);
    nativeWorker.addEventListener("messageerror", this.workerFailed);
    nativeWorker.addEventListener("message", this.workerMessage);
    this.watch(this.readyTask);
  }

  private workerFailed = () => this.fail(new Error("pdfWorkerFailed"));
  private workerMessage = (event: MessageEvent) => {
    if (event.data?.type === "pdfWorkerFailed") this.workerFailed();
  };

  private fail(error: Error) {
    if (this.stopped) return;
    this.destroy();
    this.report(error);
  }

  private watch<R>(task: WorkerTask<R>) {
    this.pending.add(task as WorkerTask<unknown>);
    const timer = setTimeout(() => this.fail(new Error("pdfTimeout")), PDF_READER_TIMEOUT);
    const done = () => {
      clearTimeout(timer);
      this.pending.delete(task as WorkerTask<unknown>);
    };
    task.wait(done, (error) => {
      done();
      // Page virtualization and superseded searches deliberately cancel work.
      if (error.type !== "abort" && error.reason?.code !== PdfErrorCode.Cancelled) this.fail(pdfReaderError(error));
    });
  }

  override proxy<R>(task: WorkerTask<R>, request: Parameters<WebWorkerEngine["proxy"]>[1]) {
    if (this.stopped) {
      // Plugin teardown may close documents after the owning tab has terminated its worker.
      if (request.data.name === "closeDocument" || request.data.name === "closeAllDocuments") task.resolve(true as R);
      else task.abort({ code: PdfErrorCode.Cancelled, message: "fileClosed" });
      return;
    }
    this.watch(task);
    // Transfer ownership so DocumentManager's retry options cannot retain another full PDF in the UI.
    const transfer = request.data.name === "openDocumentBuffer" ? [request.data.args[0].content] : [];
    super.proxy(task, request, transfer);
  }

  override destroy() {
    if (!this.stopped) {
      this.stopped = true;
      this.nativeWorker.removeEventListener("error", this.workerFailed);
      this.nativeWorker.removeEventListener("messageerror", this.workerFailed);
      this.nativeWorker.removeEventListener("message", this.workerMessage);
      this.nativeWorker.removeEventListener("message", this.handle);
      this.nativeWorker.terminate();
      for (const task of this.pending) task.abort({ code: PdfErrorCode.Cancelled, message: "fileClosed" });
      this.pending.clear();
      this.tasks.clear();
    }
    const task = new WorkerTask<boolean>(this.nativeWorker, "closed");
    task.resolve(true);
    return task;
  }
}

export async function readPdfBuffer(path: string, signal: AbortSignal, onCloseError: (error: unknown) => void) {
  let reader: DocumentRangeReader | undefined;
  let finished = false;
  const close = () => {
    if (reader) void pdfWithTimeout(reader.close(), 1000).catch(onCloseError);
  };
  signal.addEventListener("abort", close, { once: true });
  try {
    const opening = DocumentRangeReader.open(path, signal).then(async (opened) => {
      reader = opened;
      if (signal.aborted || finished) {
        await opened.close().catch(onCloseError);
        throw new Error("fileClosed");
      }
      return opened;
    });
    const opened = await pdfWithTimeout(opening, PDF_READER_TIMEOUT, signal);
    if (!opened.size) throw new Error("pdfEmpty");
    // EmbedPDF 2.15.1 uses FPDF_LoadMemDocument; its URL mode also reads the complete buffer.
    return (await pdfWithTimeout(opened.read(0, opened.size), PDF_READER_TIMEOUT, signal)).buffer;
  } finally {
    finished = true;
    signal.removeEventListener("abort", close);
    if (reader) await pdfWithTimeout(reader.close(), 1000);
  }
}
