import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/utils/cn";
import {
  PdfAnnotationSubtype,
  PdfErrorCode,
  type PdfAnnotationObject,
  type PdfDocumentObject,
  type PdfPageObject,
} from "@embedpdf/models";
import type { SelectionScope } from "@embedpdf/plugin-selection";
import {
  Bot,
  Copy,
  Crop,
  Eraser,
  Highlighter,
  Languages,
  MessageSquarePlus,
  MousePointer2,
  Pencil,
  Redo2,
  RefreshCw,
  Save,
  Send,
  StickyNote,
  Trash2,
  Type,
  Underline,
  Undo2,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, type PointerEvent } from "react";
import { toast } from "sonner";
import { BoardMenu } from "./BoardMenu";
import type { BoardChoice } from "./BoardPicker";
import { DocumentTab, documentError, documentText as t } from "./DocumentTab";
import {
  annotationBounds,
  annotationColors,
  annotationSortIndex,
  clientToReader,
  eraseInkPaths,
  filterAnnotations,
  newAnnotation,
  pdfRectToReader,
  pdfToReader,
  readerRectToPdf,
  readerToPdf,
  roundedAnnotationPosition,
  type AnnotationPosition,
  type AnnotationType,
  type PdfAnnotation,
  type PdfPoint,
} from "./PdfAnnotations";
import type { PdfReaderEngine } from "./PdfReader";
import { formattedSelection } from "./PdfSelectionRects";
import { autoTranslateEnabled } from "./TranslateCard";

type Tool = "select" | AnnotationType | "eraser";
type ExternalAnnotation = { id: string; pageIndex: number; source: PdfAnnotationObject };
const tools = {
  select: MousePointer2,
  highlight: Highlighter,
  underline: Underline,
  note: StickyNote,
  text: Type,
  image: Crop,
  ink: Pencil,
  eraser: Eraser,
};
const report = (error: unknown) => toast.error(documentError(error));

