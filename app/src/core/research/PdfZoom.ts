type Viewer = InstanceType<(typeof import("pdfjs-dist/legacy/web/pdf_viewer.mjs"))["PDFViewer"]>;

const clampScale = (scale: number) => Math.max(0.25, Math.min(4, scale));

export function zoomPdf(viewer: Viewer, scale: number, point?: [number, number]) {
  const rect = viewer.container.getBoundingClientRect();
  const [top, left] = viewer.containerTopLeft;
  // PDFViewer expects offset-parent coordinates; our pane is nested below the toolbar.
  const origin = point ? [point[0] - rect.left + left, point[1] - rect.top + top] : undefined;
  viewer.updateScale({ scaleFactor: clampScale(scale) / viewer.currentScale, origin, drawingDelay: 150 });
}

export function bindPdfZoom(
  container: HTMLDivElement,
  getViewer: () => Viewer | null,
  isActive: () => boolean,
  signal: AbortSignal,
) {
  let frame = 0;
  let targetScale: number | undefined;
  let appliedScale: number | undefined;
  let point: [number, number];
  const reset = () => {
    cancelAnimationFrame(frame);
    frame = 0;
    targetScale = appliedScale = undefined;
  };
  container.addEventListener(
    "wheel",
    (event) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      event.stopPropagation();
      const viewer = getViewer();
      if (!viewer || !Number.isFinite(event.deltaY)) return;
      const mode = event.deltaMode;
      const delta = mode === 0 ? event.deltaY : Math.sign(event.deltaY) * Math.min(1, Math.abs(event.deltaY)) * 30;
      if (targetScale === undefined || viewer.currentScale !== appliedScale) targetScale = viewer.currentScale;
      // Keep sub-percent pinch deltas: PDFViewer rounds each applied scale to 1%.
      targetScale = clampScale(targetScale * Math.exp(-Math.max(-30, Math.min(30, delta)) / 100));
      appliedScale = viewer.currentScale;
      point = [event.clientX, event.clientY];
      if (!frame) {
        frame = requestAnimationFrame(() => {
          frame = 0;
          zoomPdf(viewer, targetScale!, point);
          appliedScale = viewer.currentScale;
        });
      }
    },
    { passive: false, signal },
  );
  window.addEventListener(
    "keydown",
    (event) => {
      if (!isActive() || (!event.ctrlKey && !event.metaKey) || event.altKey || event.isComposing) return;
      if (!["+", "=", "-", "0"].includes(event.key)) return;
      const target = event.target;
      if (target instanceof Element && target.closest("input, textarea, [contenteditable=true]")) return;
      event.preventDefault();
      // Capture before KeyBindsUI's window listener and the WebView's page zoom.
      event.stopImmediatePropagation();
      reset();
      const viewer = getViewer();
      if (viewer) zoomPdf(viewer, event.key === "0" ? 1 : viewer.currentScale * (event.key === "-" ? 1 / 1.2 : 1.2));
    },
    { capture: true, signal },
  );
  signal.addEventListener("abort", reset, { once: true });
}
