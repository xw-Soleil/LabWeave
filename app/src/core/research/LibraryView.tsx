import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Settings } from "@/core/service/Settings";
import { cn } from "@/utils/cn";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import {
  ArrowDown,
  ArrowUp,
  Book,
  BookOpen,
  Check,
  ChevronRight,
  FileClock,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  GraduationCap,
  Inbox,
  Languages,
  Library,
  MoreHorizontal,
  NotebookPen,
  PanelLeft,
  PanelRight,
  Plus,
  Presentation,
  RefreshCw,
  RotateCcw,
  Search,
  Trash2,
  Upload,
  WandSparkles,
  X,
  type LucideIcon,
} from "lucide-react";
import i18next from "i18next";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { documentError, openDocumentFile } from "./DocumentTab";
import {
  addCollection,
  countLibrary,
  createItem,
  createLibrary,
  queryLibrary,
  removeCollection,
  renameCollection,
  restoreItem,
  trashItem,
  updateItem,
  useLibrary,
  type LibraryItem,
  type LibrarySnapshot,
  type ReadStatus,
} from "./Library";
import type { CreateLibraryItemFields, LibraryItemPatch } from "./LibraryFormat";
import { downloadArxivPdf, findPaperId, lookupChanges, lookupItem, lookupPaper, recognizePdf } from "./LibraryLookup";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import ZoteroSyncDialog from "./ZoteroSyncDialog";

type Scope = { kind: "all" } | { kind: "collection"; path: string } | { kind: "unfiled" } | { kind: "trash" };
type SortKey = "title" | "authors" | "year" | "status" | "added";
type Sort = { key: SortKey; direction: "asc" | "desc" };

const STATUSES: ReadStatus[] = ["unread", "toRead", "reading", "read"];
const STATUS_COLOR: Record<ReadStatus, string> = {
  unread: "text-muted-foreground",
  toRead: "text-orange-600 dark:text-orange-400",
  reading: "text-sky-600 dark:text-sky-400",
  read: "text-emerald-600 dark:text-emerald-400",
};
const STATUS_DOT: Record<ReadStatus, string> = {
  unread: "bg-muted-foreground/50",
  toRead: "bg-orange-500",
  reading: "bg-sky-500",
  read: "bg-emerald-500",
};
const ITEM_TYPE_ICONS: [RegExp, LucideIcon, string][] = [
  [/会议|conference|proceeding/i, Presentation, "text-orange-500"],
  [/预印|preprint|arxiv/i, FileClock, "text-violet-500"],
  [/书|book/i, Book, "text-amber-700 dark:text-amber-500"],
  [/学位|thesis|dissertation/i, GraduationCap, "text-teal-600"],
];
function itemTypeIcon(itemType?: string): [LucideIcon, string] {
  const hit = itemType ? ITEM_TYPE_ICONS.find(([pattern]) => pattern.test(itemType)) : undefined;
  return hit ? [hit[1], hit[2]] : [FileText, "text-sky-600 dark:text-sky-400"];
}

const LAYOUT_KEY = "labweave.libraryLayout";
/** 列表第一眼先画这么多行（够铺满一屏），其余的紧接着补上 */
const FIRST_SCREEN = 30;
function storedLayout(): { tree: boolean; info: boolean } {
  const saved = globalThis.localStorage?.getItem(LAYOUT_KEY);
  const parsed = saved ? (JSON.parse(saved) as Partial<{ tree: boolean; info: boolean }>) : {};
  return { tree: parsed.tree ?? true, info: parsed.info ?? true };
}

/**
 * 文献库页的文案。React 显示文字时自己会转义，这里关掉 i18next 那一层转义，
 * 否则路径里的 / 会显示成 &#x2F;。
 */
function useLibraryText() {
  const { t } = useTranslation("research");
  return useCallback(
    (key: string, options?: Record<string, unknown>): string =>
      t(key, { ...options, interpolation: { escapeValue: false } }) as string,
    [t],
  );
}

/** 文献库的错误代码（library.xxx）翻成中文，其他的交给文档的错误翻译 */
function libraryError(error: unknown): string {
  const code = error instanceof Error ? error.message : String(error);
  return code.startsWith("library.")
    ? i18next.t(`library.errors.${code.slice("library.".length)}`, {
        ns: "research",
        defaultValue: i18next.t("library.errors.readFailed", { ns: "research" }),
      })
    : documentError(error);
}
const reportError = (error: unknown) => toast.error(libraryError(error));

/** 「联网补全信息」：空着的直接补上；和现有内容不一样的，列出来问过再改 */
async function completeItem(root: string, item: LibraryItem, t: ReturnType<typeof useLibraryText>) {
  const working = toast.loading(t("library.lookup.searching"));
  const found = await lookupItem(item).finally(() => toast.dismiss(working));
  const { fill, replace } = lookupChanges(item, found);
  const names = (patch: LibraryItemPatch) =>
    Object.keys(patch)
      .map((field) => t(`library.fields.${field}`))
      .join(t("library.lookup.separator"));
  const show = (value: unknown) => {
    const text = [value].flat().join("; ");
    return text.length > 80 ? `${text.slice(0, 80)}…` : text;
  };
  let patch = fill;
  if (Object.keys(replace).length) {
    const title = t("library.lookup.differTitle");
    const lines = [
      t("library.lookup.differDescription", { title: item.title }),
      ...Object.entries(replace).map(([field, value]) =>
        t("library.lookup.differLine", {
          field: t(`library.fields.${field}`),
          old: show(item[field as keyof LibraryItemPatch]),
          new: show(value),
        }),
      ),
    ];
    const cancel = { id: "cancel", label: t("library.lookup.cancel"), variant: "ghost" } as const;
    const useFound = { id: "replace", label: t("library.lookup.useFound") } as const;
    const answer = Object.keys(fill).length
      ? await Dialog.buttons(title, [...lines, t("library.lookup.willFill", { fields: names(fill) })].join("\n"), [
          cancel,
          { id: "fill", label: t("library.lookup.fillOnly"), variant: "outline" },
          useFound,
        ])
      : await Dialog.buttons(title, lines.join("\n"), [cancel, useFound]);
    if (answer === "cancel") return;
    if (answer === "replace") patch = { ...fill, ...replace };
  }
  if (!Object.keys(patch).length) {
    toast.info(t("library.lookup.upToDate"));
    return;
  }
  await updateItem(root, item.key, patch);
  toast.success(t("library.lookup.completed", { fields: names(patch) }));
}
const PANE_ROW = "group flex h-7 min-w-0 items-center gap-1.5 rounded-md pr-1.5 text-[13px] select-none";
const PANE_IDLE = "text-foreground/80 hover:bg-foreground/[0.05]";
const PANE_ACTIVE = "bg-foreground/[0.08] text-foreground";

