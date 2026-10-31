import { EventEmitter } from "events";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("@/utils/platform", () => ({ family: () => "unix" }));

vi.mock("@/core/Project", () => ({
  Project: class {},
  service: () => () => {},
  ProjectState: { Saved: "saved", Unsaved: "unsaved" },
}));
vi.mock("@/core/service/Settings", () => ({
  Settings: {
    autoSave: true,
    autoBackup: false,
    autoSaveInterval: 1,
    autoBackupInterval: 1,
    autoBackupStrategy: "sideBySide",
  },
}));
vi.mock("@tauri-apps/api/path", () => ({
  appCacheDir: vi.fn(async () => "/app-cache"),
  join: vi.fn(async (...parts: string[]) => parts.join("/")),
}));
vi.mock("@tauri-apps/plugin-fs", () => ({
  exists: vi.fn(),
  writeFile: vi.fn(),
  readDir: vi.fn(async () => []),
  stat: vi.fn(),
  remove: vi.fn(),
  mkdir: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), dismiss: vi.fn() } }));

import { AutoSaveBackupService, SAVE_AFTER_EDIT_DELAY_MS, SAVE_RETRY_FIRST_DELAY_MS } from "./AutoSaveBackupService";
import { toast } from "sonner";
import { Settings } from "@/core/service/Settings";
import type { Project } from "@/core/Project";
import { writeFile } from "@tauri-apps/plugin-fs";

/** 带 on/off/emit 的假工程，和 Project 一样通过事件通知 stage-commit / state-change */
function fakeProject<T extends object>(fields: T): EventEmitter & T {
  return Object.assign(new EventEmitter(), fields);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  Settings.autoBackup = false;
  Settings.autoSave = true;
});

describe("automatic project persistence", () => {
  it("skips an active manual save and collaborative documents", () => {
    vi.spyOn(Date, "now").mockReturnValue(10000);
    const project = fakeProject({ uri: {}, isSaving: true, projectState: "unsaved", save: vi.fn() });
    const service = new AutoSaveBackupService(project as unknown as Project);
    service.tick();
    expect(project.save).not.toHaveBeenCalled();
    project.isSaving = false;
    Object.assign(project, { isCollab: true });
    service.tick();
    expect(project.save).not.toHaveBeenCalled();
  });

  it("does not start another snapshot or autosave while a backup is pending", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(0);
    Settings.autoBackup = true;
    let finish!: (value: Uint8Array) => void;
    const project = fakeProject({
      uri: { toString: () => "file:///research/test.prg" },
      projectState: "unsaved",
      stageHash: "changed",
      getFileContent: vi.fn(
        () =>
          new Promise<Uint8Array>((resolve) => {
            finish = resolve;
          }),
      ),
      save: vi.fn(),
    });
    const service = new AutoSaveBackupService(project as unknown as Project);
    now.mockReturnValue(2000);
    service.tick();
    await vi.waitFor(() => expect(project.getFileContent).toHaveBeenCalledOnce());
    now.mockReturnValue(5000);
    service.tick();
    expect(project.getFileContent).toHaveBeenCalledOnce();
    expect(project.save).not.toHaveBeenCalled();
    finish(new Uint8Array());
    await vi.waitFor(() => expect((service as unknown as { isBackingUp: boolean }).isBackingUp).toBe(false));
    now.mockReturnValue(8000);
    service.tick();
    await Promise.resolve();
    service.tick();
    expect(project.save).toHaveBeenCalledOnce();
  });

  it("keeps side-by-side backups out of the research folder", async () => {
    vi.mocked(writeFile).mockClear();
    vi.spyOn(Date, "now").mockReturnValue(0);
    Settings.autoBackup = true;
    const project = fakeProject({
      uri: { toString: () => "file:///research/test.prg" },
      projectState: "saved",
      stageHash: "changed",
      getFileContent: vi.fn(async () => new Uint8Array()),
      save: vi.fn(),
    });
    const service = new AutoSaveBackupService(project as unknown as Project);
    vi.spyOn(Date, "now").mockReturnValue(2000);
    service.tick();
    await vi.waitFor(() => expect(writeFile).toHaveBeenCalled());
    const backupPath = vi.mocked(writeFile).mock.calls[0][0] as string;
    expect(backupPath.startsWith("/app-cache/auto-backup-v2/")).toBe(true);
    expect(backupPath).not.toContain("_backup");
  });
});

