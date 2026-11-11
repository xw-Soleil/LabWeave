import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import Markdown from "@/components/ui/markdown";
import { TabWorkspace } from "@/core/TabWorkspace";
import { Settings } from "@/core/service/Settings";
import { activeTabAtom, store } from "@/state";
import { cn } from "@/utils/cn";
import { isMac } from "@/utils/platform";
import { EditorView } from "@codemirror/view";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { readFile } from "@tauri-apps/plugin-fs";
import { open } from "@tauri-apps/plugin-shell";
import {
  BookOpen,
  Bot,
  Copy,
  ExternalLink,
  FolderOpen,
  Image as ImageIcon,
  Languages,
  LocateFixed,
  MoreHorizontal,
  PencilLine,
  RefreshCw,
  Save,
  SquareArrowOutUpRight,
} from "lucide-react";
import {
  createElement,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from "react";
import { toast } from "sonner";
import { HighlightedCode } from "./CodeHighlight";
import { editorText, resolveDocumentImage } from "./DocumentFile";
import { DocumentTab, documentError, documentText as t, openDocumentFile } from "./DocumentTab";
import MarkdownEditor, { type MarkdownEditMode } from "./MarkdownEditor";
import type { LivePreviewConfig } from "./MarkdownLivePreview";
import type { OutlineHeading, OutlinePosition } from "./NoteHeadings";
import { NoteProperties, noteStats, splitFrontmatter } from "./NoteProperties";
import { documentWikilinkComponent } from "./ObsidianMarkdown";
import PdfView from "./PdfView";
import { askAiAboutSelection, clearReadingContext, watchMarkdownReadingSelection } from "./ReadingContext";
import { readingThemeVars, resolveReadingTheme } from "./ReadingTheme";
import { fileKindOf } from "./ResearchShell";
import { autoTranslateEnabled, selectionForTranslation, TranslateCard } from "./TranslateCard";

function imageType(path: string) {
  const extension = path.split(".").at(-1)?.toLowerCase();
  return extension === "svg" ? "image/svg+xml" : extension === "jpg" ? "image/jpeg" : `image/${extension}`;
}

/** 读本地图片，给出一个页面里能用的地址；不再用时收回 */
function useImageUrl(imagePath: string | undefined) {
  const [image, setImage] = useState<{ url?: string; error?: string }>({});
  useEffect(() => {
    if (!imagePath) return;
    let disposed = false;
    let url: string | undefined;
    setImage({});
    void (async () => {
      const bytes = await readFile(imagePath);
      if (disposed) return;
      url = URL.createObjectURL(new Blob([bytes], { type: imageType(imagePath) }));
      setImage({ url });
    })().catch((error) => {
      if (!disposed) setImage({ error: documentError(error) });
    });
    return () => {
      disposed = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [imagePath]);
  return { image, setImage };
}

const openImageTab = (path: string) => void openDocumentFile(path).catch((error) => toast.error(documentError(error)));
const revealInFiles = (path: string) =>
  void import("@/sub/FileManagerWindow")
    .then(({ default: FileManagerWindow }) => FileManagerWindow.reveal(path))
    .catch((error) => toast.error(documentError(error)));

/** 复制图片本身（不是路径）；剪贴板只认 PNG，别的格式先画成 PNG */
function copyImage(path: string) {
  const png = (async () => {
    const blob = new Blob([await readFile(path)], { type: imageType(path) });
    if (blob.type === "image/png") return blob;
    const url = URL.createObjectURL(blob);
    try {
      const image = new Image();
      image.src = url;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      canvas.getContext("2d")!.drawImage(image, 0, 0);
      return await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob((result) => (result ? resolve(result) : reject(new Error("imageCopyFailed"))), "image/png"),
      );
    } finally {
      URL.revokeObjectURL(url);
    }
  })();
  // 剪贴板要在点菜单的那一下里写，所以先交一个「稍后给出」的图片
  navigator.clipboard
    .write([new ClipboardItem({ "image/png": png })])
    .then(() => toast.success(t("image.copied")))
    .catch((error) => toast.error(documentError(error)));
}

/** 照 Obsidian：图片上右键能在新标签页打开、在文件栏里找到它、用系统程序打开、复制；⌘（Ctrl）点图片直接在新标签页打开 */
function ImageMenu({ path, children }: { path: string; children: ReactElement }) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="min-w-52">
        <ContextMenuItem onSelect={() => openImageTab(path)}>
          <SquareArrowOutUpRight />
          {t("image.openInTab")}
          <ContextMenuShortcut>{t("image.clickHint", { key: isMac ? "⌘" : "Ctrl" })}</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => revealInFiles(path)}>
          <LocateFixed />
          {t("image.revealInFiles")}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => void openWithSystem(path)}>
          <ExternalLink />
          {t("openSystem")}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => void openWithSystem(path.replace(/[\\/][^\\/]*$/, ""))}>
          <FolderOpen />
          {t("image.openFolder")}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => copyImage(path)}>
          <ImageIcon />
          {t("image.copy")}
        </ContextMenuItem>
        <ContextMenuItem
          onSelect={() =>
            void writeText(path)
              .then(() => toast.success(t("image.pathCopied")))
              .catch((error) => toast.error(documentError(error)))
          }
        >
          <Copy />
          {t("image.copyPath")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function DocumentImage({
  path,
  src,
  alt,
  width,
}: {
  path: string;
  src?: string;
  alt?: string;
  width?: number | string;
}) {
  const resolved = useMemo(() => {
    try {
      return { path: resolveDocumentImage(path, src ?? "") };
    } catch (error) {
      return { error: documentError(error) };
    }
  }, [path, src]);
  const { image, setImage } = useImageUrl(resolved.path);
  const error = resolved.error ?? image.error;
  if (error)
    return (
      <span role="status" className="text-destructive">
        {alt || src}: {error}
      </span>
    );
  return image.url && resolved.path ? (
    <ImageMenu path={resolved.path}>
      {/* 大图在后台解码，滚到图片时不卡一下。
          没写宽度的图和用户的 Obsidian（博客）一样当二倍图，显示成原图一半，最宽到正文宽度 */}
      <img
        src={image.url}
        alt={alt ?? ""}
        width={width}
        decoding="async"
        onLoad={(event) => {
          const element = event.currentTarget;
          if (width === undefined && element.naturalWidth && !/\.svg$/i.test(src ?? ""))
            element.style.width = `${element.naturalWidth / 2}px`;
        }}
        onError={() => setImage({ error: t("imageFailed") })}
        onMouseDown={(event) => {
          // 右键、⌘ 点击时编辑器不要把光标挪进来露出原文
          if (event.button === 2 || (isMac ? event.metaKey : event.ctrlKey)) event.stopPropagation();
        }}
        onClick={(event) => {
          if (!(isMac ? event.metaKey : event.ctrlKey)) return;
          event.preventDefault();
          event.stopPropagation();
          openImageTab(resolved.path!);
        }}
      />
    </ImageMenu>
  ) : (
    <span>{t("loading")}</span>
  );
}

/** 在软件里看图：默认缩到放得下，点一下看原图大小 */
function ImageView({ tab }: { tab: DocumentTab }) {
  const { image } = useImageUrl(tab.path);
  const [actual, setActual] = useState(false);
  return (
    <>
      <ViewHeader
        tab={tab}
        menu={
          <>
            <DropdownMenuItem onSelect={() => revealInFiles(tab.path)}>
              <LocateFixed />
              {t("image.revealInFiles")}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => copyImage(tab.path)}>
              <ImageIcon />
              {t("image.copy")}
            </DropdownMenuItem>
          </>
        }
      />
      <div className={cn("min-h-0 flex-1 overflow-auto", !actual && "flex items-center justify-center p-6")}>
        {image.error ? (
          <p role="status" className="text-destructive p-6">
            {image.error}
          </p>
        ) : image.url ? (
          <ImageMenu path={tab.path}>
            <img
              src={image.url}
              alt={tab.title}
              title={t(actual ? "image.fit" : "image.actualSize")}
              className={cn(
                "select-none",
                actual ? "max-w-none cursor-zoom-out" : "max-h-full max-w-full cursor-zoom-in object-contain",
              )}
              onClick={() => setActual(!actual)}
            />
          </ImageMenu>
        ) : (
          <p className="text-muted-foreground p-6">{t("loading")}</p>
        )}
      </div>
    </>
  );
}

