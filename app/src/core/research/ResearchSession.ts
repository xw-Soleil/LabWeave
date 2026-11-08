import { Dialog } from "@/components/ui/dialog";
import { Project } from "@/core/Project";
import { RESEARCH_FILES_CHANGED_EVENT, ResearchFolder } from "@/core/research/ResearchFolder";
import { onResearchEvent } from "@/core/research/ResearchShell";
import {
  decidePanelToggle,
  enterSidePeekTrigger,
  getSidePanelStates,
  registerSidePanels,
  setSidePanelPinned,
  sideEdgeOfGroup,
  withoutAutoPin,
} from "@/core/research/SidePanels";
import { closeEmptyDrafts, onOpenFile } from "@/core/service/GlobalMenu";
import { Settings } from "@/core/service/Settings";
import { ComponentTab, Tab } from "@/core/Tab";
import {
  findTabGroup,
  findTabGroupByTabId,
  FIXED_SIDE_GROUP_IDS,
  getTabGroups,
  isFixedSideGroupId,
  type FixedSideEdge,
} from "@/core/TabGroup";
import { TabWorkspace } from "@/core/TabWorkspace";
import { activeResourceTabAtom, store, tabGroupRootAtom, tabsAtom } from "@/state";
// 静态 import 让文件面板模块常驻，它在模块加载时注册 toggleFiles 监听
import FileManagerWindow from "@/sub/FileManagerWindow";
import { exists } from "@tauri-apps/plugin-fs";
import i18next from "i18next";
import { atom } from "jotai";
import { FolderOpen } from "lucide-react";
import { toast } from "sonner";
import { URI } from "vscode-uri";

export type ResearchPanel = "files" | "ai";

export interface ResearchWorkspaceItem {
  absPath: string;
  relPath: string;
  name: string;
  open: boolean;
  /** 文件修改时间（毫秒）；取不到时为空 */
  mtime?: number;
}

/** 竖栏「工作区」按钮旁的弹出列表是否打开（快捷键也走 focusWorkspace 事件，所以状态放这里） */
export const workspacePopoverOpenAtom = atom(false);
/** 研究文件夹或其中的工作区变了（RESEARCH_FILES_CHANGED_EVENT），列表需要重新读取时加一 */
export const researchFilesVersionAtom = atom(0);

function t(key: string, options?: Record<string, unknown>) {
  return i18next.t(key, { ns: "research", ...options });
}

function reportError(error: unknown) {
  toast.error(t("workspace.failed", { message: error instanceof Error ? error.message : String(error) }));
}

function bumpFilesVersion() {
  store.set(researchFilesVersionAtom, store.get(researchFilesVersionAtom) + 1);
}

function samePath(a: string, b: string) {
  const normalize = (path: string) => path.replace(/\\/g, "/").replace(/\/+$/, "").normalize("NFC").toLowerCase();
  return normalize(a) === normalize(b);
}

function openFileProjects(): Project[] {
  return store
    .get(tabsAtom)
    .filter((tab): tab is Project => tab instanceof Project && !tab.closing && tab.uri.scheme === "file");
}

/** 会话里存的路径：选了研究文件夹就存相对路径，否则存绝对路径 */
function toStoredPath(fsPath: string) {
  return ResearchFolder.getRoot() ? ResearchFolder.toRelative(fsPath) : fsPath.replace(/\\/g, "/");
}

const panelTabIds: Record<ResearchPanel, Set<string>> = { files: new Set(), ai: new Set() };

/** 面板模块打开标签页后调用，竖栏和会话记录就能准确认出它 */
export function markResearchPanelTab(panel: ResearchPanel, tabId: string) {
  panelTabIds[panel].add(tabId);
}

// 面板模块还没调用 markResearchPanelTab 时，按它们 open() 里固定的选项认
function looksLikePanel(panel: ResearchPanel, tab: Tab) {
  if (!(tab instanceof ComponentTab) || tab.closable) return false;
  if (panel === "files") return tab.icon === FolderOpen;
  return tab.contextTarget === "activeResourceTab" && tab.titleBarOverlay && !tab.closeOnEscape && tab.title === "";
}

export function findResearchPanelTab(panel: ResearchPanel, tabs: Tab[] = store.get(tabsAtom)): Tab | undefined {
  const alive = tabs.filter((tab) => !tab.closing);
  return alive.find((tab) => panelTabIds[panel].has(tab.id)) ?? alive.find((tab) => looksLikePanel(panel, tab));
}

