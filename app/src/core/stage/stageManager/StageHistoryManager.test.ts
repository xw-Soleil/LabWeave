import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const settings = vi.hoisted(() => ({
  unwatch: vi.fn(),
  watch: vi.fn(),
}));

vi.mock("@/core/Project", () => ({
  Project: class Project {},
  ProjectState: { Saved: "saved", Unsaved: "unsaved" },
  service: (id: string) => (target: { id?: string }) => {
    target.id = id;
    return target;
  },
}));
vi.mock("@/core/service/Settings", () => ({
  Settings: {
    historyManagerMode: "memoryEfficient",
    historySize: 100,
    showDebug: false,
    watch: settings.watch,
  },
}));
vi.mock("@graphif/serializer", () => ({
  serialize: (value: unknown) => structuredClone(value),
  deserialize: (value: unknown) => structuredClone(value),
}));

import { HistoryManager } from "./StageHistoryManager";

describe("HistoryManager cleanup", () => {
  it("undoes nested gesture edits in a single step", () => {
    const project = {
      stage: [{ text: "before" }],
      emit: vi.fn(),
      projectState: "saved",
      stageManager: { updateReferences: vi.fn() },
    };
    const manager = new HistoryManager(project as never);
    manager.batch(() => {
      project.stage[0].text = "middle";
      manager.recordStep();
      manager.batch(() => {
        project.stage[0].text = "after";
        manager.recordStep();
      });
    });
    expect(project.emit).toHaveBeenCalledTimes(1);
    manager.undo();
    expect(project.stage).toEqual([{ text: "before" }]);
    manager.redo();
    expect(project.stage).toEqual([{ text: "after" }]);
  });

  it("keeps renamed file references valid after undo and redo", () => {
    const project = {
      stage: [{ sourcePath: "old.pdf", text: "before" }],
      emit: vi.fn(),
      projectState: "saved",
      stageManager: { updateReferences: vi.fn() },
    };
    const manager = new HistoryManager(project as never);
    project.stage[0].text = "after";
    manager.recordStep();
    manager.rewriteSnapshots((stage) => {
      for (const card of stage as { sourcePath: string }[]) card.sourcePath = "new.pdf";
    });
    manager.undo();
    expect(project.stage).toEqual([{ sourcePath: "new.pdf", text: "before" }]);
    manager.redo();
    expect(project.stage).toEqual([{ sourcePath: "new.pdf", text: "after" }]);
  });
  beforeEach(() => {
    settings.unwatch.mockReset();
    settings.watch.mockReset().mockImplementation((_key, callback) => {
      callback("memoryEfficient");
      return settings.unwatch;
    });
  });

  it("unsubscribes from Settings when the acquired service is disposed", () => {
    const manager = new HistoryManager({ stage: [], emit: vi.fn(), projectState: "saved" } as never);
    const dispose = (manager as unknown as { dispose?: () => void }).dispose;

    expect(dispose).toBeTypeOf("function");
    dispose?.call(manager);
    expect(settings.unwatch).toHaveBeenCalledOnce();
  });
});

describe("undo and redo after the project was saved", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /** 模拟「编辑一步 → 自动保存把状态改成已保存」之后的工程 */
  function savedProjectWithOneStep(mode: "memoryEfficient" | "timeEfficient") {
    settings.watch.mockReset().mockImplementation((_key, callback) => {
      callback(mode);
      return settings.unwatch;
    });
    const project = {
      stage: [{ text: "a" }] as unknown[],
      projectState: "saved",
      emit: vi.fn(),
      stageManager: { updateReferences: vi.fn() },
    };
    const manager = new HistoryManager(project as never);
    project.stage = [{ text: "a" }, { text: "b" }];
    manager.recordStep();
    expect(project.projectState).toBe("unsaved");
    project.projectState = "saved";
    project.emit.mockClear();
    return { project, manager };
  }

  it.each(["memoryEfficient", "timeEfficient"] as const)(
    "marks the project unsaved and emits history-change so autosave writes the restored stage (%s)",
    (mode) => {
      const { project, manager } = savedProjectWithOneStep(mode);
      manager.undo();
      expect(project.stage).toHaveLength(1);
      expect(project.projectState).toBe("unsaved");
      expect(project.emit).toHaveBeenCalledWith("history-change");

      project.projectState = "saved";
      project.emit.mockClear();
      manager.redo();
      expect(project.stage).toHaveLength(2);
      expect(project.projectState).toBe("unsaved");
      expect(project.emit).toHaveBeenCalledWith("history-change");
    },
  );

  it("leaves the state alone when there is nothing to redo", () => {
    const { project, manager } = savedProjectWithOneStep("memoryEfficient");
    manager.redo();
    expect(project.projectState).toBe("saved");
    expect(project.emit).not.toHaveBeenCalled();
  });

  it("keeps upstream behaviour outside the research shell", () => {
    vi.stubEnv("LR_RESEARCH_SHELL", "false");
    const { project, manager } = savedProjectWithOneStep("memoryEfficient");
    manager.undo();
    expect(project.stage).toHaveLength(1);
    expect(project.projectState).toBe("saved");
    expect(project.emit).not.toHaveBeenCalled();
  });
});
