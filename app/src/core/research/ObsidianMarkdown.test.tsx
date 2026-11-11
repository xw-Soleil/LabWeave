// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ resolve: vi.fn(), create: vi.fn(), open: vi.fn(), error: vi.fn() }));
vi.mock("./DocumentLinks", () => ({ createDocumentLinkResolver: mocks.create }));
vi.mock("./DocumentTab", () => ({ openDocumentFile: mocks.open }));
vi.mock("sonner", () => ({ toast: { error: mocks.error } }));
vi.mock("i18next", () => ({ default: { t: (key: string) => key } }));
import Markdown from "@/components/ui/markdown";
import { katexCompatible } from "./ObsidianMarkdown";

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.create.mockReturnValue(mocks.resolve);
  mocks.resolve.mockImplementation(async (target: string) =>
    target === "missing" ? null : { path: `/project/${target.split("#")[0]}.md`, heading: target.split("#")[1] },
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
async function render(source: string, inDocument = false) {
  await act(async () => {
    root.render(<Markdown source={source} document={inDocument ? { path: "/project/notes/source.md" } : undefined} />);
  });
  await act(async () => {
    await vi.dynamicImportSettled();
  });
}

describe("Obsidian Markdown display", () => {
  it("renders nested callouts, formatted titles, default titles and the required DOM", async () => {
    await render(
      "> [!WARNING]+ **Careful**\n> First line\n>\n> - item\n>\n> > [!note]\n> > Nested\n\n> Ordinary quote",
    );
    const callout = container.querySelector(".callout")!;
    expect(callout.getAttribute("data-callout")).toBe("warning");
    expect(callout.getAttribute("data-fold")).toBe("+");
    expect(callout.querySelector(".callout-title strong")?.textContent).toBe("Careful");
    expect(callout.querySelector(".callout-icon svg.lucide-triangle-alert")).not.toBeNull();
    expect(callout.querySelector(".callout-content p")?.textContent).toBe("First line");
    expect(callout.querySelector("li")?.textContent?.trim()).toBe("item");
    expect(callout.querySelector('[data-callout="note"] .callout-title')?.textContent).toBe("Note");
    expect(container.querySelector("blockquote")?.textContent).toContain("Ordinary quote");
  });

  it("keeps fold state on the page and supports click, Enter and Space", async () => {
    await render("> [!tip]- Hidden\n> body\n\n> [!info]+ Open\n> body");
    const titles = container.querySelectorAll<HTMLElement>(".callout-title");
    const bodies = container.querySelectorAll<HTMLElement>(".callout-content");
    expect(bodies[0].hidden).toBe(true);
    expect(bodies[1].hidden).toBe(false);
    await act(async () => titles[0].click());
    expect(bodies[0].hidden).toBe(false);
    expect(titles[0].getAttribute("aria-expanded")).toBe("true");
    await act(async () => titles[0].dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(bodies[0].hidden).toBe(true);
    await act(async () => titles[1].dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true })));
    expect(bodies[1].hidden).toBe(true);
  });

  it.each([
    ["summary", "clipboard-list"],
    ["tldr", "clipboard-list"],
    ["info", "info"],
    ["todo", "circle-check"],
    ["hint", "flame"],
    ["important", "flame"],
    ["success", "check"],
    ["done", "check"],
    ["question", "circle-question-mark"],
    ["help", "circle-question-mark"],
    ["faq", "circle-question-mark"],
    ["caution", "triangle-alert"],
    ["attention", "triangle-alert"],
    ["failure", "x"],
    ["fail", "x"],
    ["missing", "x"],
    ["danger", "zap"],
    ["error", "zap"],
    ["bug", "bug"],
    ["example", "list"],
    ["quote", "quote"],
    ["cite", "quote"],
    ["unknown", "pencil"],
    ["constructor", "pencil"],
  ])("uses the Obsidian icon for %s", async (type, icon) => {
    await render(`> [!${type}]\n> body`);
    expect(container.querySelector(`.callout-icon svg.lucide-${icon}`)).not.toBeNull();
  });

  it("leaves AI wikilinks and embeds as text and does not look for files", async () => {
    await render("[[paper]] [[paper|Alias]] ![[figure.png|300]]\n\n> [!note] AI note");
    expect(container.querySelector(".wikilink, img")).toBeNull();
    expect(container.textContent).toContain("[[paper|Alias]]");
    expect(container.querySelector(".callout")).not.toBeNull();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("opens resolved links with aliases and headings, and reports unresolved notes", async () => {
    await render("[[paper]] [[paper#Methods|方法]] [[missing]] ![[paper|Embedded note]]", true);
    const links = container.querySelectorAll<HTMLAnchorElement>("a.wikilink");
    expect(links).toHaveLength(4);
    expect(links[1].textContent).toBe("方法");
    expect(links[1].dataset.target).toBe("paper#Methods");
    expect(links[2].classList.contains("is-unresolved")).toBe(true);
    await act(async () => {
      links[1].click();
      await vi.dynamicImportSettled();
    });
    expect(mocks.open).toHaveBeenCalledWith("/project/paper.md", { heading: "Methods" });
    await act(async () => {
      links[2].click();
      await vi.dynamicImportSettled();
    });
    expect(mocks.error).toHaveBeenCalledWith("document.errors.noteNotFound");
    expect(mocks.open).toHaveBeenCalledOnce();
  });

  it("does not parse escaped syntax, code, math or existing Markdown links", async () => {
    await render(
      "\\[[escaped]] `[[code]]` $[[math]]$ [label [[inside]]](https://example.com)\n\n```md\n![[code.png]]\n> [!note]\n```\n\n> \\[!tip] escaped\n\n[[real]]",
      true,
    );
    expect(container.querySelectorAll(".wikilink")).toHaveLength(1);
    expect(container.querySelector(".wikilink")?.textContent).toBe("real");
    expect(container.querySelector(".callout")).toBeNull();
    expect(mocks.resolve).toHaveBeenCalledTimes(1);
  });

  it("shows file lookup failures instead of silently treating them as missing notes", async () => {
    mocks.resolve.mockRejectedValue(new Error("linkReadFailed"));
    await render("[[paper]]", true);
    expect(container.querySelector('[role="status"]')?.textContent).toBe("document.errors.linkReadFailed");
  });

  it("passes encoded local image paths and width to the existing renderer, keeping Markdown embeds as links", async () => {
    mocks.resolve.mockImplementation(async (target: string) => ({
      path: target === "note.md" ? "c:/Project/note.md" : "c:/Project/assets/50% 图.png",
    }));
    const Image = (props: ComponentProps<"img">) => <img {...props} />;
    await act(async () =>
      root.render(
        <Markdown
          source="![[50% 图.png|300]] ![[note.md]]"
          document={{ path: "C:\\PROJECT\\notes\\source.md" }}
          components={{ img: Image }}
        />,
      ),
    );
    await act(async () => {
      await vi.dynamicImportSettled();
    });
    expect(container.querySelectorAll("img")).toHaveLength(1);
    expect(container.querySelector("img")?.getAttribute("src")).toBe("../assets/50%25%20%E5%9B%BE.png");
    expect(container.querySelector("img")?.getAttribute("width")).toBe("300");
    expect(container.querySelector("a.wikilink")?.textContent).toBe("note.md");
  });

  it("marks blank source lines above blocks and list items like the user's spacing-sync plugin", async () => {
    await render("# A\n\n## B\n\n\npara\n$$\nx\n$$\n\n- one\n\n- two\n\n![p](x.png)\n\n*cap*", true);
    const body = container.querySelector(".markdown-body")!;
    expect(body.classList.contains("prose")).toBe(false);
    expect(body.querySelector("h1")?.getAttribute("data-blank")).toBeNull();
    expect(body.querySelector("h2")?.getAttribute("data-blank")).toBe("1");
    expect(body.querySelector("h2")?.getAttribute("data-after-heading")).toBe("true");
    expect(body.querySelector("p")?.getAttribute("data-blank")).toBe("2");
    // 整行公式紧跟在段落后面，没有空行；KaTeX 换掉的是里面那层，标记留在外面
    expect(body.querySelector(".math-block")?.getAttribute("data-blank")).toBeNull();
    expect(body.querySelector(".math-block > .katex-display")).not.toBeNull();
    expect(body.querySelector(".katex-mathml")).toBeNull();
    const items = body.querySelectorAll("li");
    expect(items[0].getAttribute("data-blank")).toBeNull();
    expect(items[1].getAttribute("data-blank")).toBe("1");
    expect(body.querySelector(".reading-caption")?.textContent).toBe("cap");
  });

  it("accepts operators written straight after _ or ^ the way Obsidian's MathJax does", async () => {
    expect(katexCompatible(String.raw`h_\max \le V^\sup + \text_\mathrm{x} + \maxima_\maxima`)).toBe(
      String.raw`h_{\max} \le V^{\sup} + \text_\mathrm{x} + \maxima_\maxima`,
    );
    await render(String.raw`约束 $h(x_0) \le h_\max$，以及 $$V_\max$$`);
    expect(container.querySelectorAll(".katex")).toHaveLength(2);
    expect(container.querySelector(".katex-error")).toBeNull();
  });
});
