// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  stat: vi.fn(),
  writeFile: vi.fn(),
  open: vi.fn(),
  theme: { preset: "default" },
}));
vi.mock("@tauri-apps/plugin-fs", () => ({ readFile: mocks.readFile, stat: mocks.stat, writeFile: mocks.writeFile }));
vi.mock("@tauri-apps/plugin-shell", () => ({ open: mocks.open }));
vi.mock("@/core/research/ResearchFolder", () => ({
  ResearchFolder: { ensureRootRegistered: vi.fn() },
  notifyResearchFilesChanged: vi.fn(),
}));
vi.mock("@/core/service/Settings", () => ({ Settings: { use: () => [mocks.theme] } }));
vi.mock("./DocumentLinks", () => ({
  createDocumentLinkResolver: () => async (target: string) =>
    target.startsWith("https:")
      ? null
      : { path: target.endsWith(".png") ? "/research/fig/a.png" : "/research/notes/note.md" },
}));
vi.mock("@/core/service/Telemetry", () => ({ Telemetry: {} }));
vi.mock("@/components/ui/dialog", () => ({ Dialog: { buttons: vi.fn(async () => "reload") } }));
vi.mock("i18next", () => ({ default: { t: (key: string) => key } }));
import { activeResourceTabAtom, activeTabAtom, store, tabsAtom } from "@/state";
import { activeDocumentTab, DocumentTab } from "./DocumentTab";
import DocumentView from "./DocumentView";
import { readingContextAtom } from "./ReadingContext";
import { editorText } from "./DocumentFile";

