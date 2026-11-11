import { cn } from "@/utils/cn";
import {
  documentWikilinkComponent,
  MarkdownCallout,
  rehypeMathCompat,
  rehypeObsidian,
} from "@/core/research/ObsidianMarkdown";
import { open } from "@tauri-apps/plugin-shell";
import { useMemo, type ComponentType } from "react";
import production from "react/jsx-runtime";
import rehypeReact from "rehype-react";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import { unified } from "unified";

export default function Markdown({
  source,
  className = "",
  components,
  document,
}: {
  source: string;
  className?: string;
  components?: Record<string, ComponentType<any>>;
  document?: { path: string };
}) {
  // 双链组件只随文档路径变：边打字边预览时不重新挂载、不重新去磁盘上找链接目标
  const documentPath = document?.path;
  const image = components?.img;
  const wikilink = useMemo(
    () => (documentPath ? documentWikilinkComponent(documentPath, image) : undefined),
    [documentPath, image],
  );
  const content = useMemo(() => {
    const processor = unified()
      .use(remarkParse)
      .use(remarkGfm)
      .use(remarkBreaks)
      .use(remarkMath)
      .use(remarkRehype)
      .use(rehypeObsidian, { document: !!wikilink })
      .use(rehypeMathCompat)
      .use(rehypeKatex)
      .use(rehypeReact, {
        ...production,
        components: {
          a: (props: any) => (
            <a
              {...props}
              onClick={(e) => {
                e.preventDefault();
                open(props.href);
              }}
            />
          ),
          ...components,
          "reading-callout": MarkdownCallout,
          ...(wikilink ? { "reading-wikilink": wikilink } : {}),
        },
      });
    return processor.processSync(source).result;
  }, [source, components, wikilink]);

  return (
    <div
      className={cn(
        className,
        "prose max-w-none cursor-text text-sm select-text",
        "[--tw-prose-body:var(--card-foreground)] [--tw-prose-bold:var(--card-foreground)] [--tw-prose-bullets:var(--muted-foreground)] [--tw-prose-captions:var(--muted-foreground)] [--tw-prose-code:var(--card-foreground)] [--tw-prose-counters:var(--muted-foreground)] [--tw-prose-headings:var(--card-foreground)] [--tw-prose-hr:var(--border)] [--tw-prose-lead:var(--card-foreground)] [--tw-prose-links:var(--primary)] [--tw-prose-pre-bg:var(--muted)] [--tw-prose-pre-code:var(--card-foreground)] [--tw-prose-quote-borders:var(--border)] [--tw-prose-quotes:var(--muted-foreground)] [--tw-prose-td-borders:var(--border)] [--tw-prose-th-borders:var(--border)]",
      )}
    >
      {content}
    </div>
  );
}
