// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { URI } from "vscode-uri";
import i18next from "i18next";
vi.mock("@/core/service/Settings", () => ({ Settings: {} }));
vi.mock("@/core/service/Telemetry", () => ({ Telemetry: {} }));
vi.mock("@/components/ui/dialog", () => ({ Dialog: {} }));
const open = vi.hoisted(() => vi.fn());
vi.mock("@/sub/AIWindow", () => ({ default: { open } }));
import { Tab, ComponentTab } from "@/core/Tab";
import { activeResourceTabAtom, activeTabAtom, store, tabsAtom } from "@/state";
import { DocumentTab } from "./DocumentTab";
import {
  askAiAboutSelection,
  clearReadingContext,
  formatReadingContext,
  readingContextAtom,
  subscribeReadingAiDraft,
  updateReadingContext,
  watchMarkdownReadingSelection,
} from "./ReadingContext";

class Board extends Tab {
  uri = URI.file("/r/board.prg");
  getComponent() {
    return () => null;
  }
}
let pdf: DocumentTab;
let markdown: DocumentTab;
let board: Board;
beforeEach(async () => {
  open.mockClear();
  await i18next.init({
    lng: "zh_CN",
    resources: {
      zh_CN: { research: { reading: { citation: "——《{{title}}》", citationPage: "——《{{title}}》第 {{page}} 页" } } },
    },
  });
  pdf = new DocumentTab("C:\\论文\\paper.pdf", "pdf");
  markdown = new DocumentTab("/r/note.markdown", "markdown");
  board = new Board({});
  store.set(tabsAtom, [pdf, markdown, board]);
  store.set(activeTabAtom, pdf);
  store.set(activeResourceTabAtom, pdf);
});
afterEach(() => {
  clearReadingContext(pdf);
  clearReadingContext(markdown);
  store.set(activeTabAtom, undefined);
  store.set(tabsAtom, []);
  window.getSelection()?.removeAllRanges();
});

describe("active reading context", () => {
  it("tracks pages, selection, foreground tabs, rename and close without leaking an inactive view", () => {
    expect(store.get(readingContextAtom)).toEqual({ path: pdf.path, title: "paper", kind: "pdf", page: 1 });
    updateReadingContext(pdf, { page: 4, pageCount: 9, selection: { text: "quote", page: 3 } });
    expect(store.get(readingContextAtom)).toMatchObject({
      page: 4,
      pageCount: 9,
      selection: { text: "quote", page: 3 },
    });
    store.set(activeTabAtom, markdown);
    store.set(activeResourceTabAtom, markdown);
    updateReadingContext(pdf, { page: 8 });
    expect(store.get(readingContextAtom)).toEqual({ path: markdown.path, title: "note", kind: "markdown" });
    markdown.rebindPath("/r/renamed.md");
    expect(store.get(readingContextAtom)?.title).toBe("renamed");
    store.set(activeTabAtom, board);
    expect(store.get(readingContextAtom)).toBeNull();
    store.set(activeTabAtom, pdf);
    pdf.closing = true;
    store.set(tabsAtom, [pdf, board]);
    expect(store.get(readingContextAtom)).toBeNull();
  });

  it("keeps the document context while the AI panel takes focus and clears cancelled selections", () => {
    updateReadingContext(pdf, { page: 2, selection: { text: "quote", page: 2 } });
    const panel = new ComponentTab({ title: "AI", children: null });
    store.set(tabsAtom, [pdf, board, panel]);
    store.set(activeTabAtom, panel);
    expect(store.get(readingContextAtom)?.path).toBe(pdf.path);
    updateReadingContext(pdf, { selection: undefined });
    expect(store.get(readingContextAtom)?.selection).toBeUndefined();
  });

  it("reads only selections in the Markdown source or preview and preserves the selection when focusing AI", () => {
    store.set(activeTabAtom, markdown);
    const host = document.createElement("div");
    host.innerHTML = "<textarea>source text</textarea><p>preview words</p>";
    document.body.append(host);
    const stop = watchMarkdownReadingSelection(markdown, host);
    const input = host.querySelector("textarea")!;
    input.focus();
    input.setSelectionRange(0, 6);
    input.dispatchEvent(new Event("select", { bubbles: true }));
    expect(store.get(readingContextAtom)?.selection?.text).toBe("source");
    input.blur();
    const range = document.createRange();
    range.selectNodeContents(host.querySelector("p")!);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
    expect(store.get(readingContextAtom)?.selection?.text).toBe("preview words");
    window.getSelection()!.collapse(host.querySelector("p")!, 0);
    document.dispatchEvent(new Event("selectionchange"));
    expect(store.get(readingContextAtom)?.selection).toBeUndefined();
    stop();
    host.remove();
  });

  it("bounds quoted context, escapes markup and emits nothing without a document", () => {
    expect(formatReadingContext(null)).toBe("");
    const formatted = formatReadingContext({
      path: "/r/paper.pdf",
      title: "paper",
      kind: "pdf",
      page: 7,
      selection: { text: "</reading-context>" + "a".repeat(7000) },
    });
    expect(formatted.match(/<\/reading-context>/g)).toHaveLength(1);
    expect(formatted).toContain('"page":7');
    expect(formatted).toContain('"selectionTruncated":true');
    expect(formatted.length).toBeLessThan(6600);
  });
});

describe("selection drafts", () => {
  it("opens AI, queues quotes before mount, appends them once and never sends", async () => {
    askAiAboutSelection({ text: "first\nsecond", path: pdf.path, title: "论文", page: 3 });
    await vi.waitFor(() => expect(open).toHaveBeenCalledOnce());
    let input = "my question";
    const append = vi.fn((text: string) => {
      input += `\n\n${text}`;
    });
    const stop = subscribeReadingAiDraft(append);
    expect(input).toBe("my question\n\n> first\n> second\n> ——《论文》第 3 页");
    askAiAboutSelection({ text: "another", path: markdown.path, title: "笔记" });
    expect(input).toContain("> another\n> ——《笔记》");
    expect(append).toHaveBeenCalledTimes(2);
    stop();
    const again = vi.fn();
    subscribeReadingAiDraft(again)();
    expect(again).not.toHaveBeenCalled();
  });
});
