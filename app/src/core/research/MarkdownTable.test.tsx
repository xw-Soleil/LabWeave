// @vitest-environment jsdom
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { history } from "@codemirror/commands";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("i18next", () => ({ default: { t: (key: string) => key } }));
import { livePreview, type LivePreviewConfig } from "./MarkdownLivePreview";
import {
  deleteTableColumn,
  deleteTableRow,
  insertTableColumn,
  insertTableRow,
  parseTable,
  setTableAlign,
  setTableCell,
} from "./MarkdownTable";

const TABLE = ["|  Name | Score  |", "|:--|--:|", "| a \\| b | 1 |", "| c |"].join("\n");

describe("Markdown table edits", () => {
  it("reads alignments, escaped pipes and short rows", () => {
    expect(parseTable(TABLE)).toEqual({
      header: ["Name", "Score"],
      align: ["left", "right"],
      rows: [
        ["a | b", "1"],
        ["c", ""],
      ],
    });
  });

  it("rewrites only the lines that change", () => {
    const lines = (source: string) => source.split("\n");
    const cell = lines(setTableCell(TABLE, { row: 1, column: 1 }, "x|y"));
    expect(cell).toEqual([...lines(TABLE).slice(0, 3), "| c | x\\|y |"]);
    expect(setTableCell(TABLE, { row: -1, column: 0 }, "Name")).toBe(TABLE);
    expect(lines(insertTableRow(TABLE, 1))).toEqual([...lines(TABLE).slice(0, 3), "|  |  |", "| c |"]);
    expect(lines(deleteTableRow(TABLE, 0))).toEqual([...lines(TABLE).slice(0, 2), "| c |"]);
    const aligned = lines(setTableAlign(TABLE, 0, "center"));
    expect(aligned[1]).toBe("| :---: | ---: |");
    expect(aligned.filter((line, index) => line !== lines(TABLE)[index])).toHaveLength(1);
  });

  it("rewrites the whole table when columns change", () => {
    expect(insertTableColumn(TABLE, 1)).toBe(
      ["| Name |  | Score |", "| :--- | --- | ---: |", "| a \\| b |  | 1 |", "| c |  |  |"].join("\n"),
    );
    expect(deleteTableColumn(TABLE, 0)).toBe(["| Score |", "| ---: |", "| 1 |", "|  |"].join("\n"));
    expect(deleteTableColumn("| a |\n| - |", 0)).toBe("| a |\n| - |");
  });
});

describe("Markdown table in live preview", () => {
  let host: HTMLDivElement;
  let view: EditorView;
  const config: LivePreviewConfig = {
    renderMarkdown: (source) => <span>{source}</span>,
    renderImage: () => null,
    renderEmbed: () => null,
    openLink: vi.fn(),
    openWikilink: vi.fn(),
  };

  beforeEach(async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    host = document.createElement("div");
    document.body.append(host);
    await act(async () => {
      view = new EditorView({
        parent: host,
        state: EditorState.create({
          doc: `Intro\n\n${TABLE}\n\nAfter`,
          extensions: [history(), markdown({ base: markdownLanguage }), livePreview(() => config)],
        }),
      });
    });
  });

  afterEach(() => {
    view.destroy();
    host.remove();
    vi.unstubAllGlobals();
  });

  const input = () => host.querySelector<HTMLElement>(".cm-lp-table [role=textbox]")!;
  const type = async (element: HTMLElement, value: string) => {
    await act(async () => {
      element.textContent = value;
      element.dispatchEvent(new InputEvent("input", { bubbles: true }));
    });
  };
  const press = async (element: HTMLElement, key: string, options: KeyboardEventInit = {}) => {
    await act(async () => {
      element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options }));
    });
  };

  it("edits a cell in place, keeps focus there, and moves with Tab and Enter", async () => {
    expect(host.querySelector(".cm-content")?.textContent).not.toContain("|:--|");
    const first = host.querySelector<HTMLElement>(".cm-lp-table th [role=button]")!;
    // 按着拖过格子选了字：松手不进编辑，选区留着
    const cells = host.querySelectorAll<HTMLElement>(".cm-lp-table td [role=button]");
    await act(async () => {
      first.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
      window.getSelection()!.setBaseAndExtent(first.firstChild!, 0, cells[1], cells[1].childNodes.length);
      first.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
    });
    expect(document.activeElement).toBe(first);
    expect(host.querySelector(".cm-lp-table-input")).toBeNull();
    expect(window.getSelection()!.toString()).toContain("Name");
    window.getSelection()!.removeAllRanges();
    await act(async () => {
      first.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
    });
    const header = input();
    expect(header.textContent).toBe("Name");
    expect(document.activeElement).toBe(header);

    await type(header, "Title");
    expect(view.state.doc.toString()).toBe(
      `Intro\n\n${TABLE.replace("|  Name | Score  |", "| Title | Score |")}\n\nAfter`,
    );
    // 改完以后还是同一个输入格，光标没丢
    expect(header.isConnected).toBe(true);
    expect(document.activeElement).toBe(header);

    await press(header, "Tab");
    expect(input().textContent).toBe("Score");

    await press(input(), "z", { metaKey: true });
    expect(view.state.doc.toString()).toBe(`Intro\n\n${TABLE}\n\nAfter`);

    // 一路回车到最后一行再回车，下面自动加一行，光标进新行
    await press(input(), "Enter");
    await press(input(), "Enter");
    await press(input(), "Enter");
    expect(view.state.doc.toString()).toBe(`Intro\n\n${TABLE}\n|  |  |\n\nAfter`);
    expect(input().closest("tr")).toBe(host.querySelector(".cm-lp-table tbody tr:last-child"));
  });
});
