import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { activeTabAtom, store } from "@/state";
import { cn } from "@/utils/cn";
import { createPluginRegistration } from "@embedpdf/core";
import { EmbedPDF, useDocumentPermissions } from "@embedpdf/core/react";
import { PdfErrorCode, PdfZoomMode, type PdfBookmarkObject, type PdfDocumentObject } from "@embedpdf/models";
import { BookmarkPluginPackage, useBookmarkCapability } from "@embedpdf/plugin-bookmark/react";
import { DocumentManagerPluginPackage } from "@embedpdf/plugin-document-manager/react";
import {
  GlobalPointerProvider,
  InteractionManagerPluginPackage,
  PagePointerProvider,
} from "@embedpdf/plugin-interaction-manager/react";
import { RenderLayer, RenderPluginPackage } from "@embedpdf/plugin-render/react";
import { Scroller, ScrollPluginPackage, useScroll, useScrollCapability } from "@embedpdf/plugin-scroll/react";
import { SearchLayer, SearchPluginPackage, useSearch, useSearchCapability } from "@embedpdf/plugin-search/react";
import { SelectionLayer, SelectionPluginPackage, useSelectionCapability } from "@embedpdf/plugin-selection/react";
import { ThumbImg, ThumbnailPluginPackage, ThumbnailsPane, type ThumbMeta } from "@embedpdf/plugin-thumbnail/react";
import { TilingLayer, TilingPluginPackage } from "@embedpdf/plugin-tiling/react";
import {
  Viewport,
  ViewportPluginPackage,
  useViewportElement,
  useViewportCapability,
} from "@embedpdf/plugin-viewport/react";
import { useZoom, useZoomCapability, ZoomMode, ZoomPluginPackage } from "@embedpdf/plugin-zoom/react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { ChevronDown, ChevronLeft, ChevronRight, Copy, PanelLeft, Search, X, ZoomIn, ZoomOut } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { DocumentTab, documentError, documentText as t } from "./DocumentTab";
import {
  bookmarkDestination,
  PDF_READER_TIMEOUT,
  PdfReaderEngine,
  pdfPageNumber,
  pdfPageTransform,
  pdfReaderError,
  readPdfBuffer,
} from "./PdfReader";
import { bindPdfZoom, zoomPdf } from "./PdfZoom";

const reportToast = (error: unknown) => toast.error(documentError(pdfReaderError(error)));

function IconButton({
  label,
  children,
  ...props
}: { label: string; children: ReactNode } & Omit<React.ComponentProps<typeof Button>, "children">) {
  return (
    <Button variant="ghost" size="icon" aria-label={label} title={label} {...props}>
      {children}
    </Button>
  );
}

function PdfPage({
  documentId,
  page,
  scale,
  onPaint,
  onError,
}: {
  documentId: string;
  page: PdfDocumentObject["pages"][number];
  scale: number;
  onPaint: () => void;
  onError: (error: unknown) => void;
}) {
  const [painted, setPainted] = useState(false);
  useEffect(() => {
    if (painted) return;
    const timer = setTimeout(() => onError(new Error("pdfTimeout")), PDF_READER_TIMEOUT);
    return () => clearTimeout(timer);
  }, [painted, onError]);
  return (
    <div
      className="absolute origin-top-left"
      style={{ transform: pdfPageTransform(page.rotation, page.size.width * scale, page.size.height * scale) }}
    >
      <PagePointerProvider
        documentId={documentId}
        pageIndex={page.index}
        className="bg-white shadow-sm"
        data-pdf-page={page.index}
      >
        <RenderLayer
          documentId={documentId}
          pageIndex={page.index}
          scale={Math.min(1, 1600 / Math.max(page.size.width, page.size.height))}
          dpr={1}
          className="pointer-events-none absolute inset-0"
          onLoad={() => {
            setPainted(true);
            onPaint();
          }}
          onError={() => onError(new Error("pdfRenderFailed"))}
        />
        <TilingLayer documentId={documentId} pageIndex={page.index} className="pointer-events-none absolute inset-0" />
        <SearchLayer documentId={documentId} pageIndex={page.index} className="absolute inset-0" />
        <SelectionLayer documentId={documentId} pageIndex={page.index} />
      </PagePointerProvider>
    </div>
  );
}