export function usePdfAnnotations(
  tab: DocumentTab,
  pdf: PdfDocumentObject,
  engine: PdfReaderEngine,
  selection: SelectionScope | undefined,
  reveal: () => void,
) {
  const [tool, setTool] = useState<Tool>("select");
  const [color, setColor] = useState<string>(annotationColors.yellow);
  const [selected, setSelected] = useState("");
  const [menu, setMenu] = useState(false);
  const [external, setExternal] = useState<ExternalAnnotation[]>([]);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState("");
  const [, update] = useState(0);
  const knownPages = useRef(new Set<number>());
  const scanningRef = useRef(false);
  const live = useRef(true);
  const drawing = useRef(false);
  useEffect(() => {
    live.current = true;
    void tab.loadAnnotations();
    const changed = () => update((value) => value + 1);
    tab.on("state-change", changed);
    return () => {
      live.current = false;
      tab.off("state-change", changed);
    };
  }, [tab]);
  // 和 Zotero 一样：点页面空白处或按 Esc 取消选中；点批注本身、侧栏卡片、工具栏不算
  useEffect(() => {
    if (!selected) return;
    const onPointerDown = (event: globalThis.PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target?.closest("[data-pdf-page]") || target.closest("[data-annotation-id]")) return;
      setSelected("");
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      setSelected("");
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [selected]);
  const enabled =
    !!tab.annotations &&
    !tab.annotations.moving &&
    !tab.annotations.locationFailed &&
    !tab.loadingAnnotations &&
    !tab.pendingAnnotations;
  const items = tab.annotations?.annotations ?? [];
  const commit = (annotations: PdfAnnotation[]) => {
    if (!enabled || tab.closing) return;
    tab.annotations!.change(annotations);
    tab.annotationsChanged();
  };
  /** 选中一条批注；show 为 false 时不动侧栏（刚划完高亮、框完图，不把批注栏弹出来） */
  const select = (id: string, show = true) => {
    if (!live.current) return;
    setSelected(id);
    if (show) reveal();
  };
  const action = (work: () => Promise<void>) => {
    const release = engine.retain();
    return tab.runAnnotationAction(work).finally(release);
  };
  const add = (type: AnnotationType, position: AnnotationPosition, text = "", focusComment = false) =>
    action(async () => {
      const model = tab.annotations;
      if (!model || model.moving) return;
      const page = pdf.pages[position.pageIndex];
      const geometryTask = selection?.getState().geometry[page.index] ?? engine.getPageGeometry(pdf, page).toPromise();
      const [pageLabel, geometry] = await Promise.all([tab.pdfPageLabel(page.index), geometryTask]);
      if (tab.closing || model !== tab.annotations || model.moving) throw new Error("annotationBusy");
      const annotation = newAnnotation(type, color, position, page, geometry, text, pageLabel);
      while (model.annotations.some((item) => item.id === annotation.id))
        annotation.id = newAnnotation(type, color, position, page, geometry).id;
      commit([...model.annotations, annotation]);
      select(annotation.id, focusComment);
      // 做完一次就回到普通光标；手绘要连着画好几笔，留在手绘上
      if (type !== "ink" && live.current) setTool("select");
      if (focusComment && live.current)
        requestAnimationFrame(() => document.getElementById(`annotation-comment-${tab.id}-${annotation.id}`)?.focus());
    });
  /** 返回新建的批注（跨好几页时不止一条），什么都没建时是空数组 */
  const annotateSelection = async (
    type: "highlight" | "underline",
    addComment = false,
    chosenColor = color,
    /** 划词翻译卡片「高亮并写进批注」时带上译文 */
    comment = "",
  ) => {
    // Capture selection state before plugin teardown or another gesture can clear it.
    // 高亮的框用我们按行算的，不用选区插件的松框：那种框在有的 PDF 上比字高出三四倍
    const formatted = selection ? formattedSelection(selection.getState()) : [];
    const geometries = selection?.getState().geometry;
    const textTask = selection && enabled && formatted.length ? selection.getSelectedText() : undefined;
    const created: PdfAnnotation[] = [];
    await action(async () => {
      if (!selection || !enabled) return;
      if (!formatted.length) return;
      const model = tab.annotations!;
      const texts = await textTask!.toPromise();
      // Zotero represents at most two adjacent pages in one annotation via nextPageRects.
      for (let i = 0; i < formatted.length; i += 2) {
        const first = formatted[i];
        const page = pdf.pages[first.pageIndex];
        const pageLabel = await tab.pdfPageLabel(page.index);
        const position: AnnotationPosition = {
          pageIndex: page.index,
          rects: first.segmentRects.map((rect) => readerRectToPdf(page, rect)),
        };
        let text = texts[i] ?? "";
        const next = formatted[i + 1];
        if (next && next.pageIndex === page.index + 1) {
          position.nextPageRects = next.segmentRects.map((rect) => readerRectToPdf(pdf.pages[next.pageIndex], rect));
          text += " " + (texts[i + 1] ?? "");
        } else if (next) i--;
        const geometry = geometries?.[page.index] ?? (await engine.getPageGeometry(pdf, page).toPromise());
        created.push(newAnnotation(type, chosenColor, position, page, geometry, text, pageLabel));
      }
      if (tab.closing || tab.annotations !== model || model.moving) throw new Error("annotationBusy");
      if (comment) created[0] = { ...created[0], comment };
      commit([...model.annotations, ...created]);
      if (live.current) {
        selection.clear();
        setMenu(false);
        setTool("select");
      }
      select(created[0].id, addComment);
      if (addComment && live.current)
        requestAnimationFrame(() => document.getElementById(`annotation-comment-${tab.id}-${created[0].id}`)?.focus());
    });
    return created;
  };
  const selectionAction = useRef(annotateSelection);
  selectionAction.current = annotateSelection;
  useEffect(() => {
    if (!selection) return;
    const offStart = selection.onBeginSelection(() => setMenu(false));
    const offEnd = selection.onEndSelection(() => {
      if (!selection.getFormattedSelection().length) return;
      if (tool === "highlight" || tool === "underline") void selectionAction.current(tool).catch(report);
      // 框选、便签这些工具拖动时不该选中文字；万一选上了就清掉，也不弹菜单
      else if (tool !== "select") selection.clear();
      else setMenu(true);
    });
    const offChange = selection.onSelectionChange((value) => {
      if (!value) setMenu(false);
    });
    return () => {
      offStart();
      offEnd();
      offChange();
    };
  }, [selection, tool]);
  const receiveExternal = useCallback((page: PdfPageObject, values: PdfAnnotationObject[]) => {
    if (!live.current || knownPages.current.has(page.index)) return;
    knownPages.current.add(page.index);
    const annotations = values
      .filter(
        (item) =>
          item.type !== PdfAnnotationSubtype.LINK &&
          item.type !== PdfAnnotationSubtype.WIDGET &&
          item.type !== PdfAnnotationSubtype.POPUP,
      )
      .map((source) => ({ id: `external-${page.index}-${source.id}`, pageIndex: page.index, source }));
    if (annotations.length)
      setExternal((old) =>
        [...old, ...annotations].sort(
          (a, b) => a.pageIndex - b.pageIndex || a.source.rect.origin.y - b.source.rect.origin.y,
        ),
      );
  }, []);
  const scanExternal = useCallback(async () => {
    if (scanningRef.current) return;
    scanningRef.current = true;
    setScanning(true);
    setScanError("");
    try {
      for (const page of pdf.pages) {
        if (!live.current) return;
        if (!knownPages.current.has(page.index))
          receiveExternal(page, await engine.getPageAnnotations(pdf, page).toPromise());
      }
    } catch (error) {
      if (live.current) setScanError(documentError(error));
    } finally {
      scanningRef.current = false;
      if (live.current) setScanning(false);
    }
  }, [pdf, engine, receiveExternal]);
  const finishErase = (before: PdfAnnotation[], after: PdfAnnotation[], page: PdfPageObject) =>
    action(async () => {
      if (before.length === after.length && before.every((item, index) => item === after[index])) return;
      const model = tab.annotations;
      const geometry =
        selection?.getState().geometry[page.index] ?? (await engine.getPageGeometry(pdf, page).toPromise());
      if (tab.closing || !model || model.moving) throw new Error("annotationBusy");
      if (model.annotations !== before) throw new Error("annotationBusy");
      commit(
        after.map((item) => {
          if (before.includes(item)) return item;
          const position = roundedAnnotationPosition(item.position);
          return { ...item, position, sortIndex: annotationSortIndex(page, position, geometry) };
        }),
      );
    });
  const edit = (id: string, patch: Partial<Pick<PdfAnnotation, "color" | "comment" | "tags">>) =>
    commit(
      items.map((item) =>
        item.id === id && !item.readOnly ? { ...item, ...patch, dateModified: new Date().toISOString() } : item,
      ),
    );
  const history = (redo: boolean) => {
    if (!enabled || drawing.current) return;
    if (redo) tab.annotations!.redo();
    else tab.annotations!.undo();
    tab.annotationsChanged();
  };
  return {
    tab,
    pdf,
    engine,
    selection,
    tool,
    setTool,
    color,
    setColor,
    selected,
    select,
    menu,
    setMenu,
    enabled,
    items,
    add,
    annotateSelection,
    commit,
    edit,
    history,
    external,
    receiveExternal,
    scanExternal,
    scanning,
    scanError,
    finishErase,
    drawing,
  };
}
export type AnnotationController = ReturnType<typeof usePdfAnnotations>;

function Colors({
  value,
  onChange,
  disabled = false,
  stacked = false,
}: {
  value: string;
  onChange: (color: string) => void;
  disabled?: boolean;
  /** 选区菜单里用：平时几个圆点叠在一起，鼠标移上去才散开（照 Agentero），不占一长条 */
  stacked?: boolean;
}) {
  const [spread, setSpread] = useState(false);
  if (stacked) {
    const colors = Object.entries(annotationColors);
    // 聚拢时相邻两个圆点叠住一半，散开后各自分开
    const step = spread ? 20 : 8;
    const motion = "duration-300 ease-[cubic-bezier(0.34,1.4,0.64,1)] motion-reduce:transition-none";
    return (
      <div
        role="group"
        aria-label={t("annotation.color")}
        className={cn("relative h-7 shrink-0 transition-[width]", motion)}
        style={{ width: 28 + (colors.length - 1) * step }}
        onPointerEnter={() => setSpread(true)}
        onPointerLeave={() => setSpread(false)}
        onFocusCapture={() => setSpread(true)}
        onBlurCapture={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) setSpread(false);
        }}
      >
        {colors.map(([name, color], index) => (
          <button
            key={name}
            type="button"
            aria-label={t(`annotation.colors.${name}`)}
            title={t(`annotation.colors.${name}`)}
            aria-pressed={value === color}
            disabled={disabled}
            className={cn(
              "focus-visible:ring-ring/50 absolute top-0 flex size-7 items-center justify-center rounded-full transition-[left] outline-none focus-visible:ring-2 active:scale-95 disabled:opacity-50",
              motion,
            )}
            // 聚拢时上次用的颜色露在最上面，其余按顺序往下压
            style={{ left: index * step, zIndex: value === color ? colors.length + 1 : colors.length - index }}
            onClick={() => onChange(color)}
          >
            <span
              className={cn(
                "size-4 rounded-full border border-black/25 transition-shadow dark:border-white/25",
                spread ? "shadow-md" : "shadow-sm",
                value === color && "ring-foreground ring-offset-background ring-2 ring-offset-1",
              )}
              style={{ background: color }}
            />
          </button>
        ))}
      </div>
    );
  }
  return (
    <div role="group" aria-label={t("annotation.color")} className="flex flex-wrap gap-1">
      {Object.entries(annotationColors).map(([name, color]) => (
        <Button
          key={name}
          variant="ghost"
          size="icon"
          className="size-7"
          aria-label={t(`annotation.colors.${name}`)}
          title={t(`annotation.colors.${name}`)}
          aria-pressed={value === color}
          disabled={disabled}
          onClick={() => onChange(color)}
        >
          <span
            className={cn(
              "size-4 rounded-full border",
              value === color && "ring-foreground ring-offset-background ring-2 ring-offset-2",
            )}
            style={{ background: color }}
          />
        </Button>
      ))}
    </div>
  );
}

