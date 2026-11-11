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
});