function PdfGestures({ tab }: { tab: DocumentTab }) {
  const viewport = useViewportElement();
  const { provides } = useZoomCapability();
  useEffect(() => {
    const container = viewport?.current;
    if (!container || !provides) return;
    const zoom = provides.forDocument(tab.id);
    const controller = new AbortController();
    bindPdfZoom(
      container,
      () => ({
        container,
        get currentScale() {
          return zoom.getState().currentZoomLevel;
        },
        requestZoom: (scale, point) => zoom.requestZoom(scale, point),
      }),
      () => store.get(activeTabAtom) === tab,
      controller.signal,
    );
    return () => controller.abort();
  }, [viewport, provides, tab]);
  return null;
}

function OutlineItem({ item, go }: { item: PdfBookmarkObject; go: (item: PdfBookmarkObject) => void }) {
  const destination = bookmarkDestination(item);
  const children = item.children ?? [];
  return (
    <li>
      <Collapsible defaultOpen>
        <div className="flex min-w-0 items-center">
          {children.length > 0 && (
            <CollapsibleTrigger asChild>
              <IconButton label={t("pdf.toggleOutlineItem")}>
                <ChevronDown />
              </IconButton>
            </CollapsibleTrigger>
          )}
          <Button
            variant="ghost"
            className="h-auto min-w-0 flex-1 justify-start py-2 text-left whitespace-normal"
            disabled={!destination}
            onClick={() => go(item)}
          >
            <span className="min-w-0 flex-1 break-words">{item.title || t("pdf.untitledBookmark")}</span>
            {destination && (
              <span className="text-muted-foreground text-xs tabular-nums">{destination.pageIndex + 1}</span>
            )}
          </Button>
        </div>
        {children.length > 0 && (
          <CollapsibleContent>
            <ul className="ml-3 border-l pl-2">
              {children.map((child, index) => (
                <OutlineItem key={index} item={child} go={go} />
              ))}
            </ul>
          </CollapsibleContent>
        )}
      </Collapsible>
    </li>
  );
}

