import { Dialog } from "@/components/ui/dialog";
import { Tab } from "@/core/Tab";
import { TabWorkspace } from "@/core/TabWorkspace";
import { activeResourceTabAtom, store, tabsAtom } from "@/state";
import { exists } from "@tauri-apps/plugin-fs";
import { open } from "@tauri-apps/plugin-shell";
import i18next from "i18next";
import { FileText, NotebookPen } from "lucide-react";
import { lazy, Suspense } from "react";
import { toast } from "sonner";
import { URI } from "vscode-uri";
import { identifyDocument, documentKey, documentPath, MarkdownDocument, markdownFileIO } from "./DocumentFile";
import { notifyResearchFilesChanged, ResearchFolder } from "./ResearchFolder";
import { fileKindOf } from "./ResearchShell";
import { loadAnnotationStore, type PdfAnnotationStore } from "./PdfAnnotationStore";

const DocumentView = lazy(() => import("./DocumentView"));
export const documentText = (key: string, options?: Record<string, unknown>) =>
  i18next.t(`document.${key}`, { ns: "research", ...options, interpolation: { escapeValue: false } });

export function documentError(error: unknown): string {
  const code = error instanceof Error ? error.message : String(error);
  const known = [
    "fileChanged",
    "pdfTimeout",
    "pdfWorkerFailed",
    "pdfLocked",
    "pdfEmpty",
    "pdfTooLarge",
    "pdfRenderFailed",
    "imageNotLocal",
    "fileClosed",
    "unsupportedLink",
    "editsDuringReload",
    "annotationBusy",
    "annotationLocation",
    "annotationReadFailed",
    "annotationWriteFailed",
    "annotationCorrupt",
    "annotationChanged",
    "annotationCleanupFailed",
    "annotationDestinationExists",
    "annotationRollbackFailed",
    "annotationReadOnly",
  ];
  if (known.includes(code)) return documentText(`errors.${code}`);
  if (error instanceof Error && error.name === "PasswordException") return documentText("errors.pdfLocked");
  return documentText("errors.failed", { error: code });
}

export class DocumentTab extends Tab {
  uri: URI;
  markdown?: MarkdownDocument;
  annotations?: PdfAnnotationStore;
  loadingAnnotations = false;
  private annotationLoading?: Promise<void>;
  private annotationSaveTimer?: ReturnType<typeof setTimeout>;
  error = "";
  saving = false;
  loadingMarkdown = false;
  pdfLocation = { page: 1, scale: "fit-width" as string | number };
  private loading?: Promise<void>;
  private readonly component = () => (
    <Suspense fallback={<div className="text-muted-foreground p-6">{documentText("loading")}</div>}>
      <DocumentView tab={this} />
    </Suspense>
  );

  constructor(
    public path: string,
    readonly kind: "markdown" | "pdf",
  ) {
    super({});
    this.uri = URI.file(path);
    this.closeOnEscape = false;
    this.beforeClose = async () => {
      if (this.annotations?.moving) return false;
      if (!this.hasUnsavedChanges && !this.saving) return true;
      TabWorkspace.focus(this.id);
      const answer = await Dialog.buttons(
        documentText(this.kind === "pdf" ? "annotation.closeTitle" : "closeTitle"),
        this.title,
        [
          { id: "cancel", label: documentText("cancel"), variant: "ghost" },
          { id: "discard", label: documentText("discard"), variant: "destructive" },
          { id: "save", label: documentText("save") },
        ],
      );
      if (answer === "save") return (await this.save()) && !this.hasUnsavedChanges;
      if (answer === "discard" && !this.saving) {
        clearTimeout(this.annotationSaveTimer);
        return true;
      }
      return false;
    };
  }

  override get title() {
    return this.path.split("/").at(-1) ?? this.path;
  }
  override get icon() {
    return this.kind === "markdown" ? NotebookPen : FileText;
  }
  override get hasUnsavedChanges() {
    return this.markdown?.dirty ?? this.annotations?.dirty ?? false;
  }
  getComponent() {
    return this.component;
  }

  changed() {
    this.emit("state-change");
    store.set(tabsAtom, [...store.get(tabsAtom)]);
  }