describe("saving soon after an edit", () => {
  const fileProject = () =>
    fakeProject({
      uri: { toString: () => "file:///research/a.prg" },
      isDraft: false,
      isCollab: false,
      isSaving: false,
      projectState: "unsaved",
      save: vi.fn(async () => {}),
    });

  it("saves once, about five seconds after the last stage commit, without any tick", () => {
    vi.useFakeTimers();
    const project = fileProject();
    new AutoSaveBackupService(project as unknown as Project);
    project.emit("stage-commit");
    vi.advanceTimersByTime(SAVE_AFTER_EDIT_DELAY_MS - 1000);
    project.emit("stage-commit");
    vi.advanceTimersByTime(SAVE_AFTER_EDIT_DELAY_MS - 1000);
    expect(project.save).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(project.save).toHaveBeenCalledExactlyOnceWith({ includeThumbnail: false });
  });

  it("also saves after undo or redo (history-change)", () => {
    vi.useFakeTimers();
    const project = fileProject();
    new AutoSaveBackupService(project as unknown as Project);
    project.emit("history-change");
    vi.advanceTimersByTime(SAVE_AFTER_EDIT_DELAY_MS);
    expect(project.save).toHaveBeenCalledOnce();
  });

  it("schedules a save when the state turns unsaved, but not on repeated unsaved events from isSaving toggles", () => {
    vi.useFakeTimers();
    const project = Object.assign(fileProject(), { projectState: "saved" });
    new AutoSaveBackupService(project as unknown as Project);
    project.emit("state-change", "saved");
    vi.advanceTimersByTime(SAVE_AFTER_EDIT_DELAY_MS);
    expect(project.save).not.toHaveBeenCalled();

    project.projectState = "unsaved";
    project.emit("state-change", "unsaved");
    vi.advanceTimersByTime(SAVE_AFTER_EDIT_DELAY_MS);
    expect(project.save).toHaveBeenCalledOnce();

    project.emit("state-change", "unsaved");
    project.emit("state-change", "unsaved");
    vi.advanceTimersByTime(SAVE_AFTER_EDIT_DELAY_MS * 3);
    expect(project.save).toHaveBeenCalledOnce();
  });

  it("schedules another round when the project is still unsaved after a save (edit during the write)", async () => {
    vi.useFakeTimers();
    const project = fileProject();
    project.save
      .mockImplementationOnce(async () => {})
      .mockImplementation(async () => {
        project.projectState = "saved";
      });
    new AutoSaveBackupService(project as unknown as Project);
    project.emit("stage-commit");
    await vi.advanceTimersByTimeAsync(SAVE_AFTER_EDIT_DELAY_MS);
    expect(project.save).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(SAVE_AFTER_EDIT_DELAY_MS);
    expect(project.save).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(SAVE_AFTER_EDIT_DELAY_MS * 3);
    expect(project.save).toHaveBeenCalledTimes(2);
  });

  it("stops retrying a failing save until there is a new edit or the back-off has passed, and warns once", async () => {
    vi.useFakeTimers();
    vi.mocked(toast.error).mockClear();
    const project = Object.assign(fileProject(), {
      editRevision: 1,
      save: vi.fn(async () => {
        // 和 Project 一样：保存开始和结束时 isSaving 切换，各发一次 state-change(Unsaved)
        project.emit("state-change", "unsaved");
        project.emit("state-change", "unsaved");
        throw new Error("volume unplugged");
      }),
    });
    const service = new AutoSaveBackupService(project as unknown as Project);
    project.emit("stage-commit");
    await vi.advanceTimersByTimeAsync(SAVE_AFTER_EDIT_DELAY_MS);
    expect(project.save).toHaveBeenCalledOnce();
    expect(toast.error).toHaveBeenCalledOnce();

    // 没有新编辑：5 秒定时器不再重排，tick 也在退避期内跳过
    await vi.advanceTimersByTimeAsync(SAVE_AFTER_EDIT_DELAY_MS * 4);
    service.tick();
    await vi.advanceTimersByTimeAsync(0);
    expect(project.save).toHaveBeenCalledOnce();

    // 退避期过了，tick 会再试一次，仍失败也不再弹第二条提示
    await vi.advanceTimersByTimeAsync(SAVE_RETRY_FIRST_DELAY_MS);
    service.tick();
    await vi.advanceTimersByTimeAsync(0);
    expect(project.save).toHaveBeenCalledTimes(2);
    expect(toast.error).toHaveBeenCalledOnce();

    // 有新编辑就照常在 5 秒后保存
    project.editRevision = 2;
    project.emit("stage-commit");
    await vi.advanceTimersByTimeAsync(SAVE_AFTER_EDIT_DELAY_MS);
    expect(project.save).toHaveBeenCalledTimes(3);

    project.save.mockImplementation(async () => {});
    project.editRevision = 3;
    project.emit("stage-commit");
    await vi.advanceTimersByTimeAsync(SAVE_AFTER_EDIT_DELAY_MS);
    expect(project.save).toHaveBeenCalledTimes(4);
    expect(toast.dismiss).toHaveBeenCalledWith("research-autosave-failed:file:///research/a.prg");
  });

  it("waits for a running save instead of starting a second one", () => {
    vi.useFakeTimers();
    const project = fileProject();
    project.isSaving = true;
    new AutoSaveBackupService(project as unknown as Project);
    project.emit("stage-commit");
    vi.advanceTimersByTime(SAVE_AFTER_EDIT_DELAY_MS);
    expect(project.save).not.toHaveBeenCalled();
    project.isSaving = false;
    vi.advanceTimersByTime(SAVE_AFTER_EDIT_DELAY_MS);
    expect(project.save).toHaveBeenCalledOnce();
  });

  it("does nothing when autosave is off, after dispose, or outside the research shell", () => {
    vi.useFakeTimers();
    Settings.autoSave = false;
    const disabled = fileProject();
    new AutoSaveBackupService(disabled as unknown as Project);
    disabled.emit("stage-commit");
    vi.advanceTimersByTime(SAVE_AFTER_EDIT_DELAY_MS);
    expect(disabled.save).not.toHaveBeenCalled();

    Settings.autoSave = true;
    const disposed = fileProject();
    const service = new AutoSaveBackupService(disposed as unknown as Project);
    disposed.emit("stage-commit");
    service.dispose();
    vi.advanceTimersByTime(SAVE_AFTER_EDIT_DELAY_MS);
    expect(disposed.save).not.toHaveBeenCalled();

    vi.stubEnv("LR_RESEARCH_SHELL", "false");
    const upstream = fileProject();
    new AutoSaveBackupService(upstream as unknown as Project);
    upstream.emit("stage-commit");
    vi.advanceTimersByTime(SAVE_AFTER_EDIT_DELAY_MS);
    expect(upstream.save).not.toHaveBeenCalled();
  });

  it("never saves drafts from the timer", () => {
    vi.useFakeTimers();
    const draft = Object.assign(fileProject(), { isDraft: true });
    new AutoSaveBackupService(draft as unknown as Project);
    draft.emit("stage-commit");
    vi.advanceTimersByTime(SAVE_AFTER_EDIT_DELAY_MS);
    expect(draft.save).not.toHaveBeenCalled();
  });
});