export function PdfAnnotationToolbar({ controller: c }: { controller: AnnotationController }) {
  const reload = async () => {
    if (
      c.tab.hasUnsavedChanges &&
      (await Dialog.buttons(t("reloadTitle"), t("reloadDescription"), [
        { id: "cancel", label: t("cancel"), variant: "ghost" },
        { id: "reload", label: t("reload"), variant: "destructive" },
      ])) !== "reload"
    )
      return;
    await c.tab.loadAnnotations(true);
  };
  return (
    <>
      <div
        role="toolbar"
        aria-label={t("annotation.tools")}
        className="flex flex-wrap items-center gap-1 border-b px-2 py-1"
      >
        {Object.entries(tools).map(([name, Icon]) => (
          <Button
            key={name}
            variant={c.tool === name ? "secondary" : "ghost"}
            size="icon"
            aria-label={t(`annotation.${name}`)}
            title={t(`annotation.${name}`)}
            aria-pressed={c.tool === name}
            disabled={!c.enabled && name !== "select"}
            onClick={() => {
              c.selection?.clear();
              c.setTool(name as Tool);
            }}
          >
            <Icon />
          </Button>
        ))}
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="icon" aria-label={t("annotation.color")} title={t("annotation.color")}>
              <span className="size-5 rounded-full border" style={{ background: c.color }} />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-2">
            <Colors value={c.color} onChange={c.setColor} />
          </PopoverContent>
        </Popover>
        <div className="mx-1 h-5 border-l" />
        <Button
          variant="ghost"
          size="icon"
          aria-label={t("annotation.undo")}
          title={t("annotation.undo")}
          disabled={!c.tab.annotations?.canUndo}
          onClick={() => c.history(false)}
        >
          <Undo2 />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t("annotation.redo")}
          title={t("annotation.redo")}
          disabled={!c.tab.annotations?.canRedo}
          onClick={() => c.history(true)}
        >
          <Redo2 />
        </Button>
        <span role="status" className="text-muted-foreground ml-auto text-xs">
          {t(
            c.tab.loadingAnnotations
              ? "loading"
              : c.tab.saving
                ? "saving"
                : c.tab.hasUnsavedChanges
                  ? "annotation.unsaved"
                  : c.tab.annotations
                    ? "annotation.saved"
                    : "annotation.unavailable",
          )}
        </span>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t("save")}
          title={t("save")}
          disabled={!c.enabled || c.tab.saving}
          onClick={() => void c.tab.save()}
        >
          <Save />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t("reload")}
          title={t("reload")}
          disabled={c.tab.loadingAnnotations || c.tab.saving || c.tab.pendingAnnotations || c.tab.annotations?.moving}
          onClick={() => void reload().catch(report)}
        >
          <RefreshCw />
        </Button>
      </div>
      {(c.tab.error || c.tab.annotations?.locationFailed) && (
        <Alert variant="destructive">
          <AlertDescription>{c.tab.error || t("errors.annotationRollbackFailed")}</AlertDescription>
        </Alert>
      )}
    </>
  );
}

