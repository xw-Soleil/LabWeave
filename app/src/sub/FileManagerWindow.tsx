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
import { displayWorkspaceName, FileName, splitFileName } from "@/components/ui/file-name";
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
import {
  activeResearchWorkspace,
  addResearchProject,
  authorizeResearchProject,
  createResearchProject,
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
import { renameResearchFile } from "@/core/research/ResearchRename";
import { restoreLastResearchFile } from "@/core/research/ResearchTrash";
import { hidePeekForDrag } from "@/core/research/SidePanels";
import { Settings } from "@/core/service/Settings";
import { createSubWindow } from "@/core/subWindowOpen";
import { TabWorkspace } from "@/core/TabWorkspace";
import { activeResourceTabAtom, store, tabsAtom } from "@/state";
import { cn } from "@/utils/cn";
import { isMac } from "@/utils/platform";
import { Vector } from "@graphif/data-structures";
import { Rectangle } from "@graphif/shapes";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { exists } from "@tauri-apps/plugin-fs";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import i18next from "i18next";
import { useAtomValue } from "jotai";
import {
  Archive,
  BookOpen,
  BookOpenText,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  Database,
  Copy,
  ExternalLink,
  File,
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileJson,
  FileSpreadsheet,
  FileText,
  FileVideo,
  FlaskConical,
  Folder,
  FolderCode,
  FolderInput,
  FolderOpen,
  FolderPlus,
  Images,
  LayoutDashboard,
  Library,
  LocateFixed,
  MoreHorizontal,
  NotebookPen,
  Paperclip,
  Pencil,
  Plus,
  Presentation,
  RefreshCw,
  Search,
  Trash2,
  X,
  type LucideIcon,
} from "lucide-react";
import React from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

// 照 Obsidian 的文件栏：按文件夹名、扩展名自动配图标，用户不用手动选
const FOLDER_ICONS: [RegExp, LucideIcon][] = [
  [/^(assets?|attachments?|附件|资源)$/i, Paperclip],
  [/^(images?|imgs?|figures?|figs?|pics?|pictures?|screenshots?|图片|截图|插图)$/i, Images],
  [/^(data|datasets?|数据|数据集)$/i, Database],
  [/^(src|code|scripts?|源码|代码|脚本)$/i, FolderCode],
  [/^(papers?|refs?|references?|literature|library|文献|文献库|论文|参考文献)$/i, Library],
  [/^(notes?|笔记|随笔)$/i, NotebookPen],
  [/^(docs?|documents?|文档|资料)$/i, BookOpen],
  [/^(tests?|experiments?|实验)$/i, FlaskConical],
  [/^(archives?|归档|存档)$/i, Archive],
  [/^(\.?trash|回收站)$/i, Trash2],
];
const EXTENSION_ICONS: [RegExp, LucideIcon][] = [
  [/\.(md|markdown|txt)$/i, FileText],
  [/\.pdf$/i, BookOpenText],
  [/\.(png|jpe?g|gif|webp|svg|bmp|tiff?|heic|avif)$/i, FileImage],
  [/\.(csv|tsv|xlsx?|numbers)$/i, FileSpreadsheet],
  [/\.(json|ya?ml|toml|xml)$/i, FileJson],
  [/\.(py|ipynb|m|ts|tsx|js|jsx|rs|c|cc|cpp|h|hpp|v|sv|vh|vhdl?|java|go|sh|tex|bib)$/i, FileCode],
  [/\.(zip|tar|gz|tgz|7z|rar)$/i, FileArchive],
  [/\.(mp3|wav|flac|m4a)$/i, FileAudio],
  [/\.(mp4|mov|mkv|webm)$/i, FileVideo],
  [/\.(pptx?|key)$/i, Presentation],
];
function folderIcon(name: string, expanded: boolean): LucideIcon {
  return FOLDER_ICONS.find(([pattern]) => pattern.test(name))?.[1] ?? (expanded ? FolderOpen : Folder);
}
function fileIcon(entry: Pick<ResearchFileEntry, "kind" | "name">): LucideIcon {
  if (entry.kind === "workspace") return LayoutDashboard;
  return EXTENSION_ICONS.find(([pattern]) => pattern.test(entry.name))?.[1] ?? File;
}
const TREE_INDENT = 16;
const treeIndent = (depth: number) => 6 + depth * TREE_INDENT;
const TREE_ROW = "group flex h-7 min-w-0 items-center gap-1.5 rounded-md pr-1.5 text-[13px] select-none";
const TREE_IDLE = "text-foreground/80 hover:bg-foreground/[0.05]";
const TREE_ACTIVE = "bg-foreground/[0.08] text-foreground";

function TreeGuide({ depth }: { depth: number }) {
  return (
    <span
      aria-hidden
      className="bg-foreground/10 pointer-events-none absolute top-0 bottom-0 w-px"
      style={{ left: treeIndent(depth) + 8 }}
    />
  );
}
/**
 * 照 Obsidian 文件栏顶上的两个按钮：全部收起（collapse 加一，所有文件夹收起来）；
 * 定位文件（reveal 指向某个文件，它上面的文件夹都展开，滚到它那一行）。
 */
interface TreeSignals {
  collapse: number;
  reveal?: { key: string; nonce: number };
}
const TreeSignalsContext = React.createContext<TreeSignals>({ collapse: 0 });
const REVEAL_FILE_EVENT = "pg-reveal-research-file";
let pendingReveal: string | undefined;

let cachedQuery = "";
/** 文件夹右键「在文件夹中查找」：detail 是它相对研究文件夹的路径 */
const FIND_IN_FOLDER_EVENT = "pg-find-in-folder";
const showError = (error: unknown) =>
  toast.error(
    i18next.t("workspace.failed", {
      ns: "research",
      message: researchWorkspaceError(error),
      interpolation: { escapeValue: false },
    }),
  );

type CreateKind = "note" | "folder" | "workspace";
const CREATE_KINDS: [CreateKind, LucideIcon][] = [
  ["note", NotebookPen],
  ["workspace", LayoutDashboard],
  ["folder", FolderPlus],
];

/** 问名字，在研究文件夹的某个文件夹里新建笔记、白板或文件夹；笔记和白板建好就打开，文件栏里定位到新建的那一项 */
async function createInFolder(kind: CreateKind, directory: string) {
  const text = (key: string) => i18next.t(key, { ns: "research" });
  const prefix = kind === "workspace" ? "workspace.new" : `files.create.${kind}.new`;
  const input = await Dialog.input(text(`${prefix}Title`), text(`${prefix}Description`), {
    placeholder: text(`${prefix}Placeholder`),
  });
  if (!input?.trim()) return;
  const path =
    kind === "workspace"
      ? await ResearchFolder.createWorkspace(input, directory)
      : await ResearchFolder.createEntry(kind, input, directory);
  if (!path) return;
  if (kind === "note") await openDocumentFile(path);
  FileManagerWindow.reveal(path);
}

/** 用系统的选文件夹窗口把已有文件夹加进工作区；新建时在选好的位置里再问一个名字。返回加进去的项目路径 */
export async function pickResearchProject(create = false): Promise<string | null> {
  const text = (key: string, options?: Record<string, unknown>) =>
    i18next.t(key, { ns: "research", ...options, interpolation: { escapeValue: false } });
  const folder = await openDialog({
    directory: true,
    title: text(create ? "projectTree.createLocation" : "projectTree.add"),
  });
  if (!folder) return null;
  if (!create) {
    try {
      return await addResearchProject(folder);
    } catch (error) {
      toast.error(researchWorkspaceError(error));
      return null;
    }
  }
  let name: string | undefined = "";
  for (;;) {
    name = await Dialog.input(text("projectTree.create"), text("projectTree.createHint", { parent: folder }), {
      defaultValue: name,
      placeholder: text("projectTree.projectName"),
    });
    if (name === undefined) return null;
    try {
      return await createResearchProject(folder, name);
    } catch (error) {
      const invalid = error instanceof Error && error.message === "invalidProjectName";
      toast.error(invalid ? text("projectTree.invalidProjectName") : researchWorkspaceError(error));
      if (!invalid) return null;
    }
  }
}

/**
 * 文件栏里原位改名的输入框。照访达：一出来先选中扩展名前面那一段，直接打字就换掉名字；
 * 回车或焦点离开交出新名字，Esc 交出 undefined（不改）。
 */
function RenameInput({ name, label, onDone }: { name: string; label: string; onDone: (name?: string) => void }) {
  const ref = React.useRef<HTMLInputElement>(null);
  const done = React.useRef(false);
  React.useEffect(() => {
    ref.current?.focus({ preventScroll: true });
    ref.current?.setSelectionRange(0, splitFileName(name).stem.length);
  }, [name]);
  const finish = (value?: string) => {
    // 回车以后输入框被拿掉，还会再来一次失焦
    if (done.current) return;
    done.current = true;
    onDone(value);
  };
  return (
    <input
      ref={ref}
      defaultValue={name}
      aria-label={label}
      spellCheck={false}
      autoCapitalize="off"
      autoCorrect="off"
      className="bg-background text-foreground ring-primary/70 -my-px h-[22px] min-w-0 flex-1 cursor-text rounded-[4px] px-1 text-[13px] ring-1 outline-none select-text"
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        // 拼音选字时的回车是确认候选字，不是确认改名
        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
        if (event.key !== "Enter" && event.key !== "Escape") return;
        // 这两个键到此为止：别再去打开文件、收起侧栏
        event.preventDefault();
        event.stopPropagation();
        finish(event.key === "Enter" ? event.currentTarget.value : undefined);
      }}
      onBlur={(event) => finish(event.currentTarget.value)}
    />
  );
}

