import { Button } from "@/components/ui/button";
import ResearchFileMenu from "@/components/research-file-menu";
import { promptResearchRename } from "@/core/research/ResearchRename";
import { restoreLastResearchFile } from "@/core/research/ResearchTrash";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { displayWorkspaceName, FileName } from "@/components/ui/file-name";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Project } from "@/core/Project";
import { dropFilesAtClientPoint } from "@/core/research/ResearchDrop";
import {
  RESEARCH_FILES_CHANGED_EVENT,
  ResearchFolder,
  type ResearchFileEntry,
  type ResearchFolderScan,
} from "@/core/research/ResearchFolder";
import { emitResearchEvent, onResearchEvent } from "@/core/research/ResearchShell";
import { closeEmptyDrafts, onOpenFile } from "@/core/service/GlobalMenu";
import { Settings } from "@/core/service/Settings";
import { createSubWindow } from "@/core/subWindowOpen";
import { TabWorkspace } from "@/core/TabWorkspace";
import { activeResourceTabAtom, store, tabsAtom } from "@/state";
import { cn } from "@/utils/cn";
import { Vector } from "@graphif/data-structures";
import { Rectangle } from "@graphif/shapes";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import i18next from "i18next";
import { useAtomValue } from "jotai";
import {
  ChevronDown,
  ChevronRight,
  ExternalLink,
  FileImage,
  FileText,
  FolderInput,
  FolderOpen,
  LayoutDashboard,
  NotebookPen,
  Plus,
  RefreshCw,
  Search,
  X,
  type LucideIcon,
} from "lucide-react";
import React from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { URI } from "vscode-uri";

type SectionKind = ResearchFileEntry["kind"];

const SECTIONS: { kind: SectionKind; icon: LucideIcon }[] = [
  { kind: "workspace", icon: LayoutDashboard },
  { kind: "pdf", icon: FileText },
  { kind: "image", icon: FileImage },
  { kind: "markdown", icon: NotebookPen },
];

const SECTION_ICONS = Object.fromEntries(SECTIONS.map((section) => [section.kind, section.icon])) as Record<
  SectionKind,
  LucideIcon
>;

/** 按下后移动超过这个距离（像素）才算拖拽，否则是点击 */
const DRAG_THRESHOLD = 5;
const PANEL_ENTER_REFRESH_INTERVAL = 3000;
/** 名字中间省略时，扩展名前面再多留几个字，`v7_final.pdf` 和 `v7_final2.pdf` 才分得出来 */
const NAME_TAIL_CHARS = 4;
const COLLAPSED_SECTIONS_KEY = "research.files.collapsedSections";

// 面板切到同组别的标签页时组件会卸载，这些放在模块里，切回来时不用从头再读、搜索词也还在
let cachedScan: { root: string; scan: ResearchFolderScan } | null = null;
let cachedQuery = "";

function loadCollapsedSections(): Set<SectionKind> {
  const saved = (localStorage.getItem(COLLAPSED_SECTIONS_KEY) ?? "").split(",");
  return new Set(SECTIONS.map((section) => section.kind).filter((kind) => saved.includes(kind)));
}

function pathKey(path: string) {
  return path.replace(/\\/g, "/").normalize("NFC").toLowerCase();
}