/** 选区菜单在面板里的位置：中线横坐标、菜单下沿，翻译卡片接在下面 */
export type SelectionAnchor = { center: number; bottom: number };

export function PdfSelectionMenu({
  controller: c,
  copy,
  onTranslate,
  onAskAi,
  onSend,
}: {
  controller: AnnotationController;
  copy: () => void;
  onTranslate?: (anchor: SelectionAnchor) => void;
  onAskAi?: () => void;
  /** 发到白板：在菜单里选了哪块白板以后，先高亮，再把这条高亮发过去 */
  onSend?: (annotation: PdfAnnotation, board: BoardChoice) => void;
}) {
  const [type, setType] = useState<"highlight" | "underline">("highlight");
  const element = useRef<HTMLDivElement>(null);
  const [location, setLocation] = useState({ left: 12, top: 12 });
  const onTranslateRef = useRef(onTranslate);
  onTranslateRef.current = onTranslate;
  const anchor = () => ({
    center: location.left + (element.current?.offsetWidth ?? 0) / 2,
    bottom: location.top + (element.current?.offsetHeight ?? 0),
  });
  useEffect(() => {
    const menu = element.current;
    const panel = menu?.parentElement;
    const selected = c.selection ? formattedSelection(c.selection.getState()).at(-1) : undefined;
    if (!c.menu || !menu || !panel || !selected) return;
    const page = c.pdf.pages[selected.pageIndex];
    const surface = panel.querySelector(`[data-pdf-annotations="${page.index}"]`);
    if (!surface) return;
    const bounds = surface.getBoundingClientRect();
    const parent = panel.getBoundingClientRect();
    const { origin, size } = selected.rect;
    const corners = [
      [origin.x, origin.y],
      [origin.x + size.width, origin.y],
      [origin.x, origin.y + size.height],
      [origin.x + size.width, origin.y + size.height],
    ].map(([x, y]) => {
      const u = x / page.size.width,
        v = y / page.size.height;
      const [a, b] = [
        [u, v],
        [1 - v, u],
        [1 - u, 1 - v],
        [v, 1 - u],
      ][page.rotation % 4];
      return [bounds.left - parent.left + a * bounds.width, bounds.top - parent.top + b * bounds.height];
    });
    const top = Math.min(...corners.map((point) => point[1])) - menu.offsetHeight - 8;
    const left = corners.reduce((sum, point) => sum + point[0], 0) / 4 - menu.offsetWidth / 2;
    const next = {
      left: Math.max(8, Math.min(left, parent.width - menu.offsetWidth - 8)),
      top: Math.max(
        8,
        Math.min(
          top >= 8 ? top : Math.max(...corners.map((point) => point[1])) + 8,
          parent.height - menu.offsetHeight - 8,
        ),
      ),
    };
    setLocation(next);
    // 照用户 Obsidian 插件的「选中就翻译」：开着的话一松开鼠标就翻
    if (autoTranslateEnabled())
      onTranslateRef.current?.({
        center: next.left + menu.offsetWidth / 2,
        bottom: next.top + menu.offsetHeight,
      });
  }, [c.menu, c.pdf, c.selection]);
  if (!c.menu) return null;
  return (
    <div
      ref={element}
      role="toolbar"
      aria-label={t("annotation.selectionMenu")}
      className="bg-popover text-popover-foreground absolute z-50 flex max-w-full flex-wrap items-center gap-1 rounded-lg border p-2 shadow-lg"
      style={location}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <Button
        size="icon"
        variant={type === "highlight" ? "secondary" : "ghost"}
        aria-label={t("annotation.highlight")}
        aria-pressed={type === "highlight"}
        onClick={() => setType("highlight")}
      >
        <Highlighter />
      </Button>
      <Button
        size="icon"
        variant={type === "underline" ? "secondary" : "ghost"}
        aria-label={t("annotation.underline")}
        aria-pressed={type === "underline"}
        onClick={() => setType("underline")}
      >
        <Underline />
      </Button>
      <Colors
        stacked
        value={c.color}
        disabled={!c.enabled}
        onChange={(color) => {
          c.setColor(color);
          void c.annotateSelection(type, false, color).catch(report);
        }}
      />
      <Button size="icon" variant="ghost" aria-label={t("pdf.copy")} onClick={copy}>
        <Copy />
      </Button>
      <Button
        size="icon"
        variant="ghost"
        aria-label={t("annotation.addComment")}
        disabled={!c.enabled}
        onClick={() => void c.annotateSelection(type, true).catch(report)}
      >
        <MessageSquarePlus />
      </Button>
      {(onTranslate || onAskAi || onSend) && <span className="bg-border mx-0.5 h-5 w-px" />}
      {onTranslate && (
        <Button variant="ghost" size="sm" className="h-8 gap-1.5 px-2 text-xs" onClick={() => onTranslate(anchor())}>
          <Languages />
          {t("selection.translate")}
        </Button>
      )}
      {onAskAi && (
        <Button variant="ghost" size="sm" className="h-8 gap-1.5 px-2 text-xs" onClick={onAskAi}>
          <Bot />
          {t("selection.askAi")}
        </Button>
      )}
      {onSend && (
        <BoardMenu
          onPick={(board) =>
            void c
              .annotateSelection(type)
              .then(([first, ...rest]) => {
                if (first) onSend({ ...first, text: [first, ...rest].map((item) => item.text).join(" ") }, board);
              })
              .catch(report)
          }
        >
          <Button variant="ghost" size="sm" className="h-8 gap-1.5 px-2 text-xs" disabled={!c.enabled}>
            <Send />
            {t("toBoard.action")}
          </Button>
        </BoardMenu>
      )}
    </div>
  );
}

