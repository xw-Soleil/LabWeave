import { WebWorkerEngine, WorkerTask } from "@embedpdf/engines/worker";
import { PdfActionType, PdfErrorCode, TaskStage, type PdfErrorReason, type PdfLinkTarget } from "@embedpdf/models";
import { DocumentRangeReader } from "./DocumentFile";
import { pdfWithTimeout } from "./PdfDocument";

export const PDF_READER_TIMEOUT = 25000;
// shortcut: 2.15.1 copies the entire PDF into WASM; lift this limit when range opening is available.
export const PDF_READER_MAX_BYTES = 128 * 1024 * 1024;

export function pdfReaderError(error: unknown): Error {
  if (error instanceof Error) return error;
  const reason = (error as { reason?: PdfErrorReason })?.reason ?? (error as PdfErrorReason);
  if (reason?.code === PdfErrorCode.Password) return new Error("pdfLocked");
  return new Error(reason?.message || "pdfWorkerFailed");
}

export function pdfDestination(target: PdfLinkTarget | undefined) {
  if (target?.type === "destination") return target.destination;
  if (target?.type === "action" && target.action.type === PdfActionType.Goto) return target.action.destination;
  return undefined;
}

export function pdfExternalUrl(target: PdfLinkTarget | undefined): string | undefined {
  if (target?.type !== "action" || target.action.type !== PdfActionType.URI) return undefined;
  const uri = target.action.uri.trim();
  if (/^https?:\/\/[^\s]+$/i.test(uri)) return uri;
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
    this.watch(this.readyTask, WebWorkerEngine.readyTaskId);
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

  private watch<R>(task: WorkerTask<R>, id: string) {
    this.pending.add(task as WorkerTask<unknown>);
    const timer = setTimeout(() => this.fail(new Error("pdfTimeout")), PDF_READER_TIMEOUT);
    const done = () => {
      clearTimeout(timer);
      this.pending.delete(task as WorkerTask<unknown>);
      this.tasks.delete(id);
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
    this.watch(task, request.id);
    // Transfer ownership so DocumentManager's retry options cannot retain another full PDF in the UI.
    const transfer = request.data.name === "openDocumentBuffer" ? [request.data.args[0].content] : [];
    // Upstream Task.wait swallows callback exceptions, including postMessage failures.
    this.readyTask.wait(
      () => {
        if (this.stopped || task.state.stage !== TaskStage.Pending) return;
        this.tasks.set(request.id, task);
        try {
          this.nativeWorker.postMessage(request, transfer);
        } catch {
          task.reject({ code: PdfErrorCode.Unknown, message: "pdfWorkerFailed" });
        }
      },
      () => task.abort({ code: PdfErrorCode.Cancelled, message: "fileClosed" }),
    );
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
    const opening = DocumentRangeReader.open(path, signal)
      .then(async (opened) => {
        reader = opened;
        if (signal.aborted || finished) {
          await pdfWithTimeout(opened.close(), 1000).catch(onCloseError);
          throw new Error("fileClosed");
        }
        return opened;
      })
      .catch((error) => {
        if ((signal.aborted || finished) && !(error instanceof Error && error.message === "fileClosed"))
          onCloseError(error);
        throw error;
      });
    const opened = await pdfWithTimeout(opening, PDF_READER_TIMEOUT, signal);
    if (!Number.isSafeInteger(opened.size) || opened.size < 0 || opened.size > PDF_READER_MAX_BYTES)
      throw new Error("pdfTooLarge");
    if (!opened.size) throw new Error("pdfEmpty");
    // EmbedPDF 2.15.1 uses FPDF_LoadMemDocument; its URL mode also reads the complete buffer.
    return (await pdfWithTimeout(opened.read(0, opened.size), PDF_READER_TIMEOUT, signal)).buffer;
  } finally {
    finished = true;
    signal.removeEventListener("abort", close);
    if (reader) await pdfWithTimeout(reader.close(), 1000);
  }
}
