import { redo, undo } from "@codemirror/commands";
import { syntaxTree } from "@codemirror/language";
import { EditorState, StateField, type Extension, type Range } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import type { MarkdownConfig } from "@lezer/markdown";
import katex from "katex";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { TableEditor } from "./MarkdownTable";
import { NoteProperties, splitFrontmatter } from "./NoteProperties";

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

const roots = new WeakMap<HTMLElement, Root>();

/**
 * 把一段 React 画进编辑器；key 相同就不重画。
 * interactive：里面有输入框（笔记属性），编辑器不接管里面的鼠标和键盘；
 * 否则点一下就把光标放进去、露出原文（提示框、表格）。
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
  eq(other: ReactWidget) {
    return other.key === this.key && other.className === this.className;
  }
  toDOM(view: EditorView) {
    const dom = document.createElement(this.block ? "div" : "span");
    dom.className = this.className;
    const root = createRoot(dom);
    roots.set(dom, root);
    root.render(this.render(view, dom));
    // React 画完以后再让编辑器量一次高度
    requestAnimationFrame(() => view.requestMeasure());
    return dom;
  }
  updateDOM(dom: HTMLElement, view: EditorView) {
    const root = roots.get(dom);
    if (!root || dom.className !== this.className) return false;
    root.render(this.render(view, dom));
    requestAnimationFrame(() => view.requestMeasure());
    return true;
  }
  destroy(dom: HTMLElement) {
    const root = roots.get(dom);
    roots.delete(dom);
    // 编辑器可能在 React 渲染途中销毁小部件，推迟卸载
    queueMicrotask(() => root?.unmount());
  }
  ignoreEvent() {
    return this.interactive;
  }
}

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

class MathWidget extends WidgetType {
  constructor(
    readonly tex: string,
    readonly display: boolean,
  ) {
    super();
  }
  eq(other: MathWidget) {
    return other.tex === this.tex && other.display === this.display;
  }
  toDOM() {
    const dom = document.createElement(this.display ? "div" : "span");
    dom.className = this.display ? "cm-lp-math-block" : "cm-lp-math";
    // KaTeX 默认不信任输入（trust 关着），只生成排版用的标签
    dom.innerHTML = katex.renderToString(this.tex, { displayMode: this.display, throwOnError: false });
    return dom;
  }
  ignoreEvent() {
    return false;
  }
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

function touches(state: EditorState, from: number, to: number) {
  return state.selection.ranges.some((range) => range.from <= to && range.to >= from);
}

const CODE_NODES = new Set(["InlineCode", "FencedCode", "CodeBlock", "Frontmatter", "HTMLBlock"]);
const IMAGE_FILE = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i;

function build(state: EditorState, config: () => LivePreviewConfig): DecorationSet {
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
    return touches(state, current.from, current.to);
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
      const active = touches(state, from, to);
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

  // 整行公式 $$ … $$
  for (let number = 1; number <= state.doc.lines; number++) {
    const start = state.doc.line(number);
    if (!/^\s*\$\$/.test(start.text) || inBlock(start.from, start.to) || inCode(start.from, start.to)) continue;
    let end = start;
    const single = /^\s*\$\$(.+)\$\$\s*$/.exec(start.text);
    if (!single) {
      let next = number + 1;
      while (next <= state.doc.lines && !/\$\$\s*$/.test(state.doc.line(next).text)) next++;
      if (next > state.doc.lines) continue;
      end = state.doc.line(next);
    }
    const source = state.doc.sliceString(start.from, end.to);
    const tex = single ? single[1] : source.replace(/^\s*\$\$/, "").replace(/\$\$\s*$/, "");
    if (!touches(state, start.from, end.to)) block(start.from, end.to, new MathWidget(tex.trim(), true));
    else code.push([start.from, end.to]);
    number = end.number;
  }

  // 第二遍：行内的
  tree.iterate({
    enter(node) {
      if (inBlock(node.from, node.to)) return false;
      const name = node.name;
      const active = touches(state, node.from, node.to);
      const heading = /^ATXHeading(\d)$/.exec(name);
      if (heading) {
        line(state.doc.lineAt(node.from).from, `cm-lp-h cm-lp-h${heading[1]}`);
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

  // 双链、嵌入、行内公式：语法树里没有，按文字找，跳过代码
  const patterns: [RegExp, "wikilink" | "math"][] = [
    [/(!?)\[\[([^[\]\n]+?)\]\]/g, "wikilink"],
    [/(?<![\\$])\$(?=\S)([^$\n]*?\S)\$(?!\$)/g, "math"],
  ];
  for (const [pattern, kind] of patterns) {
    for (const match of text.matchAll(pattern)) {
      const from = match.index!;
      const to = from + match[0].length;
      if (inBlock(from, to) || inCode(from, to) || touches(state, from, to)) continue;
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

/** 实时预览：光标所在的地方露出原始写法，其他地方显示成排好版的样子 */
export function livePreview(config: () => LivePreviewConfig): Extension {
  const field = StateField.define<DecorationSet>({
    create: (state) => build(state, config),
    update(value, transaction) {
      if (
        !transaction.docChanged &&
        !transaction.selection &&
        syntaxTree(transaction.startState) === syntaxTree(transaction.state)
      )
        return value;
      return build(transaction.state, config);
    },
    provide: (field) => EditorView.decorations.from(field),
  });
  return [
    field,
    EditorView.domEventHandlers({
      mousedown(event) {
        const target = event.target instanceof Element ? event.target : null;
        const link = target?.closest<HTMLElement>("[data-lp-href], [data-lp-wikilink]");
        if (!link || event.button !== 0) return false;
        event.preventDefault();
        if (link.dataset.lpHref) config().openLink(link.dataset.lpHref);
        else if (link.dataset.lpWikilink) config().openWikilink(link.dataset.lpWikilink);
        return true;
      },
    }),
  ];
}