function ImagePreview({ item, c }: { item: PdfAnnotation; c: AnnotationController }) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    const page = c.pdf.pages[item.position.pageIndex];
    if (!page) return;
    const rect = pdfRectToReader(page, annotationBounds(item.position));
    let live = true,
      url = "";
    setError("");
    const task = c.engine.renderPageRect(c.pdf, page, rect, {
      scaleFactor: Math.min(1, 240 / Math.max(rect.size.width, rect.size.height)),
      dpr: 1,
      imageType: "image/bmp",
      withAnnotations: true,
      withForms: true,
    });
    task.wait(
      (blob) => {
        if (live) {
          url = URL.createObjectURL(blob);
          setUrl(url);
        }
      },
      (error) => {
        if (live && error.type !== "abort") setError(documentError(error));
      },
    );
    return () => {
      live = false;
      task.abort({ code: PdfErrorCode.Cancelled, message: "fileClosed" });
      if (url) URL.revokeObjectURL(url);
    };
  }, [c.engine, c.pdf, item.position]);
  return error ? (
    <span className="text-destructive text-xs">{error}</span>
  ) : url ? (
    <img
      src={url}
      alt={t("annotation.image")}
      className="max-h-40 max-w-full bg-white object-contain"
      onError={() => setError(t("imageFailed"))}
    />
  ) : null;
}

