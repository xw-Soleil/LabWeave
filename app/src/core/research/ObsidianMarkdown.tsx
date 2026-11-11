import i18next from "i18next";
import { cn } from "@/utils/cn";
import {
  Bug,
  Check,
  CircleCheck,
  CircleHelp,
  ClipboardList,
  Flame,
  Info,
  List,
  Pencil,
  Quote,
  TriangleAlert,
  X,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { Children, useEffect, useId, useState, type ComponentProps, type ComponentType, type ReactNode } from "react";
import { toast } from "sonner";
import type { ResolvedDocumentLink } from "./DocumentLinks";

interface HtmlNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HtmlNode[];
  position?: { start: { offset?: number; line?: number }; end: { offset?: number; line?: number } };
}

const text = (value: string): HtmlNode => ({ type: "text", value });
const element = (tagName: string, children: HtmlNode[], properties: Record<string, unknown> = {}): HtmlNode => ({
  type: "element",
  tagName,
  properties,
  children,
});
const nodeText = (node: HtmlNode): string => node.value ?? node.children?.map(nodeText).join("") ?? "";

const OPERATORS =
  "max|min|sup|inf|lim|liminf|limsup|log|ln|lg|exp|sin|cos|tan|cot|sec|csc|sinh|cosh|tanh|coth|arcsin|arccos|arctan|det|dim|ker|arg|deg|gcd|hom|Pr";
const BARE_OPERATOR_SCRIPT = new RegExp(String.raw`([_^])\s*(\\(?:${OPERATORS}))(?![a-zA-Z])`, "g");

/**
 * Obsidian 用 MathJax，认 `h_\max`、`x^\sin` 这种上下标直接跟运算符的写法；
 * KaTeX 不认，会显示成红字。交给 KaTeX 之前替它补上花括号。
 */
export function katexCompatible(tex: string): string {
  return tex.replace(BARE_OPERATOR_SCRIPT, "$1{$2}");
}

/** 阅读模式里公式交给 KaTeX 之前先过一遍 katexCompatible */
export function rehypeMathCompat() {
  return (tree: HtmlNode) => {
    const visit = (node: HtmlNode) => {
      const classes = node.properties?.className;
      if (
        node.tagName === "code" &&
        Array.isArray(classes) &&
        classes.some((name) => name === "math-inline" || name === "math-display")
      ) {
        for (const child of node.children ?? [])
          if (child.type === "text") child.value = katexCompatible(child.value ?? "");
        return;
      }
      node.children?.forEach(visit);
    };
    visit(tree);
  };
}

const isBlankLine = (line: string | undefined) => line !== undefined && line.trim() === "";
const MAX_BLANK = 4;

/**
 * 照用户 Obsidian 里自己写的「间距同步」插件排间距：每一块（每个列表项）上面源码里空了几行，
 * 就标上 data-blank，reading.css 按「一个空行 = 一个段落间距」排，块本身不带上下边距，
 * 阅读模式和实时预览的间距就一样了。「标题 + 一个空行 + 标题」的第二个标题标 data-after-heading，上方不多留。
 * 顺带把图注（图片后面单独一段的整行斜体）标成 reading-caption，CSS 里不用 :has()（Mac 的网页引擎里很慢）。
 */
