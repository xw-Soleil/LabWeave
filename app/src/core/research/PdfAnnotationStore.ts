import { invoke } from "@tauri-apps/api/core";
import { documentKey } from "./DocumentFile";
import { parseAnnotations, sortedAnnotations, type PdfAnnotation } from "./PdfAnnotations";

export type AnnotationTarget =
  | { kind: "project"; rootKey: string; relativePath: string }
  | { kind: "external"; pathKey: string }
  | { kind: "trash"; rootKey: string; entryId: string };
export interface AnnotationSnapshot {
  annotations: PdfAnnotation[];
  revision: string | null;
}
export interface AnnotationIO {
  load(target: AnnotationTarget): Promise<AnnotationSnapshot>;
  save(target: AnnotationTarget, expected: string | null, annotations: PdfAnnotation[]): Promise<AnnotationSnapshot>;
  move(from: AnnotationTarget, to: AnnotationTarget, expected: string | null): Promise<void>;
}
export const annotationIO: AnnotationIO = {
  load: (target) => invoke("load_pdf_annotations", { target }),
  save: (target, expected, annotations) => invoke("save_pdf_annotations", { target, expected, annotations }),
  move: (from, to, expected) => invoke("move_pdf_annotations", { from, to, expected }),
};

export async function annotationPathHash(path: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(path));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function annotationTarget(path: string): Promise<AnnotationTarget> {
  const { ResearchFolder } = await import("./ResearchFolder");
  const { activeResearchWorkspace, loadResearchWorkspace, authorizeResearchProject } =
    await import("./ResearchWorkspace");
  const projects = activeResearchWorkspace(await loadResearchWorkspace()).projects.map((project) => project.path);
  const current = ResearchFolder.getRoot();
  if (current && !projects.includes(current)) projects.push(current);
  const root = projects.filter((root) => ResearchFolder.isInside(path, root)).sort((a, b) => b.length - a.length)[0];
  if (!root) return { kind: "external", pathKey: await annotationPathHash(documentKey(path)) };
  let registered: string;
  if (root === current) {
    await ResearchFolder.ensureRootRegistered();
    registered = ResearchFolder.getRoot();
  } else registered = await authorizeResearchProject(root);
  return {
    kind: "project",
    rootKey: await annotationPathHash(registered),
    relativePath: ResearchFolder.toRelative(path, root),
  };
}

type Change = { before: PdfAnnotation[]; after: PdfAnnotation[] };

function serialized(annotations: PdfAnnotation[]) {
  // Rust's JSON maps reorder object keys; compare content independently of transport key order.
  return JSON.stringify(sortedAnnotations(annotations), (_key, value) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, value[key]]),
        )
      : value,
  );
}

export class PdfAnnotationStore {
  annotations: PdfAnnotation[];
  moving = false;
  private saved: string;
  private revision: string | null;
  private saving?: Promise<void>;
  private past: Change[] = [];
  private future: Change[] = [];

  constructor(
    public target: AnnotationTarget,
    snapshot: AnnotationSnapshot,
    private readonly io: AnnotationIO = annotationIO,
  ) {
    this.annotations = parseAnnotations(snapshot.annotations);
    this.saved = serialized(this.annotations);
    this.revision = snapshot.revision;
  }
  get dirty() {
    return serialized(this.annotations) !== this.saved;
  }
  get canUndo() {
    return !this.moving && this.past.length > 0;
  }
  get canRedo() {
    return !this.moving && this.future.length > 0;
  }

