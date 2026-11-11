import { redo, undo } from "@codemirror/commands";
import { StringStream, syntaxTree } from "@codemirror/language";
import { stexMath } from "@codemirror/legacy-modes/mode/stex";
import { EditorSelection, EditorState, StateEffect, StateField, type Extension, type Range } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet } from "@codemirror/view";
import type { MarkdownConfig } from "@lezer/markdown";
import katex from "katex";
import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { TableEditor } from "./MarkdownTable";
import { NoteProperties, splitFrontmatter } from "./NoteProperties";
import { katexCompatible } from "./ObsidianMarkdown";

/**
 * 照 Obsidian 把开头 `---` 之间那段当成「笔记属性」块。
 * 不加这条的话，Markdown 会把属性最后一行当成二级标题（下面紧跟着 ---）。
 */
export const frontmatterSyntax: MarkdownConfig = {
  defineNodes: [{ name: "Frontmatter", block: true }],
  parseBlock: [
    {
      name: "Frontmatter",
      before: "HorizontalRule",
      parse(cx, line) {
        if (cx.lineStart !== 0 || !/^---[ \t]*$/.test(line.text)) return false;
        let end = line.text.length;
        while (cx.nextLine()) {
          end = cx.lineStart + line.text.length;
          if (/^---[ \t]*$/.test(line.text)) {
            cx.nextLine();
            break;
          }
        }
        cx.addElement(cx.elt("Frontmatter", 0, end));
        return true;
      },
    },
  ],
};

export interface LivePreviewConfig {
  /** 提示框、表格这类整块，用和阅读模式同一个 Markdown 组件画出来 */
  renderMarkdown: (source: string) => ReactNode;
  renderImage: (src: string, alt: string) => ReactNode;
  /** `![[图片]]`：和阅读模式一样按文件名在项目或文献库里找 */
  renderEmbed: (target: string, width?: number) => ReactNode;
  openLink: (href: string) => void;
  openWikilink: (target: string) => void;
}

interface Mounted {
  root: Root;
  observer: ResizeObserver;
  view: EditorView;
  id: string;
}
const mounted = new WeakMap<HTMLElement, Mounted>();
/**
 * 滚出视野的小部件先留着（每个编辑器最多 PARKED_LIMIT 个），滚回来直接拿来用，
 * 提示框、公式、表格不用每次重新排版。编辑器关掉或换成源码模式时全部卸掉。
 */
const parked = new WeakMap<EditorView, Map<string, HTMLElement>>();
const PARKED_LIMIT = 150;
/** 画过的小部件有多高；还没画到的时候按这个估，滚动条和跳转不会忽长忽短。表格每改一个字就换一个 key，所以只记最近的 */
const heights = new Map<string, number>();
const HEIGHTS_LIMIT = 2000;
function rememberHeight(id: string, height: number) {
  heights.delete(id);
  heights.set(id, height);
  if (heights.size > HEIGHTS_LIMIT) heights.delete(heights.keys().next().value!);
}

function unmount(dom: HTMLElement) {
  const entry = mounted.get(dom);
  if (!entry) return;
  mounted.delete(dom);
  entry.observer.disconnect();
  // 编辑器可能在 React 渲染途中销毁小部件，推迟卸载
  queueMicrotask(() => entry.root.unmount());
}

/**
 * 把一段 React 画进编辑器；key 相同就不重画。
 * interactive：里面有输入框（笔记属性、表格），编辑器不接管里面的鼠标和键盘；
 * 否则点一下就把光标放进去、露出原文（提示框）。
 */
