import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import ResearchFileMenu from "@/components/research-file-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { displayWorkspaceName, FileName } from "@/components/ui/file-name";
import { Input } from "@/components/ui/input";
import { Project } from "@/core/Project";
import { DocumentTab, documentError, openDocumentFile } from "@/core/research/DocumentTab";
import { dropFilesAtClientPoint } from "@/core/research/ResearchDrop";
import {
  RESEARCH_FILES_CHANGED_EVENT,
  ResearchFolder,
  type ResearchFileEntry,
  type ResearchFolderScan,
} from "@/core/research/ResearchFolder";
import { browseResearchProject } from "@/core/research/ResearchFolderBrowser";
import {
  activeResearchWorkspace,
  authorizeResearchProject,
  loadResearchWorkspace,
  projectName,
  projectPathKey,
  readResearchDirectory,
  researchWorkspaceAtom,
  researchWorkspaceError,
  requestResearchProject,
  updateResearchWorkspace,
  type ResearchTreeEntry,
} from "@/core/research/ResearchWorkspace";
import { promptResearchRename } from "@/core/research/ResearchRename";
import { restoreLastResearchFile } from "@/core/research/ResearchTrash";
import { emitResearchEvent } from "@/core/research/ResearchShell";
import { hidePeekForDrag } from "@/core/research/SidePanels";
import { Settings } from "@/core/service/Settings";
import { createSubWindow } from "@/core/subWindowOpen";
import { TabWorkspace } from "@/core/TabWorkspace";
import { activeResourceTabAtom, store, tabsAtom } from "@/state";
import { cn } from "@/utils/cn";
import { Vector } from "@graphif/data-structures";
import { Rectangle } from "@graphif/shapes";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import { exists } from "@tauri-apps/plugin-fs";
import i18next from "i18next";
import { useAtomValue } from "jotai";
import {
  ChevronDown,
  ChevronRight,
  ExternalLink,
  File,
  FileImage,
  FileText,
  Folder,
  FolderInput,
  FolderOpen,
  FolderPlus,
  LayoutDashboard,
  MoreHorizontal,
  NotebookPen,
  Pencil,
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

const FILE_ICONS: Record<ResearchFileEntry["kind"], LucideIcon> = {
  workspace: LayoutDashboard,
  pdf: FileText,
  image: FileImage,
  markdown: NotebookPen,
  other: File,
};
let cachedQuery = "";
const showError = (error: unknown) =>
  toast.error(
    i18next.t("workspace.failed", {
      ns: "research",
      message: researchWorkspaceError(error),
      interpolation: { escapeValue: false },
    }),
  );

export default function FileManagerWindow() {
  const { t } = useTranslation("research");
  const [root] = Settings.use("researchFolderPath");
  const data = useAtomValue(researchWorkspaceAtom);
  const workspace = data && activeResearchWorkspace(data);
  const [error, setError] = React.useState("");
  const [workspaceError, setWorkspaceError] = React.useState("");
  const [query, setQuery] = React.useState(cachedQuery);
  const [scan, setScan] = React.useState<ResearchFolderScan>();
  const [version, setVersion] = React.useState(0);
  const [expanded, setExpanded] = React.useState(true);
  const [selected, setSelected] = React.useState("");
  const [drag, setDrag] = React.useState<{ entry: ResearchFileEntry; x: number; y: number } | null>(null);
  const tabs = useAtomValue(tabsAtom);
  const active = useAtomValue(activeResourceTabAtom);
  const rootRef = React.useRef<HTMLDivElement>(null);
  const suppressClick = React.useRef(false);
  const lastRefresh = React.useRef(0);
  const searching = query.trim() !== "";

  const refresh = React.useCallback(() => {
    lastRefresh.current = Date.now();
    setVersion((value) => value + 1);
  }, []);
  React.useEffect(() => {
    let alive = true;
    void loadResearchWorkspace(true).then(
      () => {
        if (alive) setWorkspaceError("");
      },
      (error) => {
        if (alive) setWorkspaceError(researchWorkspaceError(error));
      },
    );
    return () => {
      alive = false;
    };
  }, [version]);
  React.useEffect(() => {
    window.addEventListener("focus", refresh);
    window.addEventListener(RESEARCH_FILES_CHANGED_EVENT, refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      window.removeEventListener(RESEARCH_FILES_CHANGED_EVENT, refresh);
    };
  }, [refresh]);
  React.useEffect(() => {
    if (!searching || !root) {
      setScan(undefined);
      setError("");
      return;
    }
    let alive = true;
    setScan(undefined);
    setError("");
    void ResearchFolder.scan(true)
      .then((result) => {
        if (alive) setScan(result);
      })
      .catch((error) => {
        if (alive) setError(String(error));
      });
    return () => {
      alive = false;
    };
  }, [root, version, searching]);

  const updateQuery = (value: string) => {
    cachedQuery = value;
    setQuery(value);
  };
  const openPaths = new Set(
    tabs
      .filter((tab) => !tab.closing && (tab instanceof Project || tab instanceof DocumentTab))
      .map((tab) => projectPathKey((tab as Project | DocumentTab).uri.fsPath)),
  );
  const activePath =
    active instanceof Project || active instanceof DocumentTab ? projectPathKey(active.uri.fsPath) : "";
  const openEntry = async (entry: ResearchFileEntry, projectRoot: string) => {
    if (entry.kind === "workspace") await requestResearchProject(projectRoot, entry.absPath);
    else {
      await authorizeResearchProject(projectRoot);
      await openDocumentFile(entry.absPath);
    }
  };
  const beforeModify = (projectRoot: string) => requestResearchProject(projectRoot);

  const addProject = async (create: boolean) => {
    const path = await browseResearchProject(create);
    if (path && !ResearchFolder.getRoot()) await requestResearchProject(path);
  };
  const renameWorkspace = async () => {
    const name = await Dialog.input(t("projectTree.rename"), t("projectTree.nameHint"), {
      defaultValue: workspace?.name || t("projectTree.defaultName"),
    });
    if (name === undefined) return;
    if (!name.trim()) {
      toast.error(t("projectTree.emptyName"));
      return;
    }
    await updateResearchWorkspace((data) => {
      activeResearchWorkspace(data).name = name.trim();
    });
  };
  const removeProject = async (path: string) => {
    if (
      !(await Dialog.confirm(
        t("projectTree.remove"),
        t("projectTree.removeHint", { path, interpolation: { escapeValue: false } }),
      ))
    )
      return;
    await requestResearchProject("", undefined, path);
  };

  // Pointer events also work with the Windows native drop target, which consumes HTML5 drag events.
  const onRowPointerDown = (
    event: React.PointerEvent<HTMLDivElement>,
    entry: ResearchFileEntry,
    projectRoot: string,
  ) => {
    if (event.button !== 0) return;
    const row = event.currentTarget;
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startY = event.clientY;
    let dragging = false;
    const onMove = (move: PointerEvent) => {
      if (move.pointerId !== pointerId) return;
      if (!dragging) {
        if (Math.hypot(move.clientX - startX, move.clientY - startY) < 5) return;
        dragging = true;
        row.setPointerCapture(pointerId);
        hidePeekForDrag("left");
      }
      setDrag({ entry, x: move.clientX, y: move.clientY });
    };
    const finish = (drop: PointerEvent | null) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onKeyDown, true);
      setDrag(null);
      if (!dragging) return;
      suppressClick.current = true;
      setTimeout(() => {
        suppressClick.current = false;
      }, 0);
      if (!drop) return;
      const panel =
        rootRef.current?.closest<HTMLElement>("[data-pg-side-panel], [data-pg-tab-group-id]") ?? rootRef.current;
      const rect = panel?.getBoundingClientRect();
      if (
        rect &&
        drop.clientX >= rect.left &&
        drop.clientX <= rect.right &&
        drop.clientY >= rect.top &&
        drop.clientY <= rect.bottom
      )
        return;
      void (
        entry.kind === "workspace"
          ? openEntry(entry, projectRoot)
          : dropFilesAtClientPoint([entry.absPath], drop.clientX, drop.clientY)
      ).catch(showError);
    };
    const onUp = (up: PointerEvent) => {
      if (up.pointerId === pointerId) finish(up);
    };
    const onCancel = (cancel: PointerEvent) => {
      if (cancel.pointerId === pointerId) finish(null);
    };
    const onKeyDown = (key: KeyboardEvent) => {
      if (key.key === "Escape" && dragging) {
        key.preventDefault();
        key.stopPropagation();
        finish(null);
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onKeyDown, true);
  };

  const renderFile = (entry: ResearchFileEntry, projectRoot: string, depth: number) => {
    const Icon = FILE_ICONS[entry.kind];
    const highlighted = projectPathKey(entry.absPath) === activePath || entry.absPath === selected;
    const open = () => {
      if (!suppressClick.current) void openEntry(entry, projectRoot).catch(showError);
    };
    return (
      <ResearchFileMenu key={entry.absPath} entry={entry} onOpen={open} beforeModify={() => beforeModify(projectRoot)}>
        <div
          role="button"
          tabIndex={0}
          title={`${entry.absPath}\n${t(entry.kind === "workspace" ? "files.workspaceRowHint" : "files.fileRowHint")}`}
          className={cn(
            "flex h-7 min-w-0 cursor-default items-center gap-2 rounded-md pr-2 text-[13px] select-none",
            highlighted ? "bg-primary/10 text-primary" : "hover:bg-accent",
          )}
          style={{ paddingLeft: 8 + depth * 14 }}
          onClick={() => {
            if (!suppressClick.current) setSelected(entry.absPath);
          }}
          onDoubleClick={open}
          onPointerDown={(event) => onRowPointerDown(event, entry, projectRoot)}
          onKeyDown={(event) => {
            if (event.key === "Enter") open();
            if (event.key === "F2") {
              event.preventDefault();
              event.stopPropagation();
              void beforeModify(projectRoot)
                .then((ready) => {
                  if (ready) return promptResearchRename(entry.absPath);
                })
                .catch(showError);
            }
          }}
        >
          <Icon className="text-muted-foreground size-3.5 shrink-0" />
          <FileName name={entry.kind === "workspace" ? displayWorkspaceName(entry.name) : entry.name} tailChars={4} />
          {searching && (
            <span className="text-muted-foreground min-w-0 shrink-[9999] truncate text-[11px]">{entry.relPath}</span>
          )}
          {openPaths.has(projectPathKey(entry.absPath)) && (
            <span className="bg-primary ml-auto size-1.5 shrink-0 rounded-full" title={t("files.opened")} />
          )}
        </div>
      </ResearchFileMenu>
    );
  };
  const matches =
    scan?.entries.filter((entry) =>
      entry.relPath.normalize("NFC").toLowerCase().includes(query.trim().normalize("NFC").toLowerCase()),
    ) ?? [];

  return (
    <div
      ref={rootRef}
      className="flex h-full min-h-0 min-w-0 flex-col"
      onPointerEnter={() => {
        if (Date.now() - lastRefresh.current > 3000) refresh();
      }}
    >
      <div className="flex h-9 shrink-0 items-center gap-1 border-b px-2">
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          aria-label={t("projectTree.toggle")}
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          <ChevronRight className={cn(expanded && "rotate-90")} />
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              className="min-w-0 flex-1 justify-start px-1"
              title={t("projectTree.workspaceHint")}
            >
              <span className="truncate">{workspace?.name || t("projectTree.defaultName")}</span>
              <ChevronDown />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuGroup>
              <DropdownMenuItem onSelect={() => void addProject(false).catch(showError)}>
                <FolderInput />
                {t("projectTree.add")}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void addProject(true).catch(showError)}>
                <FolderPlus />
                {t("projectTree.create")}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void renameWorkspace().catch(showError)}>
                <Pencil />
                {t("projectTree.rename")}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={refresh}>
                <RefreshCw />
                {t("files.refresh")}
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={!root}
                onSelect={() =>
                  void restoreLastResearchFile()
                    .then(() => toast.success(t("fileMenu.restored")))
                    .catch((error) => toast.error(documentError(error)))
                }
              >
                {t("fileMenu.restoreLast")}
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          disabled={!root}
          title={t("files.newWorkspace")}
          aria-label={t("files.newWorkspace")}
          onClick={() => emitResearchEvent("newWorkspace")}
        >
          <Plus />
        </Button>
      </div>
      <div className="flex shrink-0 items-center gap-1 px-2 py-1.5">
        <Search className="text-muted-foreground size-3.5 shrink-0" />
        <Input
          value={query}
          disabled={!root}
          aria-label={t("files.searchPlaceholder")}
          placeholder={t("files.searchPlaceholder")}
          className="h-7 min-w-0"
          onChange={(event) => updateQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              updateQuery("");
            }
          }}
        />
        {query && (
          <Button
            size="icon"
            variant="ghost"
            className="size-7"
            aria-label={t("files.clearSearch")}
            onClick={() => updateQuery("")}
          >
            <X />
          </Button>
        )}
      </div>
      {(error || workspaceError) && (
        <div role="alert" className="text-destructive px-3 py-2 text-xs break-all">
          {t("files.loadFailed", { error: workspaceError || error })}
          <Button
            variant="ghost"
            onClick={() => {
              setError("");
              setWorkspaceError("");
              refresh();
            }}
          >
            {t("files.retry")}
          </Button>
        </div>
      )}
      <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-auto p-1">
        {searching ? (
          <>
            <p className="text-muted-foreground px-2 text-xs">
              {t("projectTree.searchIn", { name: projectName(root) })}
            </p>
            {!scan && !error && root && <p className="text-muted-foreground px-2 text-xs">{t("files.loading")}</p>}
            {scan && matches.length === 0 && <p className="text-muted-foreground px-2 text-xs">{t("files.noMatch")}</p>}
            {matches.map((entry) => renderFile(entry, root, 1))}
            {scan?.truncated && (
              <p className="text-muted-foreground px-2 text-xs">
                {t("files.truncated", { count: scan.entries.length })}
              </p>
            )}
            {!!scan?.unreadableDirs.length && (
              <p className="text-muted-foreground px-2 text-xs" title={scan.unreadableDirs.join("\n")}>
                {t("files.unreadableDirs", { count: scan.unreadableDirs.length })}
              </p>
            )}
          </>
        ) : (
          expanded &&
          workspace?.projects.map((project) => (
            <DirectoryRow
              key={project.path}
              path={project.path}
              projectRoot={project.path}
              depth={0}
              version={version}
              current={projectPathKey(root) === projectPathKey(project.path)}
              renderFile={renderFile}
              onSelect={() => void requestResearchProject(project.path).catch(showError)}
              onRemove={() => void removeProject(project.path).catch(showError)}
            />
          ))
        )}
        {workspace?.projects.length === 0 && (
          <div className="flex flex-col gap-3 p-4">
            <p className="text-muted-foreground text-sm">{t("projectTree.empty")}</p>
            <Button variant="outline" onClick={() => void addProject(false).catch(showError)}>
              <FolderInput />
              {t("projectTree.add")}
            </Button>
            <Button variant="outline" onClick={() => void addProject(true).catch(showError)}>
              <FolderPlus />
              {t("projectTree.create")}
            </Button>
          </div>
        )}
      </div>
      {drag &&
        createPortal(
          <div
            className="bg-popover text-popover-foreground pointer-events-none fixed z-[9999] flex max-w-60 items-center gap-2 rounded-md border px-2 py-1 text-xs shadow-md"
            style={{ left: drag.x + 12, top: drag.y + 8 }}
          >
            {React.createElement(FILE_ICONS[drag.entry.kind], { className: "size-3.5" })}
            <FileName name={drag.entry.name} />
          </div>,
          document.body,
        )}
    </div>
  );
}

