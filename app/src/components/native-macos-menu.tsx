import { Project } from "@/core/Project";
import { isRecentFileVisible, RESEARCH_GLOBAL_MENU, researchMenuTitleKey } from "@/core/research/ResearchMenu";
import { isResearchShell } from "@/core/research/ResearchShell";
import { Settings } from "@/core/service/Settings";
import { KeyBindsUI } from "@/core/service/controlService/shortcutKeysEngine/KeyBindsUI";
import { allKeyBinds } from "@/core/service/controlService/shortcutKeysEngine/shortcutKeysRegister";
import { activeResourceTabAtom, store } from "@/state";
import { Menu, MenuItem, PredefinedMenuItem, Submenu } from "@tauri-apps/api/menu";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { nativeMenuIcon, type NativeMenuIconId } from "./native-menu-icon";
import { RecentFileManager } from "@/core/service/dataFileService/RecentFileManager";
import { onOpenFile } from "@/core/service/GlobalMenu";
import { PathString } from "@/utils/pathString";
import { useAtomValue } from "jotai";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

type ConfigItem = (typeof Settings.globalMenuConfig)[number];
type NativeMenuEntry = Awaited<ReturnType<Menu["items"]>>[number];

export const nativeMacosMenuIds = new Set([
  "file",
  "actions",
  "view",
  "ai",
  "extensions",
  "window",
  "settings",
  "about",
]);

// 只放系统自带的剪贴板命令：没有「编辑」菜单时 WKWebView 的文本框里 Cmd+C/V/X/A 不起作用。
// 不放撤销/重做：白板的 Cmd+Z 走自己的快捷键，系统的撤销会顺带改掉之前在文本框里打的字。
const researchEditItems = [
  { item: "Cut", id: "cut" },
  { item: "Copy", id: "copy" },
  { item: "Paste", id: "paste" },
  { item: "SelectAll", id: "selectAll" },
] as const;

function currentProject() {
  const tab = store.get(activeResourceTabAtom);
  return tab instanceof Project ? tab : undefined;
}

function command(id: string) {
  return KeyBindsUI.getUIKeyBind(id) ?? allKeyBinds.find((item) => item.id === id);
}

