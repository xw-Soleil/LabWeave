import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  opened: vi.fn(async () => {}),
  exported: vi.fn(),
  toastError: vi.fn(),
}));
vi.mock("@/state", async () => ({ store: (await import("jotai")).createStore() }));
vi.mock("@tauri-apps/plugin-shell", () => ({ open: async () => {} }));
vi.mock("i18next", () => ({
  default: {
    exists: (key: string) => key === "report.errors.network" || key === "report.errors.exportFailed",
    t: (key: string) => `「${key}」`,
  },
}));
vi.mock("sonner", () => ({ toast: { error: mocks.toastError } }));
vi.mock("./DocumentTab", () => ({ openDocumentFile: mocks.opened }));
vi.mock("./ResearchReport", () => ({ retryResearchReportExport: mocks.exported }));

import { store } from "@/state";
import { reportBusy, reportErrorText, reportTaskAtom, retryReportTask, startReportTask } from "./ReportTask";

const root = "/research/课题";
const result = {
  jobId: "job-1",
  directory: `${root}/汇报/2026-11-21 组会`,
  markdownPath: `${root}/汇报/2026-11-21 组会/报告.md`,
  pptxPath: `${root}/汇报/2026-11-21 组会/汇报.pptx`,
  warnings: [],
};
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));
const task = () => store.get(reportTaskAtom)!;

beforeEach(() => {
  vi.clearAllMocks();
  store.set(reportTaskAtom, null);
});

describe("a report being generated in the background", () => {
  it("shows progress while it runs, then opens the report when it is done", async () => {
    let finish!: (value: typeof result) => void;
    const onDone = vi.fn();
    const started = startReportTask({
      root,
      title: "2026-11-21 组会",
      run: (_signal, onProgress) => {
        onProgress({ stage: "analyzing" });
        return new Promise((resolve) => (finish = resolve));
      },
      onDone,
    });
    expect(started).toBe(true);
    expect(task()).toMatchObject({ state: "running", title: "2026-11-21 组会", progress: { stage: "analyzing" } });
    expect(reportBusy()).toBe(true);
    // 同一时间只生成一份
    expect(startReportTask({ root, title: "另一份", run: async () => result })).toBe(false);
    expect(task().title).toBe("2026-11-21 组会");

    finish(result);
    await settled();
    expect(task()).toMatchObject({ state: "done", result });
    expect(reportBusy()).toBe(false);
    expect(onDone).toHaveBeenCalledWith(result);
    expect(mocks.opened).toHaveBeenCalledWith(result.markdownPath);
  });

  it("says why it failed, in words when the error is one of ours", async () => {
    startReportTask({
      root,
      title: "2026-11-21 组会",
      run: async () => {
        throw new Error("researchReport.network");
      },
    });
    await settled();
    expect(task()).toMatchObject({ state: "failed", error: "「report.errors.network」" });
    expect(task().retryJobId).toBeUndefined();
    expect(mocks.opened).not.toHaveBeenCalled();
    expect(reportErrorText(new Error("别的什么错"))).toBe("别的什么错");
    expect(reportErrorText(new Error("researchReport.没有这条文案"))).toBe("researchReport.没有这条文案");
  });

  it("is cancelled without opening anything, even if the work finishes afterwards", async () => {
    const onDone = vi.fn();
    let finish!: (value: typeof result) => void;
    startReportTask({
      root,
      title: "2026-11-21 组会",
      run: () => new Promise((resolve) => (finish = resolve)),
      onDone,
    });
    task().cancel();
    finish(result);
    await settled();
    expect(task().state).toBe("cancelled");
    expect(onDone).not.toHaveBeenCalled();
    expect(mocks.opened).not.toHaveBeenCalled();
  });

  it("leaves a closed bar alone when the old work reports back", async () => {
    let finish!: (value: typeof result) => void;
    startReportTask({ root, title: "2026-11-21 组会", run: () => new Promise((resolve) => (finish = resolve)) });
    task().cancel();
    await settled();
    store.set(reportTaskAtom, null);
    finish(result);
    await settled();
    expect(store.get(reportTaskAtom)).toBeNull();
  });

  it("exports again from the saved draft when only the export failed", async () => {
    startReportTask({
      root,
      title: "2026-11-21 组会",
      run: async () => {
        throw Object.assign(new Error("researchReport.exportFailed"), { jobId: "job-1" });
      },
    });
    await settled();
    expect(task()).toMatchObject({ state: "failed", retryJobId: "job-1" });

    mocks.exported.mockResolvedValue(result);
    expect(retryReportTask(task())).toBe(true);
    expect(task()).toMatchObject({ state: "running", progress: { stage: "exporting" }, error: undefined });
    await settled();
    expect(mocks.exported).toHaveBeenCalledWith(root, "job-1", expect.any(AbortSignal));
    expect(task()).toMatchObject({ state: "done", result, title: "2026-11-21 组会" });
    expect(task().retryJobId).toBeUndefined();
    expect(mocks.opened).toHaveBeenCalledWith(result.markdownPath);
    // 没有草稿可用的不能重新导出
    expect(retryReportTask(task())).toBe(false);
  });
});
