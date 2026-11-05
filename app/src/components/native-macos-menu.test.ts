import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  config: [] as any[],
  settings: {} as Record<string, unknown>,
  project: undefined as unknown,
  alwaysOnTop: false,
  bindings: new Map<string, any>(),
  installed: undefined as any,
  fail: false,
  cleanup: undefined as (() => void) | undefined,
  errors: vi.fn(),
  invoke: vi.fn().mockResolvedValue(undefined),
  openFile: vi.fn().mockResolvedValue(undefined),
  researchRoot: "",
}));
vi.mock("@/core/service/GlobalMenu", () => ({ onOpenFile: state.openFile }));
vi.mock("@/core/service/dataFileService/RecentFileManager", () => ({
  RecentFileManager: {
    getRecentFiles: async () => [
      { uri: { scheme: "file", fsPath: "/test/recent.prg", toString: () => "/test/recent.prg" }, time: 1 },
    ],
  },
}));
vi.mock("@/utils/pathString", () => ({ PathString: { absolute2file: (path: string) => path.split("/").at(-1) } }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: state.invoke }));
vi.mock("./native-menu-icon", () => ({
  nativeMenuIcon: async (id: string, title: string) => ({ image: { id, title, close: async () => {} }, width: 52 }),
}));

vi.mock("@/core/Project", () => ({ Project: class {} }));
vi.mock("@/core/service/Settings", () => ({
  Settings: {
    use: (key: string) => [key === "globalMenuConfig" ? state.config : state.settings[key]],
    get researchFolderPath() {
      return state.researchRoot;
    },
  },
}));
vi.mock("@/core/service/controlService/shortcutKeysEngine/KeyBindsUI", () => ({
  KeyBindsUI: { getUIKeyBind: (id: string) => state.bindings.get(id) },
}));
vi.mock("@/core/service/controlService/shortcutKeysEngine/shortcutKeysRegister", () => ({ allKeyBinds: [] }));
vi.mock("@/state", () => ({
  activeResourceTabAtom: { key: "project" },
  isWindowAlwaysOnTopAtom: { key: "alwaysOnTop" },
  store: { get: () => state.project },
}));
vi.mock("jotai", () => ({
  useAtomValue: (atom: { key: string }) => (atom.key === "alwaysOnTop" ? state.alwaysOnTop : state.project),
}));
vi.mock("react", () => ({
  useRef: (current: unknown) => ({ current }),
  useEffect: (effect: () => () => void) => {
    state.cleanup = effect();
  },
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (_key: string, fallback: string) => fallback, i18n: { resolvedLanguage: "en" } }),
}));
vi.mock("@tauri-apps/api/menu", () => {
  class MenuItem {
    constructor(public options: any) {}
    static async new(options: any) {
      return new this(options);
    }
    async close() {}
  }
  class Submenu extends MenuItem {
    async text() {
      return this.options.text;
    }
    async items() {
      return this.options.items ?? [];
    }
    async prepend(items: any) {
      this.options.items.unshift(...(Array.isArray(items) ? items : [items]));
    }
    async removeAt(index: number) {
      return this.options.items.splice(index, 1)[0] ?? null;
    }
    async insert(item: any, index: number) {
      this.options.items.splice(index, 0, item);
    }
    async setAsWindowsMenuForNSApp() {
      this.options.systemWindowMenu = true;
    }
  }
  class Menu extends Submenu {
    static async default() {
      if (state.fail) throw new Error("menu unavailable");
      return new Menu({
        items: [
          new Submenu({
            text: "Project Graph",
            items: [
              new MenuItem({ text: "About project-graph" }),
              new MenuItem({ text: "Services" }),
              new MenuItem({ text: "Quit" }),
            ],
          }),
          new Submenu({ text: "File" }),
          new Submenu({ text: "Edit" }),
          new Submenu({ text: "View" }),
          new Submenu({ text: "Help" }),
          new Submenu({ text: "Window", items: [new MenuItem({ text: "Minimize" })] }),
        ],
      });
    }
    async append(item: any) {
      this.options.items.push(item);
    }
    async remove(item: any) {
      this.options.items = this.options.items.filter((entry: any) => entry !== item);
    }
    async setAsAppMenu() {
      state.installed = this;
      return null;
    }
  }
  class CheckMenuItem extends MenuItem {}
  return {
    Menu,
    Submenu,
    MenuItem,
    CheckMenuItem,
    PredefinedMenuItem: MenuItem,
  };
});

import NativeMacosMenu from "./native-macos-menu";
import { Project } from "@/core/Project";

