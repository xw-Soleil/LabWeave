import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import Markdown from "@/components/ui/markdown";
import { Textarea } from "@/components/ui/textarea";
import { TabWorkspace } from "@/core/TabWorkspace";
import { activeTabAtom, store } from "@/state";
import { readFile } from "@tauri-apps/plugin-fs";
import { open } from "@tauri-apps/plugin-shell";
import { ExternalLink, RefreshCw, Save } from "lucide-react";
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