class ReactWidget extends WidgetType {
  constructor(
    readonly key: string,
    readonly block: boolean,
    readonly className: string,
    readonly interactive: boolean,
    readonly render: (view: EditorView, dom: HTMLElement) => ReactNode,
  ) {
    super();
  }
  get id() {
    return `${this.className}\n${this.key}`;
  }
  get estimatedHeight() {
    return heights.get(this.id) ?? -1;
  }
  eq(other: ReactWidget) {
    return other.key === this.key && other.className === this.className;
  }
  toDOM(view: EditorView) {
    const pool = parked.get(view);
    const reused = pool?.get(this.id);
    if (reused) {
      pool!.delete(this.id);
      mounted.get(reused)!.root.render(this.render(view, reused));
      return reused;
    }
    const dom = document.createElement(this.block ? "div" : "span");
    dom.className = this.className;
    // 图片读完、提示框展开这类自己变高的情况，编辑器不知道，要告诉它重新量
    const observer = new ResizeObserver(() => {
      const entry = mounted.get(dom);
      if (!entry || !dom.isConnected) return;
      if (dom.offsetHeight > 0) rememberHeight(entry.id, dom.offsetHeight);
      entry.view.requestMeasure();
    });
    observer.observe(dom);
    const root = createRoot(dom);
    mounted.set(dom, { root, observer, view, id: this.id });
    // 当场画完再交给编辑器：不然滚到眼前的第一帧是空的，下一帧填上内容时高度一变，下面的字整体跳一下
    flushSync(() => root.render(this.render(view, dom)));
    return dom;
  }
  updateDOM(dom: HTMLElement, view: EditorView) {
    const entry = mounted.get(dom);
    if (!entry || dom.className !== this.className) return false;
    entry.id = this.id;
    entry.root.render(this.render(view, dom));
    return true;
  }
  destroy(dom: HTMLElement) {
    const entry = mounted.get(dom);
    if (!entry) return;
    const pool = parked.get(entry.view);
    if (!pool || pool.has(entry.id)) {
      unmount(dom);
      return;
    }
    pool.set(entry.id, dom);
    if (pool.size > PARKED_LIMIT) {
      const [oldest, element] = pool.entries().next().value!;
      pool.delete(oldest);
      unmount(element);
    }
  }
  ignoreEvent() {
    return this.interactive;
  }
}

/** 实时预览开着的这段时间才留小部件；关掉时把留着的全部卸掉 */
const widgetPool = ViewPlugin.define((view) => {
  parked.set(view, new Map());
  return {
    destroy() {
      const pool = parked.get(view);
      parked.delete(view);
      pool?.forEach(unmount);
    },
  };
});

class TextWidget extends WidgetType {
  constructor(
    readonly text: string,
    readonly className: string,
  ) {
    super();
  }
  eq(other: TextWidget) {
    return other.text === this.text && other.className === this.className;
  }
  toDOM() {
    const span = document.createElement("span");
    span.className = this.className;
    span.textContent = this.text;
    return span;
  }
  ignoreEvent() {
    return false;
  }
}

class LinkWidget extends WidgetType {
  constructor(
    readonly label: string,
    readonly target: string,
  ) {
    super();
  }
  eq(other: LinkWidget) {
    return other.label === this.label && other.target === this.target;
  }
  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-lp-link cm-lp-wikilink";
    span.dataset.lpWikilink = this.target;
    span.textContent = this.label;
    return span;
  }
  ignoreEvent() {
    return false;
  }
}

class HrWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const div = document.createElement("div");
    div.className = "cm-lp-hr";
    div.append(document.createElement("hr"));
    return div;
  }
  ignoreEvent() {
    return false;
  }
}

/** 排好的公式按原文记下来，滚回来、换行重排时不用再算一遍 */
const mathHtml = new Map<string, string>();
const MATH_HTML_LIMIT = 1000;
function renderMath(tex: string, display: boolean) {
  const key = `${display ? "D" : "I"}${tex}`;
  let html = mathHtml.get(key);
  if (html === undefined) {
    // KaTeX 默认不信任输入（trust 关着），只生成排版用的标签
    html = katex.renderToString(katexCompatible(tex), { displayMode: display, throwOnError: false });
    if (mathHtml.size >= MATH_HTML_LIMIT) mathHtml.delete(mathHtml.keys().next().value!);
    mathHtml.set(key, html);
  }
  return html;
}

/**
 * 快速滚动时，公式滚到离视野 FILL_MARGIN 以内才真正排版。
 * 编辑器每次会把视野上下各一千来像素一起画出来，公式多的笔记一下子要排几十个公式（每个几十个小标签），
 * 那一帧就卡；改成离得近了才排，一帧只排几个。不在滚动时（打字、挪光标）照常当场排好，不闪。
 */
