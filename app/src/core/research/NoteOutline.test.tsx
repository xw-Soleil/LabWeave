// @vitest-environment jsdom
import { EventEmitter } from "node:events";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocumentTab } from "./DocumentTab";
import { NoteOutline } from "./NoteOutline";

let host: HTMLElement;
let view: Root;

function note(text: string) {
  const events = new EventEmitter();
  return Object.assign(events, { markdown: { text }, outlinePosition: undefined }) as unknown as DocumentTab;
}
async function show(tab: DocumentTab) {
  await act(async () => view.render(createElement(NoteOutline, { tab })));
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  Element.prototype.scrollIntoView = vi.fn();
  host = document.createElement("div");
  view = createRoot(host);
});
afterEach(async () => {
  await act(async () => view.unmount());
});

describe("the floating note outline", () => {
  it("stays out of the way when a note has fewer than three headings", async () => {
    await show(note("# One\n\ntext\n\n## Two\n"));
    expect(host.querySelector("nav")).toBeNull();
  });

  it("lists one row per heading, marks the one being read and jumps on click", async () => {
    const tab = note("---\ntitle: x\n---\n# One\n\n## Two **bold**\n\ntext\n\n### Three\n\n> # quoted\n");
    const jump = vi.fn();
    tab.on("outline-jump", jump);
    await show(tab);
    const rows = [...host.querySelectorAll("button")];
    expect(rows.map((row) => row.textContent)).toEqual(["One", "Two bold", "Three"]);
    expect(host.querySelector('[aria-current="location"]')).toBeNull();
    await act(async () => {
      tab.outlinePosition = { index: 1 };
      tab.emit("outline-position");
    });
    expect(host.querySelector('[aria-current="location"]')?.textContent).toBe("Two bold");
    await act(async () => rows[2].click());
    expect(jump).toHaveBeenCalledWith(expect.objectContaining({ text: "Three", level: 3 }), 2);
  });

  it("follows the caret line while editing", async () => {
    const tab = note("# One\n\n## Two\n\ntext\n\n## Three\n");
    await show(tab);
    await act(async () => {
      tab.outlinePosition = { line: 4 };
      tab.emit("outline-position");
    });
    expect(host.querySelector('[aria-current="location"]')?.textContent).toBe("Two");
  });
});
