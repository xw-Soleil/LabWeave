import { EngineRunner } from "@embedpdf/engines";
import { createPdfiumEngine } from "@embedpdf/engines/pdfium-direct-engine";
import {
  FontCharset,
  PdfErrorCode,
  type PdfDocumentObject,
  type PdfEngineMethodName,
  type PdfTask,
} from "@embedpdf/models";
import { normalizePdfPageBox } from "./PdfAnnotations";
import wasmUrl from "@embedpdf/pdfium/pdfium.wasm?url";
import fontUrl from "@/assets/fonts/NotoSansSC-Regular.otf?url";

const localFontUrl = new URL(fontUrl, self.location.href).href;
const failed = () => self.postMessage({ type: "pdfWorkerFailed" });

const readerMethods = new Set<PdfEngineMethodName>([
  "openDocumentBuffer",
  "closeDocument",
  "closeAllDocuments",
  "destroy",
  "getBookmarks",
  "getPageAnnotations",
  "getPageGeometry",
  "getTextSlices",
  "extractText",
  "searchAllPages",
  "renderPage",
  "renderPageRect",
  "renderPageRaw",
  "renderPageRectRaw",
]);

class PdfReaderRunner extends EngineRunner {
  private pending = new Map<string, PdfTask<unknown>>();

  override handle(event: Parameters<EngineRunner["handle"]>[0]) {
    if (event.data.type === "AbortRequest") {
      this.pending.get(event.data.id)?.abort({ code: PdfErrorCode.Cancelled, message: "fileClosed" });
    } else super.handle(event);
  }

  // 2.15.1's runner ignores AbortRequest and does not report thrown engine calls.
  override execute = async (request: Parameters<EngineRunner["execute"]>[0]) => {
    const { id, data } = request;
    const respond = (result: unknown) => {
      this.pending.delete(id);
      self.postMessage({ id, type: "ExecuteResponse", data: result });
    };
    try {
      const method = this.engine?.[data.name];
      if (!readerMethods.has(data.name) || !method) throw new Error("pdfWorkerFailed");
      const task: PdfTask<unknown> = Reflect.apply(method, this.engine, data.args);
      this.pending.set(id, task);
      task.onProgress((progress) => {
        if (this.pending.get(id) === task) self.postMessage({ id, type: "ExecuteProgress", data: progress });
      });
      task.wait(
        (value) => {
          if (data.name === "openDocumentBuffer") {
            const document = value as PdfDocumentObject;
            document.pages = document.pages.map(normalizePdfPageBox);
          }
          respond({ type: "result", value });
        },
        (value) => respond({ type: "error", value }),
      );
    } catch {
      respond({
        type: "error",
        value: { type: "reject", reason: { code: PdfErrorCode.Unknown, message: "pdfWorkerFailed" } },
      });
    }
  };
}

function loadLocalFont(url: string): Uint8Array | null {
  try {
    if (url !== localFontUrl) throw new Error("pdfWorkerFailed");
    const request = new XMLHttpRequest();
    request.open("GET", localFontUrl, false);
    request.responseType = "arraybuffer";
    request.send();
    if (request.status !== 200 || !request.response?.byteLength) throw new Error("pdfWorkerFailed");
    return new Uint8Array(request.response);
  } catch {
    // PDFium's font callback swallows exceptions; report asset failures to the reader explicitly.
    failed();
    return null;
  }
}

// The direct engine runs exclusively inside this Vite worker, never on the UI thread.
void (async () => {
  const runner = new PdfReaderRunner();
  runner.engine = await createPdfiumEngine(new URL(wasmUrl, self.location.href).href, {
    fontFallback: { fonts: { [FontCharset.GB2312]: localFontUrl }, fontLoader: loadLocalFont },
  });
  runner.ready();
})().catch(failed);
