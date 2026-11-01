import { Button } from "@/components/ui/button";
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
import { emitResearchEvent, isResearchShell, onResearchEvent } from "@/core/research/ResearchShell";
import { closeEmptyDrafts, onOpenFile } from "@/core/service/GlobalMenu";
import { Settings } from "@/core/service/Settings";
import { createSubWindow } from "@/core/subWindowOpen";
import { TabWorkspace } from "@/core/TabWorkspace";
import { store, tabsAtom } from "@/state";
import { cn } from "@/utils/cn";
import { Vector } from "@graphif/data-structures";
import { Rectangle } from "@graphif/shapes";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import i18next from "i18next";
import { useAtomValue } from "jotai";
import {
  ChevronDown,
  ChevronRight,
  FileImage,
  FilePlus2,
  FileText,
  FolderInput,
  FolderOpen,
  LayoutDashboard,
  NotebookPen,
  RefreshCw,
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

// 面板切到同组别的标签页时组件会卸载，这些放在模块里，切回来时不用从头再读、搜索词也还在
let cachedScan: { root: string; scan: ResearchFolderScan } | null = null;
let cachedQuery = "";
const collapsedSections = new Set<SectionKind>();

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
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState("");
  const [query, setQuery] = React.useState(cachedQuery);
  const [collapsed, setCollapsed] = React.useState(() => new Set(collapsedSections));
  const [selectedPath, setSelectedPath] = React.useState("");
  const [drag, setDrag] = React.useState<{ entry: ResearchFileEntry; x: number; y: number } | null>(null);
  const tabs = useAtomValue(tabsAtom);
  const rootRef = React.useRef<HTMLDivElement>(null);
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
    setLoading(true);
    try {
      const result = await ResearchFolder.scan();
      if (generation !== generationRef.current) return;
      cachedScan = { root: ResearchFolder.getRoot(), scan: result };
      setScan(result);
      setError("");
    } catch (scanError) {
      if (generation !== generationRef.current) return;
      setError(scanError instanceof Error ? scanError.message : String(scanError));
    } finally {
      if (generation === generationRef.current) setLoading(false);
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

  const toggleSection = (kind: SectionKind) => {
    if (collapsedSections.has(kind)) collapsedSections.delete(kind);
    else collapsedSections.add(kind);
    setCollapsed(new Set(collapsedSections));
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
      <div className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center">
        <FolderOpen className="text-muted-foreground size-10" />
        <p className="text-muted-foreground text-sm">{t("files.emptyHint")}</p>
        <Button size="lg" onClick={chooseFolder}>
          <FolderInput />
          {t("files.chooseResearchFolder")}
        </Button>
      </div>
    );
  }

  const totalShown = SECTIONS.reduce((sum, section) => sum + grouped[section.kind].length, 0);

  return (
    <div ref={rootRef} className="flex h-full min-h-0 flex-col" onPointerEnter={onPanelPointerEnter}>
      <div className="flex items-center gap-1 border-b px-2 py-1.5">
        <FolderOpen className="text-muted-foreground size-4 shrink-0" />
        <div className="min-w-0 flex-1 truncate text-sm font-medium" title={root}>
          {folderNameOf(root)}
        </div>
        <Tooltip>
          <TooltipTrigger>
            <Button size="icon" variant="ghost" className="size-7" onClick={chooseFolder}>
              <FolderInput />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t("files.chooseFolder")}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger>
            <Button size="icon" variant="ghost" className="size-7" onClick={() => void refresh()}>
              <RefreshCw className={cn(loading && "animate-spin")} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t("files.refresh")}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger>
            <Button size="icon" variant="ghost" className="size-7" onClick={() => emitResearchEvent("newWorkspace")}>
              <FilePlus2 />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t("files.newWorkspace")}</TooltipContent>
        </Tooltip>
      </div>

      <div className="px-2 py-1.5">
        <Input
          className="h-8"
          value={query}
          placeholder={t("files.searchPlaceholder")}
          onChange={(event) => updateQuery(event.target.value)}
        />
      </div>

      {error ? (
        <div className="flex flex-col items-center gap-3 p-4 text-center text-sm">
          <p className="text-destructive break-all">{t("files.loadFailed", { error })}</p>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => void refresh()}>
              {t("files.retry")}
            </Button>
            <Button size="sm" onClick={chooseFolder}>
              {t("files.chooseFolder")}
            </Button>
          </div>
        </div>
      ) : !scan ? (
        <p className="text-muted-foreground p-4 text-sm">{t("files.loading")}</p>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
          {query.trim() && totalShown === 0 && (
            <p className="text-muted-foreground px-2 py-1 text-sm">{t("files.noMatch")}</p>
          )}
          {SECTIONS.map(({ kind }) => {
            const entries = grouped[kind];
            const isCollapsed = collapsed.has(kind);
            return (
              <section key={kind} className="mt-1">
                <button
                  type="button"
                  className="text-muted-foreground hover:text-foreground flex w-full items-center gap-1 px-1 py-1 text-xs font-medium"
                  onClick={() => toggleSection(kind)}
                >
                  {isCollapsed ? <ChevronRight className="size-3.5" /> : <ChevronDown className="size-3.5" />}
                  <span>{t(`files.sections.${kind}`)}</span>
                  <span className="tabular-nums">({entries.length})</span>
                </button>
                {!isCollapsed &&
                  (entries.length === 0
                    ? !query.trim() && (
                        <p className="text-muted-foreground/70 px-6 pb-1 text-xs">{t(`files.sectionEmpty.${kind}`)}</p>
                      )
                    : entries.map((entry) => (
                        <FileRow
                          key={entry.absPath}
                          entry={entry}
                          selected={selectedPath === entry.absPath}
                          opened={entry.kind === "workspace" && openPaths.has(pathKey(entry.absPath))}
                          onPointerDown={(event) => onRowPointerDown(event, entry)}
                          onClick={(event) => onRowClick(event, entry)}
                          onDoubleClick={() => onRowDoubleClick(entry)}
                        />
                      )))}
              </section>
            );
          })}
          {scan.truncated && (
            <p className="text-muted-foreground px-2 pt-2 text-xs">
              {t("files.truncated", { count: scan.entries.length })}
            </p>
          )}
          {scan.unreadableDirs.length > 0 && (
            <p className="text-muted-foreground px-2 pt-2 text-xs" title={scan.unreadableDirs.join("\n")}>
              {t("files.unreadableDirs", { count: scan.unreadableDirs.length })}
            </p>
          )}
        </div>
      )}

      {drag &&
        createPortal(
          <div
            className="bg-popover text-popover-foreground pointer-events-none fixed z-[9999] flex max-w-60 items-center gap-1.5 rounded-md border px-2 py-1 text-xs shadow-md"
            style={{ left: drag.x + 12, top: drag.y + 8 }}
          >
            {React.createElement(SECTION_ICONS[drag.entry.kind], { className: "size-3.5 shrink-0" })}
            <span className="truncate">{drag.entry.name}</span>
          </div>,
          document.body,
        )}
    </div>
  );
}

