// @vitest-environment jsdom
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("i18next", () => ({ default: { t: (key: string) => key } }));
import { frontmatterSyntax, livePreview, type LivePreviewConfig } from "./MarkdownLivePreview";

const CALLOUT = "> [!note] Title\n> body";

describe("live preview block widgets", () => {
  let host: HTMLDivElement;
  const renders = vi.fn();
  const config: LivePreviewConfig = {
    renderMarkdown: (source) => {
      renders(source);
      return <p className="rendered">{source}</p>;
    },
    renderImage: () => null,
    renderEmbed: () => null,
    openLink: vi.fn(),
    openWikilink: vi.fn(),
  };

  beforeEach(() => {
    renders.mockClear();
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
  });

  afterEach(() => {
    host.remove();
    vi.unstubAllGlobals();
  });

  it("keeps a callout's drawing when it goes away and comes back, and unmounts it with the editor", async () => {
    let view!: EditorView;
    await act(async () => {
      view = new EditorView({
        parent: host,
        state: EditorState.create({
          doc: `Intro\n\n${CALLOUT}\n\nEnd`,
          extensions: [
            markdown({ base: markdownLanguage, extensions: [frontmatterSyntax] }),
            livePreview(() => config),
          ],
        }),
      });
    });
    const drawn = host.querySelector<HTMLElement>(".cm-lp-embed")!;
    expect(drawn.querySelector(".rendered")?.textContent).toBe(CALLOUT);
    expect(renders).toHaveBeenCalledTimes(1);

    // 删掉再撤回来（滚出视野再滚回来也是这样）：拿回原来那块，不重新画一遍 Markdown
    const from = "Intro\n\n".length;
    await act(async () => view.dispatch({ changes: { from, to: from + CALLOUT.length } }));
    expect(host.querySelector(".cm-lp-embed")).toBeNull();
    await act(async () => view.dispatch({ changes: { from, insert: CALLOUT } }));
    expect(host.querySelector(".cm-lp-embed")).toBe(drawn);
    expect(drawn.querySelector(".rendered")?.textContent).toBe(CALLOUT);

    await act(async () => view.destroy());
    expect(drawn.childElementCount).toBe(0);
  });

  const open = (doc: string, at = doc.length) =>
    new EditorView({
      parent: host,
      state: EditorState.create({
        doc,
        selection: { anchor: at },
        extensions: [markdown({ base: markdownLanguage, extensions: [frontmatterSyntax] }), livePreview(() => config)],
      }),
    });

  it("shows formula source in code colours with the drawn formula kept underneath", () => {
    const doc = "Text\n\n$$\n\\sum_k x^2\n$$\n\nEnd";
    const view = open(doc);
    expect(host.querySelectorAll(".cm-lp-math-block")).toHaveLength(1);
    expect(host.querySelector(".cm-lp-math-mark")).toBeNull();

    view.dispatch({ selection: { anchor: doc.indexOf("x^2") } });
    expect([...host.querySelectorAll(".cm-lp-math-mark")].map((mark) => mark.textContent)).toEqual(["$$", "$$"]);
    expect(host.querySelector(".cm-math-command")?.textContent).toBe("\\sum");
    expect([...host.querySelectorAll(".cm-math-letter")].map((mark) => mark.textContent)).toEqual(["k", "x"]);
    expect(host.querySelector(".cm-math-number")?.textContent).toBe("2");
    expect(host.querySelector(".cm-lp-math-preview .katex")).not.toBeNull();
    view.destroy();
  });

  it("selects the whole formula source when a drawn formula is clicked", () => {
    const doc = "a $x+1$ b\n\nEnd";
    const view = open(doc);
    host.querySelector(".cm-lp-math")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe("x+1");
    expect(host.querySelector(".cm-lp-math-tex")?.textContent).toBe("x+1");
    view.destroy();
  });

  it("keeps the layout while the mouse is held and reveals the selection on release", () => {
    const view = open("**bold** text\n\nEnd");
    const line = () => host.querySelector(".cm-line")!.textContent;
    expect(line()).toBe("bold text");

    host.querySelector(".cm-line")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    view.dispatch({ selection: { anchor: 2, head: 11 } });
    expect(line()).toBe("bold text");

    window.dispatchEvent(new MouseEvent("mouseup"));
    expect(line()).toBe("**bold** text");
    view.destroy();
  });

  it("lets a drag inside a callout select its text, and a plain click open its source", () => {
    const view = open(`Intro\n\n${CALLOUT}\n\nEnd`);
    const callout = () => host.querySelector<HTMLElement>(".cm-lp-embed");
    const text = callout()!.querySelector(".rendered")!.firstChild!;
    const before = view.state.selection.main.head;

    // 按下鼠标不能被取消：一取消，网页自己就不会开始选字（上一版就是这样，真机上一个字也选不中）
    const notPrevented = callout()!
      .querySelector(".rendered")!
      .dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    expect(notPrevented).toBe(true);
    expect(document.activeElement).toBe(callout());
    window.getSelection()!.setBaseAndExtent(text, 3, text, 8);
    window.dispatchEvent(new MouseEvent("mouseup"));
    // 拖选了字：选区留在提示框里，编辑器的光标不动，提示框也不展开
    expect(window.getSelection()!.toString()).toBe(CALLOUT.slice(3, 8));
    expect(view.state.selection.main.head).toBe(before);
    expect(callout()).not.toBeNull();

    callout()!
      .querySelector(".rendered")!
      .dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    window.getSelection()!.collapse(text, 2);
    window.dispatchEvent(new MouseEvent("mouseup"));
    // 只是点了一下：光标进到提示框开头，露出原文
    expect(view.state.selection.main.head).toBe("Intro\n\n".length);
    expect(callout()).toBeNull();
    view.destroy();
  });
});