beforeEach(() => {
  state.config = [
    { type: "topMenu", id: "about", children: [{ type: "item", id: "openAboutWindow" }] },
    { type: "topMenu", id: "settings", children: [{ type: "item", id: "openSettings" }] },
    { type: "topMenu", id: "ai", children: [{ type: "item", id: "openAI" }] },
    { type: "topMenu", id: "window", children: [] },
    {
      type: "topMenu",
      id: "file",
      children: [{ type: "sub", id: "recentFilesSub", children: [{ type: "recentFiles", id: "recentFilesEntries" }] }],
    },
    { type: "topMenu", id: "view", children: [] },
    { type: "topMenu", id: "actions", children: [] },
    { type: "topMenu", id: "extensions", children: [] },
  ];
  state.settings = { researchShowFullMenu: false };
  state.researchRoot = "";
  state.bindings.clear();
  state.bindings.set("openSettings", { onPress: vi.fn() });
  state.bindings.set("openAboutWindow", { onPress: vi.fn() });
  state.bindings.set("clickAppMenuSettingsButton", { onPress: vi.fn() });
  state.project = undefined;
  state.alwaysOnTop = false;
  state.installed = undefined;
  state.fail = false;
  state.errors.mockClear();
  state.invoke.mockClear();
  state.openFile.mockClear();
  vi.stubGlobal("window", { dispatchEvent: state.errors });
  vi.stubGlobal(
    "ErrorEvent",
    class {
      constructor(
        public type: string,
        public options: unknown,
      ) {}
    },
  );
});

