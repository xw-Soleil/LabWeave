import i18next from "i18next";
import { toast } from "sonner";
import type { ResearchSnapshot, SnapshotReason } from "./ResearchHistoryTypes";
import { RESEARCH_CONTENT_SAVED_EVENT } from "./ResearchShell";

export interface SnapshotDocument {
  id: string;
  path?: string;
  dirty: boolean;
  busy: boolean;
  revision: unknown;
  save(): Promise<void>;
}

export interface SnapshotPreparation {
  documents(root: string): Promise<SnapshotDocument[]>;
  capture(root: string, reason: SnapshotReason): Promise<ResearchSnapshot>;
}

const failure = (key: string) => new Error(i18next.t(`progress.errors.${key}`, { ns: "research" }));

async function liveDocuments(root: string): Promise<SnapshotDocument[]> {
  const [{ Project, ProjectState }, { DocumentTab }, { ResearchFolder }, { store, tabsAtom }] = await Promise.all([
    import("@/core/Project"),
    import("./DocumentTab"),
    import("./ResearchFolder"),
    import("@/state"),
  ]);
  return store.get(tabsAtom).flatMap((tab): SnapshotDocument[] => {
    if (tab instanceof Project) {
      const path = tab.uri.scheme === "file" ? tab.uri.fsPath : undefined;
      if (tab.isCollab || (path ? !ResearchFolder.isInside(path, root) : ResearchFolder.getRoot() !== root)) return [];
      return [
        {
          id: tab.id,
          path,
          dirty: tab.projectState !== ProjectState.Saved,
          busy: tab.closing || tab.isSaving || tab.fileMutationInProgress,
          revision: tab.editRevision,
          save: () => tab.save(),
        },
      ];
    }
    if (!(tab instanceof DocumentTab) || !ResearchFolder.isInside(tab.path, root)) return [];
    return [
      {
        id: tab.id,
        path: tab.path,
        dirty: tab.hasUnsavedChanges,
        busy:
          tab.closing ||
          tab.saving ||
          tab.loadingMarkdown ||
          tab.loadingAnnotations ||
          tab.pendingAnnotations ||
          !!tab.annotations?.moving,
        revision: tab.markdown?.text ?? JSON.stringify(tab.annotations?.annotations ?? null),
        save: async () => {
          if (!(await tab.save())) throw failure("saveFailed");
        },
      },
    ];
  });
}

const defaultPreparation: SnapshotPreparation = {
  documents: liveDocuments,
  capture: async (root, reason) => (await import("./ResearchHistory")).captureSnapshot(root, reason),
};
const preparing = new Set<string>();

export async function prepareResearchSnapshot(
  root: string,
  reason: SnapshotReason,
  dependencies: SnapshotPreparation = defaultPreparation,
): Promise<ResearchSnapshot> {
  if (!root) throw failure("noRoot");
  if (preparing.has(root)) throw failure("busy");
  preparing.add(root);
  try {
    const documents = await dependencies.documents(root);
    if (documents.some((document) => document.dirty && !document.path)) throw failure("unnamedDraft");
    if (documents.some((document) => document.busy)) throw failure("busy");
    for (const document of documents) if (document.dirty) await document.save();
    const saved = await dependencies.documents(root);
    if (saved.some((document) => document.dirty || document.busy)) throw failure("changed");
    const snapshot = await dependencies.capture(root, reason);
    const after = await dependencies.documents(root);
    if (
      after.length !== saved.length ||
      after.some((document) => {
        const before = saved.find((candidate) => candidate.id === document.id);
        return (
          !before ||
          document.dirty ||
          document.busy ||
          document.path !== before.path ||
          document.revision !== before.revision
        );
      })
    )
      throw failure("changed");
    return snapshot;
  } finally {
    preparing.delete(root);
  }
}

export class HistoryCheckpointScheduler {
  private timer?: ReturnType<typeof setTimeout>;
  private pending = new Map<string, number>();
  private retries = new Map<string, number>();
  private running = false;
  private disposed = false;

