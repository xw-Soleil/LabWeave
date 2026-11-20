// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResearchReportResult } from "./ResearchHistoryTypes";

const mocks = vi.hoisted(() => ({ list: vi.fn(), generate: vi.fn(), retry: vi.fn(), drafts: vi.fn(), open: vi.fn() }));
vi.mock("@/state", async () => ({ store: (await import("jotai")).createStore() }));
vi.mock("@/core/service/Settings", () => ({ Settings: { watch: () => () => undefined } }));
vi.mock("@/components/overlay-host", () => ({ OverlayHost: { open: vi.fn(), close: vi.fn() } }));
vi.mock("@/components/ui/dialog", async () => {
  const { createElement } = await import("react");
  const component =
    (tag: string) =>
    ({ children }: { children: React.ReactNode }) =>
      createElement(tag, null, children);
  return {
    Dialog: component("section"),
    DialogContent: component("div"),
    DialogHeader: component("header"),
    DialogTitle: component("h1"),
    DialogDescription: component("p"),
  };
});
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number }) =>
      `${key}${options?.count !== undefined ? ` ${options.count}` : ""}`,
  }),
}));
vi.mock("i18next", () => ({ default: { exists: () => false, t: (key: string) => key } }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), warning: vi.fn() } }));
vi.mock("@tauri-apps/plugin-shell", () => ({ open: mocks.open }));
vi.mock("./ResearchFolder", () => ({ ResearchFolder: { getRoot: () => "/project" } }));
vi.mock("./ResearchHistory", () => {
  throw new Error("Weekly report UI must not load archives");
});
vi.mock("./ResearchHistoryCoordinator", () => {
  throw new Error("Weekly report UI must not capture snapshots");
});
vi.mock("./WeeklyProgress", () => ({
  listWeeklyRecords: mocks.list,
  weekStartDate: () => "2026-11-16",
  WEEKLY_PROGRESS_CHANGED_EVENT: "weekly-changed",
}));
vi.mock("./ResearchReport", () => ({
  generateWeeklyResearchReport: mocks.generate,
  retryResearchReportExport: mocks.retry,
  listResearchReportDrafts: mocks.drafts,
}));

import { store } from "@/state";
import { ResearchProgressDialog, researchReportTaskAtom, startResearchReportTask } from "./ResearchProgressDialog";

const records = ["2026-11-16", "2026-11-09"].map((weekStart) => ({
  weekStart,
  path: `进展记录/周进展/${weekStart}.md`,
  markdown: "# Weekly",
  revision: "abc",
  items: [],
  links: [],
}));
const result: ResearchReportResult = {
  directory: "/project/汇报/one",
  markdownPath: "/project/汇报/one/report.md",
  pptxPath: "/project/汇报/one/report.pptx",
  snapshotId: "weekly:2026-11-16:abc",
  warnings: [],
};
let root: Root;
let container: HTMLDivElement;
const button = (text: string) =>
  [...container.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.includes(text))!;
async function click(element: HTMLElement) {
  await act(async () => element.click());
}
async function show(initialWeek?: string) {
  await act(async () =>
    root.render(<ResearchProgressDialog root="/project" initialWeek={initialWeek} onClose={vi.fn()} />),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.list.mockResolvedValue(records);
  mocks.generate.mockResolvedValue(result);
  mocks.retry.mockResolvedValue(result);
  mocks.drafts.mockResolvedValue({ entries: [], warnings: [] });
  mocks.open.mockResolvedValue(undefined);
  store.set(researchReportTaskAtom, null);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  store.set(researchReportTaskAtom, null);
  vi.unstubAllGlobals();
});

describe("weekly report dialog", () => {
  it("generates only from the chosen week and opens its output", async () => {
    await show("2026-11-09");
    expect(mocks.list).toHaveBeenCalledWith("/project");
    expect(container.querySelector("select")?.value).toBe("2026-11-09");
    await click(button("weekly.reportGenerate"));
    expect(mocks.generate).toHaveBeenCalledWith(expect.objectContaining({ root: "/project", weekStart: "2026-11-09" }));
    await click(button("progress.openPpt"));
    expect(mocks.open).toHaveBeenCalledWith(result.pptxPath);
  });
  it("does not offer generation when no weekly record exists", async () => {
    mocks.list.mockResolvedValue([]);
    await show();
    expect(button("weekly.reportGenerate").disabled).toBe(true);
    expect(container.textContent).toContain("weekly.noReportWeeks");
    expect(mocks.generate).not.toHaveBeenCalled();
  });
  it("shows a load failure and keeps generation disabled", async () => {
    mocks.list.mockRejectedValue(new Error("disk disconnected"));
    await show();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("disk disconnected");
    expect(button("weekly.reportGenerate").disabled).toBe(true);
  });
  it("refreshes available weeks after an external weekly edit", async () => {
    await show();
    mocks.list.mockResolvedValue([records[1]]);
    await act(async () => window.dispatchEvent(new Event("weekly-changed")));
    expect(container.querySelector("select")?.value).toBe("2026-11-09");
  });
  it("keeps an in-flight report alive across closing and reopening", async () => {
    let finish!: (value: ResearchReportResult) => void;
    mocks.generate.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await show();
    await click(button("weekly.reportGenerate"));
    await act(async () => root.render(null));
    expect(store.get(researchReportTaskAtom)?.state).toBe("running");
    await act(async () => finish(result));
    await show();
    expect(container.textContent).toContain("progress.task.done");
    expect(mocks.generate).toHaveBeenCalledTimes(1);
  });
  it("cancels the running generator and never presents a late success", async () => {
    let finish!: (value: ResearchReportResult) => void;
    mocks.generate.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await show();
    await click(button("weekly.reportGenerate"));
    await click(button("progress.cancel"));
    expect(mocks.generate.mock.calls[0][0].signal.aborted).toBe(true);
    await act(async () => finish(result));
    expect(store.get(researchReportTaskAtom)?.state).toBe("cancelled");
  });
  it("does not start a second report while one is running", async () => {
    mocks.generate.mockImplementation(() => new Promise(() => undefined));
    await act(async () => {
      expect(startResearchReportTask({ root: "/project", weekStart: "2026-11-16" })).toBe(true);
    });
    expect(startResearchReportTask({ root: "/elsewhere", weekStart: "2026-11-09" })).toBe(false);
    expect(mocks.generate).toHaveBeenCalledTimes(1);
  });
  it("retries export from the stored draft without calling AI again", async () => {
    mocks.generate.mockRejectedValue(Object.assign(new Error("researchReport.exportFailed"), { jobId: "draft-1" }));
    await show();
    await click(button("weekly.reportGenerate"));
    await click(button("progress.retryExport"));
    expect(mocks.retry).toHaveBeenCalledWith("/project", "draft-1", expect.any(AbortSignal));
    expect(mocks.generate).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("progress.task.done");
  });
  it("keeps valid saved drafts available when another draft is corrupt", async () => {
    mocks.drafts.mockResolvedValue({
      entries: [{ jobId: "saved", title: "Valid draft", createdAt: "2026-11-16T00:00:00Z", snapshotId: "weekly:old" }],
      warnings: ["bad draft"],
    });
    await show();
    expect(container.textContent).toContain("progress.draftsSkipped 1");
    expect(container.textContent).toContain("Valid draft");
    await click(button("progress.reexport"));
    expect(mocks.retry).toHaveBeenCalledWith("/project", "saved", expect.any(AbortSignal));
    expect(mocks.generate).not.toHaveBeenCalled();
  });
});