export function PdfReaderContent({
  tab,
  document: pdf,
  onPaint,
  onError,
}: {
  tab: DocumentTab;
  document: PdfDocumentObject;
  onPaint: () => void;
  onError: (error: unknown) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const [initialLocation] = useState(() => ({ ...tab.pdfLocation }));
  const { provides: scrollApi } = useScrollCapability();
  const { provides: viewportApi } = useViewportCapability();
  const { provides: zoomApi } = useZoomCapability();
  const { provides: searchApi } = useSearchCapability();
  const { provides: selectionApi } = useSelectionCapability();
  const { provides: bookmarksApi } = useBookmarkCapability();
  const scroll = useMemo(() => scrollApi?.forDocument(tab.id), [scrollApi, tab.id]);
  const zoom = useMemo(() => zoomApi?.forDocument(tab.id), [zoomApi, tab.id]);
  const search = useMemo(() => searchApi?.forDocument(tab.id), [searchApi, tab.id]);
  const selection = useMemo(() => selectionApi?.forDocument(tab.id), [selectionApi, tab.id]);
  const { state: scrollState } = useScroll(tab.id);
  const { state: zoomState } = useZoom(tab.id);
  const { state: searchState } = useSearch(tab.id);
  const { canCopyContents } = useDocumentPermissions(tab.id);
  const [sidebar, setSidebar] = useState(true);
  const [sidebarPage, setSidebarPage] = useState("thumbnails");
  const [bookmarks, setBookmarks] = useState<PdfBookmarkObject[] | null>(null);
  const [jump, setJump] = useState(String(initialLocation.page));
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [hasSelection, setHasSelection] = useState(false);
  const page = scrollState.currentPage;
  const pages = pdf.pages.length;

  useEffect(() => {
    if (!scroll || !scrollApi || !zoom || !viewportApi) return;
    let restored = false;
    const restore = () => {
      if (restored) return;
      const metrics = viewportApi.forDocument(tab.id).getMetrics();
      if (!metrics.clientWidth || !metrics.clientHeight) return;
      restored = true;
      // The v2 zoom plugin only recalculates automatic modes when the viewport mounts.
      zoom.requestZoom(zoom.getState().zoomLevel);
      scroll.scrollToPage({ pageNumber: Math.min(initialLocation.page, pages), behavior: "instant" });
    };
    const offLayout = scrollApi.onLayoutReady((event) => {
      if (event.documentId === tab.id) restore();
    });
    const offResize = viewportApi.onViewportResize((event) => {
      if (event.documentId === tab.id) restore();
    });
    restore();
    const offPage = scroll.onPageChange((event) => {
      if (restored) tab.pdfLocation.page = event.pageNumber;
    });
    const offZoom = zoom.onZoomChange((event) => {
      tab.pdfLocation.scale = event.level;
    });
    return () => {
      offLayout();
      offResize();
      offPage();
      offZoom();
    };
  }, [scroll, scrollApi, viewportApi, zoom, tab, initialLocation, pages]);

  useEffect(() => setJump(String(page)), [page]);
  useEffect(() => {
    if (!bookmarksApi) return;
    let live = true;
    const task = bookmarksApi.forDocument(tab.id).getBookmarks();
    task.wait(
      (value) => {
        if (live) setBookmarks(value.bookmarks);
      },
      (error) => {
        if (live && error.type !== "abort") onError(pdfReaderError(error));
      },
    );
    return () => {
      live = false;
      task.abort({ code: PdfErrorCode.Cancelled, message: "fileClosed" });
    };
  }, [bookmarksApi, tab.id, onError]);

  useEffect(() => selection?.onSelectionChange((value) => setHasSelection(!!value)), [selection]);
  useEffect(() => {
    if (searchOpen) searchInput.current?.focus();
  }, [searchOpen]);
  useEffect(() => {
    if (!search) return;
    if (!searchOpen || !query.trim()) {
      search.stopSearch();
      return;
    }
    const timer = setTimeout(() => {
      search.startSearch();
      search.searchAllPages(query).wait(
        () => {},
        (error) => {
          if (error.type !== "abort" && error.reason.code !== PdfErrorCode.Cancelled) onError(pdfReaderError(error));
        },
      );
    }, 200);
    return () => {
      clearTimeout(timer);
      search.stopSearch();
    };
  }, [query, searchOpen, search, onError]);

  const activeResult = searchState.results[searchState.activeResultIndex];
  useEffect(() => {
    if (!searchOpen || !activeResult || !scroll) return;
    scroll.scrollToPage({
      pageNumber: activeResult.pageIndex + 1,
      pageCoordinates: activeResult.rects[0]?.origin,
      alignY: 30,
      behavior: "instant",
    });
  }, [activeResult, searchOpen, scroll]);

  const focusPage = () => host.current?.querySelector<HTMLElement>(".pg-document-pdf")?.focus({ preventScroll: true });
  const closeSearch = () => {
    setSearchOpen(false);
    setQuery("");
    search?.stopSearch();
    focusPage();
  };
  const copy = () => {
    if (canCopyContents && selection)
      void selection
        .getSelectedText()
        .toPromise()
        .then((text) => writeText(text.join("\n")))
        .catch(reportToast);
  };
  const go = (value: string | number) => {
    const target = pdfPageNumber(value, pages);
    if (target && scroll) {
      scroll.scrollToPage({ pageNumber: target, behavior: "instant" });
      setJump(String(target));
    } else setJump(String(page));
  };
  const changeZoom = (factor: number) => {
    const container = host.current?.querySelector<HTMLDivElement>(".pg-document-pdf");
    if (zoom && container)
      zoomPdf(
        {
          container,
          currentScale: zoom.getState().currentZoomLevel,
          requestZoom: (scale, center) => zoom.requestZoom(scale, center),
        },
        zoom.getState().currentZoomLevel * factor,
      );
  };
  const goBookmark = (item: PdfBookmarkObject) => {
    const destination = bookmarkDestination(item);
    if (!destination || !pdfPageNumber(destination.pageIndex + 1, pages)) return;
    scroll?.scrollToPage({
      pageNumber: destination.pageIndex + 1,
      pageCoordinates: destination.zoom.mode === PdfZoomMode.XYZ ? destination.zoom.params : undefined,
      behavior: "instant",
    });
  };

  return (
    <div
      ref={host}
      className="flex min-h-0 flex-1 flex-col"
      onKeyDownCapture={(event) => {
        if (event.nativeEvent.isComposing || event.altKey || store.get(activeTabAtom) !== tab) return;
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
          event.preventDefault();
          event.stopPropagation();
          setSearchOpen(true);
          searchInput.current?.focus();
        } else if (event.key === "Escape" && searchOpen) {
          event.preventDefault();
          event.stopPropagation();
          closeSearch();
        } else if (
          (event.ctrlKey || event.metaKey) &&
          event.key.toLowerCase() === "c" &&
          hasSelection &&
          canCopyContents &&
          !(event.target as Element).closest("input, textarea, [contenteditable]")
        ) {
          event.preventDefault();
          event.stopPropagation();
          copy();
        }
      }}
    >
      <div
        role="toolbar"
        aria-label={t("pdf.toolbar")}
        className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b px-2 py-1.5"
      >
        <div className="flex items-center gap-1">
          <IconButton label={t("pdf.toggleSidebar")} aria-expanded={sidebar} onClick={() => setSidebar(!sidebar)}>
            <PanelLeft />
          </IconButton>
          <IconButton
            label={t("zoomOut")}
            disabled={zoomState.currentZoomLevel <= 0.25}
            onClick={() => changeZoom(1 / 1.2)}
          >
            <ZoomOut />
          </IconButton>
          <Select
            value={String(zoomState.zoomLevel)}
            onValueChange={(value) =>
              zoom?.requestZoom(value === ZoomMode.FitWidth || value === ZoomMode.FitPage ? value : Number(value))
            }
          >
            <SelectTrigger className="w-28" size="sm" aria-label={t("pdf.zoom")}>
              <SelectValue>{Math.round(zoomState.currentZoomLevel * 100)}%</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value={ZoomMode.FitPage}>{t("pdf.fitPage")}</SelectItem>
                <SelectItem value={ZoomMode.FitWidth}>{t("fitWidth")}</SelectItem>
                <SelectItem value="1">{t("pdf.actualSize")}</SelectItem>
                {[0.5, 0.75, 1.25, 1.5, 2, 3, 4].map((value) => (
                  <SelectItem key={value} value={String(value)}>
                    {value * 100}%
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <IconButton label={t("zoomIn")} disabled={zoomState.currentZoomLevel >= 4} onClick={() => changeZoom(1.2)}>
            <ZoomIn />
          </IconButton>
        </div>
        <div className="flex items-center gap-1">
          <IconButton label={t("previousPage")} disabled={page <= 1} onClick={() => go(page - 1)}>
            <ChevronLeft />
          </IconButton>
          <Input
            className="h-8 w-14 text-center tabular-nums"
            inputMode="numeric"
            aria-label={t("page")}
            value={jump}
            onChange={(event) => setJump(event.target.value)}
            onBlur={() => go(jump)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                go(jump);
                focusPage();
              }
            }}
          />
          <span className="text-muted-foreground min-w-8 text-xs tabular-nums">/ {pages}</span>
          <IconButton label={t("nextPage")} disabled={page >= pages} onClick={() => go(page + 1)}>
            <ChevronRight />
          </IconButton>
        </div>
        <div className="flex items-center gap-1">
          <IconButton label={t("pdf.copy")} disabled={!hasSelection || !canCopyContents} onClick={copy}>
            <Copy />
          </IconButton>
          <IconButton
            label={t("pdf.search")}
            aria-expanded={searchOpen}
            onClick={() => {
              setSearchOpen(true);
              searchInput.current?.focus();
            }}
          >
            <Search />
          </IconButton>
        </div>
      </div>
      {searchOpen && (
        <div role="search" className="bg-card flex items-center justify-end gap-1 border-b px-3 py-2">
          <Input
            ref={searchInput}
            className="h-8 max-w-72"
            aria-label={t("pdf.searchQuery")}
            placeholder={t("pdf.searchQuery")}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                event.preventDefault();
                if (event.shiftKey) search?.previousResult();
                else search?.nextResult();
              }
            }}
          />
          <span
            role="status"
            aria-live="polite"
            className="text-muted-foreground min-w-20 text-center text-xs tabular-nums"
          >
            {searchState.loading
              ? t("pdf.searching")
              : t("pdf.searchCount", {
                  current: searchState.total ? searchState.activeResultIndex + 1 : 0,
                  total: searchState.total,
                })}
          </span>
          <IconButton
            label={t("pdf.previousResult")}
            disabled={!searchState.total}
            onClick={() => search?.previousResult()}
          >
            <ChevronLeft />
          </IconButton>
          <IconButton label={t("pdf.nextResult")} disabled={!searchState.total} onClick={() => search?.nextResult()}>
            <ChevronRight />
          </IconButton>
          <IconButton label={t("pdf.closeSearch")} onClick={closeSearch}>
            <X />
          </IconButton>
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        {sidebar && (
          <aside className="bg-card w-56 max-w-[40%] shrink-0 border-r" aria-label={t("pdf.sidebar")}>
            <Tabs value={sidebarPage} onValueChange={setSidebarPage} className="h-full min-h-0 gap-0">
              <TabsList variant="line" className="w-full shrink-0 border-b">
                <TabsTrigger value="thumbnails">{t("pdf.thumbnails")}</TabsTrigger>
                <TabsTrigger value="outline">{t("pdf.outline")}</TabsTrigger>
                <TabsTrigger value="annotations">{t("pdf.annotations")}</TabsTrigger>
              </TabsList>
              <TabsContent value="thumbnails" className="min-h-0 overflow-hidden">
                <ThumbnailsPane documentId={tab.id}>
                  {(meta: ThumbMeta) => (
                    <button
                      key={meta.pageIndex}
                      type="button"
                      aria-label={t("pdf.thumbnailPage", { page: meta.pageIndex + 1 })}
                      aria-current={page === meta.pageIndex + 1 ? "page" : undefined}
                      className={cn(
                        "hover:bg-accent focus-visible:ring-ring absolute left-1/2 flex -translate-x-1/2 flex-col items-center gap-1 rounded-md border-2 p-1 focus-visible:ring-2",
                        page === meta.pageIndex + 1 ? "border-primary bg-accent" : "border-transparent",
                      )}
                      style={{ top: meta.top, width: meta.width + 12, height: meta.wrapperHeight }}
                      onClick={() => {
                        go(meta.pageIndex + 1);
                        focusPage();
                      }}
                    >
                      <div className="bg-white shadow-sm" style={{ width: meta.width, height: meta.height }}>
                        <ThumbImg documentId={tab.id} meta={meta} style={{ width: meta.width, height: meta.height }} />
                      </div>
                      <span className="text-muted-foreground text-xs tabular-nums">{meta.pageIndex + 1}</span>
                    </button>
                  )}
                </ThumbnailsPane>
              </TabsContent>
              <TabsContent value="outline" className="min-h-0 overflow-auto p-2">
                {bookmarks?.length ? (
                  <nav aria-label={t("pdf.outline")}>
                    <ul>
                      {bookmarks.map((item, index) => (
                        <OutlineItem key={index} item={item} go={goBookmark} />
                      ))}
                    </ul>
                  </nav>
                ) : (
                  <p role="status" className="text-muted-foreground p-4 text-sm">
                    {t(bookmarks ? "pdf.noOutline" : "loading")}
                  </p>
                )}
              </TabsContent>
              <TabsContent value="annotations" className="min-h-0 overflow-auto p-6">
                <p className="text-muted-foreground text-sm">{t("pdf.annotationsPlaceholder")}</p>
              </TabsContent>
            </Tabs>
          </aside>
        )}
        <div className="bg-muted relative min-h-0 min-w-0 flex-1">
          <Viewport
            documentId={tab.id}
            tabIndex={0}
            className="pg-document-pdf outline-none"
            aria-label={t("pdf.readingArea")}
          >
            <PdfGestures tab={tab} />
            <GlobalPointerProvider documentId={tab.id}>
              <Scroller
                documentId={tab.id}
                renderPage={({ pageIndex }) => (
                  <PdfPage
                    documentId={tab.id}
                    page={pdf.pages[pageIndex]}
                    scale={zoomState.currentZoomLevel}
                    onPaint={onPaint}
                    onError={onError}
                  />
                )}
              />
            </GlobalPointerProvider>
          </Viewport>
        </div>
      </div>
    </div>
  );
}