  rebindPath(path: string) {
    this.path = documentPath(path);
    this.uri = URI.file(this.path);
    this.changed();
  }

  override async dispose() {
    clearTimeout(this.annotationSaveTimer);
    await super.dispose();
  }

  loadAnnotations(reload = false): Promise<void> {
    if (this.annotationLoading) return this.annotationLoading;
    if (this.closing || this.saving || (this.annotations && !reload)) return Promise.resolve();
    this.loadingAnnotations = true;
    this.changed();
    this.annotationLoading = (async () => {
      if (this.annotations) await this.annotations.reload();
      else {
        const annotations = await loadAnnotationStore(this.path);
        if (!this.closing) this.annotations = annotations;
      }
      if (!this.closing) this.error = "";
    })()
      .catch((error) => {
        if (!this.closing) this.error = documentError(error);
      })
      .finally(() => {
        this.annotationLoading = undefined;
        this.loadingAnnotations = false;
        if (!this.closing) this.changed();
      });
    return this.annotationLoading;
  }

  annotationsChanged() {
    this.changed();
    clearTimeout(this.annotationSaveTimer);
    if (!this.error && !this.annotations?.moving)
      this.annotationSaveTimer = setTimeout(() => {
        if (!this.closing) void this.save();
      }, 500);
  }

  loadMarkdown(reload = false): Promise<void> {
    if (this.loading) return this.loading;
    if (this.closing || this.saving || (this.markdown && !reload)) return Promise.resolve();
    const original = this.markdown;
    const text = original?.text;
    this.loadingMarkdown = true;
    this.changed();
    this.loading = markdownFileIO
      .read(this.path)
      .then((snapshot) => {
        if (this.closing) return;
        if (this.markdown !== original || this.markdown?.text !== text) throw new Error("editsDuringReload");
        this.markdown = new MarkdownDocument(this.path, snapshot);
        this.error = "";
      })
      .catch((error) => {
        if (!this.closing) this.error = documentError(error);
      })
      .finally(() => {
        this.loading = undefined;
        this.loadingMarkdown = false;
        this.changed();
      });
    return this.loading;
  }

  async save(): Promise<boolean> {
    const document = this.kind === "pdf" ? this.annotations : this.markdown;
    if (!document || this.loadingMarkdown || this.loadingAnnotations || this.closing) return false;
    clearTimeout(this.annotationSaveTimer);
    this.saving = true;
    this.changed();
    try {
      await document.save();
      this.error = "";
      notifyResearchFilesChanged();
      return true;
    } catch (error) {
      this.error = documentError(error);
      toast.error(this.error);
      return false;
    } finally {
      this.saving = false;
      this.changed();
    }
  }
}

export function activeDocumentTab(): DocumentTab | undefined {
  const tab = store.get(activeResourceTabAtom);
  return tab instanceof DocumentTab ? tab : undefined;
}

const opening = new Map<string, Promise<DocumentTab>>();

export async function openDocumentFile(path: string): Promise<DocumentTab | undefined> {
  const kind = fileKindOf(path);
  if (kind !== "markdown" && kind !== "pdf") {
    await open(path);
    return;
  }
  if (ResearchFolder.isInside(path)) await ResearchFolder.ensureRootRegistered();
  const identified = await identifyDocument(path);
  const { key } = identified;
  let task = opening.get(key);
  if (!task) {
    task = Promise.resolve().then(async () => {
      const tabs = store.get(tabsAtom).filter((tab): tab is DocumentTab => tab instanceof DocumentTab && !tab.closing);
      let existing = tabs.find((tab) => documentKey(tab.path) === documentKey(identified.path));
      if (!existing) {
        for (const tab of tabs) {
          // Atomic saves and renames can change the file behind an open path.
          if ((await exists(tab.path)) && (await identifyDocument(tab.path)).key === key && !tab.closing) {
            existing = tab;
            break;
          }
        }
      }
      if (existing) {
        TabWorkspace.focus(existing.id);
        return existing;
      }
      return TabWorkspace.open(new DocumentTab(identified.path, kind));
    });
    opening.set(key, task);
  }
  try {
    return await task;
  } finally {
    if (opening.get(key) === task) opening.delete(key);
  }
}