const FILL_MARGIN = 300;
let lastScroll = 0;
const scrolling = () => performance.now() - lastScroll < 200;
const pendingFills = new WeakMap<Element, { fill: () => void; observer: IntersectionObserver }>();
const fillObservers = new WeakMap<EditorView, IntersectionObserver>();

function scrollParent(element: HTMLElement) {
  for (let parent = element.parentElement; parent; parent = parent.parentElement)
    if (/^(auto|scroll)$/.test(getComputedStyle(parent).overflowY)) return parent;
  return null;
}

function fillWhenNear(view: EditorView, dom: HTMLElement, fill: () => void) {
  if (typeof IntersectionObserver === "undefined" || !scrolling()) {
    fill();
    return;
  }
  let observer = fillObservers.get(view);
  if (!observer) {
    observer = new IntersectionObserver(
      (entries, self) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          self.unobserve(entry.target);
          const pending = pendingFills.get(entry.target);
          pendingFills.delete(entry.target);
          pending?.fill();
        }
      },
      { root: scrollParent(view.dom), rootMargin: `${FILL_MARGIN}px 0px` },
    );
    fillObservers.set(view, observer);
  }
  pendingFills.set(dom, { fill, observer });
  observer.observe(dom);
}

function cancelFill(dom: Element) {
  pendingFills.get(dom)?.observer.unobserve(dom);
  pendingFills.delete(dom);
}

if (typeof document !== "undefined")
  document.addEventListener("scroll", () => (lastScroll = performance.now()), { capture: true, passive: true });

/** 整行公式排好后有多高：下次还没画到时按这个估，滚动条不忽长忽短，还没排时也按这个高度占位 */
const mathBlockTex = new WeakMap<Element, string>();
const mathBlockSizes =
  typeof ResizeObserver === "undefined"
    ? null
    : new ResizeObserver((entries) => {
        for (const entry of entries) {
          const tex = mathBlockTex.get(entry.target);
          const height = entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height;
          if (tex !== undefined && height > 0 && !pendingFills.has(entry.target))
            rememberHeight(`math\n${tex}`, Math.round(height));
        }
      });

class MathWidget extends WidgetType {
  constructor(
    readonly tex: string,
    readonly display: boolean,
    /** 光标在公式里时，源码下面照常显示排好的公式（和 Obsidian 一样） */
    readonly preview = false,
  ) {
    super();
  }
  eq(other: MathWidget) {
    return other.tex === this.tex && other.display === this.display && other.preview === this.preview;
  }
  get estimatedHeight() {
    return this.display && !this.preview ? (heights.get(`math\n${this.tex}`) ?? -1) : -1;
  }
  toDOM(view: EditorView) {
    const dom = document.createElement(this.display ? "div" : "span");
    dom.className = this.display ? `cm-lp-math-block${this.preview ? " cm-lp-math-preview" : ""}` : "cm-lp-math";
    if (this.display && !this.preview) {
      mathBlockTex.set(dom, this.tex);
      mathBlockSizes?.observe(dom);
    }
    // 还没排的时候先放原文占位（透明），宽度和排好的差不多，排好时这一行几乎不动
    dom.textContent = this.tex;
    dom.classList.add("cm-lp-math-pending");
    const height = this.estimatedHeight;
    if (height > 0) dom.style.minHeight = `${height}px`;
    fillWhenNear(view, dom, () => {
      dom.classList.remove("cm-lp-math-pending");
      dom.style.minHeight = "";
      dom.innerHTML = renderMath(this.tex, this.display);
    });
    return dom;
  }
  updateDOM(dom: HTMLElement) {
    // 改公式时只换里面的排版，不重建外面这一块，下面的内容不会跳
    if (!this.display || !dom.classList.contains("cm-lp-math-block") || pendingFills.has(dom)) return false;
    if (dom.classList.contains("cm-lp-math-preview") !== this.preview) return false;
    dom.innerHTML = renderMath(this.tex, true);
    if (!this.preview) mathBlockTex.set(dom, this.tex);
    return true;
  }
  destroy(dom: HTMLElement) {
    cancelFill(dom);
    mathBlockSizes?.unobserve(dom);
  }
  ignoreEvent() {
    return false;
  }
}

