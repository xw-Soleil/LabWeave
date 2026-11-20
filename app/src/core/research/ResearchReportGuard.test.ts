import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ tabs: [] as object[], invoke: vi.fn(), readFile: vi.fn(), writeFile: vi.fn() }));
vi.mock("@/state", () => ({ store: { get: () => mocks.tabs }, tabsAtom: {} }));
vi.mock("@/core/Project", () => ({ Project: class Project {}, ProjectState: { Saved: "saved", Unsaved: "unsaved" } }));
vi.mock("./DocumentTab", () => ({ DocumentTab: class DocumentTab {} }));
vi.mock("./DocumentFile", () => ({ documentKey: (path: string) => path.replace(/\\/g, "/").toLowerCase() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/plugin-fs", () => ({ readFile: mocks.readFile, writeFile: mocks.writeFile }));
vi.mock("./ResearchHistory", () => {
  throw new Error("Weekly material checks must not load history");
});

import { Project, ProjectState } from "@/core/Project";
import { DocumentTab } from "./DocumentTab";
import { generateWeeklyResearchReport } from "./ResearchReport";

const weekStart = "2026-11-16";
const path = `进展记录/周进展/${weekStart}.md`;
const options = { root: "D:/project", weekStart };
const record = { weekStart, path, revision: "saved-revision", markdown: "# 周进展\n\n## 本周进展\n" };

function document(relative: string, flags: Partial<DocumentTab>) {
  const tab = Object.create(DocumentTab.prototype) as DocumentTab;
  return Object.assign(tab, { path: `D:/project/${relative}`, hasUnsavedChanges: false }, flags);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.tabs = [];
  mocks.invoke.mockResolvedValue(record);
});

describe("saved weekly report materials", () => {
  it.each([{ hasUnsavedChanges: true }, { saving: true }, { loadingMarkdown: true }, { closing: true }])(
    "rejects an unsaved or busy selected weekly note before disk collection: %j",
    async (flags) => {
      mocks.tabs = [document(path, flags)];
      await expect(generateWeeklyResearchReport(options)).rejects.toThrow(`researchReport.materialUnsaved: ${path}`);
      expect(mocks.invoke).not.toHaveBeenCalled();
      expect(mocks.readFile).not.toHaveBeenCalled();
      expect(mocks.writeFile).not.toHaveBeenCalled();
    },
  );

  it("ignores unrelated unsaved tabs and matches selected paths across Windows casing", async () => {
    mocks.tabs = [document("unrelated.md", { hasUnsavedChanges: true })];
    await expect(generateWeeklyResearchReport(options)).rejects.toThrow("researchReport.noMaterials");
    expect(mocks.invoke).toHaveBeenCalledWith("load_weekly_progress", { root: options.root, weekStart });
    mocks.tabs = [
      Object.assign(document(path, { hasUnsavedChanges: true }), { path: `d:\\PROJECT\\${path.replace(/\//g, "\\")}` }),
    ];
    await expect(generateWeeklyResearchReport(options)).rejects.toThrow("researchReport.materialUnsaved");
    expect(mocks.invoke).toHaveBeenCalledOnce();
  });

  it("rejects an unsaved directly linked note instead of treating it as optional missing material", async () => {
    mocks.invoke.mockResolvedValue({ ...record, markdown: "# 周进展\n## 本周进展\n- 阅读了[方法笔记](../../note.md)" });
    mocks.tabs = [document("note.md", { hasUnsavedChanges: true })];
    await expect(generateWeeklyResearchReport(options)).rejects.toThrow("researchReport.materialUnsaved: note.md");
    expect(mocks.readFile).not.toHaveBeenCalled();
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  it.each(["hasUnsavedChanges", "saving", "loadingAnnotations", "pendingAnnotations", "moving"])(
    "rejects linked PDF annotation state %s before reading the saved sidecar",
    async (flag) => {
      mocks.invoke.mockResolvedValue({
        ...record,
        markdown: "# 周进展\n## 本周进展\n- 阅读了[论文](../../paper.pdf#page=3)",
      });
      const tab = document("paper.pdf", {});
      Object.assign(tab, flag === "moving" ? { annotations: { moving: true } } : { [flag]: true });
      mocks.tabs = [tab];
      await expect(generateWeeklyResearchReport(options)).rejects.toThrow("researchReport.materialUnsaved: paper.pdf");
      expect(mocks.readFile).not.toHaveBeenCalled();
      expect(mocks.writeFile).not.toHaveBeenCalled();
    },
  );

  it.each(["unsaved", "saving", "mutation", "closing"])(
    "rejects linked canvas state %s without saving any project",
    async (state) => {
      mocks.invoke.mockResolvedValue({
        ...record,
        markdown: "# 周进展\n## 本周进展\n- 整理了[画布](../../board.prg#node=one)",
      });
      const tab = Object.create(Project.prototype) as Project;
      Object.assign(tab, {
        uri: { scheme: "file", fsPath: "D:/project/board.prg" },
        projectState: state === "unsaved" ? ProjectState.Unsaved : ProjectState.Saved,
        isSaving: state === "saving",
        fileMutationInProgress: state === "mutation",
        closing: state === "closing",
        save: vi.fn(),
      });
      mocks.tabs = [tab];
      await expect(generateWeeklyResearchReport(options)).rejects.toThrow("researchReport.materialUnsaved: board.prg");
      expect(tab.save).not.toHaveBeenCalled();
      expect(mocks.readFile).not.toHaveBeenCalled();
      expect(mocks.writeFile).not.toHaveBeenCalled();
    },
  );
});
