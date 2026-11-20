// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WeeklyItem, WeeklyRecord } from "./WeeklyProgress";

const mocks = vi.hoisted(() => ({
  project: "/project",
  watchers: new Set<() => void>(),
  list: vi.fn(),
  load: vi.fn(),
  ensure: vi.fn(),
  append: vi.fn(),
  toggle: vi.fn(),
  context: vi.fn(),
  openLink: vi.fn(),
  openDocument: vi.fn(),
  openReport: vi.fn(),
  overlayOpen: vi.fn(() => ({ id: "weekly" })),
  updateItem: vi.fn(),
  summarize: vi.fn(),
  importImages: vi.fn(),
  pasteImage: vi.fn(),
  previewImage: vi.fn(),
  warning: vi.fn(),
}));
vi.mock("@/state", async () => {
  const { createStore } = await import("jotai");
  return { store: createStore() };
});
vi.mock("@/components/overlay-host", () => ({
  OverlayHost: { open: mocks.overlayOpen, close: vi.fn() },
}));
vi.mock("@/components/ui/dialog", async () => {
  const { createElement } = await import("react");
  const component =
    (tag: string) =>
    ({ children, className }: { children: React.ReactNode; className?: string }) =>
      createElement(tag, { className }, children);
  return {
    Dialog: component("section"),
    DialogContent: component("div"),
    DialogHeader: component("header"),
    DialogTitle: component("h1"),
    DialogDescription: component("p"),
  };
});
vi.mock("react-i18next", () => {
  const t = (key: string, options?: { text?: string; count?: number; title?: string; name?: string }) =>
    `${key}${options?.text ? ` ${options.text}` : options?.title ? ` ${options.title}` : options?.name ? ` ${options.name}` : options?.count !== undefined ? ` ${options.count}` : ""}`;
  return { useTranslation: () => ({ t }) };
});
vi.mock("i18next", () => ({ default: { exists: () => true, t: (key: string) => key } }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: mocks.warning } }));
vi.mock("@/core/service/Settings", () => ({
  Settings: {
    watch: (_key: string, callback: () => void) => {
      mocks.watchers.add(callback);
      return () => mocks.watchers.delete(callback);
    },
  },
}));
vi.mock("./ResearchFolder", () => ({
  ResearchFolder: { getRoot: () => mocks.project, toAbsolute: (path: string, root: string) => `${root}/${path}` },
}));
vi.mock("./DocumentTab", () => ({ openDocumentFile: mocks.openDocument }));
vi.mock("./ResearchShell", () => ({ RESEARCH_CONTENT_SAVED_EVENT: "research:saved" }));
vi.mock("./ResearchProgressDialog", () => ({ openResearchProgressDialog: mocks.openReport }));
vi.mock("./WeeklyProgressSummary", () => ({ generateWeeklyItemSummary: mocks.summarize }));
vi.mock("./WeeklyProgressMedia", () => ({
  importWeeklyImages: mocks.importImages,
  pasteWeeklyImage: mocks.pasteImage,
  loadWeeklyImagePreview: mocks.previewImage,
}));
vi.mock("./WeeklyProgress", () => ({
  listWeeklyRecords: mocks.list,
  loadWeeklyRecord: mocks.load,
  ensureWeeklyRecord: mocks.ensure,
  appendWeeklyItem: mocks.append,
  setWeeklyItemDone: mocks.toggle,
  openWeeklyLink: mocks.openLink,
  currentWeeklyContextLink: mocks.context,
  summarizeWeeklyItem: (text: string) =>
    text
      .trim()
      .split(/[。.!！\n]/)[0]
      .slice(0, 56),
  displayWeeklyLink: (_record: string, href: string) =>
    decodeURIComponent(href)
      .replace(/^(\.\.\/)+/, "")
      .replace(/#page=(\d+)/, " · 第 $1 页"),
  updateWeeklyItem: mocks.updateItem,
  WEEKLY_PROGRESS_CHANGED_EVENT: "research:weekly-progress-changed",
  weekStartDate: (date?: Date) => {
    if (!date) return "2026-11-16";
    const monday = new Date(date);
    monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
    return `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, "0")}-${String(monday.getDate()).padStart(2, "0")}`;
  },
}));

import {
  clampWeeklyFloat,
  toggleWeeklyProgressFloat,
  WeeklyProgressDialog,
  WeeklyProgressFloat,
  weeklySectionItems,
} from "./WeeklyProgressPanel";

const week = "2026-11-16";
const record = (items: WeeklyItem[] = [], weekStart = week): WeeklyRecord => ({
  weekStart,
  path: `进展记录/周进展/${weekStart}.md`,
  markdown: "# weekly record",
  revision: "revision-1",
  items,
  links: [],
});
const task = (text = "Compare experiment results"): WeeklyItem => ({
  id: "line:8",
  section: "todo",
  text,
  done: false,
  links: [{ label: "Experiment note", href: "../../notes/experiment.md#Results" }],
});
let container: HTMLDivElement;
let root: Root;
let projectCount = 0;
const button = (text: string) =>
  [...container.querySelectorAll<HTMLButtonElement>("button")].find((value) => value.textContent?.includes(text))!;
const labelled = <T extends Element = HTMLButtonElement>(label: string) =>
  container.querySelector<T>(`[aria-label="${label}"]`)!;
async function click(element: HTMLElement) {
  await act(async () => element.click());
}
async function select(element: HTMLSelectElement, value: string) {
  await act(async () => {
    element.value = value;
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
async function enter(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    const prototype =
      element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function showDialog(initialWeek?: string, onClose = vi.fn()) {
  await act(async () =>
    root.render(<WeeklyProgressDialog root={mocks.project} initialWeek={initialWeek} onClose={onClose} />),
  );
}
async function showFloat() {
  await act(async () => {
    toggleWeeklyProgressFloat();
    root.render(<WeeklyProgressFloat />);
  });
}
function pointer(type: string, x: number, y: number) {
  const event = new MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true });
  Object.defineProperty(event, "pointerId", { value: 4 });
  return event;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const preferences = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => preferences.get(key) ?? null,
    setItem: (key: string, value: string) => preferences.set(key, value),
    clear: () => preferences.clear(),
  });
  mocks.project = `/project-${++projectCount}`;
  mocks.watchers.clear();
  localStorage.clear();
  mocks.list.mockResolvedValue([]);
  mocks.load.mockResolvedValue(null);
  mocks.ensure.mockResolvedValue(record());
  mocks.context.mockResolvedValue(undefined);
  mocks.openDocument.mockResolvedValue(undefined);
  mocks.openLink.mockResolvedValue(undefined);
  mocks.append.mockImplementation(async (_root, value, section, text, link, options) => ({
    ...value,
    revision: "revision-2",
    items: [
      ...value.items,
      {
        id: "line:10",
        section,
        text,
        summary: options?.summary,
        images: options?.images,
        done: section === "done",
        links: [...(link ? [link] : []), ...(options?.links ?? [])],
      },
    ],
  }));
  mocks.toggle.mockImplementation(async (_root, value, id, done) => ({
    ...value,
    revision: "revision-2",
    items: value.items.map((item: WeeklyItem) => (item.id === id ? { ...item, done } : item)),
  }));
  mocks.updateItem.mockImplementation(async (_root, value, id, update) => {
    const next = {
      ...value,
      revision: "revision-2",
      items: value.items.map((item: WeeklyItem) => (item.id === id ? { ...item, ...update } : item)),
    };
    mocks.load.mockResolvedValue(next);
    return next;
  });
  mocks.summarize.mockResolvedValue("Concise AI title");
  mocks.importImages.mockResolvedValue([]);
  mocks.pasteImage.mockResolvedValue(undefined);
  mocks.previewImage.mockResolvedValue("data:image/png;base64,aGVsbG8=");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("weekly progress controls", () => {
  it("reads an empty week without creating or saving a record", async () => {
    await showDialog();
    expect(container.textContent).toContain("weekly.emptyWeek");
    expect(mocks.load).toHaveBeenCalledWith(mocks.project, week);
    expect(mocks.ensure).not.toHaveBeenCalled();
    expect(mocks.append).not.toHaveBeenCalled();
    expect(button("weekly.fullRecord").disabled).toBe(true);
    expect(button("weekly.report").disabled).toBe(true);
  });

  it("creates a Markdown record only after the first explicit save, retaining the precise context link", async () => {
    const link = { label: "Paper p. 7", href: "../../papers/paper.pdf#page=7" };
    mocks.context.mockResolvedValue(link);
    await showDialog();
    await click(button("weekly.attachCurrent"));
    expect(mocks.ensure).not.toHaveBeenCalled();
    await enter(container.querySelector("textarea")!, "Compare the proposed decoder");
    await select(labelled<HTMLSelectElement>("weekly.itemSection"), "next");
    await click(button("weekly.saveItem"));
    expect(mocks.ensure).toHaveBeenCalledOnce();
    expect(mocks.ensure).toHaveBeenCalledWith(mocks.project, week);
    expect(mocks.append).toHaveBeenCalledWith(
      mocks.project,
      record(),
      "next",
      "Compare the proposed decoder",
      undefined,
      {
        summary: "Compare the proposed decoder",
        images: [],
        links: [link],
      },
    );
    expect(container.querySelector("textarea")?.value).toBe("");
    expect(labelled("weekly.section.next").textContent).toContain("Compare the proposed decoder");
  });

  it("moves a checked task into completed progress and can restore it without changing its source link", async () => {
    const saved = record([task()]);
    mocks.load.mockResolvedValue(saved);
    const close = vi.fn();
    await showDialog(undefined, close);
    await click(labelled<HTMLInputElement>(`weekly.markDone ${task().text}`));
    expect(mocks.toggle).toHaveBeenCalledWith(mocks.project, saved, "line:8", true);
    expect(labelled("weekly.section.done").textContent).toContain(task().text);
    expect(labelled("weekly.section.todo").textContent).not.toContain(task().text);
    await click(labelled<HTMLInputElement>(`weekly.markPending ${task().text}`));
    expect(labelled("weekly.section.todo").textContent).toContain(task().text);
    await click(button("Experiment note"));
    expect(mocks.openLink).toHaveBeenCalledWith(mocks.project, expect.any(Object), task().links[0]);
    expect(close).toHaveBeenCalledOnce();
  });

  it("keeps unsaved input and shows a translated conflict instead of silently losing the change", async () => {
    mocks.load.mockResolvedValue(record());
    mocks.append.mockRejectedValue(new Error("weekly.conflict"));
    await showDialog();
    await enter(container.querySelector("textarea")!, "A useful finding");
    await click(button("weekly.saveItem"));
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("weekly.errors.conflict");
    expect(container.querySelector("textarea")?.value).toBe("A useful finding");
    expect(button("weekly.saveItem").disabled).toBe(false);
  });

  it("refreshes after editing the weekly Markdown and ignores unrelated content saves", async () => {
    const saved = record([task("Original task")]);
    mocks.load.mockResolvedValue(saved);
    await showDialog();
    const readsBefore = mocks.load.mock.calls.length;
    await act(async () => {
      window.dispatchEvent(new CustomEvent("research:saved", { detail: { path: `${mocks.project}/notes/other.md` } }));
    });
    expect(mocks.load.mock.calls.length).toBe(readsBefore);
    mocks.load.mockResolvedValue(record([task("Edited in Markdown")]));
    await act(async () => {
      window.dispatchEvent(new CustomEvent("research:saved", { detail: { path: `${mocks.project}/${saved.path}` } }));
    });
    expect(container.textContent).toContain("Edited in Markdown");
    expect(container.textContent).not.toContain("Original task");
    expect(mocks.ensure).not.toHaveBeenCalled();
  });

  it("keeps the dialog visible if its detailed source cannot be opened", async () => {
    mocks.load.mockResolvedValue(record([task()]));
    mocks.openLink.mockRejectedValue(new Error("weekly.fileNotFound"));
    const close = vi.fn();
    await showDialog(undefined, close);
    await click(button("Experiment note"));
    expect(close).not.toHaveBeenCalled();
    expect(container.textContent).toContain(task().text);
  });

  it("hands the selected historical week to report generation and opens its actual Markdown file", async () => {
    const older = record([task("Historical task")], "2026-11-09");
    mocks.list.mockResolvedValue([older]);
    mocks.load.mockImplementation(async (_root, selected) => (selected === older.weekStart ? older : null));
    await showDialog();
    await select(labelled<HTMLSelectElement>("weekly.chooseWeek"), older.weekStart);
    await click(button("weekly.report"));
    expect(mocks.openReport).toHaveBeenCalledWith("report", older.weekStart);
    await click(button("weekly.fullRecord"));
    expect(mocks.openDocument).toHaveBeenCalledWith(`${mocks.project}/${older.path}`);
    expect(mocks.ensure).not.toHaveBeenCalled();
  });

  it("ignores an older asynchronous response after switching weeks", async () => {
    let resolveCurrent!: (value: WeeklyRecord) => void;
    const pending = new Promise<WeeklyRecord>((resolve) => {
      resolveCurrent = resolve;
    });
    const older = record([task("Older result")], "2026-11-09");
    mocks.load.mockImplementation((_root, selected) => (selected === week ? pending : Promise.resolve(older)));
    mocks.list.mockResolvedValue([older]);
    await showDialog();
    await select(labelled<HTMLSelectElement>("weekly.chooseWeek"), older.weekStart);
    await act(async () => resolveCurrent(record([task("Wrong week result")])));
    expect(container.textContent).toContain("Older result");
    expect(container.textContent).not.toContain("Wrong week result");
  });

  it("refreshes the week list even when the current week still has no record", async () => {
    await showDialog();
    mocks.list.mockResolvedValue([record([], "2026-11-09")]);
    await click(button("weekly.refresh"));
    const weeks = [...labelled<HTMLSelectElement>("weekly.chooseWeek").options].map((option) => option.value);
    expect(weeks).toContain("2026-11-09");
    expect(mocks.ensure).not.toHaveBeenCalled();
  });

  it("closes the project-specific dialog when the active project changes", async () => {
    const close = vi.fn();
    await showDialog(undefined, close);
    await act(async () => {
      mocks.project = "/another-project";
      mocks.watchers.forEach((watch) => watch());
    });
    expect(close).toHaveBeenCalledOnce();
  });

  it("shows a readable linked-file card while retaining the exact encoded target for editing and saving", async () => {
    const href = "../../%E6%96%87%E7%8C%AE/%E8%AE%BA%E6%96%87.pdf#page=7";
    mocks.context.mockResolvedValue({ label: "论文 · 第 7 页", href });
    await showDialog();
    await click(button("weekly.attachCurrent"));
    expect(container.textContent).toContain("文献/论文.pdf · 第 7 页");
    expect(container.textContent).not.toContain("%E6");
    expect(container.textContent).not.toContain("../../");
    expect(labelled("weekly.linkTarget")).toBeNull();
    await click(labelled("weekly.editNamedLink 论文 · 第 7 页"));
    expect(labelled<HTMLInputElement>("weekly.linkTarget").value).toBe(href);
    await click(button("weekly.confirmLink"));
    await enter(labelled<HTMLInputElement>("weekly.itemTitle"), "论文指标核对");
    await click(button("weekly.saveItem"));
    expect(mocks.append).toHaveBeenCalledWith(mocks.project, record(), "done", "", undefined, {
      summary: "论文指标核对",
      images: [],
      links: [{ label: "论文 · 第 7 页", href }],
    });
  });

  it("derives an editable short title locally while preserving the entire detailed text", async () => {
    await showDialog();
    const details = "完成文献对照。详细对比包含实验条件、评价指标和下一步验证方法。";
    await enter(labelled<HTMLTextAreaElement>("weekly.itemDetails"), details);
    expect(labelled<HTMLInputElement>("weekly.itemTitle").value).toBe("完成文献对照");
    await enter(labelled<HTMLInputElement>("weekly.itemTitle"), "文献指标对照");
    await click(button("weekly.saveItem"));
    expect(mocks.append).toHaveBeenCalledWith(mocks.project, record(), "done", details, undefined, {
      summary: "文献指标对照",
      images: [],
      links: [],
    });
    expect(mocks.summarize).not.toHaveBeenCalled();
  });

  it("opens an existing item in the full-width form and saves only after explicit confirmation", async () => {
    const saved = record([{ ...task(), summary: "实验结果对照" }]);
    mocks.load.mockResolvedValue(saved);
    await showDialog();
    await click(labelled("weekly.editItemNamed 实验结果对照"));
    const input = labelled<HTMLInputElement>("weekly.itemTitle");
    expect(document.activeElement).toBe(input);
    expect(labelled<HTMLTextAreaElement>("weekly.itemDetails").value).toBe(task().text);
    await enter(input, "跨被试结果对照");
    expect(mocks.updateItem).not.toHaveBeenCalled();
    await click(button("weekly.saveChanges"));
    expect(mocks.updateItem).toHaveBeenCalledWith(mocks.project, saved, "line:8", {
      summary: "跨被试结果对照",
      text: task().text,
      links: task().links,
      images: [],
    });
    expect(container.textContent).toContain(task().text);
    expect(container.textContent).toContain("跨被试结果对照");
  });

  it("uses AI only on request and discards its result when the detailed text changes", async () => {
    let resolveTitle!: (value: string) => void;
    mocks.summarize.mockReturnValue(
      new Promise<string>((resolve) => {
        resolveTitle = resolve;
      }),
    );
    await showDialog();
    await enter(labelled<HTMLTextAreaElement>("weekly.itemDetails"), "Original content. More details.");
    expect(mocks.summarize).not.toHaveBeenCalled();
    await click(button("weekly.aiSummary"));
    expect(mocks.summarize).toHaveBeenCalledWith("Original content. More details.", "done", expect.any(AbortSignal));
    await enter(labelled<HTMLTextAreaElement>("weekly.itemDetails"), "Updated content. Latest details.");
    await act(async () => resolveTitle("Stale AI title"));
    expect(labelled<HTMLInputElement>("weekly.itemTitle").value).toBe("Updated content");
    expect(mocks.summarize.mock.calls[0][2].aborted).toBe(true);
    expect(mocks.append).not.toHaveBeenCalled();
  });

  it("keeps the local title and details if AI is not configured", async () => {
    mocks.summarize.mockRejectedValue(new Error("researchReport.aiNotConfigured"));
    await showDialog();
    await enter(labelled<HTMLTextAreaElement>("weekly.itemDetails"), "本地标题。完整内容仍然保留。");
    await click(button("weekly.aiSummary"));
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("progress.reportErrors.aiNotConfigured");
    expect(labelled<HTMLInputElement>("weekly.itemTitle").value).toBe("本地标题");
    expect(labelled<HTMLTextAreaElement>("weekly.itemDetails").value).toBe("本地标题。完整内容仍然保留。");
  });

  it("previews selected images, removes pending references, and saves an image-only item explicitly", async () => {
    const first = { label: "result.png", href: "附件/2026-11-16/first.png" };
    const second = { label: "diagram.png", href: "附件/2026-11-16/second.png" };
    mocks.importImages.mockResolvedValue([first, second]);
    await showDialog();
    await click(button("weekly.addImage"));
    expect(mocks.ensure).not.toHaveBeenCalled();
    expect(container.querySelectorAll("img")).toHaveLength(2);
    await click(labelled("weekly.removeImage result.png"));
    await click(button("weekly.saveItem"));
    expect(mocks.append).toHaveBeenCalledWith(mocks.project, record(), "done", "", undefined, {
      summary: "weekly.imageRecord",
      images: [second],
      links: [],
    });
  });

  it("accepts image paste into the form without duplicating the same attachment", async () => {
    const image = { label: "Pasted image", href: "附件/2026-11-16/paste.png" };
    mocks.pasteImage.mockResolvedValue(image);
    await showDialog();
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { items: [{ type: "image/png" }] } });
    await act(async () => labelled<HTMLTextAreaElement>("weekly.itemDetails").dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
    await click(button("weekly.pasteImage"));
    expect(container.querySelectorAll("img")).toHaveLength(1);
    expect(mocks.ensure).not.toHaveBeenCalled();
  });

  it("keeps unsaved titles, details, source links and images isolated by week", async () => {
    const older = "2026-11-09";
    const source = { label: "Week A source", href: "../../notes/week-a.md" };
    const image = { label: "Week A image", href: `附件/${week}/a.png` };
    mocks.list.mockResolvedValue([record([], older)]);
    mocks.context.mockResolvedValue(source);
    mocks.importImages.mockResolvedValue([image]);
    await showDialog();
    await enter(labelled<HTMLTextAreaElement>("weekly.itemDetails"), "Week A details");
    await enter(labelled<HTMLInputElement>("weekly.itemTitle"), "Week A title");
    await select(labelled<HTMLSelectElement>("weekly.itemSection"), "next");
    await click(button("weekly.attachCurrent"));
    await click(button("weekly.addImage"));
    await select(labelled<HTMLSelectElement>("weekly.chooseWeek"), older);
    expect(labelled<HTMLInputElement>("weekly.itemTitle").value).toBe("");
    expect(labelled<HTMLTextAreaElement>("weekly.itemDetails").value).toBe("");
    expect(container.querySelectorAll("img")).toHaveLength(0);
    expect(container.textContent).not.toContain("Week A source");
    await enter(labelled<HTMLTextAreaElement>("weekly.itemDetails"), "Week B details");
    await select(labelled<HTMLSelectElement>("weekly.chooseWeek"), week);
    expect(labelled<HTMLInputElement>("weekly.itemTitle").value).toBe("Week A title");
    expect(labelled<HTMLTextAreaElement>("weekly.itemDetails").value).toBe("Week A details");
    expect(labelled<HTMLSelectElement>("weekly.itemSection").value).toBe("next");
    expect(container.textContent).toContain("Week A source");
    expect(container.querySelectorAll("img")).toHaveLength(1);
    await click(button("weekly.saveItem"));
    expect(mocks.append).toHaveBeenCalledWith(mocks.project, record(), "next", "Week A details", undefined, {
      summary: "Week A title",
      images: [image],
      links: [source],
    });
    await select(labelled<HTMLSelectElement>("weekly.chooseWeek"), older);
    expect(labelled<HTMLTextAreaElement>("weekly.itemDetails").value).toBe("Week B details");
  });

  it.each(["unmount", "project switch"])(
    "aborts a pending image picker on %s before accepting its result",
    async (reason) => {
      let finish!: (value: { label: string; href: string }[]) => void;
      mocks.importImages.mockReturnValue(
        new Promise((resolve) => {
          finish = resolve;
        }),
      );
      await showDialog();
      await click(button("weekly.addImage"));
      const signal = mocks.importImages.mock.calls[0][2] as AbortSignal;
      expect(signal.aborted).toBe(false);
      await act(async () => {
        if (reason === "unmount") root.render(<div />);
        else {
          mocks.project = `${mocks.project}-changed`;
          mocks.watchers.forEach((watch) => watch());
        }
      });
      expect(signal.aborted).toBe(true);
      await act(async () => finish([{ label: "Late image", href: "附件/late.png" }]));
      expect(container.querySelectorAll("img")).toHaveLength(0);
      expect(mocks.ensure).not.toHaveBeenCalled();
      expect(mocks.append).not.toHaveBeenCalled();
    },
  );
});

describe("editing existing weekly items", () => {
  it("preserves two original image captions for one file when importing another image", async () => {
    const first = { label: "Original caption", href: "附件/original.png" };
    const alias = { ...first, label: "Different original caption" };
    const added = { label: "New result", href: "附件/new.png" };
    const saved = record([{ ...task(), summary: "Image references", images: [first, alias] }]);
    mocks.load.mockResolvedValue(saved);
    mocks.importImages.mockResolvedValue([first, added, added]);
    await showDialog();
    await click(labelled("weekly.editItemNamed Image references"));
    await click(button("weekly.addImage"));
    expect(container.querySelectorAll("form img")).toHaveLength(3);
    await click(button("weekly.saveChanges"));
    expect(mocks.updateItem).toHaveBeenCalledWith(
      mocks.project,
      saved,
      "line:8",
      expect.objectContaining({ images: [first, alias, added] }),
    );
    await click(labelled("weekly.editItemNamed Image references"));
    await click(labelled("weekly.removeImage Different original caption"));
    expect(container.querySelectorAll("form img")).toHaveLength(2);
    await click(button("weekly.saveChanges"));
    expect(mocks.updateItem).toHaveBeenLastCalledWith(
      mocks.project,
      expect.objectContaining({ revision: "revision-2" }),
      "line:8",
      expect.objectContaining({ images: [first, added] }),
    );
  });

  it("preserves existing link aliases when adding another file", async () => {
    const originalLinks = [task().links[0], { ...task().links[0], label: "Original reference alias" }];
    const saved = record([{ ...task(), summary: "Reference aliases", links: originalLinks }]);
    mocks.load.mockResolvedValue(saved);
    await showDialog();
    await click(labelled("weekly.editItemNamed Reference aliases"));
    await click(button("weekly.attachFile"));
    await enter(labelled<HTMLInputElement>("weekly.linkLabel"), "New source");
    await enter(labelled<HTMLInputElement>("weekly.linkTarget"), "../../new.md");
    await click(button("weekly.confirmLink"));
    await click(button("weekly.saveChanges"));
    expect(mocks.updateItem).toHaveBeenCalledWith(
      mocks.project,
      saved,
      "line:8",
      expect.objectContaining({ links: [...originalLinks, { label: "New source", href: "../../new.md" }] }),
    );
  });

  it("adds images and multiple file links without dropping original references", async () => {
    const oldImage = { label: "Original figure", href: "附件/original.png" };
    const newImage = { label: "New figure", href: "附件/new.png" };
    const currentLink = { label: "Current paper", href: "../../papers/paper.pdf#page=4" };
    const manualLink = { label: "Meeting detail", href: "../../meetings/week.md#Decision" };
    const saved = record([{ ...task(), summary: "实验对照", images: [oldImage] }]);
    mocks.load.mockResolvedValue(saved);
    mocks.context.mockResolvedValue(currentLink);
    mocks.importImages.mockResolvedValue([newImage]);
    await showDialog();
    await click(labelled("weekly.editItemNamed 实验对照"));
    await enter(
      labelled<HTMLTextAreaElement>("weekly.itemDetails"),
      "Full original details\nAdditional experimental result",
    );
    await click(button("weekly.attachCurrent"));
    await click(button("weekly.attachFile"));
    await enter(labelled<HTMLInputElement>("weekly.linkLabel"), manualLink.label);
    await enter(labelled<HTMLInputElement>("weekly.linkTarget"), manualLink.href);
    await click(button("weekly.confirmLink"));
    await click(button("weekly.addImage"));
    await click(button("weekly.saveChanges"));
    expect(mocks.updateItem).toHaveBeenCalledWith(mocks.project, saved, "line:8", {
      summary: "实验对照",
      text: "Full original details\nAdditional experimental result",
      links: [...task().links, currentLink, manualLink],
      images: [oldImage, newImage],
    });
    expect(mocks.ensure).not.toHaveBeenCalled();
    expect(mocks.append).not.toHaveBeenCalled();
  });

  it("cancels without writing and restores the separate new-item draft", async () => {
    const saved = record([{ ...task(), summary: "Stored item" }]);
    const draftImage = { label: "Draft figure", href: "附件/draft.png" };
    const draftLink = { label: "Draft source", href: "../../draft.md" };
    mocks.load.mockResolvedValue(saved);
    mocks.importImages.mockResolvedValue([draftImage]);
    mocks.context.mockResolvedValue(draftLink);
    await showDialog();
    await enter(labelled<HTMLTextAreaElement>("weekly.itemDetails"), "Unsaved new details");
    await enter(labelled<HTMLInputElement>("weekly.itemTitle"), "New item title");
    await click(button("weekly.attachCurrent"));
    await click(button("weekly.addImage"));
    await click(labelled("weekly.editItemNamed Stored item"));
    await enter(labelled<HTMLInputElement>("weekly.itemTitle"), "Discard this edit");
    await click(button("weekly.cancelEdit"));
    expect(labelled<HTMLInputElement>("weekly.itemTitle").value).toBe("New item title");
    expect(labelled<HTMLTextAreaElement>("weekly.itemDetails").value).toBe("Unsaved new details");
    const editor = container.querySelector("form")!;
    expect(editor.textContent).toContain("Draft source");
    expect(editor.querySelectorAll("img")).toHaveLength(1);
    expect(mocks.updateItem).not.toHaveBeenCalled();
    expect(mocks.append).not.toHaveBeenCalled();
    expect(mocks.ensure).not.toHaveBeenCalled();
  });

  it("requires save or cancel before changing weeks or editing another item", async () => {
    mocks.load.mockResolvedValue(
      record([
        { ...task(), summary: "First" },
        { ...task(), id: "line:11", summary: "Second" },
      ]),
    );
    await showDialog();
    await click(labelled("weekly.editItemNamed First"));
    expect(labelled<HTMLSelectElement>("weekly.chooseWeek").disabled).toBe(true);
    expect(labelled<HTMLButtonElement>("weekly.previousWeek").disabled).toBe(true);
    expect(labelled<HTMLButtonElement>("weekly.editItemNamed Second").disabled).toBe(true);
    expect(container.querySelector("form")!.textContent).toContain("weekly.editItemHint");
    await click(button("weekly.cancelEdit"));
    expect(labelled<HTMLSelectElement>("weekly.chooseWeek").disabled).toBe(false);
    expect(labelled<HTMLButtonElement>("weekly.editItemNamed Second").disabled).toBe(false);
  });

  it("submits the fixed opening revision after external refresh and keeps edits on conflict", async () => {
    const base = record([{ ...task(), summary: "Original task" }]);
    mocks.load.mockResolvedValue(base);
    await showDialog();
    await click(labelled("weekly.editItemNamed Original task"));
    await enter(labelled<HTMLTextAreaElement>("weekly.itemDetails"), "My pending changes");
    const changed = {
      ...record([{ ...task("Different item now at line 8"), summary: "Different task" }]),
      revision: "revision-external",
    };
    mocks.load.mockResolvedValue(changed);
    await act(async () =>
      window.dispatchEvent(new CustomEvent("research:saved", { detail: { path: `${mocks.project}/${base.path}` } })),
    );
    expect(labelled<HTMLTextAreaElement>("weekly.itemDetails").value).toBe("My pending changes");
    mocks.updateItem.mockRejectedValue(new Error("weekly.conflict"));
    await click(button("weekly.saveChanges"));
    expect(mocks.updateItem).toHaveBeenCalledWith(
      mocks.project,
      base,
      "line:8",
      expect.objectContaining({ text: "My pending changes" }),
    );
    expect(container.querySelector("form [role=alert]")?.textContent).toBe("weekly.errors.conflict");
    expect(labelled<HTMLTextAreaElement>("weekly.itemDetails").value).toBe("My pending changes");
    expect(mocks.ensure).not.toHaveBeenCalled();
  });

  it("keeps an old image when preview fails and removes only explicitly selected references", async () => {
    const failedImage = { label: "Unavailable original", href: "附件/old.svg" };
    const removedImage = { label: "Removed figure", href: "附件/remove.png" };
    const saved = record([{ ...task(), summary: "Results", images: [failedImage, removedImage] }]);
    mocks.load.mockResolvedValue(saved);
    mocks.previewImage.mockImplementation(async (_root, _record, link) => {
      if (link.href === failedImage.href) throw new Error("weekly.imageReadFailed");
      return "data:image/png;base64,aGVsbG8=";
    });
    await showDialog();
    await click(labelled("weekly.editItemNamed Results"));
    await click(labelled("weekly.removeImage Removed figure"));
    await click(labelled("weekly.removeNamedLink Experiment note"));
    await click(button("weekly.saveChanges"));
    expect(mocks.updateItem).toHaveBeenCalledWith(mocks.project, saved, "line:8", {
      summary: "Results",
      text: task().text,
      links: [],
      images: [failedImage],
    });
  });

  it("discards AI output from a cancelled editor even if the new draft has identical text", async () => {
    const saved = record([{ ...task("Same details"), summary: "Same title" }]);
    mocks.load.mockResolvedValue(saved);
    let finish!: (value: string) => void;
    mocks.summarize.mockReturnValue(
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
    );
    await showDialog();
    await enter(labelled<HTMLTextAreaElement>("weekly.itemDetails"), "Same details");
    await enter(labelled<HTMLInputElement>("weekly.itemTitle"), "Same title");
    await click(labelled("weekly.editItemNamed Same title"));
    await click(button("weekly.aiSummary"));
    await click(button("weekly.cancelEdit"));
    await act(async () => finish("Title from cancelled edit"));
    expect(labelled<HTMLInputElement>("weekly.itemTitle").value).toBe("Same title");
    expect((mocks.summarize.mock.calls[0][2] as AbortSignal).aborted).toBe(true);
    expect(mocks.updateItem).not.toHaveBeenCalled();
  });
});

describe("floating weekly memo", () => {
  it("shows short titles and media counts and opens the matching item for full details", async () => {
    const saved = record([
      {
        ...task("Long detailed original content that should stay available only in the full progress record."),
        summary: "实验对照",
        images: [{ label: "Result", href: "附件/result.png" }],
      },
    ]);
    mocks.load.mockResolvedValue(saved);
    await showFloat();
    expect(container.textContent).toContain("实验对照");
    expect(container.textContent).not.toContain(saved.items[0].text);
    expect(container.textContent).toContain("weekly.imageCount 1");
    expect(mocks.previewImage).not.toHaveBeenCalled();
    await click(labelled("weekly.inspectItem 实验对照"));
    expect(mocks.overlayOpen).toHaveBeenCalledWith(
      expect.objectContaining({ props: expect.objectContaining({ initialWeek: week, initialItemId: "line:8" }) }),
    );
  });

  it("enlarges the actual memo independently from minimizing and opening the full record", async () => {
    localStorage.setItem(
      `labweave-weekly-float:${mocks.project}`,
      JSON.stringify({ open: false, minimized: false, x: 50, y: 50 }),
    );
    await showFloat();
    expect(labelled("weekly.floatTitle").className).toContain("w-[21rem]");
    await click(labelled("weekly.enlargeFloat"));
    expect(labelled("weekly.floatTitle").className).toContain("w-[32rem]");
    expect(mocks.overlayOpen).not.toHaveBeenCalled();
    await click(labelled("weekly.minimize"));
    await click(labelled("weekly.expand"));
    expect(labelled("weekly.floatTitle").className).toContain("w-[32rem]");
    await click(labelled("weekly.shrinkFloat"));
    expect(labelled("weekly.floatTitle").className).toContain("w-[21rem]");
    expect(JSON.parse(localStorage.getItem(`labweave-weekly-float:${mocks.project}`)!)).toMatchObject({
      enlarged: false,
    });
  });

  it("keeps memo key events away from board shortcuts without preventing button activation", async () => {
    await showFloat();
    const keyDown = vi.fn();
    const keyUp = vi.fn();
    window.addEventListener("keydown", keyDown);
    window.addEventListener("keyup", keyUp);
    try {
      const control = labelled("weekly.minimize");
      const down = new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true });
      const up = new KeyboardEvent("keyup", { key: "Delete", bubbles: true, cancelable: true });
      await act(async () => {
        control.dispatchEvent(down);
        control.dispatchEvent(up);
      });
      expect(keyDown).not.toHaveBeenCalled();
      expect(keyUp).not.toHaveBeenCalled();
      expect(down.defaultPrevented).toBe(false);
      expect(up.defaultPrevented).toBe(false);
    } finally {
      window.removeEventListener("keydown", keyDown);
      window.removeEventListener("keyup", keyUp);
    }
  });

  it("opens, minimizes, expands, and closes without writing research content", async () => {
    mocks.load.mockResolvedValue(record([task()]));
    await showFloat();
    expect(container.textContent).toContain(task().text);
    await click(labelled("weekly.minimize"));
    expect(container.textContent).toContain("weekly.pendingCount 1");
    expect(container.textContent).not.toContain(task().text);
    await click(labelled("weekly.expand"));
    expect(container.textContent).toContain(task().text);
    await click(labelled("weekly.closeFloat"));
    expect(container.querySelector('[role="region"]')).toBeNull();
    await act(async () => toggleWeeklyProgressFloat());
    expect(container.textContent).toContain(task().text);
    expect(mocks.ensure).not.toHaveBeenCalled();
    expect(mocks.append).not.toHaveBeenCalled();
    expect(mocks.toggle).not.toHaveBeenCalled();
  });

  it("limits each section to three essentials until expanded", async () => {
    const items = Array.from({ length: 5 }, (_, index) => ({ ...task(`Task ${index + 1}`), id: `line:${index}` }));
    mocks.load.mockResolvedValue(record(items));
    await showFloat();
    expect(container.textContent).toContain("Task 3");
    expect(container.textContent).not.toContain("Task 4");
    await click(button("weekly.more 2"));
    expect(container.textContent).toContain("Task 5");
    await click(button("weekly.less"));
    expect(container.textContent).not.toContain("Task 4");
  });

  it("keeps display preferences separate per project and discards stale reads on project switch", async () => {
    let resolveOld!: (value: WeeklyRecord) => void;
    mocks.load.mockReturnValueOnce(
      new Promise<WeeklyRecord>((resolve) => {
        resolveOld = resolve;
      }),
    );
    await showFloat();
    const firstProject = mocks.project;
    await act(async () => {
      mocks.project = `${firstProject}-other`;
      mocks.watchers.forEach((watch) => watch());
    });
    expect(container.querySelector('[role="region"]')).toBeNull();
    mocks.load.mockResolvedValue(record([task("New project's task")]));
    await act(async () => toggleWeeklyProgressFloat());
    await act(async () => resolveOld(record([task("Stale old task")])));
    expect(container.textContent).toContain("New project's task");
    expect(container.textContent).not.toContain("Stale old task");
  });

  it("clamps dragging inside the viewport and persists only the final position", async () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ width: 336, height: 400 } as DOMRect);
    await showFloat();
    const panel = labelled<HTMLDivElement>("weekly.floatTitle");
    const startX = Number.parseFloat(panel.style.left);
    const startY = Number.parseFloat(panel.style.top);
    await act(async () => {
      container
        .querySelector("[data-weekly-drag-region]")!
        .dispatchEvent(pointer("pointerdown", startX + 10, startY + 10));
      window.dispatchEvent(pointer("pointermove", -300, -300));
      window.dispatchEvent(pointer("pointerup", -300, -300));
    });
    expect(panel.style.left).toBe("12px");
    expect(panel.style.top).toBe("12px");
    expect(JSON.parse(localStorage.getItem(`labweave-weekly-float:${mocks.project}`)!)).toMatchObject({ x: 12, y: 12 });
    expect(mocks.ensure).not.toHaveBeenCalled();
    expect(clampWeeklyFloat({ x: 5000, y: 5000 }, 336, 400, 1024, 768)).toEqual({ x: 676, y: 356 });
  });

  it("retains completed next-week tasks in the accomplishments section", () => {
    const next = { ...task("Next step"), section: "next" as const, done: true };
    expect(weeklySectionItems(record([next]), "done")).toEqual([next]);
    expect(weeklySectionItems(record([next]), "next")).toEqual([]);
  });
});