function folderNameOf(path: string) {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function showError(error: unknown) {
  toast.error(error instanceof Error ? error.message : String(error));
}

// 走事件而不是直接调 ResearchFolder.chooseRoot()：ResearchSession 收到后还会更新工作区列表和会话记录
function chooseFolder() {
  emitResearchEvent("chooseFolder");
}

/**
 * 文件面板：停靠在左侧，列出研究文件夹里的工作区、论文、图片和笔记。
 * 没有文件监听（fs 插件没开 watch），窗口重新获得焦点时刷新。
 */
export default function FileManagerWindow() {
  const { t } = useTranslation("research");
  const [root] = Settings.use("researchFolderPath");
  const [scan, setScan] = React.useState<ResearchFolderScan | null>(
    cachedScan && cachedScan.root === root ? cachedScan.scan : null,
  );
  const [error, setError] = React.useState("");
  const [query, setQuery] = React.useState(cachedQuery);
  const [collapsed, setCollapsed] = React.useState(loadCollapsedSections);
  const [selectedPath, setSelectedPath] = React.useState("");
  const [drag, setDrag] = React.useState<{ entry: ResearchFileEntry; x: number; y: number } | null>(null);
  const tabs = useAtomValue(tabsAtom);
  const activeResourceTab = useAtomValue(activeResourceTabAtom);
  const rootRef = React.useRef<HTMLDivElement>(null);
  const searchRef = React.useRef<HTMLInputElement>(null);
  const generationRef = React.useRef(0);
  const suppressClickRef = React.useRef(false);
  const openingRef = React.useRef(new Set<string>());
  const lastRefreshRef = React.useRef(0);

  const refresh = React.useCallback(async () => {
    const generation = ++generationRef.current;
    lastRefreshRef.current = Date.now();
    const currentRoot = ResearchFolder.getRoot();
    if (!currentRoot) {
      setScan(null);
      setError("");
      return;
    }
    // 换了文件夹时不要先显示旧文件夹的列表
    if (cachedScan?.root !== currentRoot) setScan(null);
    try {
      const result = await ResearchFolder.scan();
      if (generation !== generationRef.current) return;
      cachedScan = { root: ResearchFolder.getRoot(), scan: result };
      setScan(result);
      setError("");
    } catch (scanError) {
      if (generation !== generationRef.current) return;
      setError(scanError instanceof Error ? scanError.message : String(scanError));
    }
  }, []);

  React.useEffect(() => {
    void refresh();
  }, [root, refresh]);

  React.useEffect(() => {
    const onChanged = () => void refresh();
    window.addEventListener("focus", onChanged);
    window.addEventListener(RESEARCH_FILES_CHANGED_EVENT, onChanged);
    return () => {
      window.removeEventListener("focus", onChanged);
      window.removeEventListener(RESEARCH_FILES_CHANGED_EVENT, onChanged);
    };
  }, [refresh]);

  // 草稿另存进研究文件夹之类的改动不一定伴随窗口失焦，鼠标移进面板时也顺手刷新（限频）
  const onPanelPointerEnter = () => {
    if (Date.now() - lastRefreshRef.current > PANEL_ENTER_REFRESH_INTERVAL) void refresh();
  };

  const openPaths = React.useMemo(
    () =>
      new Set(
        tabs
          .filter((tab): tab is Project => tab instanceof Project && !tab.closing && tab.uri.scheme === "file")
          .map((project) => pathKey(project.uri.fsPath)),
      ),
    [tabs],
  );

  const activeWorkspaceKey =
    activeResourceTab instanceof Project && activeResourceTab.uri.scheme === "file"
      ? pathKey(activeResourceTab.uri.fsPath)
      : "";

  const grouped = React.useMemo(() => {
    const needle = query.trim().normalize("NFC").toLowerCase();
    const groups: Record<SectionKind, ResearchFileEntry[]> = { workspace: [], pdf: [], image: [], markdown: [] };
    for (const entry of scan?.entries ?? []) {
      if (needle && !entry.relPath.normalize("NFC").toLowerCase().includes(needle)) continue;
      groups[entry.kind].push(entry);
    }
    return groups;
  }, [scan, query]);

  const updateQuery = (value: string) => {
    cachedQuery = value;
    setQuery(value);
  };

  const onSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Escape") return;
    if (!query) {
      event.currentTarget.blur();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    updateQuery("");
  };

  const clearQuery = () => {
    updateQuery("");
    searchRef.current?.focus();
  };

  const toggleSection = (kind: SectionKind) => {
    const next = new Set(collapsed);
    if (next.has(kind)) next.delete(kind);
    else next.add(kind);
    localStorage.setItem(COLLAPSED_SECTIONS_KEY, [...next].join(","));
    setCollapsed(next);
  };

  const revealFolder = () => {
    shellOpen(root).catch(showError);
  };

  const openWorkspace = async (entry: ResearchFileEntry) => {
    if (openingRef.current.has(entry.absPath)) return;
    openingRef.current.add(entry.absPath);
    try {
      const project = await onOpenFile(URI.file(entry.absPath), "科研工作台-文件面板");
      if (project) await closeEmptyDrafts(project);
    } catch (openError) {
      showError(openError);
    } finally {
      openingRef.current.delete(entry.absPath);
    }
  };

  const onRowClick = (event: React.MouseEvent, entry: ResearchFileEntry) => {
    if (suppressClickRef.current) return;
    setSelectedPath(entry.absPath);
    // 双击的第二下（detail 为 2）不再打开一次：第一下若已经打开完，openingRef 拦不住
    if (entry.kind === "workspace" && event.detail <= 1) void openWorkspace(entry);
  };

  const onRowDoubleClick = (entry: ResearchFileEntry) => {
    if (entry.kind === "workspace") return;
    shellOpen(entry.absPath).catch(showError);
  };

  // 用指针事件而不是 HTML5 拖放：Windows 上自定义的系统拖放目标会吞掉网页里的 drag 事件
  const onRowPointerDown = (event: React.PointerEvent<HTMLDivElement>, entry: ResearchFileEntry) => {
    if (event.button !== 0) return;
    const row = event.currentTarget;
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startY = event.clientY;
    let dragging = false;

    const onMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      if (!dragging) {
        if (Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) < DRAG_THRESHOLD) return;
        dragging = true;
        // 捕获指针，拖过白板时画布不会收到这些移动和松开事件
        row.setPointerCapture(pointerId);
      }
      setDrag({ entry, x: moveEvent.clientX, y: moveEvent.clientY });
    };
    const finish = (dropEvent: PointerEvent | null) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onKeyDown, true);
      setDrag(null);
      if (!dragging) return;
      // 在同一行上松开时浏览器还会补发一次 click，不能当成「打开」
      suppressClickRef.current = true;
      setTimeout(() => {
        suppressClickRef.current = false;
      }, 0);
      if (!dropEvent) return;
      const panel = rootRef.current?.closest<HTMLElement>("[data-pg-tab-group-id]") ?? rootRef.current;
      const rect = panel?.getBoundingClientRect();
      const insidePanel =
        rect &&
        dropEvent.clientX >= rect.left &&
        dropEvent.clientX <= rect.right &&
        dropEvent.clientY >= rect.top &&
        dropEvent.clientY <= rect.bottom;
      if (insidePanel) return;
      dropFilesAtClientPoint([entry.absPath], dropEvent.clientX, dropEvent.clientY).catch(showError);
    };
    const onUp = (upEvent: PointerEvent) => {
      if (upEvent.pointerId === pointerId) finish(upEvent);
    };
    const onCancel = (cancelEvent: PointerEvent) => {
      if (cancelEvent.pointerId === pointerId) finish(null);
    };
    const onKeyDown = (keyEvent: KeyboardEvent) => {
      if (keyEvent.key !== "Escape" || !dragging) return;
      keyEvent.preventDefault();
      keyEvent.stopPropagation();
      finish(null);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onKeyDown, true);
  };

  if (!root) {
    return (
      <div className="flex h-full min-h-0 min-w-0 flex-col">
        <div className="flex h-9 shrink-0 items-center gap-1 border-b px-2">
          <div className="text-muted-foreground flex h-7 min-w-0 items-center gap-1 px-1 text-[13px] font-medium">
            <FolderOpen className="size-4 shrink-0" />
            <span className="truncate">{t("files.noFolder")}</span>
          </div>
        </div>
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
          <FolderOpen className="text-muted-foreground size-10" />
          <p className="text-muted-foreground text-[13px]">{t("files.emptyHint")}</p>
          <Button className="h-8 rounded-[6px] px-3 py-0 text-[13px] shadow-none" onClick={chooseFolder}>
            <FolderInput />
            {t("files.chooseResearchFolder")}
          </Button>
        </div>
      </div>
    );
  }

  const searching = query.trim() !== "";
  const totalShown = SECTIONS.reduce((sum, section) => sum + grouped[section.kind].length, 0);

  return (
    <div ref={rootRef} className="flex h-full min-h-0 min-w-0 flex-col" onPointerEnter={onPanelPointerEnter}>
      <div className="flex h-9 shrink-0 items-center gap-1 border-b px-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="hover:bg-accent data-[state=open]:bg-primary/10 data-[state=open]:text-primary focus-visible:ring-primary flex h-7 min-w-0 items-center gap-1 rounded-[6px] px-1 text-[13px] font-medium outline-none focus-visible:ring-1"
            >
              <FolderOpen className="size-4 shrink-0 opacity-70" />
              <FileName name={folderNameOf(root)} title={root} keepExtension={false} />
              <ChevronDown className="size-3.5 shrink-0 opacity-70" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-48">
            <DropdownMenuItem className="h-8 text-[13px]" onSelect={chooseFolder}>
              <FolderInput />
              {t("files.changeFolder")}
            </DropdownMenuItem>
            <DropdownMenuItem className="h-8 text-[13px]" onSelect={revealFolder}>
              <ExternalLink />
              {t("files.revealInFinder")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="h-8 text-[13px]" onSelect={() => void refresh()}>
              <RefreshCw />
              {t("files.refresh")}
            </DropdownMenuItem>
            <DropdownMenuItem
              className="h-8 text-[13px]"
              onSelect={() => {
                restoreLastResearchFile()
                  .then(() => toast.success(t("fileMenu.restored")))
                  .catch(showError);
              }}
            >
              {t("fileMenu.restoreLast")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Tooltip>
          <TooltipTrigger>
            <Button
              variant="ghost"
              className="ml-auto h-7 shrink-0 gap-1 rounded-[6px] px-2 py-0 text-[12px] has-[>svg]:px-2"
              onClick={() => emitResearchEvent("newWorkspace")}
            >
              <Plus className="size-3.5" />
              {t("files.new")}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t("files.newWorkspace")}</TooltipContent>
        </Tooltip>
      </div>

      <div className="shrink-0 px-2 py-1.5">
        <div className="relative">
          <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2" />
          <Input
            ref={searchRef}
            className="bg-muted dark:bg-muted focus-visible:border-primary h-7 rounded-[6px] border-transparent px-7 text-[12px] shadow-none focus-visible:ring-0 md:text-[12px]"
            value={query}
            placeholder={t("files.searchPlaceholder")}
            onChange={(event) => updateQuery(event.target.value)}
            onKeyDown={onSearchKeyDown}
          />
          {query && (
            <button
              type="button"
              aria-label={t("files.clearSearch")}
              title={t("files.clearSearch")}
              className="text-muted-foreground hover:bg-accent hover:text-foreground absolute top-1/2 right-1 flex size-5 -translate-y-1/2 items-center justify-center rounded-[6px]"
              onClick={clearQuery}
            >
              <X className="size-3" />
            </button>
          )}
        </div>
      </div>

      {error ? (
        <div className="flex flex-col items-center gap-3 p-4 text-center text-[13px]">
          <p className="text-destructive break-all">{t("files.loadFailed", { error })}</p>
          <div className="flex gap-2">
            <Button variant="ghost" className="h-7 rounded-[6px] px-3 py-0 text-[13px]" onClick={() => void refresh()}>
              {t("files.retry")}
            </Button>
            <Button className="h-7 rounded-[6px] px-3 py-0 text-[13px] shadow-none" onClick={chooseFolder}>
              {t("files.chooseFolder")}
            </Button>
          </div>
        </div>
      ) : !scan ? (
        <p className="text-muted-foreground px-4 py-2 text-[13px]">{t("files.loading")}</p>
      ) : (
        <div className="min-h-0 flex-1 space-y-1 overflow-x-hidden overflow-y-auto px-1 py-1">
          {searching && totalShown === 0 && (
            <p className="text-muted-foreground px-2 py-1 text-[13px]">{t("files.noMatch")}</p>
          )}
          {SECTIONS.map(({ kind }) => {
            const entries = grouped[kind];
            // 工作区组没有内容时也留着，好提示用户去新建；其他空组、以及搜索时没有匹配的组都不显示
            if (entries.length === 0 && (searching || kind !== "workspace")) return null;
            const isCollapsed = collapsed.has(kind);
            return (
              <section key={kind}>
                <button
                  type="button"
                  aria-expanded={!isCollapsed}
                  className="text-muted-foreground hover:text-foreground flex h-7 w-full min-w-0 items-center gap-1 rounded-[6px] px-2 text-[11px] font-semibold tracking-wide"
                  onClick={() => toggleSection(kind)}
                >
                  <ChevronRight className={cn("size-3 shrink-0 transition-transform", !isCollapsed && "rotate-90")} />
                  <span className="truncate">{t(`files.sections.${kind}`)}</span>
                  <span className="ml-auto shrink-0 tabular-nums">{entries.length}</span>
                </button>
                {!isCollapsed &&
                  (entries.length === 0 ? (
                    <p className="text-muted-foreground flex h-7 items-center px-2 text-[12px]">
                      <span className="truncate">{t("files.sectionEmpty.workspace")}</span>
                    </p>
                  ) : (
                    entries.map((entry) => (
                      <FileRow
                        key={entry.absPath}
                        entry={entry}
                        highlighted={
                          entry.kind === "workspace"
                            ? pathKey(entry.absPath) === activeWorkspaceKey
                            : selectedPath === entry.absPath
                        }
                        opened={entry.kind === "workspace" && openPaths.has(pathKey(entry.absPath))}
                        onPointerDown={(event) => onRowPointerDown(event, entry)}
                        onClick={(event) => onRowClick(event, entry)}
                        onDoubleClick={() => onRowDoubleClick(entry)}
                        onOpen={() =>
                          entry.kind === "workspace" ? void openWorkspace(entry) : onRowDoubleClick(entry)
                        }
                      />
                    ))
                  ))}
              </section>
            );
          })}
          {scan.truncated && (
            <p className="text-muted-foreground px-2 pt-1 text-[11px]">
              {t("files.truncated", { count: scan.entries.length })}
            </p>
          )}
          {scan.unreadableDirs.length > 0 && (
            <p className="text-muted-foreground px-2 pt-1 text-[11px]" title={scan.unreadableDirs.join("\n")}>
              {t("files.unreadableDirs", { count: scan.unreadableDirs.length })}
            </p>
          )}
        </div>
      )}

      {drag &&
        createPortal(
          <div
            className="bg-popover text-popover-foreground pointer-events-none fixed z-[9999] flex max-w-60 items-center gap-2 rounded-[6px] border px-2 py-1 text-[12px] shadow-md"
            style={{ left: drag.x + 12, top: drag.y + 8 }}
          >
            {React.createElement(SECTION_ICONS[drag.entry.kind], { className: "size-3.5 shrink-0" })}
            <FileName name={rowNameOf(drag.entry)} tailChars={NAME_TAIL_CHARS} />
          </div>,
          document.body,
        )}
    </div>
  );
}