/** 公式源码照 CodeMirror 的 LaTeX 模式分词（Obsidian 编辑器也是 CodeMirror）：命令、字母、数字、括号各一种颜色 */
const MATH_TOKEN_CLASS: Record<string, string> = {
  tag: "cm-math-command",
  "variableName.special": "cm-math-letter",
  number: "cm-math-number",
  bracket: "cm-math-bracket",
  comment: "cm-math-comment",
};

export function mathTokens(tex: string) {
  const tokens: { from: number; to: number; className: string }[] = [];
  let offset = 0;
  for (const text of tex.split("\n")) {
    // 每行从公式状态重新开始：LaTeX 模式遇到空行会退回正文状态
    const state = stexMath.startState!(2);
    const stream = new StringStream(text, 2, 2);
    while (!stream.eol()) {
      const style = stexMath.token(stream, state);
      if (stream.pos === stream.start) stream.next();
      const className = style && MATH_TOKEN_CLASS[style];
      if (className) tokens.push({ from: offset + stream.start, to: offset + stream.pos, className });
      stream.start = stream.pos;
    }
    offset += text.length + 1;
  }
  return tokens;
}

interface MathBlock {
  from: number;
  to: number;
  /** $$ 中间的原文（不含 $$） */
  texFrom: number;
  texTo: number;
}

/** 整行公式 $$ … $$：开头一行以 $$ 起，到下一个以 $$ 收尾的行为止 */
function mathBlocks(state: EditorState, skip: (from: number, to: number) => boolean) {
  const found: MathBlock[] = [];
  for (let number = 1; number <= state.doc.lines; number++) {
    const start = state.doc.line(number);
    const open = /^\s*\$\$/.exec(start.text);
    if (!open || skip(start.from, start.to)) continue;
    let end = start;
    const single = /^\s*\$\$(.+)\$\$\s*$/.test(start.text);
    if (!single) {
      let next = number + 1;
      while (next <= state.doc.lines && !/\$\$\s*$/.test(state.doc.line(next).text)) next++;
      if (next > state.doc.lines) continue;
      end = state.doc.line(next);
    }
    const close = end.from + end.text.replace(/\s+$/, "").length - 2;
    found.push({ from: start.from, to: end.to, texFrom: start.from + open[0].length, texTo: close });
    number = end.number;
  }
  return found;
}

const INLINE_MATH = /(?<![\\$])\$(?=\S)([^$\n]*?\S)\$(?!\$)/g;

/** 点排好的公式：把公式原文整段选中（不含 $），和 Obsidian 一样 */
function mathSourceAt(state: EditorState, dom: HTMLElement, at: number): Interval | undefined {
  if (dom.classList.contains("cm-lp-math-block")) {
    const block = mathBlocks(state, () => false).find((math) => at >= math.from && at <= math.to);
    return block && [block.texFrom, block.texTo];
  }
  const match = /^\$(?=\S)([^$\n]*?\S)\$(?!\$)/.exec(state.doc.sliceString(at, state.doc.lineAt(at).to));
  return match ? [at + 1, at + match[0].length - 1] : undefined;
}

class CheckboxWidget extends WidgetType {
  constructor(
    readonly checked: boolean,
    readonly at: number,
  ) {
    super();
  }
  eq(other: CheckboxWidget) {
    return other.checked === this.checked && other.at === this.at;
  }
  toDOM(view: EditorView) {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "cm-lp-task";
    box.checked = this.checked;
    box.addEventListener("mousedown", (event) => event.preventDefault());
    box.addEventListener("click", (event) => {
      event.preventDefault();
      view.dispatch({ changes: { from: this.at + 1, to: this.at + 2, insert: this.checked ? " " : "x" } });
    });
    return box;
  }
}