function FileRow({
  entry,
  selected,
  opened,
  onPointerDown,
  onClick,
  onDoubleClick,
}: {
  entry: ResearchFileEntry;
  selected: boolean;
  opened: boolean;
  onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void;
  onClick: (event: React.MouseEvent<HTMLDivElement>) => void;
  onDoubleClick: () => void;
}) {
  const { t } = useTranslation("research");
  const Icon = SECTION_ICONS[entry.kind];
  const displayName = entry.kind === "workspace" ? entry.name.replace(/\.prg$/i, "") : entry.name;
  const dir = entry.relPath.includes("/") ? entry.relPath.slice(0, entry.relPath.lastIndexOf("/")) : "";
  return (
    <div
      role="button"
      tabIndex={-1}
      title={`${entry.relPath}\n${t(entry.kind === "workspace" ? "files.workspaceRowHint" : "files.fileRowHint")}`}
      className={cn(
        "hover:bg-accent flex cursor-default items-center gap-2 rounded px-2 py-1 text-sm select-none",
        selected && "bg-accent",
      )}
      onPointerDown={onPointerDown}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
    >
      <Icon className="text-muted-foreground size-4 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="truncate">{displayName}</div>
        {dir && <div className="text-muted-foreground truncate text-xs">{dir}</div>}
      </div>
      {opened && <span className="text-primary shrink-0 text-xs">{t("files.opened")}</span>}
    </div>
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
if (isResearchShell()) {
  const unsubscribe = onResearchEvent("toggleFiles", () => {
    FileManagerWindow.toggle().catch(showError);
  });
  import.meta.hot?.dispose(unsubscribe);
}
