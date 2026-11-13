import { cn } from "@/utils/cn";
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { editorText } from "./DocumentFile";
import type { DocumentTab } from "./DocumentTab";
import { parseOutline, type OutlineHeading, type OutlinePosition } from "./NoteHeadings";

function activeIndex(headings: OutlineHeading[], position: OutlinePosition | undefined) {
  if (!position) return -1;
  if ("index" in position) return position.index;
  let found = -1;
  for (const [index, heading] of headings.entries()) {
    if (heading.line > position.line) break;
    found = index;
  }
  return found;
}

/** 标题太少就不显示，和 Agentero 一样 */
const MIN_HEADINGS = 3;
/** 横杠的长短：层级越深越短 */
const BARS = ["w-5", "w-4", "w-3.5", "w-3", "w-2.5", "w-2"];

/**
 * 笔记的大纲，照 Agentero：浮在正文右边的一排小横杠，一条横杠一个标题，读到哪个哪条变深；
 * 鼠标移上去展开成带标题的卡片，点一下跳过去。只有 Markdown 才有，不占侧栏，也没有开关。
 */
export function NoteOutline({ tab }: { tab: DocumentTab }) {
  const { t } = useTranslation("research");
  const [, rerender] = useState(0);
  useEffect(() => {
    const changed = () => rerender((value) => value + 1);
    tab.on("state-change", changed);
    tab.on("outline-position", changed);
    return () => {
      tab.off("state-change", changed);
      tab.off("outline-position", changed);
    };
  }, [tab]);
  const text = useDeferredValue(tab.markdown ? editorText(tab.markdown.text) : "");
  const headings = useMemo(() => parseOutline(text), [text]);
  const current = activeIndex(headings, tab.outlinePosition);

  // 标题多到要滚动时，让读到的那条留在看得见的地方
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>('[aria-current="location"]')?.scrollIntoView({ block: "nearest" });
  }, [current]);

  if (headings.length < MIN_HEADINGS) return null;
  const top = Math.min(...headings.map((heading) => heading.level));
  return (
    <nav
      aria-label={t("outline.title")}
      className="group/outline absolute top-1/4 right-3 z-20 w-10 max-w-[70%] transition-[width] duration-200 ease-out focus-within:w-64 hover:w-64 motion-reduce:transition-none @max-md/note:hidden"
    >
      <div
        ref={list}
        className={cn(
          "max-h-[min(46vh,28rem)] overflow-y-auto overscroll-contain rounded-xl border border-transparent p-1 [scrollbar-width:none]",
          "transition-[background-color,border-color,box-shadow] duration-200 ease-out",
          "group-focus-within/outline:border-border/70 group-focus-within/outline:bg-background/95 group-focus-within/outline:shadow-lg",
          "group-hover/outline:border-border/70 group-hover/outline:bg-background/95 group-hover/outline:shadow-lg",
        )}
      >
        {headings.map((heading, index) => {
          const depth = Math.min(heading.level - top, BARS.length - 1);
          const active = index === current;
          return (
            <button
              key={index}
              type="button"
              aria-current={active ? "location" : undefined}
              title={heading.text}
              className={cn(
                "group/item hover:bg-foreground/[0.06] relative flex h-5 w-full items-center rounded-md",
                active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
                depth === 0 && index > 0 && "mt-1.5",
              )}
              onClick={() => tab.emit("outline-jump", heading, index)}
            >
              <span
                className={cn(
                  "absolute right-8 left-0 translate-x-1 truncate text-left text-xs opacity-0",
                  "transition-[transform,opacity] duration-200 motion-reduce:transition-none",
                  "group-focus-within/outline:translate-x-0 group-focus-within/outline:opacity-100",
                  "group-hover/outline:translate-x-0 group-hover/outline:opacity-100",
                  active ? "font-semibold" : depth === 0 ? "font-medium" : "font-normal",
                )}
                style={{ paddingLeft: 8 + depth * 10 }}
              >
                {heading.text || " "}
              </span>
              <span
                className={cn(
                  "absolute top-1/2 right-1.5 -translate-y-1/2 rounded-full transition-colors duration-200",
                  BARS[depth],
                  active
                    ? "bg-foreground h-1"
                    : "bg-muted-foreground/35 group-hover/item:bg-muted-foreground/70 h-[3px]",
                )}
              />
            </button>
          );
        })}
      </div>
    </nav>
  );
}