/** 表格占的整几行；按改动当时的位置找，打字让表格挪了位置也不会写错地方 */
function tableAt(state: EditorState, at: number): Interval | undefined {
  let found: Interval | undefined;
  syntaxTree(state).iterate({
    from: at,
    to: at + 1,
    enter(node) {
      if (found) return false;
      if (node.name !== "Table") return;
      found = [state.doc.lineAt(node.from).from, state.doc.lineAt(node.to).to];
      return false;
    },
  });
  return found;
}

function tableActions(view: EditorView, dom: HTMLElement) {
  const range = () => tableAt(view.state, view.posAtDOM(dom));
  return {
    edit(change: (source: string) => string) {
      const found = range();
      if (!found) return;
      const before = view.state.doc.sliceString(found[0], found[1]);
      const after = change(before);
      if (after === before) return;
      // 只把真正变了的那几个字交给编辑器，撤销记录和打字一样一段一段的
      let start = 0;
      while (start < before.length && start < after.length && before[start] === after[start]) start++;
      let end = 0;
      while (
        end < before.length - start &&
        end < after.length - start &&
        before[before.length - 1 - end] === after[after.length - 1 - end]
      )
        end++;
      view.dispatch({
        changes: { from: found[0] + start, to: found[1] - end, insert: after.slice(start, after.length - end) },
        userEvent: "input.table",
      });
    },
    undo: () => undo(view),
    redo: () => redo(view),
    leave() {
      const found = range();
      view.focus();
      if (found) view.dispatch({ selection: { anchor: Math.min(found[1] + 1, view.state.doc.length) } });
    },
  };
}

type Interval = [number, number];

function touches(selection: EditorSelection, from: number, to: number) {
  return selection.ranges.some((range) => range.from <= to && range.to >= from);
}

const CODE_NODES = new Set(["InlineCode", "FencedCode", "CodeBlock", "Frontmatter", "HTMLBlock"]);
const IMAGE_FILE = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i;

