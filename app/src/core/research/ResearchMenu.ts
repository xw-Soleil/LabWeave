import { ResearchFolder } from "@/core/research/ResearchFolder";
import { isResearchShell } from "@/core/research/ResearchShell";
import type { Settings } from "@/core/service/Settings";
import type { URI } from "vscode-uri";

type GlobalMenuNode = Settings["globalMenuConfig"][number];

/**
 * 科研模式的顶部菜单。写成静态树而不是改 globalMenuConfig：用户存过的菜单树只会追加缺的节点，改不掉旧节点。
 * 文案都在 research 命名空间的 menu.items.<id> 下，用 researchMenuTitleKey 取。
 */
export const RESEARCH_GLOBAL_MENU: GlobalMenuNode[] = [
  {
    type: "topMenu",
    id: "file",
    icon: "File",
    children: [
      { type: "item", id: "newResearchWorkspace", icon: "FilePlus" },
      { type: "item", id: "researchChooseFolder", icon: "FolderOpen" },
      { type: "separator", id: "sep-research-file-1" },
      { type: "item", id: "saveFile", icon: "Save" },
      { type: "item", id: "openCurrentProjectFileFolder", icon: "FolderSearch" },
    ],
  },
  {
    type: "topMenu",
    id: "view",
    icon: "PanelsTopLeft",
    children: [
      { type: "item", id: "researchFocusWorkspace", icon: "LayoutDashboard" },
      { type: "item", id: "researchToggleAIChat", icon: "Bot" },
      { type: "item", id: "researchToggleFileManager", icon: "FolderTree" },
    ],
  },
  {
    type: "topMenu",
    id: "settings",
    icon: "Settings",
    children: [{ type: "item", id: "clickAppMenuSettingsButton", icon: "Settings" }],
  },
  {
    type: "topMenu",
    id: "about",
    icon: "CircleAlert",
    children: [{ type: "item", id: "openAboutWindow", icon: "Info" }],
  },
];

/** 科研模式新增的快捷键，文案在 research:menu.items 下 */
export const RESEARCH_KEYBIND_IDS: ReadonlySet<string> = new Set([
  "researchFocusWorkspace",
  "researchToggleAIChat",
  "researchToggleFileManager",
  "newResearchWorkspace",
  "researchChooseFolder",
]);

/** 标记还只是 true 的那个版本停用的快捷键（见 pendingResearchKeyBindDefaults） */
const RESEARCH_DISABLED_KEYBIND_IDS_V1 = [
  "test",
  "newDraft",
  "checkoutProtectPrivacy",
  "switchActiveProject",
  "switchActiveProjectReversed",
  "selectEntityByPenStroke",
  "expandSelectEntity",
  "expandSelectEntityReversed",
  "expandSelectEntityKeepLastSelected",
  "expandSelectEntityReversedKeepLastSelected",
  "checkoutWindowOpacityMode",
  "saveSelectedImagesToProjectDirectory",
  "newFileAtCurrentProjectDir",
  "generateTreeBySelectedTextNodeTextWithAI",
  "generateNetBySelectedTextNodeTextWithAI",
  "generateSummaryBySelectedTextNodeTextWithAI",
];

/**
 * 科研模式下默认清空键位并停用的快捷键：
 * 和新快捷键或系统快捷键撞车（Cmd+N、Cmd+2、Cmd+Tab、Cmd+W），Cmd+0 会把白板变透明，
 * 或者会往研究文件夹里写文件，或者会打开一个带绘图工具的 AI 窗口；
 * Tab / E Tab / \ 树形生长会自动新建节点并连线，研究白板以自由摆放为主，用不上。
 */
export const RESEARCH_DISABLED_KEYBIND_IDS: ReadonlySet<string> = new Set([
  ...RESEARCH_DISABLED_KEYBIND_IDS_V1,
  "generateNodeTreeWithDeepMode",
  "generateNodeTreeWithDeepModeEditEdge",
  "generateNodeTreeWithBroadMode",
]);

/**
 * keybinds2.json 里的标记：记着哪些快捷键已经按科研模式的默认键位改写过，之后尊重用户自己的修改。
 * 早先的版本只存一个 true，对应 RESEARCH_DISABLED_KEYBIND_IDS_V1；现在存改写过的 id 列表。
 */
export const RESEARCH_KEYBIND_DEFAULTS_MARKER = "__researchShellKeyBindDefaultsApplied";

/** 这次启动还要按科研默认键位改写的快捷键：在停用清单里、但标记里还没记过的 */
export function pendingResearchKeyBindDefaults(marker: unknown): Set<string> {
  const applied = new Set<unknown>(
    Array.isArray(marker) ? marker : marker === true ? RESEARCH_DISABLED_KEYBIND_IDS_V1 : [],
  );
  return new Set([...RESEARCH_DISABLED_KEYBIND_IDS].filter((id) => !applied.has(id)));
}

/**
 * 焦点在侧边面板（ComponentTab）甚至文本框里时也要能用的快捷键。
 * 它们拿到的是最近激活的白板工程，而不是当前焦点标签页。
 */
export const RESEARCH_SHELL_SCOPE_KEYBIND_IDS: ReadonlySet<string> = new Set([
  ...RESEARCH_KEYBIND_IDS,
  "saveFile",
  "openCurrentProjectFileFolder",
]);

/** 命令面板在科研模式下只列这些命令 */
export const RESEARCH_COMMAND_IDS: ReadonlySet<string> = new Set([
  ...RESEARCH_KEYBIND_IDS,
  "saveFile",
  "openCurrentProjectFileFolder",
  "clickAppMenuSettingsButton",
  "openAboutWindow",
  "undo",
  "redo",
  "searchText",
  "resetView",
  "resetViewAll",
  "toggleFullscreen",
]);

export function researchMenuTitleKey(id: string): string {
  return `research:menu.items.${id}.title`;
}

/** 给 useTranslation("keyBinds") 的 t 用：科研新增的快捷键文案放在 research 命名空间里 */
export function keyBindI18nKey(id: string): string {
  return RESEARCH_KEYBIND_IDS.has(id) ? `research:menu.items.${id}` : id;
}

/** 科研模式下的最近文件只显示研究文件夹里的 */
export function isRecentFileVisible(uri: URI): boolean {
  if (!isResearchShell()) return true;
  return uri.scheme === "file" && ResearchFolder.isInside(uri.fsPath);
}