export default function LibraryView() {
  const t = useLibraryText();
  const [root, setRoot] = Settings.use("literatureLibraryPath");
  const chooseRoot = async () => {
    const path = await openDialog({ directory: true, title: t("library.chooseTitle") });
    if (path) setRoot(path);
  };
  if (!root)
    return (
      <div className="bg-background flex h-full flex-col items-center justify-center gap-4 p-8 pt-9 text-center">
        <Library className="text-muted-foreground/60 size-12" strokeWidth={1.25} />
        <div className="flex max-w-sm flex-col gap-1.5">
          <h2 className="text-base font-semibold">{t("library.emptyTitle")}</h2>
          <p className="text-muted-foreground text-sm">{t("library.emptyHint")}</p>
        </div>
        <Button onClick={() => void chooseRoot().catch(reportError)}>
          <FolderOpen data-icon="inline-start" />
          {t("library.chooseFolder")}
        </Button>
      </div>
    );
  return <LibraryBrowser key={root} root={root} onChangeRoot={() => void chooseRoot().catch(reportError)} />;
}

function LibraryBrowser({ root, onChangeRoot }: { root: string; onChangeRoot: () => void }) {
  const t = useLibraryText();
  const library = useLibrary(root);
  const { loading, error, refresh, reloadAll } = library;
  const snapshot = library.snapshot ?? undefined;
  const lastEnter = useRef(0);
  const [scope, setScope] = useState<Scope>({ kind: "all" });
  const [tags, setTags] = useState<string[]>([]);
  const [status, setStatus] = useState<ReadStatus>();
  const [text, setText] = useState("");
  const [sort, setSort] = useState<Sort>({ key: "title", direction: "asc" });
  const [selected, setSelected] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [layout, setLayout] = useState(storedLayout);
  const [syncOpen, setSyncOpen] = useState(false);
  const toggleLayout = (part: "tree" | "info") => {
    const next = { ...layout, [part]: !layout[part] };
    setLayout(next);
    globalThis.localStorage?.setItem(LAYOUT_KEY, JSON.stringify(next));
  };

  const items = useMemo(
    () =>
      snapshot
        ? queryLibrary(
            snapshot,
            {
              search: text,
              tags,
              status,
              trashed: scope.kind === "trash",
              unfiled: scope.kind === "unfiled",
              collection: scope.kind === "collection" ? scope.path : undefined,
            },
            sort,
          )
        : [],
    [snapshot, text, tags, status, scope, sort],
  );
  const counts = useMemo(() => (snapshot ? countLibrary(snapshot) : undefined), [snapshot]);
  const current = snapshot?.items.find((item) => item.key === selected);

  const run = (task: () => Promise<unknown>) => void task().then(refresh).catch(reportError);
  const targetCollections = scope.kind === "collection" ? [scope.path] : [];
  /** 库里已经有同一个 DOI 或 arXiv 编号的文献时，选中它并先问一声 */
  const mayAdd = async (fields: CreateLibraryItemFields) => {
    const same = snapshot?.items.find(
      (item) =>
        !item.trashed &&
        ((!!fields.doi && item.doi?.toLowerCase() === fields.doi) || (!!fields.arxiv && item.arxiv === fields.arxiv)),
    );
    if (!same) return true;
    setSelected(same.key);
    const answer = await Dialog.buttons(
      t("library.lookup.duplicateTitle"),
      t("library.lookup.duplicateDescription", { title: same.title }),
      [
        { id: "cancel", label: t("library.lookup.cancel"), variant: "ghost" },
        { id: "add", label: t("library.lookup.addAnyway") },
      ],
    );
    return answer === "add";
  };
  const importPdf = () =>
    run(async () => {
      const pdf = await openDialog({
        title: t("library.importTitle"),
        filters: [{ name: "PDF", extensions: ["pdf"] }],
      });
      if (!pdf) return;
      const name = pdf
        .split(/[\\/]/)
        .at(-1)!
        .replace(/\.pdf$/i, "");
      // 和 Zotero 一样先认出是哪篇，再建条目：这样文件夹名是「作者年份标题」，不是下载时的文件名
      const working = toast.loading(t("library.lookup.reading", { name }));
      const found = await recognizePdf(pdf).finally(() => toast.dismiss(working));
      const fields = { ...found.fields, title: found.fields.title || name, collections: targetCollections };
      if (!(await mayAdd(fields))) return;
      const item = await createItem(root, fields, pdf);
      setSelected(item.key);
      if (found.source === "online") toast.success(t("library.lookup.found", { title: item.title }));
      else
        toast.warning(
          [
            found.problem ? libraryError(found.problem) : "",
            t(found.source === "pdf" ? "library.lookup.fromPdf" : "library.lookup.none"),
          ]
            .filter(Boolean)
            .join(" "),
        );
    });
  const addById = () =>
    run(async () => {
      const input = await Dialog.input(t("library.addById"), t("library.addByIdHint"), {
        placeholder: t("library.addByIdPlaceholder"),
      });
      if (!input?.trim()) return;
      const working = toast.loading(t("library.lookup.searching"));
      const found = await lookupPaper(findPaperId(input.trim())).finally(() => toast.dismiss(working));
      const fields = { ...found, collections: targetCollections };
      if (!(await mayAdd(fields))) return;
      // arXiv 上的 PDF 是公开的，和 Zotero 一样顺手下回来；下不动也照样建条目，原因告诉用户
      let pdf: Uint8Array | undefined;
      let problem: unknown;
      if (found.arxiv) {
        const downloading = toast.loading(t("library.lookup.downloading"));
        pdf = await downloadArxivPdf(found.arxiv)
          .catch((error: unknown) => void (problem = error))
          .finally(() => toast.dismiss(downloading));
      }
      const item = await createItem(root, fields, pdf);
      setSelected(item.key);
      if (problem) toast.warning(t("library.lookup.pdfFailed", { title: item.title, reason: libraryError(problem) }));
      else toast.success(t("library.lookup.found", { title: item.title }));
    });
  const newItem = () =>
    run(async () => {
      const title = await Dialog.input(t("library.newItemTitle"), "", { placeholder: t("library.fields.title") });
      if (!title?.trim()) return;
      const item = await createItem(root, { title: title.trim(), collections: targetCollections });
      setSelected(item.key);
    });
  const scopeLabel =
    scope.kind === "all"
      ? t("library.all")
      : scope.kind === "unfiled"
        ? t("library.unfiled")
        : scope.kind === "trash"
          ? t("library.trash")
          : scope.path.split("/").join(" / ");

  if (error?.message === "library.manifestMissing" && !snapshot)
    return (
      <div className="bg-background flex h-full flex-col items-center justify-center gap-4 p-8 pt-9 text-center">
        <Library className="text-muted-foreground/60 size-12" strokeWidth={1.25} />
        <div className="flex max-w-md flex-col gap-1.5">
          <h2 className="text-base font-semibold">{t("library.notLibraryTitle")}</h2>
          <p className="text-muted-foreground text-sm [overflow-wrap:anywhere]">
            {t("library.notLibraryHint", { path: root })}
          </p>
        </div>
        <div className="flex flex-wrap justify-center gap-2">
          <Button onClick={() => run(() => createLibrary(root))}>
            <FolderPlus data-icon="inline-start" />
            {t("library.createHere")}
          </Button>
          <Button variant="outline" onClick={onChangeRoot}>
            {t("library.changeFolder")}
          </Button>
        </div>
      </div>
    );

  return (
    <div
      className="bg-background flex h-full min-h-0 pt-9 text-[13px]"
      onPointerEnter={() => {
        if (Date.now() - lastEnter.current < 1500) return;
        lastEnter.current = Date.now();
        void refresh();
      }}
    >
      {layout.tree && (
        <aside className="bg-foreground/[0.02] flex w-56 shrink-0 flex-col border-r">
          <CollectionPane
            root={root}
            snapshot={snapshot}
            counts={counts}
            scope={scope}
            onScope={(next) => {
              setScope(next);
              setSelected("");
            }}
            run={run}
            onChangeRoot={onChangeRoot}
          />
          <TagPane snapshot={snapshot} counts={counts} selected={tags} onChange={setTags} />
        </aside>
      )}
      <section className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-10 shrink-0 items-center gap-1 px-3">
          <ToolButton
            icon={PanelLeft}
            label={t("library.collections")}
            active={layout.tree}
            onClick={() => toggleLayout("tree")}
          />
          <ToolButton icon={Plus} label={t("library.newItem")} onClick={newItem} />
          <ToolButton icon={Upload} label={t("library.importPdf")} onClick={importPdf} />
          <ToolButton icon={WandSparkles} label={t("library.addById")} onClick={addById} />
          <span className="flex-1" />
          <Button
            variant="ghost"
            size="sm"
            disabled={!snapshot || loading || !!error}
            onClick={() => setSyncOpen(true)}
          >
            {t("zoteroSync.title")}
          </Button>
          <ToolButton
            icon={RefreshCw}
            label={t("library.refresh")}
            onClick={() => void reloadAll()}
            className={cn(loading && "[&_svg]:animate-spin")}
          />
          <ToolButton
            icon={PanelRight}
            label={t("library.info")}
            active={layout.info}
            onClick={() => toggleLayout("info")}
          />
        </div>
        <div className="px-3 pb-2">
          <div className="bg-foreground/[0.04] flex h-8 items-center gap-2 rounded-md px-2.5">
            <Search className="text-muted-foreground size-3.5 shrink-0" />
            <input
              value={text}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") setText("");
              }}
              placeholder={t("library.searchPlaceholder")}
              aria-label={t("library.searchPlaceholder")}
              className="placeholder:text-muted-foreground min-w-0 flex-1 bg-transparent text-[13px] outline-none"
            />
            {text && (
              <button type="button" aria-label={t("library.clearSearch")} onClick={() => setText("")}>
                <X className="text-muted-foreground size-3.5" />
              </button>
            )}
          </div>
        </div>
        <div className="text-muted-foreground flex min-h-5 items-center gap-2 px-4 pb-1 text-xs">
          <span className="truncate">{scopeLabel}</span>
          {status && <FilterChip onClear={() => setStatus(undefined)}>{t(`library.status.${status}`)}</FilterChip>}
          {tags.map((tag) => (
            <FilterChip key={tag} onClear={() => setTags(tags.filter((value) => value !== tag))}>
              #{tag}
            </FilterChip>
          ))}
        </div>
        <ItemTable
          items={items}
          sort={sort}
          onSort={(key) =>
            setSort((old) =>
              old.key === key
                ? { key, direction: old.direction === "asc" ? "desc" : "asc" }
                : { key, direction: "asc" },
            )
          }
          selected={selected}
          onSelect={setSelected}
          expanded={expanded}
          onToggle={(key) =>
            setExpanded((old) => {
              const next = new Set(old);
              if (!next.delete(key)) next.add(key);
              return next;
            })
          }
          root={root}
          run={run}
          empty={
            loading && !snapshot
              ? t("library.loading")
              : error
                ? t("library.loadFailed", { error: libraryError(error) })
                : snapshot?.items.length
                  ? t("library.noMatch")
                  : t("library.noItems")
          }
        />
        <div className="text-muted-foreground flex h-7 shrink-0 items-center gap-3 border-t px-4 text-xs">
          {t("library.footer", { count: items.length })}
          {!!snapshot?.errors.length && (
            <span
              className="text-destructive/80"
              title={snapshot.errors.map((item) => `${item.key}: ${libraryError(new Error(item.code))}`).join("\n")}
            >
              {t("library.skipped", { count: snapshot.errors.length })}
            </span>
          )}
          {error && snapshot && <span className="text-destructive/80 truncate">{libraryError(error)}</span>}
        </div>
      </section>
      {layout.info && (
        <aside className="flex w-72 shrink-0 flex-col overflow-y-auto border-l">
          {current ? (
            <InfoPane
              key={current.key}
              item={current}
              root={root}
              collections={snapshot?.collections ?? []}
              run={run}
            />
          ) : (
            <Overview
              counts={counts}
              status={status}
              onStatus={(value) => setStatus(value === status ? undefined : value)}
            />
          )}
        </aside>
      )}
      {syncOpen && snapshot && (
        <ZoteroSyncDialog
          snapshot={snapshot}
          onClose={() => {
            setSyncOpen(false);
            void refresh();
          }}
        />
      )}
    </div>
  );
}