function AnnotationCard({
  item,
  c,
  jump,
  onSend,
}: {
  item: PdfAnnotation;
  c: AnnotationController;
  jump: (page: number, x: number, y: number) => void;
  onSend?: (annotation: PdfAnnotation, board: BoardChoice) => void;
}) {
  // 圈的字和框的图能发到白板；便签、文字框、手绘没有可摘的内容
  const sendable =
    onSend && (item.type === "image" || ((item.type === "highlight" || item.type === "underline") && item.text));
  const [tags, setTags] = useState("");
  const card = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (c.selected === item.id) card.current?.scrollIntoView?.({ block: "nearest" });
  }, [c.selected, item.id]);
  const readOnly = !!item.readOnly || !c.enabled;
  const page = c.pdf.pages[item.position.pageIndex];
  const go = () => {
    c.select(item.id);
    if (page) {
      const rect = pdfRectToReader(page, annotationBounds(item.position));
      jump(page.index, rect.origin.x, rect.origin.y);
    }
  };
  return (
    <Card
      ref={card}
      className={cn("gap-2 rounded-md border-l-4 py-2", c.selected === item.id && "ring-primary ring-1")}
      style={{ borderLeftColor: item.color }}
      data-annotation-card={item.id}
      tabIndex={0}
      aria-label={t("annotation.jump")}
      onClick={(event) => {
        if (!(event.target as Element).closest("button, input, textarea")) go();
      }}
      onKeyDown={(event) => {
        if (event.target === event.currentTarget && ["Enter", " "].includes(event.key)) {
          event.preventDefault();
          go();
        }
      }}
    >
      <CardHeader className="px-3">
        <CardTitle className="flex items-center justify-between gap-2">
          <Button variant="ghost" size="sm" className="h-auto justify-start px-0" onClick={go}>
            {t("annotation.page", { page: item.pageLabel })}
          </Button>
          <span className="text-muted-foreground text-xs font-normal">{t(`annotation.${item.type}`)}</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 px-3">
        {item.readOnly && <Badge variant="secondary">{t("annotation.readOnly")}</Badge>}
        {item.type === "image" && (
          <button type="button" onClick={go} aria-label={t("annotation.jump")}>
            <ImagePreview item={item} c={c} />
          </button>
        )}
        {item.text && (
          <button type="button" className="line-clamp-5 text-left text-xs whitespace-pre-wrap" onClick={go}>
            {item.text}
          </button>
        )}
        <Textarea
          id={`annotation-comment-${c.tab.id}-${item.id}`}
          aria-label={t("annotation.comment")}
          placeholder={t(item.type === "text" ? "annotation.textPlaceholder" : "annotation.commentPlaceholder")}
          className="min-h-14 resize-y text-sm"
          value={item.comment}
          readOnly={readOnly}
          onChange={(event) => c.edit(item.id, { comment: event.target.value })}
        />
        <div className="flex flex-wrap gap-1">
          {item.tags.map((tag, index) => (
            <Badge key={index} variant="secondary" style={tag.color ? { borderColor: tag.color } : undefined}>
              {tag.name}
              {!readOnly && (
                <button
                  type="button"
                  aria-label={t("annotation.removeTag", { tag: tag.name })}
                  onClick={() => c.edit(item.id, { tags: item.tags.filter((_, i) => i !== index) })}
                >
                  ×
                </button>
              )}
            </Badge>
          ))}
        </div>
        {!readOnly && (
          <Input
            aria-label={t("annotation.tags")}
            placeholder={t("annotation.tagPlaceholder")}
            value={tags}
            className="h-7 text-xs"
            onChange={(event) => setTags(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
              event.preventDefault();
              const name = tags.trim();
              if (name && !item.tags.some((tag) => tag.name === name))
                c.edit(item.id, { tags: [...item.tags, { name }] });
              setTags("");
            }}
          />
        )}
      </CardContent>
      {(!readOnly || sendable) && (
        <CardFooter className="justify-between gap-1 px-3">
          {readOnly ? <span /> : <Colors value={item.color} onChange={(color) => c.edit(item.id, { color })} />}
          <div className="flex gap-1">
            {sendable && (
              <BoardMenu onPick={(board) => onSend(item, board)}>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  aria-label={t("toBoard.action")}
                  title={t("toBoard.action")}
                >
                  <Send />
                </Button>
              </BoardMenu>
            )}
            {!readOnly && (
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                aria-label={t("annotation.delete")}
                onClick={() => c.commit(c.items.filter((annotation) => annotation.id !== item.id))}
              >
                <Trash2 />
              </Button>
            )}
          </div>
        </CardFooter>
      )}
    </Card>
  );
}

export function PdfAnnotationSidebar({
  controller: c,
  jump,
  onSend,
}: {
  controller: AnnotationController;
  jump: (page: number, x: number, y: number) => void;
  onSend?: (annotation: PdfAnnotation, board: BoardChoice) => void;
}) {
  const [query, setQuery] = useState("");
  const [color, setColor] = useState("");
  const scan = c.scanExternal;
  useEffect(() => {
    void scan();
  }, [scan]);
  const filtered = filterAnnotations(c.items, query, color);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-col gap-2 border-b p-2">
        <Input
          aria-label={t("annotation.filter")}
          placeholder={t("annotation.filter")}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <Colors value={color} onChange={(next) => setColor(next === color ? "" : next)} />
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-3">
        {!filtered.length && <p className="text-muted-foreground text-sm">{t("annotation.empty")}</p>}
        {filtered.map((item) => (
          <AnnotationCard key={item.id} item={item} c={c} jump={jump} onSend={onSend} />
        ))}
        {c.scanning && (
          <p role="status" className="text-muted-foreground text-xs">
            {t("annotation.scanning")}
          </p>
        )}
        {c.scanError && (
          <Alert variant="destructive">
            <AlertDescription>
              {c.scanError}
              <Button variant="outline" size="sm" onClick={() => void c.scanExternal()}>
                {t("retry")}
              </Button>
            </AlertDescription>
          </Alert>
        )}
        {c.external
          .filter(
            ({ source }) =>
              (!color ||
                ("color" in source && source.color === color) ||
                ("strokeColor" in source && source.strokeColor === color)) &&
              (!query || source.contents?.toLocaleLowerCase().includes(query.toLocaleLowerCase())),
          )
          .map((item) => (
            <Card key={item.id} className="gap-2 rounded-md py-2">
              <CardHeader className="px-3">
                <CardTitle>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => jump(item.pageIndex, item.source.rect.origin.x, item.source.rect.origin.y)}
                  >
                    {t("annotation.page", { page: item.pageIndex + 1 })}
                  </Button>
                </CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-2 px-3">
                <Badge variant="secondary">{t("annotation.external")}</Badge>
                <p className="text-xs whitespace-pre-wrap">{item.source.contents || t("annotation.noComment")}</p>
              </CardContent>
            </Card>
          ))}
      </div>
    </div>
  );
}