/** selection：按哪个选区决定露出原文；拖选途中用按下鼠标前的选区，排版不动 */
function build(state: EditorState, config: () => LivePreviewConfig, selection = state.selection): DecorationSet {
  const decorations: Range<Decoration>[] = [];
  const blocks: Interval[] = [];
  const code: Interval[] = [];
  const text = state.doc.toString();
  const inBlock = (from: number, to: number) => blocks.some(([start, end]) => from >= start && to <= end);
  const inCode = (from: number, to: number) => code.some(([start, end]) => from < end && to > start);
  const block = (from: number, to: number, widget: WidgetType) => {
    blocks.push([from, to]);
    decorations.push(Decoration.replace({ widget, block: true }).range(from, to));
  };
  const hide = (from: number, to: number) => {
    if (from < to && !inBlock(from, to)) decorations.push(Decoration.replace({}).range(from, to));
  };
  const line = (from: number, className: string) => {
    if (!inBlock(from, from)) decorations.push(Decoration.line({ class: className }).range(from));
  };
  const lineActive = (at: number) => {
    const current = state.doc.lineAt(at);
    return touches(selection, current.from, current.to);
  };

  // 笔记属性：照 Obsidian 总是显示成表格，在表格里直接改
  const frontmatter = splitFrontmatter(text);
  if (frontmatter) {
    const yamlFrom = frontmatter.opening.length;
    const fence = frontmatter.closing.replace(/\r?\n$/, "");
    block(
      0,
      yamlFrom + frontmatter.yaml.length + fence.length,
      new ReactWidget(frontmatter.yaml, true, "cm-lp-properties", true, (view) => (
        <NoteProperties
          yaml={frontmatter.yaml}
          onChange={(yaml) => {
            const current = splitFrontmatter(view.state.doc.toString());
            if (!current) return;
            const from = current.opening.length;
            view.dispatch({ changes: { from, to: from + current.yaml.length, insert: yaml } });
          }}
        />
      )),
    );
  }

  const tree = syntaxTree(state);
  // 第一遍：整块替换的（提示框、表格、分隔线），光标进去就露出原文
  tree.iterate({
    enter(node) {
      if (CODE_NODES.has(node.name)) code.push([node.from, node.to]);
      if (inBlock(node.from, node.to)) return false;
      const from = state.doc.lineAt(node.from).from;
      const to = state.doc.lineAt(node.to).to;
      const active = touches(selection, from, to);
      if (node.name === "Blockquote") {
        const source = state.doc.sliceString(from, to);
        const callout = /^>\s*\[![\w-]+\]/.test(source);
        if (callout && !active) {
          block(from, to, new ReactWidget(source, true, "cm-lp-embed", false, () => config().renderMarkdown(source)));
          return false;
        }
        for (let at = from; at <= to; ) {
          const current = state.doc.lineAt(at);
          line(current.from, callout ? "cm-lp-quote cm-lp-callout-raw" : "cm-lp-quote");
          at = current.to + 1;
        }
        // 露出原文时 [!类型] 这类记号变浅，和正文分得开
        const type = callout && /^(>\s*)(\[![\w-]+\][+-]?)/.exec(source);
        if (type)
          decorations.push(
            Decoration.mark({ class: "cm-md-mark" }).range(
              from + type[1].length,
              from + type[1].length + type[2].length,
            ),
          );
        return;
      }
      // 正文里的表格总是显示成表格，点格子直接改；引用、列表里的表格还是光标进去露出原文
      if (node.name === "Table" && node.node.parent?.name === "Document") {
        const source = state.doc.sliceString(from, to);
        block(
          from,
          to,
          new ReactWidget(`table:${source}`, true, "cm-lp-table-block", true, (view, dom) => (
            <TableEditor
              source={source}
              {...tableActions(view, dom)}
              renderInline={(cell) => config().renderMarkdown(cell)}
            />
          )),
        );
        return false;
      }
      if (node.name === "Table" && !active) {
        const source = state.doc.sliceString(from, to);
        block(from, to, new ReactWidget(source, true, "cm-lp-embed", false, () => config().renderMarkdown(source)));
        return false;
      }
      if (node.name === "HorizontalRule" && !active) {
        block(from, to, new HrWidget());
        return false;
      }
    },
  });

  // 公式原文：$ 和 $$ 变浅，中间等宽字、按 LaTeX 分词上色
  const mathSource = (texFrom: number, texTo: number) => {
    const mark = (from: number, to: number, className: string) => {
      if (from < to) decorations.push(Decoration.mark({ class: className }).range(from, to));
    };
    mark(texFrom, texTo, "cm-lp-math-tex");
    for (const token of mathTokens(state.doc.sliceString(texFrom, texTo)))
      mark(texFrom + token.from, texFrom + token.to, token.className);
  };

  // 整行公式 $$ … $$；光标进去时露出原文，排好的公式留在原文下面
  for (const math of mathBlocks(state, (from, to) => inBlock(from, to) || inCode(from, to))) {
    const tex = state.doc.sliceString(math.texFrom, math.texTo).trim();
    if (!touches(selection, math.from, math.to)) {
      block(math.from, math.to, new MathWidget(tex, true));
      continue;
    }
    code.push([math.from, math.to]);
    decorations.push(Decoration.mark({ class: "cm-lp-math-mark" }).range(math.texFrom - 2, math.texFrom));
    decorations.push(Decoration.mark({ class: "cm-lp-math-mark" }).range(math.texTo, math.texTo + 2));
    mathSource(math.texFrom, math.texTo);
    if (tex)
      decorations.push(
        Decoration.widget({ widget: new MathWidget(tex, true, true), block: true, side: 1 }).range(math.to),
      );
  }

  // 第二遍：行内的
  tree.iterate({
    enter(node) {
      if (inBlock(node.from, node.to)) return false;
      const name = node.name;
      const active = touches(selection, node.from, node.to);
      const heading = /^ATXHeading(\d)$/.exec(name);
      if (heading) {
        // 「标题 + 一个空行 + 标题」时第二个标题上方不多留，和阅读模式一样
        const current = state.doc.lineAt(node.from);
        const afterHeading =
          current.number > 2 &&
          !state.doc.line(current.number - 1).text.trim() &&
          /^#{1,6}\s/.test(state.doc.line(current.number - 2).text);
        line(current.from, `cm-lp-h cm-lp-h${heading[1]}${afterHeading ? " cm-lp-h-after" : ""}`);
        if (!active)
          for (let child = node.node.firstChild; child; child = child.nextSibling)
            if (child.name === "HeaderMark") hide(child.from, text[child.to] === " " ? child.to + 1 : child.to);
        return;
      }
      if (name === "FencedCode") {
        const first = state.doc.lineAt(node.from).number;
        const last = state.doc.lineAt(node.to).number;
        for (let number = first; number <= last; number++) {
          const edge = number === first || number === last;
          line(
            state.doc.line(number).from,
            [
              "cm-lp-codeblock",
              number === first && "cm-lp-codeblock-first",
              number === last && "cm-lp-codeblock-last",
              edge && "cm-lp-codeblock-fence",
            ]
              .filter(Boolean)
              .join(" "),
          );
        }
        return false;
      }
      if (["Emphasis", "StrongEmphasis", "Strikethrough", "InlineCode"].includes(name)) {
        if (!active)
          for (let child = node.node.firstChild; child; child = child.nextSibling)
            if (/Mark$/.test(child.name)) hide(child.from, child.to);
        return name !== "InlineCode";
      }
      if (name === "QuoteMark") {
        if (!lineActive(node.from)) hide(node.from, text[node.to] === " " ? node.to + 1 : node.to);
        return;
      }
      if (name === "ListMark" && node.node.parent?.parent?.name === "BulletList") {
        if (!lineActive(node.from))
          decorations.push(
            Decoration.replace({ widget: new TextWidget("•", "cm-lp-bullet") }).range(node.from, node.to),
          );
        return;
      }
      if (name === "ListMark" && node.node.parent?.parent?.name === "OrderedList") {
        // 序号和阅读模式一样用主色
        decorations.push(Decoration.mark({ class: "cm-lp-ordered-mark" }).range(node.from, node.to));
        return;
      }
      if (name === "TaskMarker") {
        if (!active)
          decorations.push(
            Decoration.replace({
              widget: new CheckboxWidget(/x/i.test(state.doc.sliceString(node.from, node.to)), node.from),
            }).range(node.from, node.to),
          );
        return;
      }
      if (name === "Image") {
        const url = node.node.getChild("URL");
        if (!active && url) {
          const src = state.doc.sliceString(url.from, url.to);
          const alt = /^!\[([^\]]*)\]/.exec(state.doc.sliceString(node.from, node.to))?.[1] ?? "";
          decorations.push(
            Decoration.replace({
              widget: new ReactWidget(`img:${src}:${alt}`, false, "cm-lp-image", false, () =>
                config().renderImage(src, alt),
              ),
            }).range(node.from, node.to),
          );
        }
        return false;
      }
      if (name === "Link") {
        const marks = node.node.getChildren("LinkMark");
        const url = node.node.getChild("URL");
        if (!active && marks.length >= 2 && url && marks[1].from > marks[0].to) {
          hide(marks[0].from, marks[0].to);
          decorations.push(
            Decoration.mark({
              attributes: { class: "cm-lp-link", "data-lp-href": state.doc.sliceString(url.from, url.to) },
            }).range(marks[0].to, marks[1].from),
          );
          hide(marks[1].from, node.to);
        }
        return false;
      }
    },
  });

  // 空行照用户 Obsidian 的「间距同步」：正文里一个空行 16px，引用里只有「>」的空行半个字高，和阅读模式一样
  for (let number = 1; number <= state.doc.lines; number++) {
    const current = state.doc.line(number);
    if (inCode(current.from, current.to)) continue;
    if (!current.text.trim()) line(current.from, "cm-lp-blank");
    else if (/^\s*>\s*$/.test(current.text)) line(current.from, "cm-lp-blank-inner");
  }

  // 双链、嵌入、行内公式：语法树里没有，按文字找，跳过代码
  const patterns: [RegExp, "wikilink" | "math"][] = [
    [/(!?)\[\[([^[\]\n]+?)\]\]/g, "wikilink"],
    [INLINE_MATH, "math"],
  ];
  for (const [pattern, kind] of patterns) {
    for (const match of text.matchAll(pattern)) {
      const from = match.index!;
      const to = from + match[0].length;
      if (inBlock(from, to) || inCode(from, to)) continue;
      if (touches(selection, from, to)) {
        if (kind === "math") {
          decorations.push(Decoration.mark({ class: "cm-lp-math-mark" }).range(from, from + 1));
          decorations.push(Decoration.mark({ class: "cm-lp-math-mark" }).range(to - 1, to));
          mathSource(from + 1, to - 1);
        }
        continue;
      }
      if (kind === "math") {
        decorations.push(Decoration.replace({ widget: new MathWidget(match[1], false) }).range(from, to));
        continue;
      }
      const [target, alias] = match[2].split("|");
      const file = target.trim();
      if (match[1]) {
        const width = Number(alias);
        if (IMAGE_FILE.test(file))
          decorations.push(
            Decoration.replace({
              widget: new ReactWidget(`embed:${match[2]}`, false, "cm-lp-image", false, () =>
                config().renderEmbed(file, Number.isFinite(width) && width > 0 ? width : undefined),
              ),
            }).range(from, to),
          );
        continue;
      }
      decorations.push(Decoration.replace({ widget: new LinkWidget((alias ?? target).trim(), file) }).range(from, to));
    }
  }

  return Decoration.set(decorations, true);
}