/**
 * 标签页现在是否在屏幕上：浮动的只要没在关闭就算；停靠的要是所在分组正在显示的那一页。
 * 面板的开关按钮按这个判断，不能看 activeTabAtom：那是键盘焦点，面板看得见时焦点通常在白板上。
 */
export function isTabVisibleInWorkspace(tabId: string): boolean {
  const tabs = store.get(tabsAtom);
  const tab = tabs.find((candidate) => candidate.id === tabId);
  if (!tab || tab.closing) return false;
  if (tab.layout !== "docked") return true;
  const group = findTabGroupByTabId(store.get(tabGroupRootAtom), tabId);
  if (!group) return false;
  // 和 DockedArea 挑显示页的规则一致：activeTabId 指向的停靠页，没有就显示最后一个停靠页
  const dockedIds = group.tabIds.filter((id) =>
    tabs.some((candidate) => candidate.id === id && candidate.layout === "docked"),
  );
  const shownId = group.activeTabId && dockedIds.includes(group.activeTabId) ? group.activeTabId : dockedIds.at(-1);
  return shownId === tabId;
}

/** 主编辑区（不是左右固定侧栏）里正在显示的工作区 */
function findMainProject(): Project | undefined {
  const active = store.get(activeResourceTabAtom);
  if (active instanceof Project && !active.closing && active.layout === "docked") return active;
  const tabs = store.get(tabsAtom);
  const isProject = (tab: Tab | undefined): tab is Project => tab instanceof Project && !tab.closing;
  for (const group of getTabGroups(store.get(tabGroupRootAtom))) {
    if (isFixedSideGroupId(group.id)) continue;
    const shown = tabs.find((tab) => tab.id === group.activeTabId);
    if (isProject(shown)) return shown;
    const any = tabs.find((tab) => group.tabIds.includes(tab.id) && isProject(tab));
    if (isProject(any)) return any;
  }
  return tabs.find(isProject);
}

export function focusMainWorkspace() {
  const project = findMainProject();
  if (project) TabWorkspace.focus(project.id);
}

/** 研究文件夹里的 .prg 加上已经打开的工作区（可能在文件夹外面） */
export async function listResearchWorkspaces(): Promise<ResearchWorkspaceItem[]> {
  const items: ResearchWorkspaceItem[] = [];
  const openPaths = openFileProjects().map((project) => project.uri.fsPath);
  if (ResearchFolder.getRoot()) {
    for (const entry of await ResearchFolder.listFiles()) {
      if (entry.kind !== "workspace") continue;
      items.push({
        absPath: entry.absPath,
        relPath: entry.relPath,
        name: entry.name.replace(/\.prg$/i, ""),
        open: openPaths.some((path) => samePath(path, entry.absPath)),
        mtime: entry.mtime,
      });
    }
  }
  for (const path of openPaths) {
    if (items.some((item) => samePath(item.absPath, path))) continue;
    const name = path.split(/[\\/]/).pop() ?? path;
    items.push({ absPath: path, relPath: toStoredPath(path), name: name.replace(/\.prg$/i, ""), open: true });
  }
  return items.sort((a, b) => a.relPath.localeCompare(b.relPath));
}

export async function openResearchWorkspace(absPath: string) {
  const opened = await onOpenFile(URI.file(absPath), "科研工作台-工作区列表");
  if (opened instanceof Project) await closeEmptyDrafts(opened);
}

export async function chooseResearchFolder(): Promise<string | null> {
  const root = await ResearchFolder.chooseRoot();
  if (root === null) return null;
  // 换了文件夹以后会话里的相对路径要按新文件夹重算；旧文件夹里没打开的那些记录也不再适用
  unreachableWorkspaces = [];
  unreachableActive = "";
  persistResearchSession();
  return root;
}

/**
 * 问名字并在研究文件夹里新建工作区；还没选研究文件夹时先选。
 * 名字检查、重名提示、打开新工作区都由 ResearchFolder.createWorkspace 负责。
 */
export async function promptNewWorkspace(): Promise<string | null> {
  if (!ResearchFolder.getRoot() && (await chooseResearchFolder()) === null) return null;
  const input = await Dialog.input(t("workspace.newTitle"), t("workspace.newDescription"), {
    placeholder: t("workspace.newPlaceholder"),
  });
  if (input === undefined || input.trim() === "") return null;
  return (await ResearchFolder.createWorkspace(input)) || null;
}

