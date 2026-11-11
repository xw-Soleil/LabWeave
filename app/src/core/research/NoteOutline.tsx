import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { dragSidePanel, sideOfTab } from "@/core/research/SidePanelDrag";
import { ComponentTab } from "@/core/Tab";
import { TabWorkspace } from "@/core/TabWorkspace";
import { activeResourceTabAtom, tabGroupRootAtom } from "@/state";
import { cn } from "@/utils/cn";
import { Vector } from "@graphif/data-structures";
import { Rectangle } from "@graphif/shapes";
import i18next from "i18next";
import { useAtomValue } from "jotai";
import { ArrowLeftRight, ChevronRight, ChevronsDownUp, ChevronsUpDown, ListTree, Search, X } from "lucide-react";
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { editorText } from "./DocumentFile";
import { DocumentTab } from "./DocumentTab";
import { parseOutline, type OutlineHeading, type OutlinePosition } from "./NoteHeadings";
import { noteOutlineTabIds } from "./NoteOutlineTab";

interface OutlineItem extends OutlineHeading {
  index: number;
  depth: number;
  parent: number;
  hasChildren: boolean;
}

function buildTree(headings: OutlineHeading[]): OutlineItem[] {
  const items = headings.map((heading, index) => ({ ...heading, index, depth: 0, parent: -1, hasChildren: false }));
  const stack: number[] = [];
  for (const item of items) {
    while (stack.length && items[stack.at(-1)!].level >= item.level) stack.pop();
    item.parent = stack.at(-1) ?? -1;
    item.depth = stack.length;
    if (item.parent >= 0) items[item.parent].hasChildren = true;
    stack.push(item.index);
  }
  return items;
}

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

const OUTLINE_SIDE_KEY = "pg-research-outline-side";
const INDENT = 14;

/**
 * 大纲面板，照 Obsidian：当前笔记的标题按层级排成树，能折叠，有竖线；
 * 读到哪个标题就亮哪个，点一下跳过去；顶上能搜、能一下全部收起或展开；
 * 按住标题栏拖到另一边，就换到左侧栏或右侧栏。
 */