function AnnotationShape({
  item,
  page,
  scale,
  selected,
  onSelect,
}: {
  item: PdfAnnotation;
  page: PdfPageObject;
  scale: number;
  selected: boolean;
  onSelect: () => void;
}) {
  const position = item.position;
  const rects = position.pageIndex === page.index ? position.rects : position.nextPageRects;
  if (item.type === "image" && rects?.length) {
    // 照 Agentero：平时不画框，免得挡着看图；鼠标移上去或选中时才淡入一个中性的细框。
    // 左上角留一个批注颜色的小点，知道这里框过。页面总是白底，颜色写死，不跟主题走。
    return (
      <g
        data-annotation-id={item.id}
        onClick={onSelect}
        className="group"
        style={{ cursor: "pointer", pointerEvents: "all" }}
      >
        {rects.map((rect, i) => {
          const { origin, size } = pdfRectToReader(page, rect);
          const box = { x: origin.x, y: origin.y, width: size.width, height: size.height };
          const shown = selected ? "opacity-100" : "opacity-0 group-hover:opacity-100";
          return (
            <g key={i}>
              <rect {...box} fill="transparent" />
              <circle
                cx={origin.x}
                cy={origin.y}
                r={3 / scale}
                fill={item.color}
                className={cn("transition-opacity duration-150", selected ? "opacity-0" : "group-hover:opacity-0")}
              />
              <g data-region-frame className={cn("transition-opacity duration-150", shown)}>
                <rect
                  {...box}
                  fill="rgba(30, 34, 45, 0.07)"
                  stroke="rgba(255, 255, 255, 0.8)"
                  strokeWidth={4}
                  vectorEffect="non-scaling-stroke"
                />
                <rect
                  {...box}
                  fill="none"
                  stroke="rgba(30, 34, 45, 0.92)"
                  strokeWidth={2}
                  vectorEffect="non-scaling-stroke"
                />
              </g>
            </g>
          );
        })}
      </g>
    );
  }
  if (item.type === "highlight" && rects?.length) {
    // 照 Zotero：整条高亮作为一层统一上色，透明度加在这一层上，行与行重叠的地方不会叠深；
    // 每行上下各放宽一点，相邻两行连成一片；不描边，选中时只是颜色稍深一点（侧栏卡片同时标出）。
    const boxes = rects.map((rect) => {
      const { origin, size } = pdfRectToReader(page, rect);
      const pad = size.height * 0.12;
      return { x: origin.x, y: origin.y - pad, width: size.width, height: size.height + pad * 2 };
    });
    return (
      <g data-annotation-id={item.id} onClick={onSelect} style={{ cursor: "pointer", pointerEvents: "visiblePainted" }}>
        <g
          className={selected ? "opacity-55" : "opacity-40 hover:opacity-50"}
          style={{ mixBlendMode: "multiply" }}
          fill={item.color}
        >
          {boxes.map((box, i) => (
            <rect key={i} {...box} />
          ))}
        </g>
      </g>
    );
  }
  return (
    <g data-annotation-id={item.id} onClick={onSelect} style={{ cursor: "pointer", pointerEvents: "visiblePainted" }}>
      {rects?.map((rect, i) => {
        const { origin, size } = pdfRectToReader(page, rect);
        if (item.type === "text")
          return (
            <foreignObject
              key={i}
              x={origin.x}
              y={origin.y}
              width={size.width}
              height={size.height}
              transform={
                position.rotation
                  ? `rotate(${-position.rotation} ${origin.x + size.width / 2} ${origin.y + size.height / 2})`
                  : undefined
              }
            >
              <div
                style={{
                  color: item.color,
                  fontSize: (position.fontSize ?? 14) * (pdfToReader(page, [1, 0])[0] - pdfToReader(page, [0, 0])[0]),
                  lineHeight: 1.2,
                  whiteSpace: "pre-wrap",
                  overflowWrap: "anywhere",
                  width: "100%",
                  height: "100%",
                  border: selected ? `1px dashed ${item.color}` : undefined,
                }}
              >
                {item.comment || "…"}
              </div>
            </foreignObject>
          );
        if (item.type === "note")
          return (
            <g key={i}>
              <rect
                x={origin.x}
                y={origin.y}
                width={size.width}
                height={size.height}
                rx={2}
                fill={item.color}
                stroke={selected ? "#222" : item.color}
              />
              <path
                d={`M${origin.x + 5} ${origin.y + 7}h${size.width - 10}m-${size.width - 10} 4h${size.width - 10}`}
                stroke="#333"
                strokeWidth={1}
              />
            </g>
          );
        return (
          <rect
            key={i}
            x={origin.x}
            y={item.type === "underline" ? origin.y + size.height - 1 : origin.y}
            width={size.width}
            height={item.type === "underline" ? 1.5 : size.height}
            fill={item.color}
            stroke={selected ? item.color : "none"}
            strokeWidth={1.5}
          />
        );
      })}
      {position.pageIndex === page.index &&
        position.paths?.map((path, i) => {
          const points: string[] = [];
          for (let j = 0; j < path.length; j += 2) points.push(pdfToReader(page, [path[j], path[j + 1]]).join(","));
          if (points.length === 1) points.push(points[0]);
          return (
            <polyline
              key={i}
              points={points.join(" ")}
              fill="none"
              stroke={item.color}
              strokeWidth={position.width! * (pdfToReader(page, [1, 0])[0] - pdfToReader(page, [0, 0])[0])}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          );
        })}
    </g>
  );
}