export async function openResearchPanel(panel: ResearchPanel) {
  if (panel === "files") {
    FileManagerWindow.open();
  } else {
    (await import("@/sub/AIWindow")).default.open();
  }
}

const PANEL_EDGE: Record<ResearchPanel, FixedSideEdge> = { files: "left", ai: "right" };

/**
 * 竖栏按钮、快捷键切换面板。面板在左右侧栏里时（默认）只切换固定/收起，不关掉，
 * 收起后对话和文件列表都还在；用户在定制设置里改成别的打开方式时，照旧打开/关闭。
 */
export async function toggleResearchPanel(panel: ResearchPanel) {
  const tab = findResearchPanelTab(panel);
  const group = tab ? findTabGroupByTabId(store.get(tabGroupRootAtom), tab.id) : undefined;
  const edge = sideEdgeOfGroup(group?.id);
  if (tab && !edge) {
    if (panel === "files") await FileManagerWindow.toggle();
    else (await import("@/sub/AIWindow")).default.toggle();
    return;
  }
  const decision = decidePanelToggle({
    open: !!tab,
    pinned: getSidePanelStates()[edge ?? PANEL_EDGE[panel]].pinned,
    frontmost: !!tab && group?.activeTabId === tab.id,
  });
  if (decision === "open" || !tab || !edge) {
    // 打开后焦点落在收着的侧栏上，SidePanels 会把它固定下来
    await openResearchPanel(panel);
    return;
  }
  if (decision === "collapse") {
    setSidePanelPinned(edge, false);
    return;
  }
  setSidePanelPinned(edge, true);
  TabWorkspace.focus(tab.id);
}

/** 鼠标停在竖栏「文件」按钮上：弹出文件面板，没打开过就先打开，同一侧显示着别的面板就切过来 */
export function peekFilesPanel() {
  enterSidePeekTrigger("left", () => {
    const tab = findResearchPanelTab("files");
    if (!tab) FileManagerWindow.open();
    else if (findTabGroupByTabId(store.get(tabGroupRootAtom), tab.id)?.activeTabId !== tab.id) {
      TabWorkspace.focus(tab.id);
    }
  });
}

/** 鼠标贴住窗口左边缘：弹出左侧栏；左侧一个面板都没有时打开文件面板 */
export function peekLeftSide() {
  enterSidePeekTrigger("left", () => {
    if (!findTabGroup(store.get(tabGroupRootAtom), FIXED_SIDE_GROUP_IDS.left)) FileManagerWindow.open();
  });
}

// 启动恢复完成前、关闭窗口逐个关标签页时都不能写会话，否则会把上次的记录冲掉
let sessionTracking = false;

// 启动时因为研究文件夹（或它所在的外接盘、网络盘）暂时访问不到而没能恢复的工作区。
// 写会话时把它们留在列表里，下次启动再试；打开过一次以后就按正常的打开/关闭记录。
let unreachableWorkspaces: string[] = [];
let unreachableActive = "";

export function setResearchSessionTracking(enabled: boolean) {
  sessionTracking = enabled;
}

export function renameSessionWorkspace(oldPath: string, newPath: string) {
  const before = toStoredPath(oldPath);
  const after = toStoredPath(newPath);
  unreachableWorkspaces = unreachableWorkspaces.map((path) => (samePath(path, before) ? after : path));
  if (samePath(unreachableActive, before)) unreachableActive = after;
  const session = Settings.researchSession;
  Settings.researchSession = {
    ...session,
    openWorkspaces: session.openWorkspaces.map((path) => (samePath(path, before) ? after : path)),
    active: samePath(session.active, before) ? after : session.active,
  };
  persistResearchSession();
}