export default function NativeMacosMenu({ onReady }: { onReady: (ready: boolean) => void }) {
  const [config] = Settings.use("globalMenuConfig");
  const [showFullMenu] = Settings.use("researchShowFullMenu");
  const researchMenu = isResearchShell() && !showFullMenu;
  const project = useAtomValue(activeResourceTabAtom);
  const { t, i18n } = useTranslation("keyBinds");
  const queue = useRef(Promise.resolve());

  useEffect(() => {
    let cancelled = false;
    const resources: { close: () => Promise<void> }[] = [];
    const iconStyles: { title: string; width: number }[] = [];
    const own = <T extends { close: () => Promise<void> }>(resource: T): T => {
      resources.push(resource);
      return resource;
    };
    const titleOf = (id: string, fallback?: string) =>
      t(researchMenu ? researchMenuTitleKey(id) : `${id}.title`, fallback ?? id);
    const buildItem = async (item: ConfigItem): Promise<MenuItem | Submenu | PredefinedMenuItem | null> => {
      if (item.visible === false) return null;
      if (item.type === "separator") return own(await PredefinedMenuItem.new({ item: "Separator" }));
      const text = titleOf(item.id, item.label);
      if (item.type === "sub" || item.type === "topMenu") {
        const items = [];
        for (const child of item.children ?? []) {
          if (child.type === "recentFiles" && child.visible !== false) {
            const recentFiles = (await RecentFileManager.getRecentFiles())
              .filter((file) => isRecentFileVisible(file.uri))
              .sort((a, b) => b.time - a.time)
              .slice(0, 12);
            for (const file of recentFiles) {
              items.push(
                own(
                  await MenuItem.new({
                    text: PathString.absolute2file(decodeURI(file.uri.toString())),
                    action: () => {
                      void onOpenFile(file.uri, "NativeMenu最近打开的文件");
                    },
                  }),
                ),
              );
            }
            continue;
          }
          const built = await buildItem(child);
          if (built) items.push(built);
        }
        // macOS hides the title when an image is present, so include the label in the image.
        const hasIcon = !researchMenu && item.type === "topMenu" && nativeMacosMenuIds.has(item.id);
        const rendered = hasIcon ? await nativeMenuIcon(item.id as NativeMenuIconId, text) : undefined;
        if (rendered) iconStyles.push({ title: text, width: rendered.width });
        return own(await Submenu.new({ text, items, icon: rendered ? own(rendered.image) : undefined }));
      }
      if (item.type !== "item") return null;
      const binding = command(item.id);
      return own(
        await MenuItem.new({
          text,
          enabled: !!binding?.onPress && (await binding.when?.(currentProject())) !== false,
          action: () => {
            void (async () => {
              const latest = command(item.id);
              const active = currentProject();
              if ((await latest?.when?.(active)) !== false) await latest?.onPress?.(active);
            })();
          },
        }),
      );
    };

    // 科研模式：应用菜单里是「关于」「设置…」，然后是 文件、编辑、视图、窗口，都用文字标题。
    const installResearchMenu = async (menu: Menu, defaults: NativeMenuEntry[]): Promise<Submenu> => {
      let systemWindowItems: NativeMenuEntry[] = [];
      for (const entry of defaults) {
        if (!(entry instanceof Submenu)) continue;
        const title = await entry.text();
        if (title === "Window") {
          systemWindowItems = await entry.items();
          systemWindowItems.forEach(own);
        }
        if (["File", "Edit", "View", "Help", "Window"].includes(title)) await menu.remove(entry);
      }
      const applicationMenu = defaults[0];
      if (!(applicationMenu instanceof Submenu)) throw new Error("Application menu is unavailable");
      // Tauri 自带的「关于」只是系统面板，换成应用自己的关于页
      const previousAbout = await applicationMenu.removeAt(0);
      if (previousAbout) own(previousAbout);
      const topMenu = (id: string) => RESEARCH_GLOBAL_MENU.find((item) => item.id === id && item.type === "topMenu");
      const applicationItems: ConfigItem[] = [
        ...(topMenu("about")?.children ?? []),
        { type: "separator", id: "sep-research-application" },
        ...(topMenu("settings")?.children ?? []),
      ];
      let applicationIndex = 0;
      for (const item of applicationItems) {
        const built = await buildItem(item);
        if (built) await applicationMenu.insert(built, applicationIndex++);
      }
      // 系统自带的「退出」直接结束进程，不经过 onCloseRequested，关闭前的自动保存和未保存提示都会被跳过；
      // 换成关主窗口，走同一条关闭流程
      const quitIndex = (await applicationMenu.items()).length - 1;
      const previousQuit = await applicationMenu.removeAt(quitIndex);
      if (previousQuit) own(previousQuit);
      await applicationMenu.insert(
        own(
          await MenuItem.new({
            text: titleOf("quit", "Quit"),
            accelerator: "CmdOrCtrl+Q",
            action: () => {
              void getCurrentWindow().close();
            },
          }),
        ),
        quitIndex,
      );
      const file = topMenu("file");
      if (file) {
        const built = await buildItem(file);
        if (built) await menu.append(built);
      }
      const editItems = [];
      for (const { item, id } of researchEditItems) {
        editItems.push(own(await PredefinedMenuItem.new({ item, text: titleOf(id) })));
      }
      await menu.append(own(await Submenu.new({ text: titleOf("edit"), items: editItems })));
      const view = topMenu("view");
      if (view) {
        const built = await buildItem(view);
        if (built) await menu.append(built);
      }
      const windowMenu = own(await Submenu.new({ text: titleOf("window"), items: systemWindowItems }));
      await menu.append(windowMenu);
      return windowMenu;
    };

    queue.current = queue.current.then(async () => {
      if (cancelled) return;
      try {
        const menu = own(await Menu.default());
        const defaults = await menu.items();
        defaults.forEach(own);
        let windowMenu: Submenu | undefined;
        if (researchMenu) {
          windowMenu = await installResearchMenu(menu, defaults);
        } else {
          for (const entry of defaults) {
            if (entry instanceof Submenu && ["File", "Edit", "View", "Help"].includes(await entry.text())) {
              await menu.remove(entry);
            }
          }
          const settings = config.find((item) => item.id === "settings" && item.type === "topMenu");
          const about = config.find((item) => item.id === "about" && item.type === "topMenu");
          const applicationMenu = defaults[0];
          if (!(applicationMenu instanceof Submenu)) throw new Error("Application menu is unavailable");
          const previousAbout = await applicationMenu.removeAt(0);
          if (previousAbout) own(previousAbout);
          const applicationItems: ConfigItem[] = [
            ...(settings ? [{ ...settings, type: "sub" as const }] : []),
            ...(about?.visible !== false
              ? (about?.children ?? []).filter((item) => item.id !== "openAboutWindow")
              : []),
          ];
          let applicationIndex = 0;
          for (const item of applicationItems) {
            const built = await buildItem(item);
            if (built) await applicationMenu.insert(built, applicationIndex++);
          }
          for (const id of nativeMacosMenuIds) {
            if (id === "settings" || id === "about") continue;
            const top = config.find((item) => item.id === id && item.type === "topMenu");
            if (!top || top.visible === false) continue;
            const built = await buildItem(top);
            if (!(built instanceof Submenu)) continue;
            if (top.id === "window") {
              windowMenu = built;
              // Tauri's default menu uses the English title, independently of the app locale.
              for (const entry of defaults) {
                if (entry instanceof Submenu && (await entry.text()) === "Window") {
                  const systemItems = await entry.items();
                  systemItems.forEach(own);
                  await built.prepend(own(await PredefinedMenuItem.new({ item: "Separator" })));
                  await built.prepend(systemItems);
                  await menu.remove(entry);
                  break;
                }
              }
            }
            await menu.append(built);
          }
        }
        if (cancelled) return;
        const previous = await menu.setAsAppMenu();
        await invoke("style_macos_menu_icons", { icons: iconStyles });
        await windowMenu?.setAsWindowsMenuForNSApp();
        await previous?.close();
        onReady(true);
      } catch (error) {
        onReady(false);
        window.dispatchEvent(new ErrorEvent("error", { error, message: String(error) }));
      } finally {
        // The installed menu retains its items; release the JavaScript resource handles.
        for (const resource of resources.reverse()) await resource.close();
      }
    });
    return () => {
      cancelled = true;
    };
  }, [config, researchMenu, project, t, i18n.resolvedLanguage, onReady]);

  return null;
}