function MarkdownView({ tab }: { tab: DocumentTab }) {
  const [theme] = Settings.use("readingTheme");
  const source = useDeferredValue(editorText(tab.markdown?.text ?? ""));
  const components = useMemo(
    () => ({
      code: HighlightedCode,
      img: (props: ComponentProps<"img">) => (
        <DocumentImage path={tab.path} src={props.src} alt={props.alt} width={props.width} />
      ),
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
  const [mode, setMode] = useState<MarkdownMode>(() => stored(MODE_KEY, ["read", "edit"], "edit"));
  const [editMode, setEditMode] = useState<MarkdownEditMode>(() => stored(EDIT_MODE_KEY, ["live", "source"], "live"));
  const pickMode = (value: MarkdownMode) => {
    setMode(value);
    globalThis.localStorage?.setItem(MODE_KEY, value);
  };
  const pickEditMode = (value: MarkdownEditMode) => {
    setEditMode(value);
    globalThis.localStorage?.setItem(EDIT_MODE_KEY, value);
    pickMode("edit");
  };
  const previewArea = useRef<HTMLDivElement>(null);
  useEffect(watchReadingSelection, []);

  // 大纲：点标题跳过去；滚动时告诉大纲读到哪个标题了
  const editorView = useRef<EditorView | null>(null);
  const loaded = !!tab.markdown;
  useEffect(() => {
    const area = previewArea.current;
    if (!area) return;
    const headingsIn = () => area.querySelectorAll<HTMLElement>(":scope .markdown-body > :is(h1, h2, h3, h4, h5, h6)");
    const jump = (heading: OutlineHeading, index: number) => {
      const view = editorView.current;
      if (mode === "edit" && view) {
        const line = view.state.doc.line(Math.min(heading.line + 1, view.state.doc.lines));
        view.dispatch({
          selection: { anchor: line.from },
          effects: EditorView.scrollIntoView(line.from, { y: "start", yMargin: 16 }),
        });
        view.focus();
        return;
      }
      headingsIn()[index]?.scrollIntoView({ block: "start" });
    };
    let frame = 0;
    const report = () => {
      frame = 0;
      const top = area.getBoundingClientRect().top + 48;
      const view = editorView.current;
      let position: OutlinePosition;
      if (mode === "edit" && view) {
        const block = view.lineBlockAtHeight(Math.max(0, top - view.documentTop));
        position = { line: view.state.doc.lineAt(block.from).number - 1 };
      } else {
        let index = -1;
        for (const heading of headingsIn()) {
          if (heading.getBoundingClientRect().top > top) break;
          index++;
        }
        position = { index };
      }
      const previous = tab.outlinePosition;
      if (previous && JSON.stringify(previous) === JSON.stringify(position)) return;
      tab.outlinePosition = position;
      tab.emit("outline-position");
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(report);
    };
    tab.on("outline-jump", jump);
    area.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => {
      tab.off("outline-jump", jump);
      area.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(frame);
    };
  }, [tab, mode, loaded]);
  const wikilink = useMemo(() => documentWikilinkComponent(tab.path, components.img), [tab.path, components]);
  const liveConfig: LivePreviewConfig = {
    renderMarkdown: (block) => <Markdown source={block} components={components} document={{ path: tab.path }} />,
    renderImage: (src, alt) => <DocumentImage path={tab.path} src={src} alt={alt} />,
    renderEmbed: (target, width) =>
      createElement(wikilink, { "data-target": target, "data-embed": "1", "data-width": width }, target),
    openLink: (href) =>
      void (async () => {
        if (/^https?:\/\//i.test(href)) return open(href);
        const path = resolveDocumentImage(tab.path, href);
        const kind = fileKindOf(path);
        if (kind !== "markdown" && kind !== "pdf") throw new Error("unsupportedLink");
        await openDocumentFile(path);
      })().catch((error) => toast.error(documentError(error))),
    openWikilink: (target) =>
      void (async () => {
        const { createDocumentLinkResolver } = await import("./DocumentLinks");
        const link = await createDocumentLinkResolver(tab.path)(target);
        if (!link) throw new Error("noteNotFound");
        if (!/\.(md|pdf)$/i.test(link.path)) throw new Error("unsupportedLink");
        await openDocumentFile(link.path, { heading: link.heading });
      })().catch((error) => toast.error(documentError(error))),
  };
  useEffect(() => {
    const heading = tab.markdownHeading;
    if (!heading || !tab.markdown || tab.loadingMarkdown || source !== editorText(tab.markdown.text)) return;
    if (mode === "edit") {
      setMode("read");
      return;
    }
    const normalize = (value: string) => value.trim().normalize("NFC").toLowerCase();
    const target = [
      ...(previewArea.current?.querySelectorAll<HTMLElement>(
        ".markdown-body h1, .markdown-body h2, .markdown-body h3, .markdown-body h4, .markdown-body h5, .markdown-body h6",
      ) ?? []),
    ].find((element) => normalize(element.textContent ?? "") === normalize(heading));
    tab.markdownHeading = undefined;
    if (!target) {
      toast.error(t("errors.headingNotFound"));
      return;
    }
    let revealed = false;
    for (let parent = target.parentElement; parent && parent !== previewArea.current; parent = parent.parentElement) {
      if (parent.matches(".callout-content[hidden]")) {
        parent.parentElement?.querySelector<HTMLElement>(":scope > .callout-title")?.click();
        revealed = true;
      }
    }
    if (!revealed) target.scrollIntoView({ block: "start" });
    else {
      const frame = requestAnimationFrame(() => target.scrollIntoView({ block: "start" }));
      return () => cancelAnimationFrame(frame);
    }
  }, [tab, tab.markdownHeading, tab.loadingMarkdown, source, mode]);
  const frontmatter = splitFrontmatter(source);
  const stats = useMemo(() => noteStats(source), [source]);
  const editProperties = (yaml: string) => {
    // 以最新原文为准重拼，预览用的是稍慢一拍的文字，不能拿它覆盖刚打的字
    const current = splitFrontmatter(editorText(tab.markdown!.text));
    if (!current) return;
    tab.markdown!.edit(current.opening + yaml + current.closing + current.body);
    tab.changed();
  };
  const preview = (
    <article className="reading-view">
      <h1 className="reading-title">{noteTitle(tab.title)}</h1>
      {frontmatter && <NoteProperties yaml={frontmatter.yaml} onChange={editProperties} />}
      <Markdown
        source={frontmatter ? frontmatter.body : source}
        components={components}
        document={{ path: tab.path }}
      />
    </article>
  );
  return (
    <div
      className="relative flex min-h-0 flex-1 flex-col"
      style={readingThemeVars(resolveReadingTheme(theme)) as CSSProperties}
      onKeyDownCapture={(event) => {
        // Cmd/Ctrl+E 在阅读和编辑之间切换，和 Obsidian 一样
        if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "e") {
          event.preventDefault();
          pickMode(mode === "read" ? "edit" : "read");
        }
      }}
    >
      <ViewHeader
        tab={tab}
        actions={
          <HeaderButton
            label={t(mode === "read" ? "modes.toEdit" : "modes.toRead")}
            onClick={() => pickMode(mode === "read" ? "edit" : "read")}
          >
            {mode === "read" ? <PencilLine /> : <BookOpen />}
          </HeaderButton>
        }
        menu={
          <>
            <DropdownMenuRadioGroup
              value={mode === "read" ? "read" : editMode}
              onValueChange={(value) => (value === "read" ? pickMode("read") : pickEditMode(value as MarkdownEditMode))}
            >
              <DropdownMenuRadioItem value="read">{t("modes.read")}</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="live">{t("modes.live")}</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="source">{t("modes.source")}</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={!tab.markdown || tab.saving || tab.loadingMarkdown}
              onSelect={() => void tab.save()}
            >
              <Save />
              {t(tab.saving ? "saving" : "save")}
              <DropdownMenuShortcut>{isMac ? "⌘S" : "Ctrl+S"}</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem disabled={tab.saving || tab.loadingMarkdown} onSelect={() => void reload()}>
              <RefreshCw />
              {t("reload")}
            </DropdownMenuItem>
          </>
        }
      />
      {tab.error && (
        <Alert variant="destructive">
          <AlertDescription>{tab.error}</AlertDescription>
        </Alert>
      )}
      {!tab.markdown ? (
        <div role="status" className="text-muted-foreground p-6">
          {tab.error ? t("retryHint") : t("loading")}
        </div>
      ) : mode === "edit" ? (
        <div ref={previewArea} className="reading-scroll relative min-h-0 flex-1 overflow-auto px-8 pt-6">
          <div className="reading-view">
            <h1 className="reading-title">{noteTitle(tab.title)}</h1>
            <MarkdownEditor
              value={editorText(tab.markdown.text)}
              mode={editMode}
              config={liveConfig}
              disabled={tab.loadingMarkdown}
              label={t("source")}
              onView={(view) => (editorView.current = view)}
              onChange={(text) => {
                tab.markdown!.edit(text);
                tab.changed();
              }}
            />
          </div>
          <PreviewSelection key={`${mode}-${editMode}`} area={previewArea} path={tab.path} title={tab.title} />
        </div>
      ) : (
        <div
          ref={previewArea}
          className="reading-scroll relative min-h-0 flex-1 overflow-auto px-8 pt-6 pb-24"
          aria-label={t("preview")}
        >
          {preview}
          <PreviewSelection key={mode} area={previewArea} path={tab.path} title={tab.title} />
        </div>
      )}
      {/* 右下角的词数、字符数，和 Obsidian 的状态栏一样 */}
      {tab.markdown && (
        <div
          role="status"
          className="text-muted-foreground bg-background/85 pointer-events-none absolute right-4 bottom-1.5 z-10 flex gap-3 rounded px-2 py-0.5 text-xs tabular-nums"
        >
          <span>{t("stats.words", { n: stats.words.toLocaleString("en-US") })}</span>
          <span>{t("stats.characters", { n: stats.characters.toLocaleString("en-US") })}</span>
        </div>
      )}
    </div>
  );
}

/** Markdown 预览里选中文字：弹出翻译、问 AI、复制，和 PDF 的选区菜单一样 */
function PreviewSelection({
  area,
  path,
  title,
}: {
  area: RefObject<HTMLDivElement | null>;
  path: string;
  title: string;
}) {
  const [menu, setMenu] = useState<{ text: string; center: number; top: number; bottom: number }>();
  const [translation, setTranslation] = useState<{ text: string; center: number; bottom: number }>();
  useEffect(() => {
    const element = area.current;
    if (!element) return;
    const onUp = () =>
      requestAnimationFrame(() => {
        const selection = window.getSelection();
        const raw = selection?.toString().trim() ?? "";
        if (!selection?.rangeCount || !raw || !element.contains(selection.anchorNode)) return setMenu(undefined);
        const rect = selection.getRangeAt(0).getBoundingClientRect();
        const box = element.getBoundingClientRect();
        const next = {
          text: selectionForTranslation(raw),
          center: rect.left + rect.width / 2 - box.left + element.scrollLeft,
          top: rect.top - box.top + element.scrollTop,
          bottom: rect.bottom - box.top + element.scrollTop,
        };
        setMenu(next);
        if (autoTranslateEnabled()) setTranslation(next);
      });
    const onDown = (event: PointerEvent) => {
      if (!(event.target instanceof Element && event.target.closest("[data-selection-ui], [role=dialog]")))
        setMenu(undefined);
    };
    element.addEventListener("pointerup", onUp);
    element.addEventListener("pointerdown", onDown);
    return () => {
      element.removeEventListener("pointerup", onUp);
      element.removeEventListener("pointerdown", onDown);
    };
  }, [area]);
  const width = area.current?.clientWidth ?? 600;
  return (
    <>
      {menu && (
        <div
          data-selection-ui
          role="toolbar"
          aria-label={t("selection.menu")}
          className="bg-popover text-popover-foreground absolute z-40 flex items-center gap-0.5 rounded-lg border p-1 shadow-lg"
          style={{ left: Math.max(8, Math.min(menu.center - 110, width - 228)), top: Math.max(4, menu.top - 44) }}
        >
          <Button variant="ghost" size="sm" className="h-7 gap-1.5 px-2 text-xs" onClick={() => setTranslation(menu)}>
            <Languages />
            {t("selection.translate")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5 px-2 text-xs"
            onClick={() => {
              askAiAboutSelection({ text: menu.text, path, title: title.replace(/\.md$/i, "") });
              setMenu(undefined);
            }}
          >
            <Bot />
            {t("selection.askAi")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5 px-2 text-xs"
            onClick={() =>
              void writeText(window.getSelection()?.toString() ?? menu.text)
                .then(() => setMenu(undefined))
                .catch((error) => toast.error(documentError(error)))
            }
          >
            <Copy />
            {t("selection.copy")}
          </Button>
        </div>
      )}
      {translation && (
        <TranslateCard
          text={translation.text}
          left={translation.center}
          top={translation.bottom + 8}
          bounds={{ width, height: area.current?.scrollHeight ?? 800 }}
          onClose={() => setTranslation(undefined)}
        />
      )}
    </>
  );
}

export const READING_SELECTION = "reading-selection";
let selectionWatchers = 0;
let readingHighlight: Highlight | undefined;

/**
 * 选区落在阅读区（.reading-scroll）里时，把它放进 reading-selection 高亮，reading.css 只给文字涂色。
 * 一直用同一个高亮，往里 clear / add：Mac 的网页引擎在 CSS.highlights.delete、set 时不重画
 * （实测旧的蓝色要等别的东西触发重画才消失，看着像卡了一秒），clear / add 会马上重画。
 */
function paintReadingSelection() {
  const selection = window.getSelection();
  const highlight = (readingHighlight ??= new Highlight());
  if (CSS.highlights.get(READING_SELECTION) !== highlight) CSS.highlights.set(READING_SELECTION, highlight);
  highlight.clear();
  for (let index = 0; selection && !selection.isCollapsed && index < selection.rangeCount; index++) {
    const range = selection.getRangeAt(index);
    const container = range.commonAncestorContainer;
    const element = container instanceof Element ? container : container.parentElement;
    if (element?.closest(".reading-scroll")) highlight.add(range.cloneRange());
  }
}

/**
 * 照 Obsidian 的选中样子：只有文字上色。Mac 的网页引擎画原生选区时会把段落间、正文两侧的空白一起涂满，
 * 所以原生选区在阅读区里是透明的（reading.css），由这里画。几篇文档同时开着也只挂一个监听。
 */
function watchReadingSelection() {
  // 测试环境（jsdom）和很旧的网页引擎没有自定义高亮，这时 reading.css 也不会把原生选区设成透明
  if (typeof Highlight === "undefined" || !globalThis.CSS?.highlights) return;
  if (selectionWatchers++ === 0) document.addEventListener("selectionchange", paintReadingSelection);
  return () => {
    if (--selectionWatchers > 0) return;
    document.removeEventListener("selectionchange", paintReadingSelection);
    readingHighlight?.clear();
    CSS.highlights.delete(READING_SELECTION);
  };
}

/** 文件名当大标题时去掉 .md，和 Obsidian 一样 */
const noteTitle = (name: string) => name.replace(/\.(md|markdown)$/i, "");

/** 照 Obsidian：阅读，或者编辑（编辑又分实时预览和源码），都记在本机 */
type MarkdownMode = "read" | "edit";
const MODE_KEY = "labweave.markdownView";
const EDIT_MODE_KEY = "labweave.markdownEditMode";
function stored<T extends string>(key: string, values: T[], fallback: T): T {
  // 测试环境里 localStorage 可能是 undefined
  const value = globalThis.localStorage?.getItem(key);
  return values.includes(value as T) ? (value as T) : fallback;
}

export default function DocumentView({ tab }: { tab: DocumentTab }) {
  const host = useRef<HTMLDivElement>(null);
  const [, update] = useState(0);
  useEffect(() => {
    const unwatch =
      tab.kind === "markdown" && host.current ? watchMarkdownReadingSelection(tab, host.current) : undefined;
    return () => {
      unwatch?.();
      clearReadingContext(tab);
    };
  }, [tab]);
  useEffect(() => {
    const changed = () => update((value) => value + 1);
    tab.on("state-change", changed);
    return () => {
      tab.off("state-change", changed);
    };
  }, [tab]);
  return (
    <div
      ref={host}
      className="bg-background flex h-full min-h-0 flex-col"
      onFocusCapture={() => {
        if (store.get(activeTabAtom) !== tab) TabWorkspace.focus(tab.id);
      }}
    >
      {tab.kind === "markdown" ? (
        <MarkdownView tab={tab} />
      ) : tab.kind === "image" ? (
        <ImageView tab={tab} />
      ) : (
        <>
          <ViewHeader tab={tab} />
          <PdfView key={tab.id} tab={tab} />
        </>
      )}
    </div>
  );
}

function HeaderButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <Button
      variant="ghost"
      size="icon"
      className="text-muted-foreground hover:text-foreground size-7 [&_svg:not([class*='size-'])]:size-4"
      title={label}
      aria-label={label}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

/**
 * 照 Obsidian 的标题栏：一行，中间是「所在文件夹 / 文件名」，右边是切换按钮和「…」。
 * 保存走 ⌘S，「用系统程序打开」收进「…」，标签和文件栏的右键菜单里也有。
 */
function ViewHeader({ tab, actions, menu }: { tab: DocumentTab; actions?: ReactNode; menu?: ReactNode }) {
  const folder = tab.path.split(/[\\/]/).at(-2);
  return (
    <div className="flex h-9 shrink-0 items-center gap-2 px-2">
      <span className="flex-1" />
      <div className="min-w-0 truncate text-[13px]" title={tab.path}>
        {folder && <span className="text-muted-foreground">{folder} / </span>}
        <span>{noteTitle(tab.title)}</span>
      </div>
      <div className="flex flex-1 items-center justify-end gap-0.5">
        {actions}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="text-muted-foreground hover:text-foreground size-7 [&_svg:not([class*='size-'])]:size-4"
              aria-label={t("modes.more")}
              title={t("modes.more")}
            >
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-48">
            {menu}
            {menu && <DropdownMenuSeparator />}
            <DropdownMenuItem onSelect={() => void openWithSystem(tab.path)}>
              <ExternalLink />
              {t("openSystem")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

const openWithSystem = (path: string) => open(path).catch((error) => toast.error(documentError(error)));