function DirectoryRow({
  path,
  projectRoot,
  depth,
  version,
  current,
  renderFile,
  onSelect,
  onRemove,
}: {
  path: string;
  projectRoot: string;
  depth: number;
  version: number;
  current?: boolean;
  renderFile: (entry: ResearchFileEntry, root: string, depth: number) => React.ReactNode;
  onSelect?: () => void;
  onRemove?: () => void;
}) {
  const { t } = useTranslation("research");
  const [expanded, setExpanded] = React.useState(false);
  const [entries, setEntries] = React.useState<ResearchTreeEntry[]>();
  const [error, setError] = React.useState("");
  const [visibleCount, setVisibleCount] = React.useState(200);
  React.useEffect(() => {
    if (!expanded && depth !== 0) return;
    let alive = true;
    setError("");
    setEntries(undefined);
    setVisibleCount(200);
    if (!expanded) {
      void exists(path)
        .then((available) => {
          if (alive && !available) setError("missing");
        })
        .catch((error) => {
          if (alive) setError(String(error));
        });
      return () => {
        alive = false;
      };
    }
    void authorizeResearchProject(projectRoot)
      .then(() => readResearchDirectory(projectRoot, path))
      .then((entries) => {
        if (alive) setEntries(entries);
      })
      .catch((error) => {
        if (alive) {
          setEntries(undefined);
          setError(String(error));
        }
      });
    return () => {
      alive = false;
    };
  }, [expanded, path, projectRoot, version, depth]);
  return (
    <div>
      <div
        className={cn(
          "flex h-8 items-center gap-1 rounded-md pr-1 text-[13px]",
          current ? "bg-primary/5" : "hover:bg-accent",
        )}
        style={{ paddingLeft: depth * 14 + 4 }}
      >
        <Button
          size="icon"
          variant="ghost"
          className="size-6 shrink-0"
          aria-label={t("projectTree.expand", { name: projectName(path) })}
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          <ChevronRight className={cn(expanded && "rotate-90")} />
        </Button>
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          title={path}
          onClick={() => {
            if (onSelect) {
              onSelect();
              setExpanded(true);
            } else setExpanded(!expanded);
          }}
        >
          {onSelect ? (
            <FolderOpen className="text-muted-foreground size-4 shrink-0" />
          ) : (
            <Folder className="text-muted-foreground size-3.5 shrink-0" />
          )}
          <span className="truncate">{projectName(path)}</span>
        </button>
        {current && <Badge variant="secondary">{t("projectTree.current")}</Badge>}
        {onRemove && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="icon"
                variant="ghost"
                className="size-6 shrink-0"
                aria-label={t("projectTree.actions", { name: projectName(path) })}
              >
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuGroup>
                <DropdownMenuItem onSelect={() => void shellOpen(path).catch(showError)}>
                  <ExternalLink />
                  {t("files.revealInFinder")}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={onRemove}>{t("projectTree.remove")}</DropdownMenuItem>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      {error && (
        <p role="status" className="text-muted-foreground px-4 py-1 text-xs" title={error}>
          {t(onSelect ? "projectTree.missing" : "projectTree.unreadable")}
        </p>
      )}
      {expanded && !error && (
        <div>
          {!entries ? (
            <p className="text-muted-foreground px-4 py-1 text-xs">{t("files.loading")}</p>
          ) : entries.length === 0 ? (
            <p className="text-muted-foreground px-4 py-1 text-xs">{t("projectTree.noFiles")}</p>
          ) : (
            entries
              .slice(0, visibleCount)
              .map((entry) =>
                entry.directory ? (
                  <DirectoryRow
                    key={entry.absPath}
                    path={entry.absPath}
                    projectRoot={projectRoot}
                    depth={depth + 1}
                    version={version}
                    renderFile={renderFile}
                  />
                ) : (
                  renderFile(entry, projectRoot, depth + 2)
                ),
              )
          )}
          {entries && entries.length > visibleCount && (
            <Button variant="ghost" onClick={() => setVisibleCount((count) => count + 200)}>
              {t("projectTree.showMore", { count: entries.length - visibleCount })}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

const fileManagerTabIds = new Set<string>();
const findOpenTab = () => store.get(tabsAtom).find((tab) => !tab.closing && fileManagerTabIds.has(tab.id));
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
  import("@/core/research/ResearchSession")
    .then(({ markResearchPanelTab }) => markResearchPanelTab("files", tab.id))
    .catch(showError);
  return tab;
};
FileManagerWindow.toggle = async () => {
  const existing = findOpenTab();
  if (!existing) {
    FileManagerWindow.open();
    return;
  }
  const { isTabVisibleInWorkspace } = await import("@/core/research/ResearchSession");
  if (existing.closing) return;
  if (isTabVisibleInWorkspace(existing.id)) {
    fileManagerTabIds.delete(existing.id);
    await TabWorkspace.close(existing.id);
  } else TabWorkspace.focus(existing.id);
};
