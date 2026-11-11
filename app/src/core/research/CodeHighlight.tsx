import { LanguageDescription, type Language } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { highlightCode, tagHighlighter, tags } from "@lezer/highlight";
import { useEffect, useState, type ComponentProps } from "react";

/** 代码里各类记号的类名，编辑器和阅读模式共用；颜色在 reading.css 里，深浅色各一套 */
export const codeHighlighter = tagHighlighter([
  { tag: tags.keyword, class: "cm-code-keyword" },
  { tag: [tags.string, tags.regexp, tags.escape, tags.special(tags.string)], class: "cm-code-string" },
  { tag: tags.comment, class: "cm-code-comment" },
  { tag: [tags.number, tags.bool, tags.null, tags.atom, tags.unit], class: "cm-code-number" },
  {
    tag: [tags.function(tags.variableName), tags.function(tags.propertyName), tags.macroName],
    class: "cm-code-function",
  },
  { tag: [tags.typeName, tags.className, tags.namespace], class: "cm-code-type" },
  { tag: [tags.propertyName, tags.attributeName], class: "cm-code-property" },
  { tag: tags.tagName, class: "cm-code-tag" },
  { tag: [tags.operator, tags.derefOperator], class: "cm-code-operator" },
  { tag: [tags.meta, tags.annotation], class: "cm-code-meta" },
]);

export interface CodeToken {
  text: string;
  className: string;
}

/** 语言表里没有、但科研里常写的名字 */
const ALIASES: Record<string, string> = { matlab: "octave" };

/** 按代码块开头写的语言名（python、py、bash、matlab……）找语言；编辑器和阅读模式共用 */
export function findCodeLanguage(info: string): LanguageDescription | null {
  const name = info.trim().split(/\s/)[0].toLowerCase();
  return name ? LanguageDescription.matchLanguageName(languages, ALIASES[name] ?? name, false) : null;
}

type Parser = Language["parser"];
const parsers = new Map<string, Promise<Parser | null>>();

/** 第一次用到某种语言时才加载 */
function parserFor(language: string): Promise<Parser | null> {
  const key = language.toLowerCase();
  let pending = parsers.get(key);
  if (!pending) {
    const description = findCodeLanguage(key);
    pending = description ? description.load().then((support) => support.language.parser) : Promise.resolve(null);
    parsers.set(key, pending);
  }
  return pending;
}

/** 认不出的语言返回 null，照原样显示 */
export async function highlightSource(code: string, language: string): Promise<CodeToken[] | null> {
  const parser = await parserFor(language);
  if (!parser) return null;
  const tokens: CodeToken[] = [];
  highlightCode(
    code,
    parser.parse(code),
    codeHighlighter,
    (text, className) => tokens.push({ text, className }),
    () => tokens.push({ text: "\n", className: "" }),
  );
  return tokens;
}

/** 阅读模式里的 `code`：带语言名的代码块上色，行内代码照旧 */
export function HighlightedCode({ className, children, ...props }: ComponentProps<"code">) {
  const language = /(?:^|\s)language-([^\s]+)/.exec(className ?? "")?.[1];
  const code = typeof children === "string" ? children : undefined;
  const [tokens, setTokens] = useState<CodeToken[] | null>(null);
  useEffect(() => {
    setTokens(null);
    if (!language || code === undefined) return;
    let disposed = false;
    void highlightSource(code, language).then((result) => {
      if (!disposed) setTokens(result);
    });
    return () => {
      disposed = true;
    };
  }, [language, code]);
  return (
    <code className={className} {...props}>
      {tokens
        ? tokens.map((token, index) =>
            token.className ? (
              <span key={index} className={token.className}>
                {token.text}
              </span>
            ) : (
              token.text
            ),
          )
        : children}
    </code>
  );
}