describe("macOS system menus (full menu)", () => {
  beforeEach(() => {
    state.settings.researchShowFullMenu = true;
  });

  it("replaces About with Settings in the application menu and preserves system actions", async () => {
    const ready = vi.fn();
    NativeMacosMenu({ onReady: ready });
    await vi.waitFor(() => expect(ready).toHaveBeenCalledWith(true));
    const entries = state.installed.options.items;
    const expected = ["file", "actions", "view", "ai", "extensions", "window"];
    expect(entries.map((entry: any) => entry.options.text)).toEqual(["Project Graph", ...expected]);
    expect(entries.slice(1).map((entry: any) => entry.options.icon.id)).toEqual(expected);
    expect(state.invoke).toHaveBeenCalledWith("style_macos_menu_icons", {
      icons: expected.map((title) => ({ title, width: 52 })),
    });
    expect(entries[6].options.items[0].options.text).toBe("Minimize");
    expect(entries[6].options.systemWindowMenu).toBe(true);
    expect(entries[0].options.items.map((item: any) => item.options.text)).toEqual(["settings", "Services", "Quit"]);
    entries[0].options.items[0].options.items[0].options.action();
    await vi.waitFor(() => expect(state.bindings.get("openSettings").onPress).toHaveBeenCalledOnce());
  });

  it("uses the latest project and rechecks the command condition at click time", async () => {
    const run = vi.fn();
    const when = vi.fn(() => true);
    state.bindings.set("openAI", { onPress: run, when });
    const ready = vi.fn();
    NativeMacosMenu({ onReady: ready });
    await vi.waitFor(() => expect(ready).toHaveBeenCalledWith(true));
    const action = state.installed.options.items.find((entry: any) => entry.options.text === "ai").options.items[0]
      .options.action;
    state.project = Object.create(Project.prototype);
    action();
    await vi.waitFor(() => expect(run).toHaveBeenCalledWith(state.project));
    when.mockReturnValue(false);
    action();
    await Promise.resolve();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("keeps the in-window menus available and surfaces native menu failures", async () => {
    state.fail = true;
    const ready = vi.fn();
    NativeMacosMenu({ onReady: ready });
    await vi.waitFor(() => expect(ready).toHaveBeenCalledWith(false));
    expect(state.errors).toHaveBeenCalledOnce();
  });
});

describe("macOS system menus (research menu)", () => {
  it("shows About and Settings first, then File, Edit, View and Window with text titles", async () => {
    const ready = vi.fn();
    NativeMacosMenu({ onReady: ready });
    await vi.waitFor(() => expect(ready).toHaveBeenCalledWith(true));
    const entries = state.installed.options.items;
    expect(entries.map((entry: any) => entry.options.text)).toEqual([
      "Project Graph",
      "file",
      "edit",
      "view",
      "window",
    ]);
    expect(entries.slice(1).every((entry: any) => entry.options.icon === undefined)).toBe(true);
    expect(state.invoke).toHaveBeenCalledWith("style_macos_menu_icons", { icons: [] });

    const application = entries[0].options.items;
    expect(application.map((item: any) => item.options.text ?? item.options.item)).toEqual([
      "openAboutWindow",
      "Separator",
      "clickAppMenuSettingsButton",
      "Services",
      "Quit",
    ]);
    application[0].options.action();
    await vi.waitFor(() => expect(state.bindings.get("openAboutWindow").onPress).toHaveBeenCalledOnce());

    expect(entries[1].options.items.map((item: any) => item.options.text ?? item.options.item)).toEqual([
      "newResearchWorkspace",
      "researchChooseFolder",
      "Separator",
      "saveFile",
      "openCurrentProjectFileFolder",
    ]);
    expect(entries[2].options.items.map((item: any) => item.options.item)).toEqual([
      "Cut",
      "Copy",
      "Paste",
      "SelectAll",
    ]);
    expect(entries[3].options.items.map((item: any) => item.options.text ?? item.options.item)).toEqual([
      "researchFocusWorkspace",
      "researchToggleAIChat",
      "researchToggleFileManager",
      "Separator",
      "researchToggleAlwaysOnTop",
    ]);
    expect(entries[4].options.items[0].options.text).toBe("Minimize");
    expect(entries[4].options.systemWindowMenu).toBe(true);
  });

  it("shows View → Keep window on top as a check item that follows the window state", async () => {
    state.bindings.set("researchToggleAlwaysOnTop", { onPress: vi.fn() });
    const ready = vi.fn();
    NativeMacosMenu({ onReady: ready });
    await vi.waitFor(() => expect(ready).toHaveBeenCalledWith(true));
    const pin = () => state.installed.options.items[3].options.items.at(-1);
    expect(pin().constructor.name).toBe("CheckMenuItem");
    expect(pin().options.checked).toBe(false);
    expect(pin().options.enabled).toBe(true);

    state.alwaysOnTop = true;
    ready.mockClear();
    NativeMacosMenu({ onReady: ready });
    await vi.waitFor(() => expect(ready).toHaveBeenCalledWith(true));
    expect(pin().options.checked).toBe(true);
    pin().options.action();
    await vi.waitFor(() => expect(state.bindings.get("researchToggleAlwaysOnTop").onPress).toHaveBeenCalledOnce());
  });

  it("falls back to the full menu when researchShowFullMenu is on", async () => {
    state.settings.researchShowFullMenu = true;
    const ready = vi.fn();
    NativeMacosMenu({ onReady: ready });
    await vi.waitFor(() => expect(ready).toHaveBeenCalledWith(true));
    const entries = state.installed.options.items;
    expect(entries.map((entry: any) => entry.options.text)).toEqual([
      "Project Graph",
      "file",
      "actions",
      "view",
      "ai",
      "extensions",
      "window",
    ]);
    // 系统的「退出」会跳过 onCloseRequested（关闭前自动保存、未保存提示），完整菜单里也要换掉
    const quit = entries[0].options.items.at(-1);
    expect(quit.options.text).toBe("Quit");
    expect(quit.options.accelerator).toBe("CmdOrCtrl+Q");
    expect(typeof quit.options.action).toBe("function");
  });

  it("routes Quit in the research menu through the window close flow", async () => {
    const ready = vi.fn();
    NativeMacosMenu({ onReady: ready });
    await vi.waitFor(() => expect(ready).toHaveBeenCalledWith(true));
    const quit = state.installed.options.items[0].options.items.at(-1);
    expect(quit.options.accelerator).toBe("CmdOrCtrl+Q");
    expect(typeof quit.options.action).toBe("function");
  });

  it("lists recent files inside the research folder and opens them on click", async () => {
    state.settings.researchShowFullMenu = true;
    state.researchRoot = "/test";
    const ready = vi.fn();
    NativeMacosMenu({ onReady: ready });
    await vi.waitFor(() => expect(ready).toHaveBeenCalledWith(true));
    const file = state.installed.options.items.find((entry: any) => entry.options.text === "file");
    const recent = file.options.items[0].options.items[0];
    expect(recent.options.text).toBe("recent.prg");
    recent.options.action();
    expect(state.openFile).toHaveBeenCalledOnce();
  });

  it("hides recent files outside the research folder", async () => {
    state.settings.researchShowFullMenu = true;
    const ready = vi.fn();
    NativeMacosMenu({ onReady: ready });
    await vi.waitFor(() => expect(ready).toHaveBeenCalledWith(true));
    const file = state.installed.options.items.find((entry: any) => entry.options.text === "file");
    expect(file.options.items[0].options.items).toEqual([]);
  });
});