/** 按着鼠标拖选的这段时间排版不动，松手那一刻才把选中的地方露出原文（和 Obsidian 一样） */
const pointerSelecting = StateEffect.define<boolean>();

interface Preview {
  decorations: DecorationSet;
  /** 按下鼠标前的选区；拖选途中按它排版，松手后清掉 */
  frozen: EditorSelection | null;
}

/** 实时预览：光标所在的地方露出原始写法，其他地方显示成排好版的样子 */
export function livePreview(config: () => LivePreviewConfig): Extension {
  const field = StateField.define<Preview>({
    create: (state) => ({ decorations: build(state, config), frozen: null }),
    update(value, transaction) {
      let frozen = value.frozen && transaction.docChanged ? value.frozen.map(transaction.changes) : value.frozen;
      for (const effect of transaction.effects)
        if (effect.is(pointerSelecting)) frozen = effect.value ? (frozen ?? transaction.startState.selection) : null;
      if (
        transaction.docChanged ||
        syntaxTree(transaction.startState) !== syntaxTree(transaction.state) ||
        (value.frozen && !frozen) ||
        (transaction.selection && !frozen)
      )
        return { decorations: build(transaction.state, config, frozen ?? transaction.state.selection), frozen };
      return frozen === value.frozen ? value : { decorations: value.decorations, frozen };
    },
    provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
  });
  return [
    widgetPool,
    field,
    EditorView.domEventHandlers({
      mousedown(event, view) {
        if (event.button !== 0) return false;
        const target = event.target instanceof Element ? event.target : null;
        const link = target?.closest<HTMLElement>("[data-lp-href], [data-lp-wikilink]");
        if (link) {
          event.preventDefault();
          if (link.dataset.lpHref) config().openLink(link.dataset.lpHref);
          else if (link.dataset.lpWikilink) config().openWikilink(link.dataset.lpWikilink);
          return true;
        }
        const math = target?.closest<HTMLElement>(".cm-lp-math, .cm-lp-math-block");
        const source = math && !event.shiftKey && mathSourceAt(view.state, math, view.posAtDOM(math));
        if (source) {
          event.preventDefault();
          view.focus();
          view.dispatch({ selection: EditorSelection.single(source[0], source[1]), userEvent: "select.pointer" });
          return true;
        }
        view.dispatch({ effects: pointerSelecting.of(true) });
        const release = () => {
          for (const type of ["mouseup", "dragend", "blur"]) window.removeEventListener(type, release, true);
          if (view.dom.isConnected) view.dispatch({ effects: pointerSelecting.of(false) });
        };
        for (const type of ["mouseup", "dragend", "blur"]) window.addEventListener(type, release, true);
        return false;
      },
    }),
  ];
}