export function PdfAnnotationLayer({
  controller: c,
  page,
  scale,
}: {
  controller: AnnotationController;
  page: PdfPageObject;
  scale: number;
}) {
  const [preview, setPreview] = useState<PdfAnnotation>();
  const [erased, setErased] = useState<PdfAnnotation[]>();
  const stroke = useRef<
    | { id: number; start: PdfPoint; last: PdfPoint; points: number[]; before: PdfAnnotation[]; after: PdfAnnotation[] }
    | undefined
  >(undefined);
  const painting = c.enabled && ["note", "text", "image", "ink", "eraser"].includes(c.tool);
  const point = (event: PointerEvent<SVGSVGElement>) =>
    readerToPdf(page, clientToReader(page, event.currentTarget.getBoundingClientRect(), event.clientX, event.clientY));
  const erase = (from: PdfPoint, to: PdfPoint) => {
    const gesture = stroke.current!;
    gesture.after = gesture.after.flatMap((item) => {
      if (item.type !== "ink" || item.readOnly || item.position.pageIndex !== page.index) return [item];
      const radius = readerToPdf(page, [6 / scale, 0])[0] - readerToPdf(page, [0, 0])[0];
      const paths = eraseInkPaths(item.position.paths!, from, to, radius + item.position.width! / 2);
      if (JSON.stringify(paths) === JSON.stringify(item.position.paths)) return [item];
      return paths.length
        ? [{ ...item, dateModified: new Date().toISOString(), position: { ...item.position, paths } }]
        : [];
    });
    setErased(gesture.after);
  };
  const shape = (gesture: NonNullable<typeof stroke.current>): AnnotationPosition => {
    if (c.tool === "ink") return { pageIndex: page.index, paths: [gesture.points], width: 2 };
    const [x, y] = gesture.start,
      [endX, endY] = gesture.last;
    const box: [number, number, number, number] = [
      Math.min(x, endX),
      Math.min(y, endY),
      Math.max(x, endX),
      Math.max(y, endY),
    ];
    if (c.tool === "text" && box[2] - box[0] < 10) {
      box[2] = box[0] + 160;
      box[1] = box[3] - 44;
    }
    return { pageIndex: page.index, rects: [box], ...(c.tool === "text" ? { fontSize: 14, rotation: 0 } : {}) };
  };
  const clear = () => {
    stroke.current = undefined;
    setPreview(undefined);
    setErased(undefined);
    c.drawing.current = false;
  };
  useEffect(() => clear, [c.tool]);
  return (
    <svg
      data-pdf-annotations={page.index}
      className="absolute inset-0"
      width={page.size.width * scale}
      height={page.size.height * scale}
      viewBox={`0 0 ${page.size.width} ${page.size.height}`}
      style={{
        pointerEvents: painting ? "auto" : "none",
        touchAction: painting ? "none" : undefined,
        cursor: painting ? "crosshair" : undefined,
      }}
      // 用「捕获」阶段接：这样拦得住 EmbedPDF 自己的选字，框选时不会同时选中文字
      onPointerDownCapture={(event) => {
        if (!painting || event.button !== 0 || stroke.current) return;
        event.preventDefault();
        event.stopPropagation();
        c.selection?.clear();
        const p = point(event);
        event.currentTarget.setPointerCapture(event.pointerId);
        stroke.current = { id: event.pointerId, start: p, last: p, points: [...p], before: c.items, after: c.items };
        c.drawing.current = true;
        if (c.tool === "eraser") erase(p, p);
      }}
      onPointerMoveCapture={(event) => {
        const gesture = stroke.current;
        if (!gesture || gesture.id !== event.pointerId) return;
        event.preventDefault();
        event.stopPropagation();
        const p = point(event);
        if (c.tool === "eraser") erase(gesture.last, p);
        gesture.last = p;
        gesture.points.push(...p);
        if (c.tool !== "eraser" && c.tool !== "note")
          setPreview(newAnnotation(c.tool as AnnotationType, c.color, shape(gesture), page, { runs: [] }));
      }}
      onPointerUpCapture={(event) => {
        const gesture = stroke.current;
        if (!gesture || gesture.id !== event.pointerId) return;
        event.preventDefault();
        event.stopPropagation();
        const end = point(event);
        if (c.tool === "eraser") erase(gesture.last, end);
        gesture.last = end;
        gesture.points.push(...gesture.last);
        if (c.tool === "eraser") {
          void c.finishErase(gesture.before, gesture.after, page).catch(report);
        } else if (c.tool === "note") {
          const [x, y] = gesture.last;
          void c
            .add("note", { pageIndex: page.index, rects: [[x - 11, y - 11, x + 11, y + 11]] }, "", true)
            .catch(report);
        } else {
          const position = shape(gesture);
          const box = position.rects?.[0];
          if (!box || c.tool !== "image" || (box[2] - box[0] >= 10 && box[3] - box[1] >= 10))
            void c.add(c.tool as AnnotationType, position, "", c.tool === "text").catch(report);
        }
        clear();
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={clear}
      onLostPointerCapture={() => {
        if (stroke.current) clear();
      }}
    >
      {(erased ?? c.items)
        .filter(
          (item) =>
            item.position.pageIndex === page.index ||
            (item.position.pageIndex + 1 === page.index && item.position.nextPageRects),
        )
        .map((item) => (
          <AnnotationShape
            key={item.id}
            item={item}
            page={page}
            scale={scale}
            selected={c.selected === item.id}
            onSelect={() => {
              if (!painting && !c.selection?.getState().selection) c.select(item.id);
            }}
          />
        ))}
      {preview && (
        <g pointerEvents="none">
          <AnnotationShape
            item={preview}
            page={page}
            scale={scale}
            selected={preview.type === "image"}
            onSelect={() => {}}
          />
        </g>
      )}
    </svg>
  );
}
