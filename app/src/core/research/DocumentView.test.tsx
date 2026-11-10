// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ readFile: vi.fn(), stat: vi.fn(), writeFile: vi.fn(), open: vi.fn() }));
vi.mock("@tauri-apps/plugin-fs", () => ({ readFile: mocks.readFile, stat: mocks.stat, writeFile: mocks.writeFile }));
vi.mock("@tauri-apps/plugin-shell", () => ({ open: mocks.open }));
vi.mock("@/core/research/ResearchFolder", () => ({
  ResearchFolder: { ensureRootRegistered: vi.fn() },
  notifyResearchFilesChanged: vi.fn(),
}));
vi.mock("@/core/service/Settings", () => ({ Settings: {} }));
vi.mock("@/core/service/Telemetry", () => ({ Telemetry: {} }));
vi.mock("@/components/ui/dialog", () => ({ Dialog: { buttons: vi.fn(async () => "reload") } }));
vi.mock("i18next", () => ({ default: { t: (key: string) => key } }));
import { activeResourceTabAtom, activeTabAtom, store, tabsAtom } from "@/state";
import { activeDocumentTab, DocumentTab } from "./DocumentTab";
import DocumentView from "./DocumentView";

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
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
      [...container.querySelectorAll("button")].find((button) => button.textContent === "document.reload")!.click(),
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
    await act(async () => container.querySelectorAll("textarea")[1].focus());
    expect(activeDocumentTab()).toBe(second);
  });
});
