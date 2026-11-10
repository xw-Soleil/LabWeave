export interface PdfZoomTarget {
  container: HTMLDivElement;
  currentScale: number;
  requestZoom(scale: number, center: { vx: number; vy: number }): void;
}

const clampScale = (scale: number) => Math.max(0.25, Math.min(4, scale));

export function zoomPdf(viewer: PdfZoomTarget, scale: number, point?: [number, number]) {
  if (!Number.isFinite(scale)) return;
  const rect = viewer.container.getBoundingClientRect();
  viewer.requestZoom(clampScale(scale), {
    vx: point ? point[0] - rect.left : rect.width / 2,
    vy: point ? point[1] - rect.top : rect.height / 2,
  });
}

export function bindPdfZoom(
  container: HTMLDivElement,
  getViewer: () => PdfZoomTarget | null,
  isActive: () => boolean,
  signal: AbortSignal,
) {
  let frame = 0;
  let targetScale: number | undefined;
  let appliedScale: number | undefined;
  let point: [number, number] | undefined;
  let gestureScale: number | undefined;
  const reset = () => {
    cancelAnimationFrame(frame);
    frame = 0;
    targetScale = appliedScale = undefined;
  };
  const schedule = (viewer: PdfZoomTarget) => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      zoomPdf(viewer, targetScale!, point);
      appliedScale = viewer.currentScale;
    });
  };
  container.addEventListener("pointermove", (event) => (point = [event.clientX, event.clientY]), { signal });
  container.addEventListener("pointerleave", () => (point = undefined), { signal });
  container.addEventListener(
    "wheel",
    (event) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      event.stopPropagation();
      if (gestureScale !== undefined) return;
      const viewer = getViewer();
      if (!viewer || !Number.isFinite(event.deltaY)) return;
      const mode = event.deltaMode;
      const delta = mode === 0 ? event.deltaY : Math.sign(event.deltaY) * Math.min(1, Math.abs(event.deltaY)) * 30;
      if (targetScale === undefined || viewer.currentScale !== appliedScale) targetScale = viewer.currentScale;
      // Accumulate small pinch deltas instead of losing them to per-event rounding.
      targetScale = clampScale(targetScale * Math.exp(-Math.max(-30, Math.min(30, delta)) / 100));
      appliedScale = viewer.currentScale;
      point = [event.clientX, event.clientY];
      schedule(viewer);
    },
    { passive: false, signal },
  );
  // WKWebView trackpads emit GestureEvents instead of ctrl+wheel.
  const gesture = (event: Event) => {
    const viewer = getViewer();
    if (!viewer) return;
    event.preventDefault();
    event.stopPropagation();
    const native = event as Event & { scale: number; clientX?: number; clientY?: number };
    if (event.type === "gesturestart") {
      reset();
      gestureScale = viewer.currentScale;
    }
    if (gestureScale !== undefined && Number.isFinite(native.scale) && native.scale > 0) {
      if (Number.isFinite(native.clientX) && Number.isFinite(native.clientY))
        point = [native.clientX!, native.clientY!];
      targetScale = clampScale(gestureScale * native.scale);
      schedule(viewer);
    }
    if (event.type === "gestureend") gestureScale = undefined;
  };
  for (const name of ["gesturestart", "gesturechange", "gestureend"]) {
    container.addEventListener(name, gesture, { passive: false, signal });
  }
  container.addEventListener(
    "pointerdown",
    (event) => {
      const target = event.target;
      if (target instanceof Element && !target.closest("input, textarea, select, button, a, [contenteditable]"))
        container.focus({ preventScroll: true });
    },
    { signal },
  );
  container.addEventListener(
    "keydown",
    (event) => {
      if (!isActive() || (!event.ctrlKey && !event.metaKey) || event.altKey || event.isComposing) return;
      if (!["+", "=", "-", "0"].includes(event.key)) return;
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest("input, textarea, select, [contenteditable]:not([contenteditable=false])")
      )
        return;
      event.preventDefault();
      // Consume inside the reader before KeyBindsUI's window listener.
      event.stopImmediatePropagation();
      reset();
      const viewer = getViewer();
      if (viewer)
        zoomPdf(viewer, event.key === "0" ? 1 : viewer.currentScale * (event.key === "-" ? 1 / 1.2 : 1.2), point);
    },
    { capture: true, signal },
  );
  signal.addEventListener("abort", reset, { once: true });
}