  constructor(
    private readonly capture: (root: string) => Promise<void | boolean>,
    private readonly onError: (error: unknown) => void,
    private readonly delay = 30_000,
    private readonly maxDelay = 300_000,
  ) {}

  request(root: string) {
    if (!root || this.disposed) return;
    this.retries.delete(root);
    if (!this.pending.has(root)) this.pending.set(root, Date.now());
    this.arm();
  }

  private arm() {
    if (this.disposed || this.running || !this.pending.size) return;
    clearTimeout(this.timer);
    const oldest = Math.min(...this.pending.values());
    this.timer = setTimeout(
      () => void this.flush(),
      Math.max(0, Math.min(this.delay, oldest + this.maxDelay - Date.now())),
    );
  }

  private async flush() {
    if (this.disposed || this.running) return;
    const roots = [...this.pending.keys()];
    this.pending.clear();
    this.running = true;
    try {
      for (const root of roots) {
        if (this.disposed) break;
        try {
          const captured = await this.capture(root);
          if (captured === false && !this.disposed) {
            const retries = this.retries.get(root) ?? 0;
            if (retries < 3) {
              this.retries.set(root, retries + 1);
              if (!this.pending.has(root)) this.pending.set(root, Date.now());
            }
          } else {
            this.retries.delete(root);
          }
        } catch (error) {
          this.onError(error);
        }
      }
    } finally {
      this.running = false;
      this.arm();
    }
  }

  dispose() {
    this.disposed = true;
    clearTimeout(this.timer);
    this.pending.clear();
    this.retries.clear();
  }
}

export async function startResearchHistoryService(): Promise<() => void> {
  const [{ ResearchFolder, RESEARCH_FILES_CHANGED_EVENT }, { Settings }] = await Promise.all([
    import("./ResearchFolder"),
    import("@/core/service/Settings"),
  ]);
  const scheduler = new HistoryCheckpointScheduler(
    async (root) => {
      if (preparing.has(root)) return false;
      const documents = await liveDocuments(root);
      // History captures saved disk content; unsaved editor changes remain untouched.
      if (documents.some((document) => document.busy)) return false;
      try {
        await defaultPreparation.capture(root, "auto");
      } catch (error) {
        if (
          String(error) === "history.noMaterials" ||
          (error instanceof Error && error.message === "history.noMaterials")
        )
          return;
        if (String(error).includes("history.fileChanged")) return false;
        throw error;
      }
    },
    (error) => {
      const message = error instanceof Error ? error.message : String(error);
      const history = /^(history\.[A-Za-z]+)(?::\s*([\s\S]*))?$/.exec(message);
      const key = `progress.errors.${history?.[1] ?? message}`;
      const translated = i18next.exists(key, { ns: "research" })
        ? `${i18next.t(key, { ns: "research" })}${history?.[2] ? ` ${history[2]}` : ""}`
        : message;
      toast.warning(i18next.t("progress.errors.autoFailed", { ns: "research", error: translated }), {
        id: "research-history-capture-error",
      });
    },
  );
  const current = () => scheduler.request(ResearchFolder.getRoot());
  const saved = (event: Event) => {
    const root = ResearchFolder.getRoot();
    const path = (event as CustomEvent<{ path?: string }>).detail?.path;
    if (root && path && ResearchFolder.isInside(path, root)) scheduler.request(root);
  };
  const visible = () => {
    if (document.visibilityState === "visible") current();
  };
  const unwatch = Settings.watch("researchFolderPath", (root) => scheduler.request(root));
  window.addEventListener(RESEARCH_CONTENT_SAVED_EVENT, saved);
  window.addEventListener(RESEARCH_FILES_CHANGED_EVENT, current);
  window.addEventListener("focus", current);
  document.addEventListener("visibilitychange", visible);
  const timer = setInterval(current, 300_000);
  current();
  return () => {
    clearInterval(timer);
    unwatch();
    scheduler.dispose();
    window.removeEventListener(RESEARCH_CONTENT_SAVED_EVENT, saved);
    window.removeEventListener(RESEARCH_FILES_CHANGED_EVENT, current);
    window.removeEventListener("focus", current);
    document.removeEventListener("visibilitychange", visible);
  };
}