let root: Root;
let container: HTMLDivElement;
let storage: Map<string, string>;
/** 打开文档时用阅读还是编辑，记在本机；测试里大多先用阅读视图看渲染结果 */
const viewMode = (mode: "read" | "edit", editMode: "live" | "source" = "live") => {
  storage.set("labweave.markdownView", mode);
  storage.set("labweave.markdownEditMode", editMode);
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.theme = { preset: "default" };
  storage = new Map();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, value),
  });
  viewMode("read");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  URL.createObjectURL = vi.fn(() => "blob:local-image");
  URL.revokeObjectURL = vi.fn();
  mocks.stat.mockResolvedValue({ mtime: new Date(1), size: 10 });
  mocks.open.mockResolvedValue(undefined);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("Markdown document view", () => {
  it("inherits theme variables in both editor and preview without styling the shared Markdown component", async () => {
    mocks.readFile.mockResolvedValue(new TextEncoder().encode("note"));
    const tab = new DocumentTab("/r/a.md", "markdown");
    await tab.loadMarkdown();
    await act(async () => root.render(<DocumentView tab={tab} />));
    const host = container.querySelector<HTMLElement>('[style*="--reading-font-size"]')!;
    expect(host.style.getPropertyValue("--reading-font-size")).toBe("15px");
    expect(host.contains(container.querySelector(".prose"))).toBe(true);
    expect(container.querySelector(".prose")?.getAttribute("style")).toBeNull();
    mocks.theme = { preset: "obsidian" };
    await act(async () => root.render(<DocumentView tab={tab} />));
    expect(host.style.getPropertyValue("--reading-font-size")).toBe("16px");
    expect(host.style.getPropertyValue("--reading-table-margin")).toBe("auto");
    await act(async () =>
      container.querySelector<HTMLButtonElement>('button[aria-label="document.modes.toEdit"]')!.click(),
    );
    const editorHost = container.querySelector<HTMLElement>('[style*="--reading-font-size"]')!;
    expect(editorHost.contains(container.querySelector(".cm-content"))).toBe(true);
    expect(storage.get("labweave.markdownView")).toBe("edit");
  });

  it("edits in live preview and source mode without changing untouched text, and shows properties as a table", async () => {
    viewMode("edit", "live");
    const text = "---\ntitle: 笔记\ntags:\n  - pde\n---\n# 标题\n\n正文 **加粗**\n";
    mocks.readFile.mockResolvedValue(new TextEncoder().encode(text));
    const tab = new DocumentTab("/r/a.md", "markdown");
    await tab.loadMarkdown();
    await act(async () => root.render(<DocumentView tab={tab} />));
    expect(container.querySelector(".markdown-editor")?.getAttribute("data-mode")).toBe("live");
    expect(container.querySelector(".note-properties")?.textContent).toContain("noteProperties.title");
    expect(container.querySelector(".cm-lp-h1")).not.toBeNull();
    expect(container.querySelector(".cm-content")?.textContent).not.toContain("title: 笔记");
    viewMode("edit", "source");
    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => root.render(<DocumentView tab={tab} />));
    expect(container.querySelector(".markdown-editor")?.getAttribute("data-mode")).toBe("source");
    expect(container.querySelector(".cm-content")?.textContent).toContain("title: 笔记");
    expect(editorText(tab.markdown!.text)).toBe(text);
    expect(tab.hasUnsavedChanges).toBe(false);
  });

  it("uses DocumentImage and releases its URL for local wikilink images with a width", async () => {
    mocks.readFile.mockImplementation(async (path: string) =>
      new TextEncoder().encode(path.endsWith(".md") ? "![[a.png|300]] ![[https://host/tracking.png]]" : "png"),
    );
    const tab = new DocumentTab("/research/notes/a.md", "markdown");
    await tab.loadMarkdown();
    await act(async () => root.render(<DocumentView tab={tab} />));
    await act(async () => {
      await vi.dynamicImportSettled();
    });
    expect(mocks.readFile).toHaveBeenCalledWith("/research/fig/a.png");
    expect(container.querySelectorAll("img")).toHaveLength(1);
    expect(container.querySelector("img")?.getAttribute("width")).toBe("300");
    expect(container.querySelector("img")?.getAttribute("src")).toBe("blob:local-image");
    await act(async () => root.render(null));
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:local-image");
  });

  it("scrolls to a requested heading after loading the target document", async () => {
    mocks.readFile.mockResolvedValue(new TextEncoder().encode("## Methods\nbody"));
    const tab = new DocumentTab("/r/a.md", "markdown");
    tab.markdownHeading = "Methods";
    await tab.loadMarkdown();
    const scroll = vi.fn();
    HTMLElement.prototype.scrollIntoView = scroll;
    await act(async () => root.render(<DocumentView tab={tab} />));
    expect(scroll).toHaveBeenCalledWith({ block: "start" });
    expect(scroll.mock.instances[0]).toBe(container.querySelector(".prose h2"));
    expect(tab.markdownHeading).toBeUndefined();
  });

  it("keeps Obsidian source, BOM and CRLF bytes unchanged through preview, folding and saving an unrelated edit", async () => {
    const original = "\uFEFF# 原文\r\n> [!tip]- 提示\r\n> 内容\r\n\r\n[[笔记#标题|别名]]\r\n![[笔记.md]]\r\nend\r\n";
    let disk = new TextEncoder().encode(original);
    mocks.readFile.mockImplementation(async () => disk);
    mocks.writeFile.mockImplementation(async (_path, bytes) => {
      disk = bytes;
    });
    const tab = new DocumentTab("/r/a.md", "markdown");
    await tab.loadMarkdown();
    await act(async () => root.render(<DocumentView tab={tab} />));
    await act(async () => {
      await vi.dynamicImportSettled();
    });
    await act(async () => container.querySelector<HTMLElement>(".callout-title")!.click());
    expect(tab.markdown!.text).toBe(original);
    expect(tab.hasUnsavedChanges).toBe(false);
    await act(async () => {
      await tab.save();
    });
    expect(mocks.writeFile).not.toHaveBeenCalled();
    tab.markdown!.edit(editorText(original).replace("end", "edited"));
    await act(async () => {
      await tab.save();
    });
    expect(disk).toEqual(new TextEncoder().encode(original.replace("end", "edited")));
  });

  it("reveals a heading inside collapsed callouts before scrolling to it", async () => {
    mocks.readFile.mockResolvedValue(
      new TextEncoder().encode("> [!note]- Outer\n>\n> > [!tip]- Inner\n> >\n> > ## Target\n> > body"),
    );
    const tab = new DocumentTab("/r/a.md", "markdown");
    tab.markdownHeading = "Target";
    await tab.loadMarkdown();
    const scroll = vi.fn();
    HTMLElement.prototype.scrollIntoView = scroll;
    let frame!: FrameRequestCallback;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frame = callback;
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    await act(async () => root.render(<DocumentView tab={tab} />));
    expect(container.querySelectorAll(".callout-content[hidden]")).toHaveLength(0);
    await act(async () => frame(0));
    expect(scroll.mock.instances[0]).toBe(container.querySelector(".prose h2"));
    expect(tab.hasUnsavedChanges).toBe(false);
  });
  it("renders inline/block math, tables and scoped relative images; disposes image URLs", async () => {
    mocks.readFile.mockImplementation(async (path: string) =>
      new TextEncoder().encode(
        path.endsWith(".md")
          ? "# Note\n$x^2$\n\n$$\ny=1\n$$\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n![figure](../fig/a.png)"
          : "png",
      ),
    );
    const tab = new DocumentTab("/research/notes/a.md", "markdown");
    await tab.loadMarkdown();
    await act(async () => root.render(<DocumentView tab={tab} />));
    expect(container.querySelectorAll(".katex")).toHaveLength(2);
    expect(container.querySelector("table")?.textContent).toContain("ab12");
    expect(mocks.readFile).toHaveBeenCalledWith("/research/fig/a.png");
    expect(container.querySelector("img")?.getAttribute("src")).toBe("blob:local-image");
    await act(async () => root.render(null));
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:local-image");
  });
  it("does not load remote image URLs from untrusted Markdown", async () => {
    mocks.readFile.mockResolvedValue(new TextEncoder().encode("![tracking](https://host/pixel.png)"));
    const tab = new DocumentTab("/r/a.md", "markdown");
    await tab.loadMarkdown();
    await act(async () => root.render(<DocumentView tab={tab} />));
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("document.errors.imageNotLocal");
    expect(mocks.readFile).toHaveBeenCalledOnce();
  });
  it("does not launch executable relative links from a Markdown preview", async () => {
    mocks.readFile.mockResolvedValue(new TextEncoder().encode("[read paper](../helper.exe)"));
    const tab = new DocumentTab("/r/notes/a.md", "markdown");
    await tab.loadMarkdown();
    await act(async () => root.render(<DocumentView tab={tab} />));
    await act(async () => container.querySelector("a")!.click());
    expect(mocks.open).not.toHaveBeenCalled();
  });
  it("never gives untrusted links to native WebView navigation", async () => {
    mocks.readFile.mockResolvedValue(new TextEncoder().encode("[web](https://example.com) [local](./b.md)"));
    const tab = new DocumentTab("/r/a.md", "markdown");
    await tab.loadMarkdown();
    await act(async () => root.render(<DocumentView tab={tab} />));
    expect([...container.querySelectorAll("a")].map((link) => link.getAttribute("href"))).toEqual(["#", "#"]);
    await act(async () => container.querySelector("a")!.click());
    expect(mocks.open).toHaveBeenCalledWith("https://example.com");
  });
  it("drops raw HTML and keeps KaTeX remote content untrusted", async () => {
    mocks.readFile.mockResolvedValue(
      new TextEncoder().encode(
        '<script>alert(1)</script>\n\n<img src="https://host/pixel.png" onerror="alert(1)">\n\n<iframe src="https://host"></iframe>\n\n$\\includegraphics{https://host/pixel.png}$',
      ),
    );
    const tab = new DocumentTab("/r/a.md", "markdown");
    await tab.loadMarkdown();
    await act(async () => root.render(<DocumentView tab={tab} />));
    expect(container.querySelector("script, img, iframe, object, embed")).toBeNull();
    expect(mocks.readFile).toHaveBeenCalledOnce();
  });
  it("does not replace edits made while a reload is in flight", async () => {
    mocks.readFile.mockResolvedValue(new TextEncoder().encode("original"));
    const tab = new DocumentTab("/r/a.md", "markdown");
    await tab.loadMarkdown();
    await act(async () => root.render(<DocumentView tab={tab} />));
    let finish!: (bytes: Uint8Array) => void;
    mocks.readFile.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await act(async () =>
      container
        .querySelector('button[aria-label="document.modes.more"]')!
        .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
    );
    await act(async () =>
      [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
        .find((item) => item.textContent === "document.reload")!
        .click(),
    );
    tab.markdown!.edit("new edits");
    await act(async () => finish(new TextEncoder().encode("disk")));
    expect(tab.markdown!.text).toBe("new edits");
    expect(tab.hasUnsavedChanges).toBe(true);
    expect(tab.error).toBe("document.errors.editsDuringReload");
  });
  it("makes a document focused by keyboard the save target", async () => {
    mocks.readFile.mockResolvedValue(new TextEncoder().encode("note"));
    const first = new DocumentTab("/r/a.md", "markdown");
    const second = new DocumentTab("/r/b.md", "markdown");
    await Promise.all([first.loadMarkdown(), second.loadMarkdown()]);
    store.set(tabsAtom, [first, second]);
    store.set(activeTabAtom, first);
    store.set(activeResourceTabAtom, first);
    await act(async () =>
      root.render(
        <>
          <DocumentView tab={first} />
          <DocumentView tab={second} />
        </>,
      ),
    );
    // 阅读视图里没有能获得焦点的输入框，用标题旁的书本按钮代替键盘焦点
    await act(async () =>
      container.querySelectorAll<HTMLButtonElement>('button[aria-label="document.modes.toEdit"]')[1].focus(),
    );
    expect(activeDocumentTab()).toBe(second);
    expect(store.get(readingContextAtom)).toMatchObject({ path: second.path, kind: "markdown", title: "b" });
    await act(async () => {
      const paragraph = container.querySelectorAll(".prose p")[1];
      const range = document.createRange();
      range.selectNodeContents(paragraph);
      window.getSelection()!.removeAllRanges();
      window.getSelection()!.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });
    await vi.waitFor(() => expect(store.get(readingContextAtom)?.selection?.text).toBe("note"));
  });
});