/** 「新建笔记 / 新建白板 / 新建文件夹」三项，顶上的「+」菜单和文件夹的右键菜单共用 */
function CreateItems({
  Item,
  directory,
}: {
  Item: typeof DropdownMenuItem | typeof ContextMenuItem;
  directory: string;
}) {
  const { t } = useTranslation("research");
  // 只能建在当前项目里：别的项目没有写入权限
  const allowed = ResearchFolder.isInside(directory);
  return CREATE_KINDS.map(([kind, Icon]) => (
    <Item key={kind} disabled={!allowed} onSelect={() => void createInFolder(kind, directory).catch(showError)}>
      <Icon />
      {t(kind === "workspace" ? "files.newWorkspace" : `files.create.${kind}.newTitle`)}
    </Item>
  ));
}

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
  const [renaming, setRenaming] = React.useState("");
  const [signals, setSignals] = React.useState<TreeSignals>({ collapse: 0 });
  const [drag, setDrag] = React.useState<{ entry: ResearchFileEntry; x: number; y: number } | null>(null);
  const tabs = useAtomValue(tabsAtom);
  const active = useAtomValue(activeResourceTabAtom);
  const rootRef = React.useRef<HTMLDivElement>(null);
  const suppressClick = React.useRef(false);
  const lastRefresh = React.useRef(0);
  const searching = query.trim() !== "";
  // 顶上「+」建在哪：选中的是文件就建在它所在的文件夹，是文件夹就建在里面；没选或选的不在当前项目里，建在项目最外层
  const createTarget = () => {
    if (!selected || !ResearchFolder.isInside(selected)) return root;
    return /\.[^./\\]+$/.test(selected) ? selected.replace(/[\\/][^\\/]+$/, "") : selected;
  };

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
  React.useEffect(() => {
    const find = (event: Event) => {
      cachedQuery = `${(event as CustomEvent<string>).detail}/`;
      setQuery(cachedQuery);
    };
    window.addEventListener(FIND_IN_FOLDER_EVENT, find);
    return () => window.removeEventListener(FIND_IN_FOLDER_EVENT, find);
  }, []);
  const reveal = React.useCallback(
    (path: string) => {
      const key = projectPathKey(path);
      cachedQuery = "";
      setQuery("");
      setExpanded(true);
      setSelected(path);
      setSignals((current) => ({ ...current, reveal: { key, nonce: Date.now() } }));
      // 文件夹是一层层读出来的，等那一行出现了再滚过去
      let frames = 0;
      const find = () => {
        const row = rootRef.current?.querySelector<HTMLElement>(`[data-file-key="${CSS.escape(key)}"]`);
        if (row) row.scrollIntoView({ block: "center" });
        else if (++frames < 180) requestAnimationFrame(find);
        else toast.message(t("files.notInTree"));
      };
      requestAnimationFrame(find);
    },
    [t],
  );
  React.useEffect(() => {
    const onReveal = (event: Event) => {
      pendingReveal = undefined;
      reveal((event as CustomEvent<string>).detail);
    };
    window.addEventListener(REVEAL_FILE_EVENT, onReveal);
    if (pendingReveal) {
      reveal(pendingReveal);
      pendingReveal = undefined;
    }
    return () => window.removeEventListener(REVEAL_FILE_EVENT, onReveal);
  }, [reveal]);
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
    const path = await pickResearchProject(create);
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

  const focusRow = (path: string) =>
    requestAnimationFrame(() =>
      rootRef.current
        ?.querySelector<HTMLElement>(`[data-file-key="${CSS.escape(projectPathKey(path))}"]`)
        ?.focus({ preventScroll: true }),
    );
  // 原位改名，照系统文件管理器：名字变成输入框，回车或点别处就改，Esc 取消
  const startRename = (entry: ResearchFileEntry, projectRoot: string) =>
    void beforeModify(projectRoot)
      .then((ready) => {
        if (!ready) return;
        setSelected(entry.absPath);
        setRenaming(entry.absPath);
      })
      .catch(showError);
  const finishRename = (entry: ResearchFileEntry, shown: string, name?: string) => {
    setRenaming("");
    if (name === undefined || !name.trim() || name.trim() === shown) {
      focusRow(entry.absPath);
      return;
    }
    void renameResearchFile(entry.absPath, name).then(
      (path) => {
        setSelected(path);
        focusRow(path);
      },
      (error) => toast.error(documentError(error)),
    );
  };

  const renderFile = (entry: ResearchFileEntry, projectRoot: string, depth: number) => {
    const Icon = fileIcon(entry);
    const highlighted = projectPathKey(entry.absPath) === activePath || entry.absPath === selected;
    const open = () => {
      if (!suppressClick.current) void openEntry(entry, projectRoot).catch(showError);
    };
    const shown = entry.kind === "workspace" ? displayWorkspaceName(entry.name) : entry.name;
    const editing = renaming === entry.absPath;
    return (
      <ResearchFileMenu
        key={entry.absPath}
        entry={entry}
        onOpen={open}
        onRename={() => startRename(entry, projectRoot)}
        beforeModify={() => beforeModify(projectRoot)}
      >
        <div
          role="button"
          tabIndex={0}
          data-file-key={projectPathKey(entry.absPath)}
          title={`${entry.absPath}\n${t(entry.kind === "workspace" ? "files.workspaceRowHint" : "files.fileRowHint")}`}
          className={cn(TREE_ROW, "cursor-default", highlighted ? TREE_ACTIVE : TREE_IDLE)}
          style={{ paddingLeft: treeIndent(depth) }}
          onClick={() => {
            if (!suppressClick.current) setSelected(entry.absPath);
          }}
          onDoubleClick={() => !editing && open()}
          // 从这里按住拖文件，划过正文时 Mac 的网页引擎会顺手选中正文里的字；不让按下鼠标开始选字，
          // 焦点照样落在这一行上（改名的快捷键要用）。正在改名时不管：要能在输入框里点、拖着选字
          onMouseDown={(event) => {
            if (event.button !== 0 || editing) return;
            event.preventDefault();
            event.currentTarget.focus({ preventScroll: true });
          }}
          onPointerDown={(event) => !editing && onRowPointerDown(event, entry, projectRoot)}
          onKeyDown={(event) => {
            // 输入框里的按键归输入框；按住不放的连发不算（不然回车确认完又进了改名）
            if (event.target !== event.currentTarget || event.repeat) return;
            // 改名：Windows、Linux 是 F2，Mac 是回车（和访达一样，F2 也留着）；Mac 上打开用 ⌘↓
            const rename = event.key === "F2" || (isMac && event.key === "Enter" && !event.metaKey);
            const openKey = isMac ? event.metaKey && event.key === "ArrowDown" : event.key === "Enter";
            if (!rename && !openKey) return;
            event.preventDefault();
            event.stopPropagation();
            if (rename) startRename(entry, projectRoot);
            else open();
          }}
        >
          {!searching && <span className="w-4 shrink-0" />}
          <Icon className="text-muted-foreground size-4 shrink-0" strokeWidth={1.75} />
          {editing ? (
            <RenameInput name={shown} label={t("rename.title")} onDone={(name) => finishRename(entry, shown, name)} />
          ) : (
            <FileName name={shown} tailChars={4} />
          )}
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
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              disabled={!root}
              title={t("files.create.menu")}
              aria-label={t("files.create.menu")}
            >
              <Plus />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <CreateItems Item={DropdownMenuItem} directory={createTarget()} />
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="flex shrink-0 items-center gap-1 px-2 py-1.5">
        <Search className="text-muted-foreground size-3.5 shrink-0" />
        <Input
          value={query}
          disabled={!root}
          aria-label={t("files.searchPlaceholder")}
          placeholder={t("files.searchPlaceholder")}
          className="bg-foreground/[0.04] dark:bg-foreground/[0.06] h-7 min-w-0 border-transparent text-[13px] shadow-none"
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
        <Button
          variant="ghost"
          size="icon"
          className="text-muted-foreground size-7"
          disabled={!activePath}
          title={t("files.revealActive")}
          aria-label={t("files.revealActive")}
          onClick={() => {
            if (active instanceof Project || active instanceof DocumentTab) reveal(active.uri.fsPath);
          }}
        >
          <LocateFixed />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="text-muted-foreground size-7"
          title={t("files.collapseAll")}
          aria-label={t("files.collapseAll")}
          onClick={() => setSignals((current) => ({ collapse: current.collapse + 1 }))}
        >
          <ChevronsDownUp />
        </Button>
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
      <div className="flex min-h-0 flex-1 flex-col gap-px overflow-auto px-1.5 py-1">
        {searching ? (
          <>
            <p className="text-muted-foreground px-2 text-xs">
              {t("projectTree.searchIn", { name: projectName(root) })}
            </p>
            {!scan && !error && root && <p className="text-muted-foreground px-2 text-xs">{t("files.loading")}</p>}
            {scan && matches.length === 0 && <p className="text-muted-foreground px-2 text-xs">{t("files.noMatch")}</p>}
            {matches.map((entry) => renderFile(entry, root, 0))}
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
          expanded && (
            <TreeSignalsContext.Provider value={signals}>
              {workspace?.projects.map((project) => (
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
              ))}
            </TreeSignalsContext.Provider>
          )
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
            {React.createElement(fileIcon(drag.entry), { className: "size-3.5" })}
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
  const signals = React.useContext(TreeSignalsContext);
  const [expanded, setExpanded] = React.useState(() => !!signals.reveal?.key.startsWith(`${projectPathKey(path)}/`));
  const [entries, setEntries] = React.useState<ResearchTreeEntry[]>();
  const [error, setError] = React.useState("");
  const [visibleCount, setVisibleCount] = React.useState(200);
  React.useEffect(() => {
    if (signals.collapse) setExpanded(false);
  }, [signals.collapse]);
  React.useEffect(() => {
    if (signals.reveal?.key.startsWith(`${projectPathKey(path)}/`)) setExpanded(true);
  }, [signals.reveal, path]);
  // 要定位的文件在「再显示 200 个」后面时，一次放出来
  React.useEffect(() => {
    const key = signals.reveal?.key;
    if (!key || !entries) return;
    const index = entries.findIndex((entry) => {
      const entryKey = projectPathKey(entry.absPath);
      return entryKey === key || key.startsWith(`${entryKey}/`);
    });
    if (index >= visibleCount) setVisibleCount(index + 1);
  }, [signals.reveal, entries, visibleCount]);
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
  const Icon = folderIcon(projectName(path), expanded);
  const note = "text-muted-foreground py-1 text-xs";
  const notePadding = { paddingLeft: treeIndent(depth + 1) + 22 };
  return (
    <div>
      {/* 右键文件夹：在里面新建笔记、白板、文件夹 */}
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            data-file-key={projectPathKey(path)}
            className={cn(TREE_ROW, current ? TREE_ACTIVE : TREE_IDLE, onSelect && "font-medium")}
            style={{ paddingLeft: treeIndent(depth) }}
          >
            <button
              type="button"
              className="text-muted-foreground/70 hover:text-foreground flex size-4 shrink-0 items-center justify-center rounded-sm"
              aria-label={t("projectTree.expand", { name: projectName(path) })}
              aria-expanded={expanded}
              onClick={() => setExpanded(!expanded)}
            >
              <ChevronRight className={cn("size-3.5 transition-transform duration-150", expanded && "rotate-90")} />
            </button>
            <button
              type="button"
              className="flex h-full min-w-0 flex-1 items-center gap-1.5 text-left"
              title={path}
              onClick={() => {
                if (onSelect) {
                  onSelect();
                  setExpanded(true);
                } else setExpanded(!expanded);
              }}
            >
              <Icon className="text-muted-foreground size-4 shrink-0" strokeWidth={1.75} />
              <span className="truncate">{projectName(path)}</span>
            </button>
            {current && (
              <Badge variant="secondary" className="h-4 shrink-0 px-1.5 text-[10px] font-normal">
                {t("projectTree.current")}
              </Badge>
            )}
            {onRemove && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="size-5 shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
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
        </ContextMenuTrigger>
        <ContextMenuContent>
          <CreateItems Item={ContextMenuItem} directory={path} />
          <ContextMenuSeparator />
          {/* 搜索框只搜当前项目：填上这个文件夹的相对路径，列出它里面的文件 */}
          <ContextMenuItem
            disabled={!ResearchFolder.isInside(path) || ResearchFolder.toRelative(path) === ""}
            onSelect={() =>
              window.dispatchEvent(new CustomEvent(FIND_IN_FOLDER_EVENT, { detail: ResearchFolder.toRelative(path) }))
            }
          >
            <Search />
            {t("fileMenu.findInFolder")}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuSub>
            <ContextMenuSubTrigger>
              <Copy />
              {t("fileMenu.copyPathMenu")}
            </ContextMenuSubTrigger>
            <ContextMenuSubContent>
              <ContextMenuItem onSelect={() => void writeText(path).catch(showError)}>
                {t("fileMenu.copyAbsolute")}
              </ContextMenuItem>
              <ContextMenuItem
                disabled={!ResearchFolder.isInside(path)}
                onSelect={() => void writeText(ResearchFolder.toRelative(path)).catch(showError)}
              >
                {t("fileMenu.copyRelative")}
              </ContextMenuItem>
            </ContextMenuSubContent>
          </ContextMenuSub>
          <ContextMenuItem onSelect={() => void shellOpen(path).catch(showError)}>
            <ExternalLink />
            {t("files.revealInFinder")}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {error && (
        <p role="status" className={note} style={notePadding} title={error}>
          {t(onSelect ? "projectTree.missing" : "projectTree.unreadable")}
        </p>
      )}
      {expanded && !error && (
        <div className="relative flex flex-col gap-px pt-px">
          <TreeGuide depth={depth} />
          {!entries ? (
            <p className={note} style={notePadding}>
              {t("files.loading")}
            </p>
          ) : entries.length === 0 ? (
            <p className={note} style={notePadding}>
              {t("projectTree.noFiles")}
            </p>
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
                  renderFile(entry, projectRoot, depth + 1)
                ),
              )
          )}
          {entries && entries.length > visibleCount && (
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground h-7 justify-start text-xs"
              style={notePadding}
              onClick={() => setVisibleCount((count) => count + 200)}
            >
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
/** 在文件栏里找到这个文件：打开文件栏，展开它上面的文件夹，滚到它那一行（照 Obsidian 的「在文件列表中显示」） */
FileManagerWindow.reveal = (path: string) => {
  FileManagerWindow.open();
  pendingReveal = path;
  window.dispatchEvent(new CustomEvent(REVEAL_FILE_EVENT, { detail: path }));
};