function PdfSession({
  tab,
  engine,
  buffer,
  onPaint,
  onError,
}: {
  tab: DocumentTab;
  engine: PdfReaderEngine;
  buffer: ArrayBuffer;
  onPaint: () => void;
  onError: (error: unknown) => void;
}) {
  const plugins = useMemo(
    () => [
      createPluginRegistration(DocumentManagerPluginPackage, {
        initialDocuments: [{ documentId: tab.id, name: tab.title, buffer }],
        maxDocuments: 1,
      }),
      createPluginRegistration(ViewportPluginPackage),
      createPluginRegistration(ScrollPluginPackage, { defaultBufferSize: 1 }),
      createPluginRegistration(RenderPluginPackage, {
        defaultImageType: "image/bmp",
        withAnnotations: true,
        withForms: true,
      }),
      createPluginRegistration(TilingPluginPackage, { tileSize: 512, overlapPx: 1, extraRings: 0 }),
      createPluginRegistration(ZoomPluginPackage, {
        defaultZoomLevel:
          typeof tab.pdfLocation.scale === "number"
            ? tab.pdfLocation.scale
            : tab.pdfLocation.scale === ZoomMode.FitPage
              ? ZoomMode.FitPage
              : ZoomMode.FitWidth,
        minZoom: 0.25,
        maxZoom: 4,
      }),
      createPluginRegistration(InteractionManagerPluginPackage),
      createPluginRegistration(SelectionPluginPackage, { marquee: { enabled: false }, maxCachedGeometries: 10 }),
      createPluginRegistration(SearchPluginPackage),
      createPluginRegistration(BookmarkPluginPackage),
      createPluginRegistration(ThumbnailPluginPackage, {
        width: 132,
        gap: 12,
        labelHeight: 28,
        buffer: 1,
        paddingY: 12,
      }),
    ],
    [tab, buffer],
  );
  return (
    <EmbedPDF engine={engine} plugins={plugins} autoMountDomElements={false}>
      {({ activeDocument, pluginsReady }) =>
        pluginsReady && activeDocument?.document ? (
          <PdfReaderContent tab={tab} document={activeDocument.document} onPaint={onPaint} onError={onError} />
        ) : (
          <div role="status" className="text-muted-foreground p-6">
            {t("loading")}
          </div>
        )
      }
    </EmbedPDF>
  );
}