  change(after: PdfAnnotation[]) {
    if (this.moving) throw new Error("annotationBusy");
    const next = parseAnnotations(after);
    if (JSON.stringify(next) === JSON.stringify(this.annotations)) return;
    for (const item of this.annotations.filter((item) => item.readOnly)) {
      if (JSON.stringify(next.find((next) => next.id === item.id)) !== JSON.stringify(item))
        throw new Error("annotationReadOnly");
    }
    this.past.push({ before: this.annotations, after: next });
    if (this.past.length > 100) this.past.shift();
    this.future = [];
    this.annotations = next;
  }
  undo() {
    if (!this.canUndo) return;
    const change = this.past.pop()!;
    this.future.push(change);
    this.annotations = change.before;
  }
  redo() {
    if (!this.canRedo) return;
    const change = this.future.pop()!;
    this.past.push(change);
    this.annotations = change.after;
  }
  save(): Promise<void> {
    if (this.moving) return Promise.reject(new Error("annotationBusy"));
    if (this.saving) return this.saving;
    this.saving = (async () => {
      while (this.dirty) {
        const annotations = sortedAnnotations(this.annotations);
        const submitted = serialized(annotations);
        const snapshot = await this.io.save(this.target, this.revision, annotations);
        if (serialized(parseAnnotations(snapshot.annotations)) !== submitted) throw new Error("annotationChanged");
        this.revision = snapshot.revision;
        this.saved = submitted;
      }
    })().finally(() => {
      this.saving = undefined;
    });
    return this.saving;
  }
  async reload() {
    if (this.saving || this.moving) throw new Error("annotationBusy");
    const before = this.annotations;
    const snapshot = await this.io.load(this.target);
    if (before !== this.annotations) throw new Error("editsDuringReload");
    this.annotations = parseAnnotations(snapshot.annotations);
    this.saved = serialized(this.annotations);
    this.revision = snapshot.revision;
    this.past = [];
    this.future = [];
  }
  async move(to: AnnotationTarget) {
    if (this.saving || this.dirty) throw new Error("annotationBusy");
    await this.io.move(this.target, to, this.revision);
    this.target = to;
  }
}

export async function loadAnnotationStore(path: string) {
  const target = await annotationTarget(path);
  return new PdfAnnotationStore(target, await annotationIO.load(target));
}

export async function moveDocumentAnnotations(
  oldPath: string,
  newPath: string,
  operation: () => Promise<void>,
  trash?: { entryId: string; restoring?: boolean },
) {
  if (!/\.pdf$/i.test(oldPath)) return operation();
  const { DocumentTab } = await import("./DocumentTab");
  const { store, tabsAtom } = await import("@/state");
  const tabs = store
    .get(tabsAtom)
    .filter(
      (tab): tab is InstanceType<typeof DocumentTab> =>
        tab instanceof DocumentTab && tab.kind === "pdf" && documentKey(tab.path) === documentKey(oldPath),
    );
  if (tabs.some((tab) => tab.closing || tab.annotations?.moving)) throw new Error("annotationBusy");
  for (const tab of tabs) {
    await tab.loadAnnotations();
    if (!tab.annotations || !(await tab.save())) throw new Error("annotationWriteFailed");
  }
  const projectTarget = await annotationTarget(trash?.restoring ? newPath : oldPath);
  if (trash && projectTarget.kind !== "project") throw new Error("annotationLocation");
  const trashTarget: AnnotationTarget | undefined =
    trash && projectTarget.kind === "project"
      ? { kind: "trash", rootKey: projectTarget.rootKey, entryId: trash.entryId }
      : undefined;
  const from = trash?.restoring ? trashTarget! : projectTarget;
  const to = trash && !trash.restoring ? trashTarget! : await annotationTarget(newPath);
  const annotations = tabs[0]?.annotations ?? new PdfAnnotationStore(from, await annotationIO.load(from));
  const stores = new Set([annotations, ...tabs.flatMap((tab) => (tab.annotations ? [tab.annotations] : []))]);
  for (const item of stores) item.moving = true;
  tabs.forEach((tab) => tab.changed());
  let moved = false;
  try {
    await annotations.move(to);
    moved = true;
    await operation();
    for (const tab of tabs) {
      tab.annotations!.target = to;
      tab.rebindPath(newPath);
    }
  } catch (error) {
    if (moved) {
      try {
        await annotations.move(from);
      } catch (rollback) {
        throw new AggregateError([error, rollback], "annotationRollbackFailed", { cause: rollback });
      }
    }
    throw error;
  } finally {
    for (const item of stores) item.moving = false;
    tabs.forEach((tab) => tab.changed());
  }
}