function NoteOutlinePanel({ tabId }: { tabId: string }) {
  const { t } = useTranslation("research");
  const active = useAtomValue(activeResourceTabAtom);
  const note = active instanceof DocumentTab && active.kind === "markdown" ? active : undefined;
  const [, rerender] = useState(0);
  useEffect(() => {
    if (!note) return;
    const changed = () => rerender((value) => value + 1);
    note.on("state-change", changed);
    note.on("outline-position", changed);
    return () => {
      note.off("state-change", changed);
      note.off("outline-position", changed);
    };
  }, [note]);
  const text = useDeferredValue(note?.markdown ? editorText(note.markdown.text) : "");
  const headings = useMemo(() => parseOutline(text), [text]);
  const items = useMemo(() => buildTree(headings), [headings]);
  const current = activeIndex(headings, note?.outlinePosition);

  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  useEffect(() => setCollapsed(new Set()), [note]);

  // 记住放在哪一边，下次打开还在那边
  useAtomValue(tabGroupRootAtom);
  const side = sideOfTab(tabId);
  useEffect(() => {
    if (side) localStorage.setItem(OUTLINE_SIDE_KEY, side);
  }, [side]);

  const needle = query.trim().normalize("NFC").toLowerCase();
  const visible = useMemo(() => {
    if (needle) {
      const shown = new Set<number>();
      for (const item of items) {
        if (!item.text.normalize("NFC").toLowerCase().includes(needle)) continue;
        for (let at = item.index; at >= 0 && !shown.has(at); at = items[at].parent) shown.add(at);
      }
      return items.filter((item) => shown.has(item.index));
    }
    return items.filter((item) => {
      for (let at = item.parent; at >= 0; at = items[at].parent) if (collapsed.has(at)) return false;
      return true;
    });
  }, [items, collapsed, needle]);

  // 读到的标题滚出了面板就把它滚进来
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-outline-index="${current}"]`)?.scrollIntoView({ block: "nearest" });
  }, [current]);

  const parents = items.filter((item) => item.hasChildren).map((item) => item.index);
  const allCollapsed = parents.length > 0 && parents.every((index) => collapsed.has(index));
  const toggle = (index: number) =>
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (!next.delete(index)) next.add(index);
      return next;
    });

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <div
        className="flex h-9 shrink-0 cursor-grab items-center gap-1 border-b pr-1.5 pl-2.5 select-none active:cursor-grabbing"
        title={t("outline.dragHint")}
        onMouseDown={(event) => {
          if (event.button !== 0 || (event.target as Element).closest("button")) return;
          event.preventDefault();
          dragSidePanel(tabId, event);
        }}
      >
        <ListTree className="text-muted-foreground size-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{t("outline.title")}</span>
        <Button
          variant="ghost"
          size="icon"
          className={cn("size-7", searching && "bg-foreground/[0.08]")}
          title={t("outline.search")}
          aria-label={t("outline.search")}
          aria-pressed={searching}
          onClick={() => {
            setSearching(!searching);
            setQuery("");
          }}
        >
          <Search />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          disabled={parents.length === 0}
          title={t(allCollapsed ? "outline.expandAll" : "outline.collapseAll")}
          aria-label={t(allCollapsed ? "outline.expandAll" : "outline.collapseAll")}
          onClick={() => setCollapsed(allCollapsed ? new Set() : new Set(parents))}
        >
          {allCollapsed ? <ChevronsUpDown /> : <ChevronsDownUp />}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          title={t(side === "left" ? "outline.moveRight" : "outline.moveLeft")}
          aria-label={t(side === "left" ? "outline.moveRight" : "outline.moveLeft")}
          onClick={() => TabWorkspace.dockToSide(tabId, side === "left" ? "right" : "left")}
        >
          <ArrowLeftRight />
        </Button>
      </div>
      {searching && (
        <div className="flex shrink-0 items-center gap-1 px-2 py-1.5">
          <Input
            autoFocus
            value={query}
            placeholder={t("outline.searchPlaceholder")}
            aria-label={t("outline.searchPlaceholder")}
            className="bg-foreground/[0.04] dark:bg-foreground/[0.06] h-7 min-w-0 border-transparent text-[13px] shadow-none"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              event.preventDefault();
              event.stopPropagation();
              setSearching(false);
              setQuery("");
            }}
          />
          {query && (
            <Button
              size="icon"
              variant="ghost"
              className="size-7"
              aria-label={t("outline.clearSearch")}
              onClick={() => setQuery("")}
            >
              <X />
            </Button>
          )}
        </div>
      )}
      <div ref={list} role="tree" className="min-h-0 flex-1 overflow-auto px-1.5 py-1.5">
        {!note ? (
          <p className="text-muted-foreground px-2 py-1 text-xs">{t("outline.noNote")}</p>
        ) : items.length === 0 ? (
          <p className="text-muted-foreground px-2 py-1 text-xs">{t("outline.empty")}</p>
        ) : visible.length === 0 ? (
          <p className="text-muted-foreground px-2 py-1 text-xs">{t("outline.noMatch")}</p>
        ) : (
          visible.map((item) => (
            <div
              key={item.index}
              role="treeitem"
              aria-level={item.depth + 1}
              aria-expanded={item.hasChildren ? !collapsed.has(item.index) : undefined}
              aria-selected={item.index === current}
              data-outline-index={item.index}
              className={cn(
                "relative flex min-h-7 cursor-pointer items-start gap-0.5 rounded-md py-1 pr-2 text-[13px] leading-5",
                item.index === current
                  ? "bg-foreground/[0.08] text-foreground"
                  : "text-foreground/80 hover:bg-foreground/[0.05]",
              )}
              style={{ paddingLeft: 4 + item.depth * INDENT }}
              onClick={() => note?.emit("outline-jump", headings[item.index], item.index)}
            >
              {Array.from({ length: item.depth }, (_, depth) => (
                <span
                  key={depth}
                  aria-hidden
                  className="bg-foreground/10 pointer-events-none absolute top-0 bottom-0 w-px"
                  style={{ left: 4 + depth * INDENT + 8 }}
                />
              ))}
              {item.hasChildren && !needle ? (
                <button
                  type="button"
                  className="text-muted-foreground/70 hover:text-foreground mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-sm"
                  aria-label={t(collapsed.has(item.index) ? "outline.expand" : "outline.collapse")}
                  onClick={(event) => {
                    event.stopPropagation();
                    toggle(item.index);
                  }}
                >
                  <ChevronRight
                    className={cn(
                      "size-3.5 transition-transform duration-150",
                      !collapsed.has(item.index) && "rotate-90",
                    )}
                  />
                </button>
              ) : (
                <span className="w-4 shrink-0" />
              )}
              <span className="min-w-0 break-words">{item.text || " "}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/** 打开大纲面板，放在上次放的那一边（默认右边，和 Obsidian 一样） */
export function openNoteOutline() {
  const side = localStorage.getItem(OUTLINE_SIDE_KEY) === "left" ? "left" : "right";
  const tab: ComponentTab = TabWorkspace.create({
    title: i18next.t("outline.title", { ns: "research" }),
    icon: ListTree,
    closable: true,
    closeOnEscape: false,
    canDock: true,
    layout: "docked",
    splitEdge: side,
    children: (self) => <NoteOutlinePanel tabId={self.id} />,
    rect: new Rectangle(new Vector(window.innerWidth - 320, 88), new Vector(300, window.innerHeight - 96)),
  });
  noteOutlineTabIds.add(tab.id);
}