export function rehypeReadingLayout(options: { enabled: boolean }) {
  return (tree: HtmlNode, file: { value: unknown }) => {
    if (!options.enabled || !tree.children) return;
    const lines = String(file.value).split("\n");
    /** 第 line 行（从 1 数）上面紧挨着几个空行，往上最多数到第 stop 行（不含） */
    const blanksBefore = (line: number, stop = 0) => {
      let count = 0;
      for (let index = line - 2; index >= stop && isBlankLine(lines[index]); index--) count++;
      return Math.min(count, MAX_BLANK);
    };
    const mark = (node: HtmlNode, blank: number) => {
      if (blank) node.properties = { ...node.properties, dataBlank: String(blank) };
    };
    const markListItems = (node: HtmlNode, stop: number) => {
      for (const child of node.children ?? []) {
        if (child.type !== "element") continue;
        if (child.tagName === "li" && child.position) mark(child, blanksBefore(child.position.start.line!, stop));
        markListItems(child, stop);
      }
    };
    const elements = tree.children.filter((child) => child.type === "element");
    tree.children = tree.children.map((child) => {
      if (child.type !== "element" || !child.position) return child;
      const start = child.position.start.line!;
      const blank = blanksBefore(start);
      // 整行公式会被 KaTeX 整个换掉，标记要打在外面包的一层上
      const math =
        child.tagName === "pre" &&
        child.children?.some((code) => (code.properties?.className as string[] | undefined)?.includes("math-display"));
      const target = math ? element("div", [child], { className: ["math-block"] }) : child;
      mark(target, blank);
      if (/^h[1-6]$/.test(child.tagName ?? "") && blank === 1 && /^#{1,6}\s/.test(lines[start - 3] ?? ""))
        target.properties = { ...target.properties, dataAfterHeading: "true" };
      if (child.tagName === "ul" || child.tagName === "ol") markListItems(child, start - 1);
      const previous = elements[elements.indexOf(child) - 1];
      if (child.tagName === "p" && previous && isImageParagraph(previous) && isCaption(child))
        target.properties = { ...target.properties, className: ["reading-caption"] };
      return target;
    });
  };
}

const isImageParagraph = (node: HtmlNode) =>
  node.tagName === "p" &&
  !!node.children?.some(
    (child) => child.tagName === "img" || (child.tagName === "reading-wikilink" && child.properties?.["data-embed"]),
  );
const isCaption = (node: HtmlNode) => {
  const content = node.children?.filter((child) => child.type === "element" || nodeText(child).trim()) ?? [];
  return content.length === 1 && content[0].tagName === "em";
};

export function rehypeObsidian(options: { document: boolean }) {
  return (tree: HtmlNode, file: { value: unknown }) => {
    const source = String(file.value);
    const rawText = (node: HtmlNode) => source.slice(node.position?.start.offset, node.position?.end.offset);
    function visit(node: HtmlNode) {
      if (["a", "code", "pre", "script", "style"].includes(node.tagName ?? "")) return;
      if (node.tagName === "blockquote") {
        const firstElement = node.children?.find((child) => child.type === "element");
        const paragraph = firstElement?.tagName === "p" ? firstElement : undefined;
        const first = paragraph?.children?.[0];
        const match = first?.type === "text" && /^\[!([\w-]+)\]([+-]?)[ \t]*/.exec(first.value ?? "");
        if (match && !rawText(first!).startsWith("\\")) {
          const type = match[1].toLowerCase();
          first!.value = first!.value!.slice(match[0].length);
          const children = paragraph!.children!;
          const lineEnd = children.findIndex((child) => child.tagName === "br");
          const title = children.slice(0, lineEnd < 0 ? undefined : lineEnd);
          const remainder = lineEnd < 0 ? [] : children.slice(lineEnd + 1);
          if (remainder[0]?.type === "text") remainder[0].value = remainder[0].value?.replace(/^\n/, "");
          const body = node.children!.slice(node.children!.indexOf(paragraph!) + 1);
          if (remainder.length) body.unshift(element("p", remainder));
          node.tagName = "reading-callout";
          node.properties = { "data-callout": type, "data-fold": match[2] };
          node.children = [
            element(
              "span",
              title.some((child) => nodeText(child).trim()) ? title : [text(type[0].toUpperCase() + type.slice(1))],
            ),
            ...body,
          ];
        }
      }
      if (!node.children) return;
      node.children = node.children.flatMap((child) => {
        if (options.document && child.type === "text") {
          const value = child.value ?? "";
          const pattern = /(!?)\[\[([^\]\n]+)\]\]/g;
          const raw = rawText(child);
          const originals = [...raw.matchAll(/(!?)\[\[([^\]\n]+)\]\]/g)];
          let originalIndex = 0;
          let offset = 0;
          const result: HtmlNode[] = [];
          for (const match of value.matchAll(pattern)) {
            const original = originals[originalIndex++];
            const escaped = original && /(?:^|[^\\])(?:\\\\)*\\$/.test(raw.slice(0, original.index));
            if (!original || escaped) continue;
            const [target, ...aliasParts] = match[2].split("|");
            if (!target.trim()) continue;
            const alias = aliasParts.join("|");
            const width =
              match[1] && /^\d+$/.test(alias) && Number.isSafeInteger(Number(alias)) && Number(alias) > 0
                ? Number(alias)
                : undefined;
            result.push(text(value.slice(offset, match.index)));
            result.push(
              element("reading-wikilink", [text(alias && !width ? alias : target)], {
                "data-target": target.trim(),
                "data-embed": match[1] ? "true" : undefined,
                "data-width": width,
              }),
            );
            offset = match.index! + match[0].length;
          }
          if (result.length) return [...result, text(value.slice(offset))];
        }
        visit(child);
        return [child];
      });
    }
    visit(tree);
  };
}

