import { EngineRunner } from "@embedpdf/engines";
import { createPdfiumEngine } from "@embedpdf/engines/pdfium-direct-engine";
import { FontCharset } from "@embedpdf/models";
import wasmUrl from "@embedpdf/pdfium/pdfium.wasm?url";
import fontUrl from "@/assets/fonts/NotoSansSC-Regular.otf?url";

const localFontUrl = new URL(fontUrl, self.location.href).href;
const failed = () => self.postMessage({ type: "pdfWorkerFailed" });

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
  const runner = new EngineRunner();
  runner.engine = await createPdfiumEngine(new URL(wasmUrl, self.location.href).href, {
    fontFallback: { fonts: { [FontCharset.GB2312]: localFontUrl }, fontLoader: loadLocalFont },
  });
  runner.ready();
})().catch(failed);