function rowNameOf(entry: ResearchFileEntry) {
  return entry.kind === "workspace" ? displayWorkspaceName(entry.name) : entry.name;
}

function FileRow({
  entry,
  highlighted,
  opened,
  onPointerDown,
  onClick,
  onDoubleClick,
  onOpen,
}: {
  entry: ResearchFileEntry;
  /** 当前工作区，或刚点选的文件 */
  highlighted: boolean;
  opened: boolean;
  onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void;
  onClick: (event: React.MouseEvent<HTMLDivElement>) => void;
  onDoubleClick: () => void;
  onOpen: () => void;
}) {
  const { t } = useTranslation("research");
  const Icon = SECTION_ICONS[entry.kind];
  const dir = entry.relPath.includes("/") ? entry.relPath.slice(0, entry.relPath.lastIndexOf("/")) : "";
  const tooltip = `${entry.relPath}\n${t(entry.kind === "workspace" ? "files.workspaceRowHint" : "files.fileRowHint")}`;
  return (
    <ResearchFileMenu entry={entry} onOpen={onOpen}>
      <div
        role="button"
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key === "F2") {
            event.preventDefault();
            event.stopPropagation();
            void promptResearchRename(entry.absPath);
          }
        }}
        title={tooltip}
        className={cn(
          "flex h-7 min-w-0 cursor-default items-center gap-2 rounded-[6px] px-2 text-[13px] select-none",
          highlighted ? "bg-primary/10 text-primary" : "hover:bg-accent",
        )}
        onPointerDown={onPointerDown}
        onClick={onClick}
        onDoubleClick={onDoubleClick}
      >
        <Icon className={cn("size-3.5 shrink-0", !highlighted && "text-muted-foreground")} />
        <FileName name={rowNameOf(entry)} title={tooltip} tailChars={NAME_TAIL_CHARS} />
        {/* 空间不够时子目录先缩没，名字优先；完整路径在悬停提示里 */}
        {dir && <span className="text-muted-foreground min-w-0 shrink-[9999] truncate text-[11px]">{dir}</span>}
        {opened && <span className="bg-primary ml-auto size-1.5 shrink-0 rounded-full" title={t("files.opened")} />}
      </div>
    </ResearchFileMenu>
  );
}

