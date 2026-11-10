import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  PdfAnnotationStore,
  annotationPathHash,
  annotationTarget,
  moveDocumentAnnotations,
  type AnnotationIO,
  type AnnotationSnapshot,
  type AnnotationTarget,
} from "./PdfAnnotationStore";
import { newAnnotation, annotationColors } from "./PdfAnnotations";

const mocks = vi.hoisted(() => ({
  tabs: [] as unknown[],
  invoke: vi.fn(),
  root: "/project",
  projects: ["/project", "/other"],
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@/state", () => ({ store: { get: () => mocks.tabs }, tabsAtom: {} }));
vi.mock("./ResearchFolder", () => ({
  ResearchFolder: {
    getRoot: () => mocks.root,
    ensureRootRegistered: async () => {},
    isInside: (path: string, root = mocks.root) => path.startsWith(root + "/"),
    toRelative: (path: string, root: string) => path.slice(root.length + 1),
  },
}));
vi.mock("./ResearchWorkspace", () => ({
  activeResearchWorkspace: (value: unknown) => value,
  loadResearchWorkspace: async () => ({ projects: mocks.projects.map((path) => ({ path })) }),
  authorizeResearchProject: async (path: string) => path,
}));
vi.mock("./DocumentTab", () => ({
  DocumentTab: class {
    kind = "pdf";
    closing = false;
    path = "/project/p.pdf";
    annotations?: PdfAnnotationStore;
    changed = vi.fn();
    loadAnnotations = vi.fn();
    save = vi.fn(async () => {
      await this.annotations?.save();
      return true;
    });
    rebindPath(path: string) {
      this.path = path;
    }
  },
}));
import { DocumentTab } from "./DocumentTab";

const target: AnnotationTarget = { kind: "external", pathKey: "a".repeat(64) };
const item = () =>
  newAnnotation(
    "note",
    annotationColors.yellow,
    { pageIndex: 0, rects: [[10, 20, 32, 42]] },
    { index: 0, size: { width: 600, height: 800 }, rotation: 0, objectNumber: 1 },
    { runs: [] },
  );
const empty = (): AnnotationSnapshot => ({ annotations: [], revision: null });

beforeEach(() => {
  mocks.tabs = [];
  mocks.root = "/project";
  mocks.invoke.mockReset();
  mocks.invoke.mockImplementation(async (command, args) =>
    command === "authorize_research_project" ? args.path : empty(),
  );
});

describe("annotation JSON sessions", () => {
  it("accepts Rust JSON key ordering when verifying a saved snapshot", async () => {
    const io: AnnotationIO = {
      load: vi.fn(),
      move: vi.fn(),
      save: vi.fn(async (_target, _revision, annotations) => ({
        annotations: JSON.parse(
          JSON.stringify(annotations, (_key, value) =>
            value && typeof value === "object" && !Array.isArray(value)
              ? Object.fromEntries(
                  Object.keys(value)
                    .sort()
                    .map((key) => [key, value[key]]),
                )
              : value,
          ),
        ),
        revision: "saved",
      })),
    };
    const model = new PdfAnnotationStore(target, empty(), io);
    model.change([item()]);
    await model.save();
    expect(model.dirty).toBe(false);
    expect(io.save).toHaveBeenCalledOnce();
  });

  it("serializes in-flight edits, preserves history across saves and saves undo/redo", async () => {
    let release!: () => void;
    const saved: unknown[] = [];
    const io: AnnotationIO = {
      load: vi.fn(),
      move: vi.fn(),
      save: vi.fn(async (_target, revision, annotations) => {
        saved.push({ revision, annotations });
        if (saved.length === 1)
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        return { annotations, revision: String(saved.length) };
      }),
    };
    const store = new PdfAnnotationStore(target, empty(), io);
    const note = item();
    store.change([note]);
    const saving = store.save();
    store.change([{ ...note, comment: "while saving" }]);
    expect(store.save()).toBe(saving);
    release();
    await saving;
    expect(saved).toHaveLength(2);
    expect(store.dirty).toBe(false);
    store.undo();
    expect(store.annotations[0].comment).toBe("");
    expect(store.dirty).toBe(true);
    store.redo();
    expect(store.annotations[0].comment).toBe("while saving");
    expect(store.dirty).toBe(false);
    store.undo();
    store.undo();
    await store.save();
    expect(store.annotations).toEqual([]);
    expect(store.dirty).toBe(false);
  });

  it("keeps edits after a conflict and never retries with the other writer's revision", async () => {
    const io: AnnotationIO = {
      load: vi.fn(),
      move: vi.fn(),
      save: vi.fn().mockRejectedValue(new Error("annotationChanged")),
    };
    const store = new PdfAnnotationStore(target, { annotations: [], revision: "initial" }, io);
    const note = item();
    store.change([note]);
    await expect(store.save()).rejects.toThrow("annotationChanged");
    await expect(store.save()).rejects.toThrow("annotationChanged");
    expect(store.annotations).toEqual([note]);
    expect(store.dirty).toBe(true);
    expect(io.save).toHaveBeenLastCalledWith(target, "initial", [note]);
  });

  it("protects read-only entries and edits made during reload", async () => {
    let resolve!: (value: AnnotationSnapshot) => void;
    const io: AnnotationIO = {
      load: vi.fn(
        () =>
          new Promise<AnnotationSnapshot>((done) => {
            resolve = done;
          }),
      ),
      move: vi.fn(),
      save: vi.fn(),
    };
    const note = { ...item(), readOnly: true };
    const store = new PdfAnnotationStore(target, { annotations: [note], revision: "one" }, io);
    expect(() => store.change([])).toThrow("annotationReadOnly");
    const reload = store.reload();
    const added = item();
    store.change([note, added]);
    resolve(empty());
    await expect(reload).rejects.toThrow("editsDuringReload");
    expect(store.annotations).toEqual([note, added]);
  });

  it("uses project relative paths and normalized external Windows path hashes", async () => {
    expect(await annotationTarget("/project/论文/p.pdf")).toEqual({
      kind: "project",
      rootKey: await annotationPathHash("/project"),
      relativePath: "论文/p.pdf",
    });
    expect(await annotationTarget("/other/p.pdf")).toEqual({
      kind: "project",
      rootKey: await annotationPathHash("/other"),
      relativePath: "p.pdf",
    });
    expect(await annotationTarget("C:\\Outside\\Paper.pdf")).toEqual(await annotationTarget("c:/outside/PAPER.pdf"));
    expect(await annotationTarget("/outside/Paper.pdf")).not.toEqual(await annotationTarget("/outside/paper.pdf"));
    expect(await annotationTarget("/project/.workbench/trash/12345678-1234-1234-1234-123456789012/p.pdf")).toEqual({
      kind: "trash",
      rootKey: await annotationPathHash("/project"),
      entryId: "12345678-1234-1234-1234-123456789012",
    });
  });

  it("moves saved annotations before the PDF, rebinds open tabs, and rolls back failures", async () => {
    const io: AnnotationIO = { load: vi.fn(), move: vi.fn().mockResolvedValue(undefined), save: vi.fn() };
    const before = await annotationTarget("/project/p.pdf");
    const model = new PdfAnnotationStore(before, { annotations: [item()], revision: "v1" }, io);
    const tab = new DocumentTab("/project/p.pdf", "pdf");
    tab.annotations = model;
    mocks.tabs = [tab];
    const operation = vi.fn(async () => {
      expect(model.moving).toBe(true);
      expect(io.move).toHaveBeenCalledOnce();
    });
    await moveDocumentAnnotations(tab.path, "/project/new.pdf", operation);
    expect(tab.path).toBe("/project/new.pdf");
    expect(model.target).toEqual(await annotationTarget(tab.path));
    expect(model.moving).toBe(false);
    const failed = vi.fn(async () => {
      throw new Error("disk failure");
    });
    await expect(moveDocumentAnnotations(tab.path, "/project/again.pdf", failed)).rejects.toThrow("disk failure");
    expect(tab.path).toBe("/project/new.pdf");
    expect(model.target).toEqual(await annotationTarget(tab.path));
    expect(model.moving).toBe(false);
    expect(io.move).toHaveBeenCalledTimes(3);
  });

  it("keeps the PDF in place on annotation conflict and uses the same trash sidecar on restore", async () => {
    const op = vi.fn().mockResolvedValue(undefined);
    const entryId = "12345678-1234-1234-1234-123456789012";
    await moveDocumentAnnotations("/project/p.pdf", `/project/.workbench/trash/${entryId}/p.pdf`, op, { entryId });
    const trash = { kind: "trash", rootKey: await annotationPathHash("/project"), entryId };
    expect(mocks.invoke).toHaveBeenCalledWith("move_pdf_annotations", {
      from: await annotationTarget("/project/p.pdf"),
      to: trash,
      expected: null,
    });
    await moveDocumentAnnotations(`/project/.workbench/trash/${entryId}/p.pdf`, "/project/p.pdf", op, {
      entryId,
      restoring: true,
    });
    expect(mocks.invoke).toHaveBeenCalledWith("load_pdf_annotations", { target: trash });
    mocks.invoke.mockImplementation(async (command, args) => {
      if (command === "authorize_research_project") return args.path;
      if (command === "move_pdf_annotations") throw new Error("annotationChanged");
      return empty();
    });
    op.mockClear();
    await expect(moveDocumentAnnotations("/project/p.pdf", "/project/new.pdf", op)).rejects.toThrow(
      "annotationChanged",
    );
    expect(op).not.toHaveBeenCalled();
  });

  it("keeps the captured project when the active root changes during authorization", async () => {
    mocks.invoke.mockImplementationOnce(async (_command, args) => {
      mocks.root = "/other";
      return args.path;
    });
    expect(await annotationTarget("/project/p.pdf")).toEqual({
      kind: "project",
      rootKey: await annotationPathHash("/project"),
      relativePath: "p.pdf",
    });
  });

  it("blocks further edits when a failed PDF move cannot roll its sidecar back", async () => {
    const io: AnnotationIO = {
      load: vi.fn(),
      save: vi.fn(),
      move: vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("disk failure")),
    };
    const model = new PdfAnnotationStore(
      await annotationTarget("/project/p.pdf"),
      { annotations: [item()], revision: "v1" },
      io,
    );
    const tab = new DocumentTab("/project/p.pdf", "pdf");
    tab.annotations = model;
    mocks.tabs = [tab];
    await expect(
      moveDocumentAnnotations(tab.path, "/project/new.pdf", async () => {
        throw new Error("PDF move failed");
      }),
    ).rejects.toThrow("annotationRollbackFailed");
    expect(tab.path).toBe("/project/p.pdf");
    expect(model.moving).toBe(false);
    expect(() => model.change([])).toThrow("annotationRollbackFailed");
    await expect(model.save()).rejects.toThrow("annotationRollbackFailed");
    expect(io.save).not.toHaveBeenCalled();
  });
});
