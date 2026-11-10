// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  stat: vi.fn(),
  exists: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  open: vi.fn(),
  buttons: vi.fn(),
  error: vi.fn(),
  registerRoot: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-fs", () => ({
  stat: mocks.stat,
  exists: mocks.exists,
  readFile: mocks.readFile,
  writeFile: mocks.writeFile,
}));
vi.mock("@tauri-apps/plugin-shell", () => ({ open: mocks.open }));
vi.mock("@/core/research/ResearchFolder", () => ({
  ResearchFolder: { ensureRootRegistered: mocks.registerRoot, isInside: (path: string) => path.startsWith("/r/") },
  notifyResearchFilesChanged: vi.fn(),
}));
vi.mock("@/core/service/Settings", () => ({ Settings: {} }));
vi.mock("@/core/service/Telemetry", () => ({ Telemetry: {} }));
vi.mock("@/components/ui/dialog", () => ({ Dialog: { buttons: mocks.buttons } }));
vi.mock("sonner", () => ({ toast: { error: mocks.error } }));
vi.mock("i18next", () => ({ default: { t: (key: string) => key } }));
import { activeResourceTabAtom, activeTabAtom, store, tabsAtom, tabGroupRootAtom, activeGroupIdAtom } from "@/state";
import { TabWorkspace } from "@/core/TabWorkspace";
import { DocumentTab, openDocumentFile } from "./DocumentTab";

beforeEach(() => {
  vi.clearAllMocks();
  store.set(tabsAtom, []);
  store.set(activeTabAtom, undefined);
  store.set(activeResourceTabAtom, undefined);
  store.set(tabGroupRootAtom, null);
  store.set(activeGroupIdAtom, undefined);
  mocks.stat.mockResolvedValue({ isFile: true, mtime: new Date(1), size: 4, dev: 2, ino: 3 });
  mocks.exists.mockResolvedValue(true);
  mocks.readFile.mockResolvedValue(new TextEncoder().encode("note"));
  mocks.writeFile.mockImplementation(async (_path, bytes) => {
    mocks.readFile.mockResolvedValue(bytes);
  });
  mocks.open.mockResolvedValue(undefined);
  mocks.registerRoot.mockResolvedValue(undefined);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("document tab actions", () => {
  it("normalizes a renamed Windows PDF path without changing tab identity or reader location", () => {
    const tab = new DocumentTab("C:/papers/old.pdf", "pdf");
    const id = tab.id;
    tab.pdfLocation = { page: 3, scale: 1.5 };
    tab.rebindPath("C:\\papers\\new.pdf");
    expect(tab.path).toBe("c:/papers/new.pdf");
    expect(tab.title).toBe("new.pdf");
    expect(tab.id).toBe(id);
    expect(tab.pdfLocation).toEqual({ page: 3, scale: 1.5 });
  });

  it("opens an authorized noncurrent document without depending on the current project's disk", async () => {
    mocks.registerRoot.mockRejectedValue(new Error("current disk missing"));
    expect(await openDocumentFile("/other/a.md")).toBeInstanceOf(DocumentTab);
    expect(mocks.registerRoot).not.toHaveBeenCalled();
    await expect(openDocumentFile("/r/a.md")).rejects.toThrow("current disk missing");
  });
  it.each(["md", "pdf"])(
    "deduplicates concurrent %s opens, aliases and subsequent double clicks",
    async (extension) => {
      const [first, second] = await Promise.all([
        openDocumentFile(`/r/a.${extension}`),
        openDocumentFile(`/r/./a.${extension}`),
      ]);
      expect(first).toBe(second);
      const alias = await openDocumentFile(`/r/link.${extension}`);
      expect(alias).toBe(first);
      expect(store.get(tabsAtom)).toHaveLength(1);
      expect(store.get(activeResourceTabAtom)).toBe(first);
    },
  );
  it("preserves system opening for images and Office files", async () => {
    await openDocumentFile("/r/a.png");
    await openDocumentFile("/r/a.docx");
    expect(mocks.open.mock.calls).toEqual([["/r/a.png"], ["/r/a.docx"]]);
    expect(store.get(tabsAtom)).toHaveLength(0);
  });
  it("does not reuse a stale inode after the original path has been replaced", async () => {
    const first = await openDocumentFile("/r/a.md");
    mocks.stat.mockImplementation(async (path: string) => ({ isFile: true, dev: 2, ino: path === "/r/a.md" ? 4 : 3 }));
    const movedOriginal = await openDocumentFile("/r/moved.md");
    expect(movedOriginal).not.toBe(first);
    expect(movedOriginal!.path).toBe("/r/moved.md");
    expect(store.get(tabsAtom)).toHaveLength(2);
  });
  it("still deduplicates aliases after an external editor atomically replaces the file", async () => {
    const first = await openDocumentFile("/r/a.md");
    mocks.stat.mockResolvedValue({ isFile: true, dev: 2, ino: 4 });
    expect(await openDocumentFile("/r/link.md")).toBe(first);
    expect(store.get(tabsAtom)).toHaveLength(1);
  });
  it("does not open a tab when the scoped stat operation is denied", async () => {
    mocks.stat.mockRejectedValue(new Error("access denied"));
    await expect(openDocumentFile("/private/a.md")).rejects.toThrow("access denied");
    expect(store.get(tabsAtom)).toHaveLength(0);
  });
  it("keeps a dirty tab open on cancellation, and saves before closing", async () => {
    vi.useFakeTimers();
    const tab = (await openDocumentFile("/r/a.md"))!;
    await tab.loadMarkdown();
    tab.markdown!.edit("new note");
    expect(tab.hasUnsavedChanges).toBe(true);
    mocks.buttons.mockResolvedValueOnce("cancel");
    expect(await TabWorkspace.close(tab.id)).toBe(false);
    expect(tab.closing).toBe(false);
    mocks.buttons.mockResolvedValueOnce("save");
    const closing = TabWorkspace.close(tab.id);
    await vi.advanceTimersByTimeAsync(501);
    await closing;
    expect(mocks.writeFile).toHaveBeenCalledOnce();
    expect(tab.hasUnsavedChanges).toBe(false);
    expect(store.get(tabsAtom)).toHaveLength(0);
  });
  it("retains edited text and the tab when save conflicts", async () => {
    const tab = (await openDocumentFile("/r/a.md"))!;
    await tab.loadMarkdown();
    tab.markdown!.edit("edited");
    mocks.readFile.mockResolvedValue(new TextEncoder().encode("external"));
    mocks.buttons.mockResolvedValue("save");
    expect(await TabWorkspace.close(tab.id)).toBe(false);
    expect(tab.error).toBe("document.errors.fileChanged");
    expect(tab.markdown!.text).toBe("edited");
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });
  it("discards only after explicit confirmation and does not prompt for an unedited note", async () => {
    const tab = new DocumentTab("/r/a.md", "markdown");
    await tab.loadMarkdown();
    expect(await tab.beforeClose!()).toBe(true);
    expect(mocks.buttons).not.toHaveBeenCalled();
    tab.markdown!.edit("edit");
    mocks.buttons.mockResolvedValue("discard");
    expect(await tab.beforeClose!()).toBe(true);
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });
});