/** 把当前打开的工作区和面板记进 Settings.researchSession（由 App 在标签页变化时调用） */
export function persistResearchSession() {
  if (!sessionTracking) return;
  const active = store.get(activeResourceTabAtom);
  const openWorkspaces = openFileProjects().map((project) => toStoredPath(project.uri.fsPath));
  unreachableWorkspaces = unreachableWorkspaces.filter((path) => !openWorkspaces.some((open) => samePath(open, path)));
  if (!unreachableWorkspaces.some((path) => samePath(path, unreachableActive))) unreachableActive = "";
  const next = {
    openWorkspaces: [...openWorkspaces, ...unreachableWorkspaces],
    active:
      active instanceof Project && !active.closing && active.uri.scheme === "file"
        ? toStoredPath(active.uri.fsPath)
        : unreachableActive,
    panels: { files: !!findResearchPanelTab("files"), ai: !!findResearchPanelTab("ai") },
  };
  if (JSON.stringify(next) !== JSON.stringify(Settings.researchSession)) {
    Settings.researchSession = next;
  }
}

/**
 * 启动时恢复上次的工作区和面板；没有工作区时由空状态提供主编辑区。
 * 返回 false 表示没有可恢复的内容，调用方应显示欢迎页。
 */
export async function startResearchSession(): Promise<boolean> {
  // 调 Rust 的 set_research_root，把研究文件夹加进文件访问范围；同一路径只登记一次
  const root = ResearchFolder.getRoot();
  let rootUnavailable = false;
  if (root) {
    try {
      await ResearchFolder.ensureRootRegistered();
    } catch (error) {
      rootUnavailable = true;
      toast.error(t("shell.setRootFailed", { path: root, message: String(error) }));
    }
  }

  const session = Settings.researchSession;
  const preopened = openFileProjects()[0];
  let restored = false;
  const missing: string[] = [];
  let reachable = 0;
  for (const storedPath of session.openWorkspaces) {
    const absPath = ResearchFolder.toAbsolute(storedPath);
    try {
      if (!(await exists(absPath))) {
        missing.push(storedPath);
        continue;
      }
      reachable++;
      if (await onOpenFile(URI.file(absPath), "科研工作台-恢复会话")) restored = true;
    } catch (error) {
      toast.error(t("shell.restoreFailed", { path: storedPath, message: String(error) }));
    }
  }
  // 文件夹登记失败，或者上次的工作区一个都找不到（多半是盘还没挂上），找不到的先别从会话里删；
  // 只缺几个而别的都在，说明是真删掉或挪走了，照常丢掉
  unreachableWorkspaces = rootUnavailable || reachable === 0 ? missing : [];
  unreachableActive = unreachableWorkspaces.some((path) => samePath(path, session.active)) ? session.active : "";

  // 面板按上次固定没固定显示：恢复时打开面板不算「要用它」，不自动固定
  await withoutAutoPin(async () => {
    for (const panel of ["files", "ai"] as const) {
      if (!session.panels[panel]) continue;
      try {
        await openResearchPanel(panel);
      } catch (error) {
        toast.error(t("shell.panelFailed", { message: String(error) }));
      }
    }
  });

  const activePath = session.active ? ResearchFolder.toAbsolute(session.active) : "";
  const focusTarget =
    preopened ??
    (activePath ? openFileProjects().find((project) => samePath(project.uri.fsPath, activePath)) : undefined) ??
    findMainProject();
  if (focusTarget) TabWorkspace.focus(focusTarget.id);

  sessionTracking = true;
  persistResearchSession();
  return restored || preopened !== undefined;
}

function handle(task: () => Promise<unknown>) {
  return () => {
    task().catch(reportError);
  };
}

/** 注册竖栏、快捷键、菜单发出的工作区事件；返回取消注册函数 */
export function registerResearchSession() {
  const unsubscribers = [
    onResearchEvent("focusWorkspace", () => {
      focusMainWorkspace();
      store.set(workspacePopoverOpenAtom, true);
    }),
    onResearchEvent("newWorkspace", handle(promptNewWorkspace)),
    onResearchEvent("chooseFolder", handle(chooseResearchFolder)),
    onResearchEvent(
      "toggleFiles",
      handle(() => toggleResearchPanel("files")),
    ),
    // AIWindow 只会被动态 import，它自己的模块级监听在第一次打开前不存在，所以在这里转发
    onResearchEvent(
      "toggleAI",
      handle(() => toggleResearchPanel("ai")),
    ),
    registerSidePanels(),
  ];
  window.addEventListener(RESEARCH_FILES_CHANGED_EVENT, bumpFilesVersion);
  return () => {
    unsubscribers.forEach((unsubscribe) => unsubscribe());
    window.removeEventListener(RESEARCH_FILES_CHANGED_EVENT, bumpFilesVersion);
  };
}
