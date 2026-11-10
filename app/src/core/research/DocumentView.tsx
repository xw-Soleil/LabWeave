import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import Markdown from "@/components/ui/markdown";
import { Textarea } from "@/components/ui/textarea";
import { TabWorkspace } from "@/core/TabWorkspace";
import { activeTabAtom, store } from "@/state";
import { readFile } from "@tauri-apps/plugin-fs";
import { open } from "@tauri-apps/plugin-shell";
import { cn } from "@/utils/cn";
import { BookOpen, Columns2, ExternalLink, PencilLine, RefreshCw, Save, type LucideIcon } from "lucide-react";
import { useDeferredValue, useEffect, useMemo, useState, type ComponentProps } from "react";
import { toast } from "sonner";
import { editorText, resolveDocumentImage } from "./DocumentFile";
import { DocumentTab, documentError, documentText as t, openDocumentFile } from "./DocumentTab";
import PdfView from "./PdfView";
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
  const [mode, setMode] = useState<MarkdownMode>(storedMarkdownMode);
  const pickMode = (value: MarkdownMode) => {
    setMode(value);
    globalThis.localStorage?.setItem(MARKDOWN_MODE_KEY, value);
  };
  const editor = tab.markdown && (
    <Textarea
      id={`source-${tab.id}`}
      aria-label={t("source")}
      className="reading-source min-h-0 flex-1 resize-none overflow-auto rounded-none border-0 bg-transparent px-0 py-0 shadow-none focus-visible:ring-0"
      style={{ fieldSizing: "fixed" }}
      spellCheck={false}
      disabled={tab.loadingMarkdown}
      value={editorText(tab.markdown.text)}
      onChange={(event) => {
        tab.markdown!.edit(event.target.value);
        tab.changed();
      }}
    />
  );
  const preview = (
    <article className="reading-view [&_*]:select-text">
      <h1 className="reading-title">{tab.title}</h1>
      <Markdown source={source} components={components} />
    </article>
  );
  return (
    <>
      <div className="flex items-center gap-1 px-3 py-1.5">
        <div
          role="radiogroup"
          aria-label={t("mode")}
          className="bg-foreground/[0.05] flex items-center gap-0.5 rounded-md p-0.5"
        >
          {MARKDOWN_MODES.map(({ id, icon: Icon }) => (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={mode === id}
              title={t(`modes.${id}`)}
              className={cn(
                "text-muted-foreground hover:text-foreground flex h-6 items-center gap-1 rounded px-2 text-xs",
                mode === id && "bg-background text-foreground shadow-xs",
              )}
              onClick={() => pickMode(id)}
            >
              <Icon className="size-3.5" />
              {t(`modes.${id}`)}
            </button>
          ))}
        </div>
        <span className="flex-1" />
        {tab.hasUnsavedChanges && (
          <span className="text-muted-foreground flex items-center gap-1.5 px-1 text-xs">
            <span className="bg-primary size-1.5 rounded-full" />
            {t("unsaved")}
          </span>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-xs"
          disabled={tab.saving || tab.loadingMarkdown}
          onClick={() => void reload()}
        >
          <RefreshCw data-icon="inline-start" />
          {t("reload")}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-xs"
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
      ) : mode === "split" ? (
        <div className="grid min-h-0 flex-1 grid-rows-2 border-t md:grid-cols-2 md:grid-rows-1">
          <section className="flex min-h-0 min-w-0 flex-col px-6 py-5 max-md:border-b md:border-r">{editor}</section>
          <section className="min-h-0 min-w-0 overflow-auto px-8 py-6" aria-label={t("preview")}>
            {preview}
          </section>
        </div>
      ) : mode === "edit" ? (
        <div className="flex min-h-0 flex-1 flex-col border-t px-8 py-6">
          <div className="reading-view flex min-h-0 flex-1 flex-col">{editor}</div>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto border-t px-8 pt-8 pb-24" aria-label={t("preview")}>
          {preview}
        </div>
      )}
    </>
  );
}

type MarkdownMode = "edit" | "split" | "read";
const MARKDOWN_MODE_KEY = "labweave.markdownMode";
const MARKDOWN_MODES: { id: MarkdownMode; icon: LucideIcon }[] = [
  { id: "edit", icon: PencilLine },
  { id: "split", icon: Columns2 },
  { id: "read", icon: BookOpen },
];
function storedMarkdownMode(): MarkdownMode {
  // 测试环境里 localStorage 可能是 undefined
  const value = globalThis.localStorage?.getItem(MARKDOWN_MODE_KEY);
  return MARKDOWN_MODES.some(({ id }) => id === value) ? (value as MarkdownMode) : "split";
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
      {tab.kind === "markdown" ? <MarkdownView tab={tab} /> : <PdfView key={tab.id} tab={tab} />}
    </div>
  );
}
