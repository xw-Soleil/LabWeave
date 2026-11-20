import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HistoryCheckpointScheduler,
  prepareResearchSnapshot,
  type SnapshotDocument,
  type SnapshotPreparation,
} from "./ResearchHistoryCoordinator";
import type { ResearchSnapshot } from "./ResearchHistoryTypes";

vi.mock("i18next", () => ({ default: { t: (key: string) => key } }));
vi.mock("sonner", () => ({ toast: { warning: vi.fn() } }));

const snapshot: ResearchSnapshot = {
  version: 1,
  id: "s1",
  projectId: "p1",
  createdAt: "2026-11-20T08:00:00Z",
  weekStart: "2026-11-16",
  reason: "report",
  files: [],
  warnings: [],
};

function fixture() {
  const document: SnapshotDocument = {
    id: "note",
    path: "/research/note.md",
    dirty: true,
    busy: false,
    revision: "text",
    save: vi.fn(async () => {
      document.dirty = false;
    }),
  };
  const dependencies: SnapshotPreparation = {
    documents: vi.fn(async () => [{ ...document }]),
    capture: vi.fn(async () => snapshot),
  };
  return { document, dependencies };
}

describe("prepareResearchSnapshot", () => {
  it("saves named notes before capturing the immutable report input", async () => {
    const { document, dependencies } = fixture();
    dependencies.capture = vi.fn(async () => {
      expect(document.dirty).toBe(false);
      return snapshot;
    });
    await expect(prepareResearchSnapshot("/research", "report", dependencies)).resolves.toBe(snapshot);
    expect(document.save).toHaveBeenCalledOnce();
    expect(dependencies.capture).toHaveBeenCalledWith("/research", "report");
  });

  it("does not silently leave an unnamed dirty board out of a report", async () => {
    const { document, dependencies } = fixture();
    document.path = undefined;
    await expect(prepareResearchSnapshot("/research", "report", dependencies)).rejects.toThrow("unnamedDraft");
    expect(dependencies.capture).not.toHaveBeenCalled();
  });

  it("does not capture stale disk content after a failed save", async () => {
    const { document, dependencies } = fixture();
    document.save = vi.fn(async () => {
      throw new Error("disk full");
    });
    await expect(prepareResearchSnapshot("/research", "report", dependencies)).rejects.toThrow("disk full");
    expect(dependencies.capture).not.toHaveBeenCalled();
    document.save = async () => {
      document.dirty = false;
    };
    await expect(prepareResearchSnapshot("/research", "report", dependencies)).resolves.toBe(snapshot);
  });

  it("detects edits made while a snapshot is being collected", async () => {
    const { document, dependencies } = fixture();
    dependencies.capture = async () => {
      document.revision = "new text";
      document.dirty = true;
      return snapshot;
    };
    await expect(prepareResearchSnapshot("/research", "report", dependencies)).rejects.toThrow("changed");
  });

  it("blocks capture while PDF annotations are still being applied", async () => {
    const { document, dependencies } = fixture();
    document.busy = true;
    await expect(prepareResearchSnapshot("/research", "manual", dependencies)).rejects.toThrow("busy");
    expect(document.save).not.toHaveBeenCalled();
  });

  it("refuses two simultaneous prepare operations on the same project", async () => {
    const { dependencies } = fixture();
    let finish!: (value: ResearchSnapshot) => void;
    dependencies.capture = vi.fn(
      () =>
        new Promise<ResearchSnapshot>((resolve) => {
          finish = resolve;
        }),
    );
    const first = prepareResearchSnapshot("/research", "report", dependencies);
    await vi.waitFor(() => expect(dependencies.capture).toHaveBeenCalledOnce());
    await expect(prepareResearchSnapshot("/research", "manual", dependencies)).rejects.toThrow("busy");
    finish(snapshot);
    await first;
  });
});

describe("HistoryCheckpointScheduler", () => {
  afterEach(() => vi.useRealTimers());

  it("coalesces saves without postponing checkpoints indefinitely", async () => {
    vi.useFakeTimers();
    const capture = vi.fn(async () => {});
    const scheduler = new HistoryCheckpointScheduler(capture, vi.fn(), 30, 100);
    scheduler.request("a");
    for (let time = 0; time < 4; time++) {
      await vi.advanceTimersByTimeAsync(20);
      scheduler.request("a");
    }
    expect(capture).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(20);
    expect(capture).toHaveBeenCalledExactlyOnceWith("a");
    scheduler.dispose();
  });

  it("keeps project identities separate when the user switches projects", async () => {
    vi.useFakeTimers();
    const capture = vi.fn<(root: string) => Promise<void>>(async () => {});
    const scheduler = new HistoryCheckpointScheduler(capture, vi.fn(), 30);
    scheduler.request("old");
    scheduler.request("new");
    await vi.advanceTimersByTimeAsync(30);
    expect(capture.mock.calls.map(([root]) => root)).toEqual(["old", "new"]);
    scheduler.dispose();
  });

  it("retains saves arriving during a capture and reports failures", async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const onError = vi.fn();
    const capture = vi
      .fn<(root: string) => Promise<void>>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      )
      .mockRejectedValueOnce(new Error("disk full"));
    const scheduler = new HistoryCheckpointScheduler(capture, onError, 30);
    scheduler.request("a");
    await vi.advanceTimersByTimeAsync(30);
    scheduler.request("a");
    finish();
    await vi.advanceTimersByTimeAsync(31);
    expect(capture).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledOnce();
    scheduler.dispose();
  });

  it("does not create history after service disposal", async () => {
    vi.useFakeTimers();
    const capture = vi.fn(async () => {});
    const scheduler = new HistoryCheckpointScheduler(capture, vi.fn(), 30);
    scheduler.request("a");
    scheduler.dispose();
    await vi.advanceTimersByTimeAsync(100);
    expect(capture).not.toHaveBeenCalled();
  });

  it("retries a busy save after a delay without needing another edit", async () => {
    vi.useFakeTimers();
    const capture = vi
      .fn<(root: string) => Promise<void | boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValue(undefined);
    const scheduler = new HistoryCheckpointScheduler(capture, vi.fn(), 30);
    scheduler.request("a");
    await vi.advanceTimersByTimeAsync(30);
    expect(capture).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(29);
    expect(capture).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(capture).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(100);
    expect(capture).toHaveBeenCalledTimes(2);
    scheduler.dispose();
  });

  it("bounds retries while allowing a later save to request another checkpoint", async () => {
    vi.useFakeTimers();
    const capture = vi.fn(async () => false);
    const scheduler = new HistoryCheckpointScheduler(capture, vi.fn(), 30);
    scheduler.request("a");
    await vi.advanceTimersByTimeAsync(500);
    expect(capture).toHaveBeenCalledTimes(4);
    scheduler.request("a");
    await vi.advanceTimersByTimeAsync(30);
    expect(capture).toHaveBeenCalledTimes(5);
    scheduler.dispose();
    await vi.advanceTimersByTimeAsync(500);
    expect(capture).toHaveBeenCalledTimes(5);
  });
});