export default function PdfView({ tab }: { tab: DocumentTab }) {
  const [attempt, setAttempt] = useState(0);
  const [session, setSession] = useState<{ engine: PdfReaderEngine; buffer: ArrayBuffer }>();
  const [error, setError] = useState("");
  const lifetime = useRef<{ fail: (error: unknown) => void; painted: () => void } | null>(null);
  const onError = useCallback((error: unknown) => lifetime.current?.fail(error), []);
  const onPaint = useCallback(() => lifetime.current?.painted(), []);
  useEffect(() => {
    const controller = new AbortController();
    let engine: PdfReaderEngine | undefined;
    const stop = () => {
      controller.abort();
      clearTimeout(timer);
      engine?.destroy();
    };
    const fail = (reason: unknown) => {
      if (controller.signal.aborted) return;
      stop();
      setSession(undefined);
      setError(documentError(pdfReaderError(reason)));
    };
    const timer = setTimeout(() => fail(new Error("pdfTimeout")), PDF_READER_TIMEOUT);
    lifetime.current = { fail, painted: () => clearTimeout(timer) };
    setError("");
    setSession(undefined);
    void (async () => {
      engine = new PdfReaderEngine(
        new Worker(new URL("./PdfReaderWorker.ts", import.meta.url), { type: "module" }),
        fail,
      );
      const [buffer] = await Promise.all([
        readPdfBuffer(tab.path, controller.signal, reportToast),
        engine.readyTask.toPromise(),
      ]);
      if (!controller.signal.aborted) setSession({ engine, buffer });
    })().catch(fail);
    return () => {
      lifetime.current = null;
      stop();
    };
  }, [tab, attempt]);
  if (error)
    return (
      <Alert variant="destructive">
        <AlertDescription className="flex items-center gap-3">
          {error}
          <Button variant="outline" size="sm" onClick={() => setAttempt((value) => value + 1)}>
            {t("retry")}
          </Button>
        </AlertDescription>
      </Alert>
    );
  return session ? (
    <PdfSession key={attempt} tab={tab} {...session} onPaint={onPaint} onError={onError} />
  ) : (
    <div role="status" className="text-muted-foreground p-6">
      {t("loading")}
    </div>
  );
}
