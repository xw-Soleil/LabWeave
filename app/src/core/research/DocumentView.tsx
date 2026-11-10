import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import Markdown from "@/components/ui/markdown";
import { Textarea } from "@/components/ui/textarea";
import { TabWorkspace } from "@/core/TabWorkspace";
import { activeTabAtom, store } from "@/state";
import { readFile } from "@tauri-apps/plugin-fs";
import { open } from "@tauri-apps/plugin-shell";
import { ChevronLeft, ChevronRight, ExternalLink, RefreshCw, Save, ZoomIn, ZoomOut } from "lucide-react";
import { useDeferredValue, useEffect, useMemo, useRef, useState, type ComponentProps } from "react";
import { toast } from "sonner";
import { editorText, resolveDocumentImage } from "./DocumentFile";
import { DocumentTab, documentError, documentText as t, openDocumentFile } from "./DocumentTab";
import { loadPdfJs, openPdfDocument, type OpenPdfDocument } from "./PdfDocument";
import { bindPdfZoom, zoomPdf } from "./PdfZoom";
import { fileKindOf } from "./ResearchShell";

function DocumentImage({ path, src, alt }: { path: string; src?: string; alt?: string }) {
  const [image, setImage] = useState<{ url?: string; error?: string }>({});
  useEffect(() => {
    let disposed = false;
    let url: string | undefined;
    setImage({});
    void (async () => {
      const imagePath = resolveDocumentImage(path, src ?? "");
      const bytes = await readFile(imagePath);
      if (disposed) return;
      const extension = imagePath.split(".").at(-1)?.toLowerCase();
      const type = extension === "svg" ? "image/svg+xml" : extension === "jpg" ? "image/jpeg" : `image/${extension}`;
      url = URL.createObjectURL(new Blob([bytes], { type }));
      setImage({ url });
    })().catch((error) => {
      if (!disposed) setImage({ error: documentError(error) });
    });
    return () => {
      disposed = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [path, src]);
  if (image.error)
    return (
      <span role="status" className="text-destructive">
        {alt || src}: {image.error}
      </span>
    );
  return image.url ? (
    <img src={image.url} alt={alt ?? ""} onError={() => setImage({ error: t("imageFailed") })} />
  ) : (
    <span>{t("loading")}</span>
  );
}

function MarkdownView({ tab }: { tab: DocumentTab }) {
  const source = useDeferredValue(editorText(tab.markdown?.text ?? ""));
  const components = useMemo(
    () => ({
      img: (props: ComponentProps<"img">) => <DocumentImage path={tab.path} src={props.src} alt={props.alt} />,
      a: ({ href, children }: ComponentProps<"a">) => (
        <a
          href={href?.startsWith("#") ? href : "#"}
          onAuxClick={(event) => event.preventDefault()}
          onClick={(event) => {
            if (href?.startsWith("#")) return;
            event.preventDefault();
            void (async () => {
              if (!href) return;
              if (/^https?:\/\//i.test(href)) await open(href);
              else {
                const path = resolveDocumentImage(tab.path, href);
                const kind = fileKindOf(path);
                if (kind !== "markdown" && kind !== "pdf") throw new Error("unsupportedLink");
                await openDocumentFile(path);
              }
            })().catch((error) => toast.error(documentError(error)));
          }}
        >
          {children}
        </a>
      ),
    }),
    [tab.path],
  );
  useEffect(() => {
    void tab.loadMarkdown();
  }, [tab]);

  const reload = async () => {
    if (tab.hasUnsavedChanges) {
      const answer = await Dialog.buttons(t("reloadTitle"), t("reloadDescription"), [
        { id: "cancel", label: t("cancel"), variant: "ghost" },
        { id: "reload", label: t("reload"), variant: "destructive" },
      ]);
      if (answer !== "reload") return;
    }
    await tab.loadMarkdown(true);
  };
  return (
    <>
      <div className="flex flex-wrap items-center gap-2 px-4 py-2">
        <Badge variant="secondary">Markdown</Badge>
        <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs" title={tab.path}>
          {tab.path}
        </span>
        <Button variant="ghost" size="sm" disabled={tab.saving || tab.loadingMarkdown} onClick={() => void reload()}>
          <RefreshCw data-icon="inline-start" />
          {t("reload")}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={!tab.markdown || tab.saving || tab.loadingMarkdown}
          onClick={() => void tab.save()}
        >
          <Save data-icon="inline-start" />
          {t(tab.saving ? "saving" : "save")}
        </Button>
      </div>
      {tab.error && (
        <Alert variant="destructive">
          <AlertDescription>{tab.error}</AlertDescription>
        </Alert>
      )}
      {!tab.markdown ? (
        <div role="status" className="text-muted-foreground p-6">
          {tab.error ? t("retryHint") : t("loading")}
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 grid-rows-2 gap-3 p-3 md:grid-cols-2 md:grid-rows-1">
          <section className="flex min-h-0 min-w-0 flex-col gap-2">
            <label htmlFor={`source-${tab.id}`} className="text-muted-foreground px-1 text-xs">
              {t("source")}
            </label>
            <Textarea
              id={`source-${tab.id}`}
              className="min-h-0 flex-1 resize-none overflow-auto font-mono"
              style={{ fieldSizing: "fixed" }}
              spellCheck={false}
              disabled={tab.loadingMarkdown}
              value={editorText(tab.markdown.text)}
              onChange={(event) => {
                tab.markdown!.edit(event.target.value);
                tab.changed();
              }}
            />
          </section>
          <section className="flex min-h-0 min-w-0 flex-col gap-2" aria-label={t("preview")}>
            <div className="text-muted-foreground px-1 text-xs">{t("preview")}</div>
            <div className="bg-card min-h-0 flex-1 overflow-auto rounded-md border p-5 [&_*]:select-text">
              <Markdown source={source} components={components} />
            </div>
          </section>
        </div>
      )}
    </>
  );
}

type Viewer = InstanceType<(typeof import("pdfjs-dist/legacy/web/pdf_viewer.mjs"))["PDFViewer"]>;

function PdfView({ tab }: { tab: DocumentTab }) {
  const container = useRef<HTMLDivElement>(null);
  const viewer = useRef<Viewer | null>(null);
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState({ pages: 0, page: 1, scale: 1, loading: true, error: "" });
  const [jump, setJump] = useState("1");
  useEffect(() => {
    const controller = new AbortController();
    bindPdfZoom(
      container.current!,
      () => viewer.current,
      () => store.get(activeTabAtom) === tab,
      controller.signal,
    );
    let session: OpenPdfDocument | undefined;
    let pdfViewer: Viewer | undefined;
    let linkService:
      | InstanceType<(typeof import("pdfjs-dist/legacy/web/pdf_viewer.mjs"))["PDFLinkService"]>
      | undefined;
    let observer: ResizeObserver | undefined;
    const report = (error: unknown) => {
      if (controller.signal.aborted) return;
      clearTimeout(timer);
      setState((value) => ({ ...value, pages: 0, loading: false, error: documentError(error) }));
      stop();
    };
    const stop = () => {
      if (controller.signal.aborted) return;
      controller.abort();
      clearTimeout(timer);
      observer?.disconnect();
      viewer.current = null;
      try {
        pdfViewer?.setDocument(null as never);
        linkService?.setDocument(null as never);
      } catch (error) {
        toast.error(documentError(error));
      } finally {
        void session?.destroy().catch((error) => toast.error(documentError(error)));
      }
    };
    let timer = setTimeout(() => report(new Error("pdfTimeout")), 25000);
    const watchCurrentPage = () => {
      if (controller.signal.aborted || !pdfViewer) return;
      clearTimeout(timer);
      const page = pdfViewer.getPageView(pdfViewer.currentPageNumber - 1);
      const loading = !page || !pdfViewer.renderingQueue?.isViewFinished(page);
      setState((value) => ({ ...value, loading }));
      if (loading) timer = setTimeout(() => report(new Error("pdfTimeout")), 25000);
    };
    setState({ pages: 0, page: tab.pdfLocation.page, scale: 1, loading: true, error: "" });
    setJump(String(tab.pdfLocation.page));
    void (async () => {
      // The viewer bundle reads the global installed by the matching legacy API bundle.
      await loadPdfJs();
      const { PDFViewer, EventBus, PDFLinkService } = await import("pdfjs-dist/legacy/web/pdf_viewer.mjs");
      await import("pdfjs-dist/web/pdf_viewer.css");
      if (controller.signal.aborted) return;
      const eventBus = new EventBus();
      linkService = new PDFLinkService({ eventBus });
      linkService.externalLinkEnabled = false;
      // pdf.js reads abortSignal even though its generated PDFViewerOptions omits it.
      const viewerOptions = {
        container: container.current!,
        eventBus,
        linkService,
        maxCanvasPixels: 4096 * 4096,
        abortSignal: controller.signal,
      };
      pdfViewer = new PDFViewer(viewerOptions);
      viewer.current = pdfViewer;
      linkService.setViewer(pdfViewer);
      const eventOptions = { signal: controller.signal };
      eventBus.on(
        "pagesinit",
        () => {
          const location = { ...tab.pdfLocation };
          pdfViewer!.currentScaleValue = location.scale;
          pdfViewer!.currentPageNumber = Math.min(location.page, session!.document.numPages);
          setJump(String(pdfViewer!.currentPageNumber));
          tab.pdfLocation.page = pdfViewer!.currentPageNumber;
          setState((value) => ({ ...value, pages: session!.document.numPages, page: pdfViewer!.currentPageNumber }));
          watchCurrentPage();
        },
        eventOptions,
      );
      eventBus.on(
        "pagerender",
        (event: { pageNumber: number }) => {
          if (event.pageNumber === pdfViewer!.currentPageNumber) watchCurrentPage();
        },
        eventOptions,
      );
      eventBus.on(
        "pagerendered",
        (event: { pageNumber: number; error?: unknown }) => {
          if (event.error) report(event.error);
          else if (event.pageNumber === pdfViewer!.currentPageNumber) watchCurrentPage();
        },
        eventOptions,
      );
      eventBus.on(
        "pagechanging",
        (event: { pageNumber: number }) => {
          tab.pdfLocation.page = event.pageNumber;
          setState((value) => ({ ...value, page: event.pageNumber }));
          setJump(String(event.pageNumber));
          watchCurrentPage();
        },
        eventOptions,
      );
      eventBus.on(
        "scalechanging",
        (event: { scale: number }) => {
          tab.pdfLocation.scale = pdfViewer!.currentScaleValue;
          setState((value) => ({ ...value, scale: event.scale }));
          watchCurrentPage();
        },
        eventOptions,
      );
      session = await openPdfDocument(
        tab.path,
        (error) => {
          if (controller.signal.aborted) toast.error(documentError(error));
          else report(error);
        },
        controller.signal,
      );
      if (controller.signal.aborted) {
        await session.destroy().catch((error) => toast.error(documentError(error)));
        return;
      }
      linkService.setDocument(session.document);
      pdfViewer.setDocument(session.document);
      observer = new ResizeObserver(() => {
        if (!controller.signal.aborted && container.current?.clientWidth && pdfViewer) {
          if (pdfViewer.currentScaleValue === "page-width") pdfViewer.currentScaleValue = "page-width";
          pdfViewer.update();
        }
      });
      observer.observe(container.current!);
    })().catch(report);
    return () => {
      clearTimeout(timer);
      stop();
      viewer.current = null;
    };
  }, [tab, revision]);
  const go = (page: number) => {
    if (viewer.current && Number.isInteger(page) && page >= 1 && page <= state.pages) {
      viewer.current.currentPageNumber = page;
      setJump(String(viewer.current.currentPageNumber));
    } else setJump(String(state.page));
  };
  const zoom = (factor: number) => {
    if (viewer.current) zoomPdf(viewer.current, viewer.current.currentScale * factor);
  };
  return (
    <>
      <div className="flex flex-wrap items-center justify-center gap-2 px-3 py-2">
        <Button
          variant="ghost"
          size="icon"
          aria-label={t("previousPage")}
          disabled={state.page <= 1}
          onClick={() => go(state.page - 1)}
        >
          <ChevronLeft />
        </Button>
        <Input
          className="w-16"
          type="number"
          min={1}
          max={state.pages}
          aria-label={t("page")}
          value={jump}
          onChange={(event) => setJump(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") go(Number(jump));
          }}
          onBlur={() => go(Number(jump))}
        />
        <span className="text-muted-foreground text-xs">/ {state.pages || "—"}</span>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t("nextPage")}
          disabled={state.page >= state.pages}
          onClick={() => go(state.page + 1)}
        >
          <ChevronRight />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t("zoomOut")}
          disabled={!state.pages}
          onClick={() => zoom(1 / 1.2)}
        >
          <ZoomOut />
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={!state.pages}
          onClick={() => {
            if (viewer.current) viewer.current.currentScaleValue = "page-width";
          }}
          title={t("fitWidth")}
        >
          {Math.round(state.scale * 100)}%
        </Button>
        <Button variant="ghost" size="icon" aria-label={t("zoomIn")} disabled={!state.pages} onClick={() => zoom(1.2)}>
          <ZoomIn />
        </Button>
      </div>
      {state.error && (
        <Alert variant="destructive">
          <AlertDescription className="flex items-center gap-2">
            {state.error}
            <Button variant="outline" size="sm" onClick={() => setRevision((value) => value + 1)}>
              {t("retry")}
            </Button>
          </AlertDescription>
        </Alert>
      )}
      <div className="bg-muted relative min-h-0 flex-1">
        {state.loading && (
          <div role="status" className="text-muted-foreground absolute inset-x-0 top-2 text-center text-sm">
            {t("loading")}
          </div>
        )}
        <div ref={container} tabIndex={0} className="pg-document-pdf absolute inset-0 overflow-auto">
          <div className="pdfViewer" />
        </div>
      </div>
    </>
  );
}

export default function DocumentView({ tab }: { tab: DocumentTab }) {
  const [, update] = useState(0);
  useEffect(() => {
    const changed = () => update((value) => value + 1);
    tab.on("state-change", changed);
    return () => {
      tab.off("state-change", changed);
    };
  }, [tab]);
  return (
    <div
      className="bg-background flex h-full min-h-0 flex-col pt-9"
      onFocusCapture={() => {
        if (store.get(activeTabAtom) !== tab) TabWorkspace.focus(tab.id);
      }}
    >
      <div className="flex items-center gap-2 px-4">
        <tab.icon className="text-muted-foreground size-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium" title={tab.path}>
          {tab.title}
        </span>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void open(tab.path).catch((error) => toast.error(documentError(error)))}
        >
          <ExternalLink data-icon="inline-start" />
          {t("openSystem")}
        </Button>
      </div>
      {tab.kind === "markdown" ? <MarkdownView tab={tab} /> : <PdfView tab={tab} />}
    </div>
  );
}