const icons: Record<string, LucideIcon> = {
  abstract: ClipboardList,
  summary: ClipboardList,
  tldr: ClipboardList,
  info: Info,
  todo: CircleCheck,
  tip: Flame,
  hint: Flame,
  important: Flame,
  success: Check,
  check: Check,
  done: Check,
  question: CircleHelp,
  help: CircleHelp,
  faq: CircleHelp,
  warning: TriangleAlert,
  caution: TriangleAlert,
  attention: TriangleAlert,
  failure: X,
  fail: X,
  missing: X,
  danger: Zap,
  error: Zap,
  bug: Bug,
  example: List,
  quote: Quote,
  cite: Quote,
};

export function MarkdownCallout(props: { "data-callout": string; "data-fold": string; children?: ReactNode }) {
  const type = props["data-callout"];
  const fold = props["data-fold"];
  const [expanded, setExpanded] = useState(fold !== "-");
  const id = useId();
  const [title, ...body] = Children.toArray(props.children);
  const Icon = Object.hasOwn(icons, type) ? icons[type] : Pencil;
  return (
    <div className="callout" data-callout={type} data-fold={fold}>
      <div
        className="callout-title"
        role={fold ? "button" : undefined}
        tabIndex={fold ? 0 : undefined}
        aria-expanded={fold ? expanded : undefined}
        aria-controls={fold ? id : undefined}
        onClick={fold ? () => setExpanded((value) => !value) : undefined}
        onKeyDown={
          fold
            ? (event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  setExpanded((value) => !value);
                }
              }
            : undefined
        }
      >
        <span className="callout-icon">
          <Icon aria-hidden="true" />
        </span>
        {title}
      </div>
      <div id={id} className="callout-content" hidden={!expanded}>
        {body}
      </div>
    </div>
  );
}

type WikiProps = {
  "data-target": string;
  "data-embed"?: string;
  "data-width"?: number;
  children?: ReactNode;
};

export function documentWikilinkComponent(path: string, Image?: ComponentType<ComponentProps<"img">>) {
  let resolver: Promise<(target: string) => Promise<ResolvedDocumentLink | null>> | undefined;
  const resolve = async (target: string, fresh = false) => {
    const create = () =>
      import("./DocumentLinks").then(({ createDocumentLinkResolver }) => createDocumentLinkResolver(path));
    return (await (fresh ? create() : (resolver ??= create())))(target);
  };
  const errorText = (code: string) => i18next.t(`document.errors.${code}`, { ns: "research" });
  return function DocumentWikilink(props: WikiProps) {
    const target = props["data-target"];
    const [state, setState] = useState<{ link?: ResolvedDocumentLink | null; error?: string }>({});
    useEffect(() => {
      let disposed = false;
      void resolve(target).then(
        (link) => {
          if (!disposed) setState({ link });
        },
        () => {
          if (!disposed) setState({ error: "linkReadFailed" });
        },
      );
      return () => {
        disposed = true;
      };
    }, [target]);
    if (props["data-embed"] && state.link && /\.(?:png|jpe?g|gif|webp|svg|bmp|avif)$/i.test(state.link.path) && Image) {
      // DocumentImage owns the scoped read, object URL and cleanup for both Markdown image syntaxes.
      const folderParts = path.replace(/\\/g, "/").split("/").slice(0, -1);
      const targetParts = state.link.path.split("/");
      const windows = /^(?:[a-z]:|\\\\|\/\/)/i.test(path);
      const samePart = (left: string, right: string) =>
        windows ? left.toLowerCase() === right.toLowerCase() : left === right;
      let common = 0;
      while (
        common < folderParts.length &&
        common < targetParts.length &&
        samePart(folderParts[common], targetParts[common])
      )
        common++;
      const src = [...folderParts.slice(common).map(() => ".."), ...targetParts.slice(common)]
        .map(encodeURIComponent)
        .join("/");
      return <Image src={src} alt={target} width={props["data-width"]} />;
    }
    return (
      <>
        <a
          href="#"
          className={cn("wikilink", (state.link === null || state.error) && "is-unresolved")}
          data-target={target}
          onAuxClick={(event) => event.preventDefault()}
          onClick={(event) => {
            event.preventDefault();
            void (async () => {
              const link = await resolve(target, true);
              setState({ link });
              if (!link) throw new Error("noteNotFound");
              if (!/\.(md|pdf)$/i.test(link.path)) throw new Error("unsupportedLink");
              const { openDocumentFile } = await import("./DocumentTab");
              await openDocumentFile(link.path, { heading: link.heading });
            })().catch((error) =>
              toast.error(
                errorText(
                  error instanceof Error && ["noteNotFound", "unsupportedLink"].includes(error.message)
                    ? error.message
                    : "linkReadFailed",
                ),
              ),
            );
          }}
        >
          {props.children}
        </a>
        {state.error && <span role="status">{errorText(state.error)}</span>}
      </>
    );
  };
}