function ToolButton({
  icon: Icon,
  label,
  onClick,
  active,
  className,
}: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  active?: boolean;
  className?: string;
}) {
  return (
    <Button
      variant="ghost"
      size="sm"
      title={label}
      aria-pressed={active}
      className={cn(
        "text-foreground/75 h-7 gap-1.5 px-2 text-[13px] font-normal",
        active && "text-foreground",
        className,
      )}
      onClick={onClick}
    >
      <Icon className="size-4" strokeWidth={1.75} />
      {label}
    </Button>
  );
}

function FilterChip({ children, onClear }: { children: ReactNode; onClear: () => void }) {
  return (
    <span className="bg-foreground/[0.06] text-foreground/80 flex items-center gap-1 rounded px-1.5 py-px">
      {children}
      <button type="button" className="hover:text-foreground" onClick={onClear}>
        <X className="size-3" />
      </button>
    </span>
  );
}

type Counts = ReturnType<typeof countLibrary>;
type CollectionNode = { name: string; path: string; children: CollectionNode[] };
function collectionTree(collections: string[]): CollectionNode[] {
  const top: CollectionNode[] = [];
  const byPath = new Map<string, CollectionNode>();
  for (const path of [...collections].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))) {
    const parts = path.split("/");
    let siblings = top;
    parts.forEach((name, index) => {
      const key = parts.slice(0, index + 1).join("/");
      let node = byPath.get(key);
      if (!node) {
        node = { name, path: key, children: [] };
        byPath.set(key, node);
        siblings.push(node);
      }
      siblings = node.children;
    });
  }
  return top;
}