const fileManagerTabIds = new Set<string>();

function findOpenTab() {
  return store.get(tabsAtom).find((tab) => !tab.closing && fileManagerTabIds.has(tab.id));
}

FileManagerWindow.open = () => {
  const existing = findOpenTab();
  if (existing) {
    TabWorkspace.focus(existing.id);
    return existing;
  }
  const tab = createSubWindow("FileManagerWindow", {
    title: i18next.t("files.title", { ns: "research" }),
    icon: FolderOpen,
    closable: false,
    closeOnEscape: false,
    children: <FileManagerWindow />,
    rect: new Rectangle(new Vector(8, 88), new Vector(300, window.innerHeight - 96)),
  });
  fileManagerTabIds.add(tab.id);
  // ResearchSession 静态 import 了本模块，这里用动态 import 避免循环依赖
  import("@/core/research/ResearchSession")
    .then(({ markResearchPanelTab }) => markResearchPanelTab("files", tab.id))
    .catch(showError);
  return tab;
};

/**
 * 没打开就打开；打开了但被同一组里别的标签页挡住就切到前台；看得见就关掉。
 * 按可见性判断而不是按键盘焦点：面板看得见时焦点一般在白板上，按焦点判断的话第一下只会把焦点抢走
 */
FileManagerWindow.toggle = async () => {
  const existing = findOpenTab();
  if (!existing) {
    FileManagerWindow.open();
    return;
  }
  // ResearchSession 静态 import 了本模块，这里用动态 import 避免循环依赖
  const { isTabVisibleInWorkspace } = await import("@/core/research/ResearchSession");
  if (existing.closing) return;
  if (isTabVisibleInWorkspace(existing.id)) {
    fileManagerTabIds.delete(existing.id);
    await TabWorkspace.close(existing.id);
    return;
  }
  TabWorkspace.focus(existing.id);
};

// 这个模块需要被常驻模块静态 import，监听才会生效。chooseFolder / newWorkspace 由 ResearchSession 处理
const unsubscribe = onResearchEvent("toggleFiles", () => {
  FileManagerWindow.toggle().catch(showError);
});
import.meta.hot?.dispose(unsubscribe);