function CollectionPane({
  root,
  snapshot,
  counts,
  scope,
  onScope,
  run,
  onChangeRoot,
}: {
  root: string;
  snapshot?: LibrarySnapshot;
  counts?: Counts;
  scope: Scope;
  onScope: (scope: Scope) => void;
  run: (task: () => Promise<unknown>) => void;
  onChangeRoot: () => void;
}) {
  const t = useLibraryText();
  const tree = useMemo(() => collectionTree(snapshot?.collections ?? []), [snapshot]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const add = (parent?: string) =>
    run(async () => {
      const name = await Dialog.input(t("library.newCollection"), parent ?? "", {
        placeholder: t("library.collectionName"),
      });
      if (!name?.trim()) return;
      await addCollection(root, parent ? `${parent}/${name.trim()}` : name.trim());
    });
  const rename = (path: string) =>
    run(async () => {
      const name = await Dialog.input(t("library.renameCollection"), path, {
        defaultValue: path.split("/").at(-1),
      });
      if (!name?.trim()) return;
      const next = [...path.split("/").slice(0, -1), name.trim()].join("/");
      await renameCollection(root, path, next);
      if (scope.kind === "collection" && scope.path === path) onScope({ kind: "collection", path: next });
    });
  const remove = (path: string) =>
    run(async () => {
      if (
        !(await Dialog.confirm(t("library.removeCollectionTitle", { name: path }), t("library.removeCollectionHint")))
      )
        return;
      await removeCollection(root, path);
      if (scope.kind === "collection" && (scope.path === path || scope.path.startsWith(`${path}/`)))
        onScope({ kind: "all" });
    });
  const row = (key: string, active: boolean, depth: number, content: ReactNode, onClick: () => void) => (
    <div
      key={key}
      role="button"
      tabIndex={0}
      className={cn(PANE_ROW, active ? PANE_ACTIVE : PANE_IDLE)}
      style={{ paddingLeft: 6 + depth * 14 }}
      onClick={onClick}
      onKeyDown={(event) => {
        if (event.key === "Enter") onClick();
      }}
    >
      {content}
    </div>
  );
  const count = (value?: number) => (
    <span className="text-muted-foreground/80 ml-auto pl-1 text-[11px] tabular-nums">{value ?? 0}</span>
  );
  const renderNode = (node: CollectionNode, depth: number): ReactNode => {
    const open = !collapsed.has(node.path);
    const active = scope.kind === "collection" && scope.path === node.path;
    const Icon = open && node.children.length ? FolderOpen : Folder;
    return (
      <div key={node.path} className="flex flex-col gap-px">
        {row(
          node.path,
          active,
          depth,
          <>
            <button
              type="button"
              aria-label={t("library.toggleCollection", { name: node.name })}
              className={cn(
                "text-muted-foreground/70 hover:text-foreground flex size-4 shrink-0 items-center justify-center",
                !node.children.length && "invisible",
              )}
              onClick={(event) => {
                event.stopPropagation();
                setCollapsed((old) => {
                  const next = new Set(old);
                  if (!next.delete(node.path)) next.add(node.path);
                  return next;
                });
              }}
            >
              <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} />
            </button>
            <Icon className="text-muted-foreground size-4 shrink-0" strokeWidth={1.75} />
            <span className="truncate">{node.name}</span>
            {count(counts?.byCollection[node.path])}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label={t("library.collectionActions", { name: node.name })}
                  className="text-muted-foreground hover:text-foreground hidden size-4 shrink-0 items-center justify-center group-hover:flex data-[state=open]:flex"
                  onClick={(event) => event.stopPropagation()}
                >
                  <MoreHorizontal className="size-3.5" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuGroup>
                  <DropdownMenuItem onSelect={() => add(node.path)}>
                    <FolderPlus />
                    {t("library.newSubcollection")}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => rename(node.path)}>
                    {t("library.renameCollection")}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem variant="destructive" onSelect={() => remove(node.path)}>
                    {t("library.removeCollection")}
                  </DropdownMenuItem>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </>,
          () => onScope({ kind: "collection", path: node.path }),
        )}
        {open && node.children.map((child) => renderNode(child, depth + 1))}
      </div>
    );
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-1 pr-2 pl-4">
        <span className="flex-1 truncate text-[13px] font-semibold" title={root}>
          {t("library.title")}
        </span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="size-6" aria-label={t("library.libraryActions")}>
              <MoreHorizontal className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuGroup>
              <DropdownMenuItem onSelect={() => add()}>
                <FolderPlus />
                {t("library.newCollection")}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={onChangeRoot}>
                <FolderOpen />
                {t("library.changeFolder")}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void shellOpen(root).catch(reportError)}>
                {t("files.revealInFinder")}
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button
          variant="ghost"
          size="icon"
          className="size-6"
          title={t("library.newCollection")}
          aria-label={t("library.newCollection")}
          onClick={() => add()}
        >
          <FolderPlus className="size-4" strokeWidth={1.75} />
        </Button>
      </div>
      <nav className="flex min-h-0 flex-1 flex-col gap-px overflow-y-auto px-1.5 pb-2">
        {row(
          "all",
          scope.kind === "all",
          0,
          <>
            <Library className="text-muted-foreground size-4 shrink-0" strokeWidth={1.75} />
            <span className="truncate font-medium">{t("library.all")}</span>
            {count(counts?.total)}
          </>,
          () => onScope({ kind: "all" }),
        )}
        {tree.map((node) => renderNode(node, 1))}
        <div className="h-2 shrink-0" />
        {row(
          "unfiled",
          scope.kind === "unfiled",
          0,
          <>
            <Inbox className="text-muted-foreground size-4 shrink-0" strokeWidth={1.75} />
            <span className="truncate">{t("library.unfiled")}</span>
            {count(counts?.unfiled)}
          </>,
          () => onScope({ kind: "unfiled" }),
        )}
        {row(
          "trash",
          scope.kind === "trash",
          0,
          <>
            <Trash2 className="text-muted-foreground size-4 shrink-0" strokeWidth={1.75} />
            <span className="truncate">{t("library.trash")}</span>
            {count(counts?.trashed)}
          </>,
          () => onScope({ kind: "trash" }),
        )}
      </nav>
    </div>
  );
}

function TagPane({
  snapshot,
  counts,
  selected,
  onChange,
}: {
  snapshot?: LibrarySnapshot;
  counts?: Counts;
  selected: string[];
  onChange: (tags: string[]) => void;
}) {
  const t = useLibraryText();
  const [filter, setFilter] = useState("");
  const tags = useMemo(
    () =>
      Object.keys(counts?.byTag ?? {})
        .filter((tag) => tag.toLowerCase().includes(filter.trim().toLowerCase()))
        .sort((a, b) => a.localeCompare(b)),
    [counts, filter],
  );
  return (
    <div className="flex max-h-[40%] shrink-0 flex-col gap-2 border-t px-3 py-3">
      <span className="text-[13px] font-semibold">{t("library.tags")}</span>
      <Input
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
        placeholder={t("library.filterTags")}
        className="bg-background h-7 text-xs"
      />
      <div className="flex min-h-0 flex-wrap gap-1 overflow-y-auto">
        {snapshot && !tags.length && <span className="text-muted-foreground text-xs">{t("library.noTags")}</span>}
        {tags.map((tag) => {
          const on = selected.includes(tag);
          return (
            <button
              key={tag}
              type="button"
              aria-pressed={on}
              className={cn(
                "rounded px-1.5 py-0.5 text-xs",
                on
                  ? "bg-primary text-primary-foreground"
                  : "bg-foreground/[0.06] text-foreground/80 hover:bg-foreground/10",
              )}
              onClick={() => onChange(on ? selected.filter((value) => value !== tag) : [...selected, tag])}
            >
              {tag}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ItemTable({
  items,
  sort,
  onSort,
  selected,
  onSelect,
  expanded,
  onToggle,
  root,
  run,
  empty,
}: {
  items: LibraryItem[];
  sort: Sort;
  onSort: (key: SortKey) => void;
  selected: string;
  onSelect: (key: string) => void;
  expanded: Set<string>;
  onToggle: (key: string) => void;
  root: string;
  run: (task: () => Promise<unknown>) => void;
  empty: string;
}) {
  const t = useLibraryText();
  const body = useRef<HTMLDivElement>(null);
  const grid = "grid grid-cols-[minmax(0,1fr)_minmax(0,12rem)_3.5rem_4.5rem_4.5rem] items-center gap-3";
  // 打开文献库时不等几百行全画完：先画第一屏，画出来后马上补上其余的
  const [whole, setWhole] = useState(items.length <= FIRST_SCREEN);
  useEffect(() => {
    if (whole) return;
    const timer = setTimeout(() => setWhole(true));
    return () => clearTimeout(timer);
  }, [whole]);
  const rows = whole ? items : items.slice(0, FIRST_SCREEN);
  // 右键菜单整张表共用一个（见 ItemMenu）：记着是哪一篇、鼠标点在哪
  const [menu, setMenu] = useState<{ key: string; x: number; y: number; open: boolean }>();
  const menuItem = menu && items.find((item) => item.key === menu.key);
  useEffect(() => {
    if (selected)
      body.current?.querySelector(`[data-key="${CSS.escape(selected)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selected, whole]);
  const header = (key: SortKey | null, label: string, className = "") => (
    <button
      type="button"
      disabled={!key}
      className={cn("flex min-w-0 items-center gap-1 text-left", className, key && "hover:text-foreground")}
      onClick={() => key && onSort(key)}
    >
      <span className="truncate">{label}</span>
      {key &&
        sort.key === key &&
        (sort.direction === "asc" ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />)}
    </button>
  );
  const onKeyDown = (event: KeyboardEvent) => {
    const index = items.findIndex((item) => item.key === selected);
    const item = items[index];
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const next = items[Math.min(items.length - 1, Math.max(0, index + (event.key === "ArrowDown" ? 1 : -1)))];
      if (next) onSelect(next.key);
    }
    if (!item) return;
    if (event.key === "Enter") openItem(item);
    if (event.key === "ArrowRight" && !expanded.has(item.key)) onToggle(item.key);
    if (event.key === "ArrowLeft" && expanded.has(item.key)) onToggle(item.key);
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className={cn(grid, "text-muted-foreground mx-1.5 h-8 shrink-0 border-b pr-2.5 pl-1.5 text-xs")}>
        {header("title", t("library.fields.title"), "pl-[1.375rem]")}
        {header("authors", t("library.fields.authors"))}
        {header("year", t("library.fields.year"))}
        {header("status", t("library.fields.status"))}
        {header(null, t("library.fields.attachments"))}
      </div>
      <div
        ref={body}
        role="listbox"
        tabIndex={0}
        aria-label={t("library.items")}
        className="min-h-0 flex-1 overflow-y-auto pt-1 outline-none"
        onKeyDown={onKeyDown}
      >
        {!items.length && <p className="text-muted-foreground px-6 py-10 text-center text-sm">{empty}</p>}
        {rows.map((item) => {
          const [TypeIcon, typeColor] = itemTypeIcon(item.itemType);
          const active = item.key === selected;
          const open = expanded.has(item.key);
          return (
            <div key={item.key} data-key={item.key}>
              <div
                role="option"
                aria-selected={active}
                className={cn(
                  grid,
                  "mx-1.5 h-8 rounded-md pr-2.5 pl-1.5 select-none",
                  active ? "bg-primary/10" : "hover:bg-foreground/[0.04]",
                  item.trashed && "opacity-60",
                )}
                onClick={() => onSelect(item.key)}
                onDoubleClick={() => openItem(item)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  setMenu({ key: item.key, x: event.clientX, y: event.clientY, open: true });
                }}
              >
                <div className="flex min-w-0 items-center gap-1.5">
                  <button
                    type="button"
                    aria-label={t("library.toggleAttachments")}
                    aria-expanded={open}
                    className="text-muted-foreground/60 hover:text-foreground flex size-4 shrink-0 items-center justify-center"
                    onClick={(event) => {
                      event.stopPropagation();
                      onToggle(item.key);
                    }}
                  >
                    <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} />
                  </button>
                  <TypeIcon className={cn("size-4 shrink-0", typeColor)} strokeWidth={1.75} />
                  <span className="truncate" title={item.title}>
                    {item.title}
                  </span>
                </div>
                <span className="text-foreground/75 truncate" title={item.authors.join("; ")}>
                  {item.authors.join("; ")}
                </span>
                <span className="text-foreground/75 tabular-nums">{item.year}</span>
                <StatusPicker
                  value={item.status}
                  onPick={(status) => run(() => updateItem(root, item.key, { status }))}
                  t={t}
                />
                <span className="flex items-center gap-1.5">
                  <AttachmentIcon
                    icon={FileText}
                    label={t("library.openPdf")}
                    className="text-red-500/85"
                    path={item.pdfPath}
                  />
                  <AttachmentIcon
                    icon={Languages}
                    label={t("library.openTranslation")}
                    className="text-sky-600/85"
                    path={item.translations.dual ?? item.translations.mono}
                  />
                  <AttachmentIcon
                    icon={NotebookPen}
                    label={t("library.openNote")}
                    className="text-orange-500/85"
                    path={item.notePath}
                  />
                </span>
              </div>
              {open && (
                <div className="text-foreground/75 flex flex-col pb-1">
                  {attachmentsOf(item).map(({ path, label, icon: Icon }) => (
                    <button
                      key={path}
                      type="button"
                      className="hover:bg-foreground/[0.04] mx-1.5 flex h-7 items-center gap-2 rounded-md pl-12 text-left text-xs"
                      onDoubleClick={() => void openDocumentFile(path).catch(reportError)}
                      title={path}
                    >
                      <Icon className="text-muted-foreground size-3.5 shrink-0" />
                      <span className="truncate">{label}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
        {menu && menuItem && (
          <ItemMenu
            item={menuItem}
            position={menu}
            open={menu.open}
            onClose={() => setMenu((current) => current && { ...current, open: false })}
            root={root}
            run={run}
          />
        )}
      </div>
    </div>
  );
}

function attachmentsOf(item: LibraryItem): { path: string; label: string; icon: LucideIcon }[] {
  const name = (path: string) => path.split(/[\\/]/).at(-1) ?? path;
  const list: { path: string; label: string; icon: LucideIcon }[] = [];
  if (item.pdfPath) list.push({ path: item.pdfPath, label: name(item.pdfPath), icon: FileText });
  if (item.translations.dual)
    list.push({ path: item.translations.dual, label: name(item.translations.dual), icon: Languages });
  if (item.translations.mono)
    list.push({ path: item.translations.mono, label: name(item.translations.mono), icon: Languages });
  list.push({ path: item.notePath, label: name(item.notePath), icon: NotebookPen });
  return list;
}

function openItem(item: LibraryItem) {
  void openDocumentFile(item.pdfPath ?? item.notePath).catch(reportError);
}

function AttachmentIcon({
  icon: Icon,
  label,
  className,
  path,
}: {
  icon: LucideIcon;
  label: string;
  className: string;
  path?: string;
}) {
  if (!path) return <Icon className="text-muted-foreground/20 size-4" strokeWidth={1.75} aria-hidden />;
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      className={cn("rounded-sm hover:opacity-70", className)}
      onClick={(event) => {
        event.stopPropagation();
        void openDocumentFile(path).catch(reportError);
      }}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      <Icon className="size-4" strokeWidth={1.75} />
    </button>
  );
}

function StatusPicker({
  value,
  onPick,
  t,
}: {
  value: ReadStatus;
  onPick: (status: ReadStatus) => void;
  t: ReturnType<typeof useLibraryText>;
}) {
  // 下拉菜单组件第一次点它时才装上：每行一开始就各带一个的话，画一行的时间要翻倍
  const [armed, setArmed] = useState(false);
  const [open, setOpen] = useState(false);
  const arm = () => {
    setArmed(true);
    setOpen(true);
  };
  const label = t("library.fields.status");
  const look = cn(
    "hover:bg-foreground/[0.07] data-[state=open]:bg-foreground/[0.07] -ml-1.5 truncate rounded px-1.5 py-0.5 text-xs",
    STATUS_COLOR[value],
  );
  return (
    // 菜单画在别处，但点它的事件仍会冒到这一行：拦住，免得点状态变成选中或打开这篇
    <span
      className="flex min-w-0"
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      {armed ? (
        <DropdownMenu open={open} onOpenChange={setOpen}>
          <DropdownMenuTrigger aria-label={label} className={look}>
            {t(`library.status.${value}`)}
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-24">
            {STATUSES.map((status) => (
              <DropdownMenuItem key={status} onSelect={() => status !== value && onPick(status)}>
                <Check className={cn(status !== value && "invisible")} />
                {t(`library.status.${status}`)}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        // 和下拉菜单的按钮一样，鼠标按下就弹出；键盘按回车、空格走 onClick
        <button
          type="button"
          aria-label={label}
          aria-haspopup="menu"
          className={look}
          onPointerDown={(event) => event.button === 0 && arm()}
          onClick={arm}
        >
          {t(`library.status.${value}`)}
        </button>
      )}
    </span>
  );
}

/** 条目的右键菜单。整张表共用一个，弹在鼠标按下的位置 */
function ItemMenu({
  item,
  position,
  open,
  onClose,
  root,
  run,
}: {
  item: LibraryItem;
  position: { x: number; y: number };
  open: boolean;
  onClose: () => void;
  root: string;
  run: (task: () => Promise<unknown>) => void;
}) {
  const t = useLibraryText();
  return (
    <DropdownMenu open={open} onOpenChange={(next) => !next && onClose()}>
      <DropdownMenuTrigger asChild>
        <span className="pointer-events-none fixed size-0" style={{ left: position.x, top: position.y }} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuGroup>
          {item.pdfPath && (
            <DropdownMenuItem onSelect={() => void openDocumentFile(item.pdfPath!).catch(reportError)}>
              <FileText />
              {t("library.openPdf")}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onSelect={() => void openDocumentFile(item.notePath).catch(reportError)}>
            <NotebookPen />
            {t("library.openNote")}
          </DropdownMenuItem>
          {!item.trashed && (
            <DropdownMenuItem onSelect={() => run(() => completeItem(root, item, t))}>
              <WandSparkles />
              {t("library.lookup.complete")}
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          {STATUSES.map((status) => (
            <DropdownMenuItem key={status} onSelect={() => run(() => updateItem(root, item.key, { status }))}>
              <span className={cn("mx-1 size-2 rounded-full", STATUS_DOT[status])} />
              {t("library.markAs", { status: t(`library.status.${status}`) })}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => void shellOpen(item.dir).catch(reportError)}>
            {t("files.revealInFinder")}
          </DropdownMenuItem>
          {item.trashed ? (
            <DropdownMenuItem onSelect={() => run(() => restoreItem(root, item.key))}>
              <RotateCcw />
              {t("library.restore")}
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem variant="destructive" onSelect={() => run(() => trashItem(root, item.key))}>
              <Trash2 />
              {t("library.moveToTrash")}
            </DropdownMenuItem>
          )}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function Overview({
  counts,
  status,
  onStatus,
}: {
  counts?: Counts;
  status?: ReadStatus;
  onStatus: (status: ReadStatus) => void;
}) {
  const t = useLibraryText();
  return (
    <div className="flex flex-col items-center gap-5 px-5 py-14">
      <BookOpen className="text-muted-foreground/50 size-10" strokeWidth={1.25} />
      <p className="text-muted-foreground text-sm">{t("library.pickItem")}</p>
      <div className="grid w-full grid-cols-2 gap-2">
        {STATUSES.map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={status === value}
            className={cn(
              "flex items-center justify-between rounded-lg border px-3 py-2.5 text-left transition-colors",
              status === value ? "border-foreground/30 bg-foreground/[0.04]" : "hover:bg-foreground/[0.03]",
            )}
            onClick={() => onStatus(value)}
          >
            <span className={cn("text-xs", STATUS_COLOR[value])}>{t(`library.status.${value}`)}</span>
            <span className="text-base font-semibold tabular-nums">{counts?.byStatus[value] ?? 0}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function InfoPane({
  item,
  root,
  collections,
  run,
}: {
  item: LibraryItem;
  root: string;
  collections: string[];
  run: (task: () => Promise<unknown>) => void;
}) {
  const t = useLibraryText();
  const save = (patch: Parameters<typeof updateItem>[2]) => run(() => updateItem(root, item.key, patch));
  const links: { label: string; value: string; url: string }[] = [];
  if (item.doi) links.push({ label: "DOI", value: item.doi, url: `https://doi.org/${item.doi}` });
  if (item.arxiv) links.push({ label: "arXiv", value: item.arxiv, url: `https://arxiv.org/abs/${item.arxiv}` });
  else if (item.url) links.push({ label: "URL", value: item.url, url: item.url });
  return (
    <div className="flex flex-col gap-4 px-4 py-4">
      <EditableText
        value={item.title}
        multiline
        className="text-[15px] leading-snug font-semibold"
        label={t("library.fields.title")}
        onSave={(title) => {
          if (title.trim()) save({ title: title.trim() });
        }}
      />
      <div className="flex flex-wrap gap-1">
        {STATUSES.map((status) => (
          <button
            key={status}
            type="button"
            aria-pressed={item.status === status}
            className={cn(
              "flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs",
              item.status === status
                ? "border-foreground/25 bg-foreground/[0.06] text-foreground"
                : "text-muted-foreground hover:text-foreground border-transparent",
            )}
            onClick={() => save({ status })}
          >
            <span className={cn("size-1.5 rounded-full", STATUS_DOT[status])} />
            {t(`library.status.${status}`)}
          </button>
        ))}
      </div>
      <dl className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-start gap-x-2 gap-y-1 text-xs">
        <Field label={t("library.fields.authors")}>
          <EditableText
            value={item.authors.join("; ")}
            multiline
            label={t("library.fields.authors")}
            onSave={(value) =>
              save({
                authors: value
                  .split(/[;；\n]/)
                  .map((name) => name.trim())
                  .filter(Boolean),
              })
            }
          />
        </Field>
        <Field label={t("library.fields.year")}>
          <EditableText value={item.year ?? ""} label={t("library.fields.year")} onSave={(year) => save({ year })} />
        </Field>
        <Field label={t("library.fields.venue")}>
          <EditableText
            value={item.venue ?? ""}
            label={t("library.fields.venue")}
            onSave={(venue) => save({ venue })}
          />
        </Field>
        <Field label={t("library.fields.itemType")}>
          <EditableText
            value={item.itemType ?? ""}
            label={t("library.fields.itemType")}
            onSave={(itemType) => save({ itemType })}
          />
        </Field>
        {links.map((link) => (
          <Field key={link.label} label={link.label}>
            <button
              type="button"
              className="text-primary block max-w-full truncate px-1 py-0.5 text-left hover:underline"
              title={link.url}
              onClick={() => void shellOpen(link.url).catch(reportError)}
            >
              {link.value}
            </button>
          </Field>
        ))}
        {item.added && (
          <Field label={t("library.fields.added")}>
            <span className="text-foreground/75 block px-1 py-0.5">{item.added}</span>
          </Field>
        )}
      </dl>
      <ChipEditor
        label={t("library.fields.collections")}
        values={item.collections}
        suggestions={collections}
        onChange={(values) => save({ collections: values })}
      />
      <ChipEditor
        label={t("library.fields.tags")}
        values={item.tags}
        prefix="#"
        onChange={(values) => save({ tags: values })}
      />
      {item.abstract && (
        <section className="flex flex-col gap-1">
          <h3 className="text-muted-foreground text-xs">{t("library.fields.abstract")}</h3>
          <p className="text-foreground/80 line-clamp-[12] text-xs leading-relaxed select-text">{item.abstract}</p>
        </section>
      )}
      <div className="flex gap-2">
        {item.pdfPath && (
          <Button size="sm" className="flex-1" onClick={() => void openDocumentFile(item.pdfPath!).catch(reportError)}>
            <FileText data-icon="inline-start" />
            {t("library.openPdf")}
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          className="flex-1"
          onClick={() => void openDocumentFile(item.notePath).catch(reportError)}
        >
          <NotebookPen data-icon="inline-start" />
          {t("library.openNote")}
        </Button>
        {!item.trashed && (
          <Button
            size="sm"
            variant="outline"
            aria-label={t("library.lookup.complete")}
            title={t("library.lookup.complete")}
            onClick={() => run(() => completeItem(root, item, t))}
          >
            <WandSparkles />
          </Button>
        )}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground py-1">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </>
  );
}

function EditableText({
  value,
  label,
  onSave,
  multiline,
  className,
}: {
  value: string;
  label: string;
  onSave: (value: string) => void;
  multiline?: boolean;
  className?: string;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const shared = {
    "aria-label": label,
    value: draft,
    onChange: (event: { target: { value: string } }) => setDraft(event.target.value),
    onBlur: () => {
      if (draft !== value) onSave(draft);
    },
    onKeyDown: (event: KeyboardEvent) => {
      if (event.key === "Escape") setDraft(value);
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        (event.target as HTMLElement).blur();
      }
    },
    className: cn(
      "hover:bg-foreground/[0.04] focus:bg-background focus:ring-ring/40 w-full min-w-0 resize-none rounded border-0 bg-transparent px-1 py-0.5 shadow-none outline-none focus:ring-1",
      className,
    ),
  };
  return multiline ? (
    <Textarea rows={1} style={{ fieldSizing: "content", minHeight: 0 }} {...shared} />
  ) : (
    <input {...shared} />
  );
}

function ChipEditor({
  label,
  values,
  suggestions = [],
  prefix = "",
  onChange,
}: {
  label: string;
  values: string[];
  suggestions?: string[];
  prefix?: string;
  onChange: (values: string[]) => void;
}) {
  const t = useLibraryText();
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const listId = useMemo(() => `chips-${Math.random().toString(36).slice(2)}`, []);
  const commit = () => {
    const value = draft.trim().replace(/^#/, "");
    if (value && !values.includes(value)) onChange([...values, value]);
    setDraft("");
    setAdding(false);
  };
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-muted-foreground text-xs">{label}</h3>
      <div className="flex flex-wrap items-center gap-1">
        {values.map((value) => (
          <span
            key={value}
            className="bg-foreground/[0.06] text-foreground/80 group/chip flex items-center gap-0.5 rounded px-1.5 py-0.5 text-xs"
          >
            {prefix}
            {value}
            <button
              type="button"
              aria-label={t("library.removeValue", { value })}
              className="text-muted-foreground hover:text-foreground hidden group-hover/chip:block"
              onClick={() => onChange(values.filter((item) => item !== value))}
            >
              <X className="size-3" />
            </button>
          </span>
        ))}
        {adding ? (
          <>
            <input
              autoFocus
              list={suggestions.length ? listId : undefined}
              value={draft}
              aria-label={label}
              onChange={(event) => setDraft(event.target.value)}
              onBlur={commit}
              onKeyDown={(event) => {
                if (event.key === "Enter") commit();
                if (event.key === "Escape") {
                  setDraft("");
                  setAdding(false);
                }
              }}
              className="focus:ring-ring/40 h-6 w-32 rounded border px-1.5 text-xs outline-none focus:ring-1"
            />
            {!!suggestions.length && (
              <datalist id={listId}>
                {suggestions
                  .filter((value) => !values.includes(value))
                  .map((value) => (
                    <option key={value} value={value} />
                  ))}
              </datalist>
            )}
          </>
        ) : (
          <button
            type="button"
            aria-label={t("library.addValue", { label })}
            className="text-muted-foreground hover:text-foreground hover:bg-foreground/[0.05] flex size-5 items-center justify-center rounded"
            onClick={() => setAdding(true)}
          >
            <Plus className="size-3.5" />
          </button>
        )}
      </div>
    </section>
  );
}
