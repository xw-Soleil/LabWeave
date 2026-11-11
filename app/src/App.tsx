import ActivityRail, { dockedChromeAtom } from "@/components/activity-rail";
import MyContextMenuContent from "@/components/context-menu-content";
import FloatingTabs from "@/components/floating-tabs";
import PieMenu from "@/components/pie-menu";
import ThemeModeSwitch from "@/components/theme-mode-switch";
import { Button } from "@/components/ui/button";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu";
import { Dialog } from "@/components/ui/dialog";
import { displayWorkspaceName } from "@/components/ui/file-name";
import { Project, ProjectState, ResearchSaveRefusedError } from "@/core/Project";
import {
  beginResearchSessionChange,
  endResearchSessionChange,
  persistResearchSession,
  registerResearchSession,
  setResearchSessionTracking,
} from "@/core/research/ResearchSession";
import { isResourceTab, Tab } from "@/core/Tab";
import { TabWorkspace } from "@/core/TabWorkspace";
import { GlobalMenu } from "@/core/service/GlobalMenu";
import { flushSettingsLoadErrors, Settings } from "@/core/service/Settings";
import { Telemetry } from "@/core/service/Telemetry";
import { Themes } from "@/core/service/Themes";
import { globalShortcutManager } from "@/core/service/controlService/shortcutKeysEngine/GlobalShortcutManager";
import {
  activeResourceTabAtom,
  activeTabAtom,
  isClassroomModeAtom,
  isClickThroughEnabledAtom,
  isWindowMaxsizedAtom,
  tabsAtom,
} from "@/state";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { arch, platform, version } from "@tauri-apps/plugin-os";
import { restoreStateCurrent, saveWindowState, StateFlags } from "@tauri-apps/plugin-window-state";
import { useAtom, useAtomValue } from "jotai";
import { Copy, Minus, Square, X } from "lucide-react";
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { cpuInfo } from "tauri-plugin-system-info-api";
import CommandPalette from "./CommandPalette";
import { DropWindowCover } from "./DropWindowCover";
import DockedArea from "./components/docked-area";
import RenderOverlays from "./components/overlay-host";
import { KeyBindsUI } from "./core/service/controlService/shortcutKeysEngine/KeyBindsUI";
import { checkAndFixShortcutStorage } from "./core/service/controlService/shortcutKeysEngine/ShortcutKeyFixer";
import { cn } from "./utils/cn";
import { isLinux, isMac, isWindows } from "./utils/platform";

/** 关标签页失败时提示用户；取消、没选路径不算失败，拒绝存到研究文件夹外面时 Project 已经提示过 */
function reportResearchCloseError(error: unknown) {
  if (error instanceof ResearchSaveRefusedError) return;
  if (error instanceof Error && (error.message === "取消操作" || error.message === "未选择路径")) return;
  toast.error(error instanceof Error ? error.message : String(error));
}

/** 给人看的工作区名，和标签栏一致：文件名去掉 .prg，草稿叫「未命名 1」 */
function researchWorkspaceName(project: Project, untitled: (n: string) => string): string {
  if (project.isDraft) return untitled(project.uri.path);
  if (project.uri.scheme === "file") return displayWorkspaceName(project.title);
  return project.title;
}

/** 红绿灯占的宽度（不随 UI 缩放）；左上角的菜单和标签从它右边开始 */
const MAC_TRAFFIC_LIGHTS_WIDTH = 78;

/**
 * 没有标题栏：画布铺满窗口，左上角放窗口内菜单（macOS 上是原生菜单，这里通常是空的），
 * 右上角放浅/深色切换和 Windows 的窗口按钮。两块的宽度写进 CSS 变量，
 * 挨着窗口上边的白板标签据此让位（见 DockedArea）。
 * 变量写在共同的上级元素上；父组件的 ref 这时还没挂上，所以直接取 parentElement。
 */
function FloatingCorners() {
  const leftRef = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);
  const docked = useAtomValue(dockedChromeAtom);

  useLayoutEffect(() => {
    const left = leftRef.current;
    const right = rightRef.current;
    const root = left?.parentElement;
    if (!root || !left || !right) return;
    const gap = 6;
    const update = () => {
      const start = isMac ? MAC_TRAFFIC_LIGHTS_WIDTH : 8;
      const menuWidth = left.offsetWidth;
      root.style.setProperty("--pg-top-left-inset", `${start + (menuWidth > 0 ? menuWidth + gap : 0)}px`);
      root.style.setProperty("--pg-top-right-inset", `${8 + right.offsetWidth + gap}px`);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(left);
    observer.observe(right);
    return () => observer.disconnect();
  }, []);

  return (
    <>
      <div
        ref={leftRef}
        className="absolute top-1 z-30 flex h-7 items-center empty:hidden"
        style={{ left: isMac ? MAC_TRAFFIC_LIGHTS_WIDTH : 8 }}
      >
        <GlobalMenu />
      </div>
      <div
        ref={rightRef}
        className={cn(
          "absolute right-2 z-30 flex h-7 items-center gap-1 rounded-full border px-1",
          // 贴边排法里放在顶上那一条里，不要浮起来的边框
          docked ? "top-1.5 border-transparent" : "bg-background/95 border-border/60 top-1 shadow-xs",
        )}
      >
        <ThemeModeSwitch />
        {!isMac && <WindowButtons />}
      </div>
    </>
  );
}

export default function App() {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [_, _setMaximized] = useAtom(isWindowMaxsizedAtom);

  const [tabs, setTabs] = useAtom(tabsAtom);
  const [, setActiveTab] = useAtom(activeTabAtom);
  const [activeResourceTab] = useAtom(activeResourceTabAtom);
  // const [isWide, setIsWide] = useState(false);
  const [telemetryEventSent, setTelemetryEventSent] = useState(false);
  const [isClassroomMode, setIsClassroomMode] = useAtom(isClassroomModeAtom);
  const [uiScalePercent, setUiScalePercent] = useState(Settings.uiScalePercent);
  const { t: tResearch } = useTranslation("research");

  const contextMenuTriggerRef = useRef<HTMLDivElement>(null);

  const handleTitleBarMouseDown = (event: React.MouseEvent<HTMLDivElement>) => {
    if ((event.target as Element).closest('[role="tablist"]')) return;
    if (event.buttons !== 1) return;

    if (event.detail === 2) {
      void getCurrentWindow().toggleMaximize();
      return;
    }

    void getCurrentWindow().startDragging();
  };

  // const { t } = useTranslation("app");

  useEffect(() => {
    // 设置兼容性提示依赖 Dialog UI，必须在应用挂载后再触发。
    void flushSettingsLoadErrors();

    // 先修复老用户的快捷键缓存问题（F11快捷键）
    (async () => {
      await checkAndFixShortcutStorage();
    })();
    // 注册UI级别快捷键
    KeyBindsUI.registerAllUIKeyBinds();
    KeyBindsUI.uiStartListen();

    // 在捕获阶段禁止浏览器/WebView 原生右键菜单，但允许 Radix ContextMenu 处理自己的触发区域。
    window.addEventListener(
      "contextmenu",
      (event) => {
        if (event.target instanceof Element && event.target.closest('[data-slot="context-menu-trigger"]')) return;
        event.preventDefault();
      },
      true,
    );

    // 全局错误处理
    window.addEventListener("error", (event) => {
      Telemetry.event("未知错误", String(event.error));
    });

    // 监听主题样式切换
    Settings.watch("theme", (value) => {
      const theme = Themes.applyThemeById(value);
      if (!theme) return;
      if (theme.metadata.type === "light") {
        Settings.lightTheme = value;
      } else if (theme.metadata.type === "dark") {
        Settings.darkTheme = value;
      }
    });

    // 监听主题模式切换
    Settings.watch("themeMode", (value) => {
      const targetTheme = value === "light" ? Settings.lightTheme : Settings.darkTheme;
      if (Settings.theme !== targetTheme) {
        Settings.theme = targetTheme;
      }
    });
    Settings.watch("lightTheme", (value) => {
      if (Settings.themeMode === "light" && Settings.theme !== value) {
        Settings.theme = value;
      }
    });
    Settings.watch("darkTheme", (value) => {
      if (Settings.themeMode === "dark" && Settings.theme !== value) {
        Settings.theme = value;
      }
    });

    // 初始化 UI 缩放（只缩放 UI 组件层，不缩放 Canvas 画布）
    setUiScalePercent(Settings.uiScalePercent);
    const unwatchUiScale = Settings.watch("uiScalePercent", (value) => {
      setUiScalePercent(value);
    });

    // 恢复窗口位置大小
    restoreStateCurrent(StateFlags.SIZE | StateFlags.POSITION | StateFlags.MAXIMIZED);

    // setIsWide(window.innerWidth / window.innerHeight > 1.8);

    const unlisten1 = getCurrentWindow().onResized(() => {
      if (!isOnResizedDisabled.current) {
        isMaximizedWorkaround();
      }
      // setIsWide(window.innerWidth / window.innerHeight > 1.8);
    });

    if (!telemetryEventSent) {
      setTelemetryEventSent(true);
      (async () => {
        const cpu = await cpuInfo();
        await Telemetry.event("启动应用", {
          version: await getVersion(),
          os: platform(),
          arch: arch(),
          osVersion: isLinux ? `${await invoke("get_distribution")} ${version()}` : version(),
          cpu: cpu.cpus[0].brand,
          cpuCount: cpu.cpu_count,
        });
      })();
    }

    // 加载完成了，显示窗口
    if (!window.ipc_bridge) {
      getCurrentWindow().show();
    }

    // 初始化全局快捷键管理
    globalShortcutManager.init();

    return () => {
      unlisten1?.then((f) => f());
      KeyBindsUI.uiStopListen();
      // 清理全局快捷键资源
      unwatchUiScale();
      globalShortcutManager.dispose();
    };
  }, []);

  useEffect(() => {
    setIsClassroomMode(Settings.isClassroomMode);
  }, [Settings.isClassroomMode]);

  // https://github.com/tauri-apps/tauri/issues/5812
  const isOnResizedDisabled = useRef(false);
  function isMaximizedWorkaround() {
    isOnResizedDisabled.current = true;
    getCurrentWindow()
      .isMaximized()
      .then((isMaximized) => {
        isOnResizedDisabled.current = false;
        // your stuff
        _setMaximized(isMaximized);
      });
  }

  useEffect(() => {
    const updateTabRenderLoops = () => {
      if (!activeResourceTab) return;
      if (Settings.pauseRenderWhenTabUnfocused) {
        activeResourceTab.loop();
        tabs.filter((tab) => tab !== activeResourceTab).forEach((tab) => tab.pause());
      } else {
        tabs.filter((tab) => isResourceTab(tab) && !tab.closing).forEach((tab) => tab.loop());
      }
    };
    return Settings.watch("pauseRenderWhenTabUnfocused", updateTabRenderLoops);
  }, [activeResourceTab, tabs]);

  useEffect(() => {
    TabWorkspace.synchronizeGroups();
  }, [tabs]);

  useEffect(() => {
    return registerResearchSession();
  }, []);

  useEffect(() => {
    persistResearchSession();
  }, [tabs, activeResourceTab]);

  useEffect(() => {
    let unlisten1: () => void;
    /**
     * 关闭窗口时的事件监听
     */
    getCurrentWindow()
      .onCloseRequested(async (e) => {
        e.preventDefault();
        if (!beginResearchSessionChange()) {
          toast.error(tResearch("projectTree.switchBusy"));
          return;
        }
        try {
          // 已经存过盘的工作区在弹警告前先自动保存（草稿没有路径，仍走下面的提示）
          if (Settings.autoSaveWhenClose || Settings.autoSave) {
            for (const tab of tabs) {
              if (!(tab instanceof Project) || tab.closing || tab.uri.scheme !== "file") continue;
              if (tab.projectState !== ProjectState.Unsaved) continue;
              try {
                await tab.save();
              } catch (error) {
                toast.error(tResearch("shell.autoSaveFailed", { name: tab.title, message: String(error) }));
              }
            }
          }

          // 检查是否有未保存的项目
          const unsavedTabs = tabs.filter(
            (tab): tab is Project =>
              tab instanceof Project &&
              (tab.projectState === ProjectState.Unsaved || tab.projectState === ProjectState.Stashed),
          );

          if (unsavedTabs.length > 0) {
            // 弹出警告对话框
            const response = await Dialog.buttons(
              "检测到未保存文件",
              `当前有 ${unsavedTabs.length} 个未保存的文件。直接关闭可能有文件被清空的风险，建议先手动保存文件。`,
              [
                { id: "cancel", label: "取消", variant: "ghost" },
                { id: "continue", label: "继续关闭", variant: "destructive" },
              ],
            );

            if (response === "cancel") {
              // 用户选择取消关闭，返回
              return;
            }
            // 用户选择继续关闭，执行原有关闭流程
          }

          // 逐个关标签页时不能记会话，否则下次启动什么都恢复不了
          setResearchSessionTracking(false);
          try {
            for (const tab of tabs) {
              console.log("尝试关闭", tab);
              await closeTab(tab);
            }
          } catch (error) {
            Telemetry.event("关闭应用提示是否保存文件选择了取消");
            reportResearchCloseError(error);
            setResearchSessionTracking(true);
            persistResearchSession();
            return;
          }
          Telemetry.event("关闭应用");
          // 保存窗口位置
          await saveWindowState(StateFlags.SIZE | StateFlags.POSITION | StateFlags.MAXIMIZED);
          await getCurrentWindow().destroy();
        } finally {
          endResearchSessionChange();
        }
      })
      .then((it) => {
        unlisten1 = it;
      });

    const onStateChange = () => {
      // 强制重新渲染一次
      setTabs([...tabs]);
    };
    const onContextMenu = ({ x, y }: { x: number; y: number }) => {
      contextMenuTriggerRef.current?.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          clientX: x,
          clientY: y,
        }),
      );
      setTabs([...tabs]);
    };
    for (const tab of tabs) {
      tab.on("state-change", onStateChange);
      tab.on("contextmenu", onContextMenu);
    }

    return () => {
      unlisten1?.();
      // 只摘自己挂的监听：自动保存也监听 state-change，不能一起删掉
      for (const tab of tabs) {
        tab.off("state-change", onStateChange);
        tab.off("contextmenu", onContextMenu);
      }
    };
  }, [tabs.length]);

  const closeTab = async (tab: Tab) => {
    if (tab instanceof Project) {
      if (tab.projectState === ProjectState.Stashed) {
        toast("文件还没有保存，但已经暂存，在“最近打开的文件”中可恢复文件");
      } else if (tab.projectState === ProjectState.Unsaved) {
        // 切换到这个文件
        setActiveTab(tab);
        // 只显示工作区名，不显示 file:// 地址
        const description = researchWorkspaceName(tab, (n) => tResearch("tabs.untitled", { n }));
        const response = await Dialog.buttons("是否保存更改？", description, [
          { id: "cancel", label: "取消", variant: "ghost" },
          { id: "discard", label: "不保存", variant: "destructive" },
          { id: "save", label: "保存" },
        ]);
        if (response === "save") {
          await tab.save();
        } else if (response === "cancel") {
          throw new Error("取消操作");
        }
      }
    }
    if ((await TabWorkspace.close(tab.id)) === false) throw new Error("取消操作");
  };

  const handleTabClick = useCallback((tab: Tab) => {
    TabWorkspace.focus(tab.id);
  }, []);

  const handleTabClose = useCallback(
    async (tab: Tab) => {
      try {
        await closeTab(tab);
      } catch (error) {
        // 标签栏不接这个异常，保存失败（比如存到研究文件夹外面）要提示，不能当成取消
        reportResearchCloseError(error);
      }
    },
    [closeTab],
  );

  const zoomStyle = uiScalePercent !== 100 ? ({ zoom: `${uiScalePercent / 100}` } as React.CSSProperties) : undefined;

  return (
    <>
      <div
        className={cn(
          "has-[[data-pg-settings-view]]:bg-background/[0.9516] relative flex h-full w-full flex-col overflow-clip sm:gap-2",
          !isMac && "rounded-lg",
          // 窗口本身是透明的,侧边面板要不透明,不然会透出后面的窗口
          "bg-background",
        )}
        style={{ "--pg-ui-scale": uiScalePercent / 100 } as React.CSSProperties}
        onContextMenu={(event) => {
          if ((event.target as Element).closest('[data-slot="context-menu-trigger"]')) return;
          event.preventDefault();
        }}
      >
        {/* Canvas content - NOT zoomed */}
        <DockedArea onTabClick={handleTabClick} onTabClose={handleTabClose} isClassroomMode={isClassroomMode} />
        {/* 窗口最上面一条看不见的拖动区：拖动窗口、双击缩放（标签、按钮盖在它上面照常能点） */}
        <div aria-hidden="true" className="absolute inset-x-0 top-0 z-20 h-3" onMouseDown={handleTitleBarMouseDown} />
        <FloatingCorners />
        {/* 不在缩放层里，竖栏自己按 --pg-ui-scale 缩放 */}
        <ActivityRail isClassroomMode={isClassroomMode} />

        {/* Zoomed UI layer - 缩放所有 DOM UI 元素，不缩放 Canvas 画布 */}
        <div
          style={zoomStyle}
          className={cn(
            "pointer-events-none relative z-10 flex h-full w-full flex-col",
            !isMac && "*:pointer-events-auto",
          )}
        >
          {/* 右键菜单 */}
          <ContextMenu modal={false}>
            <ContextMenuTrigger>
              <div ref={contextMenuTriggerRef} />
            </ContextMenuTrigger>
            <MyContextMenuContent />
          </ContextMenu>
        </div>

        {/* NOT zoomed - 使用固定/全屏定位的组件，缩放会破坏它们的坐标计算 */}
        <FloatingTabs zoomStyle={zoomStyle} onTabClose={handleTabClose} />
        <PieMenu />

        {/* 右上角关闭的触发角 */}
        {isWindows && (
          <div
            className="absolute top-0 right-0 z-50 h-1 w-1 cursor-pointer rounded-bl-xl bg-red-600 transition-all hover:h-10 hover:w-10 hover:bg-yellow-500"
            onClick={() => getCurrentWindow().close()}
          ></div>
        )}
        {/* 不依赖当前白板（没开白板也能拖 .prg 进来） */}
        <DropWindowCover />

        <CommandPalette zoomStyle={zoomStyle} />
        <RenderOverlays />
        {/* macOS uses native decorated-window resize regions; Tauri resize dragging is unsupported there. */}
        {!isMac && <WindowResizeHandles />}
      </div>
    </>
  );
}

function WindowResizeHandles() {
  const [enabled, setEnabled] = useState(false);
  const [hoveredDirection, setHoveredDirection] = useState<string | null>(null);

  useEffect(() => {
    const appWindow = getCurrentWindow();
    let disposed = false;
    const update = async () => {
      const [maximized, fullscreen, resizable] = await Promise.all([
        appWindow.isMaximized(),
        appWindow.isFullscreen(),
        appWindow.isResizable(),
      ]);
      if (!disposed) setEnabled(resizable && !maximized && !fullscreen);
    };
    const unlisten = appWindow.onResized(() => void update());
    void update();
    return () => {
      disposed = true;
      void unlisten.then((stop) => stop());
    };
  }, []);

  if (!enabled) return null;

  const handles = [
    ["North", "top-0 right-3 left-3 h-1.5 cursor-ns-resize", "h-0.5 w-10 rounded-full"],
    ["South", "bottom-0 right-3 left-3 h-1.5 cursor-ns-resize", "h-0.5 w-10 rounded-full"],
    ["West", "top-3 bottom-3 left-0 w-1.5 cursor-ew-resize", "h-10 w-0.5 rounded-full"],
    ["East", "top-3 bottom-3 right-0 w-1.5 cursor-ew-resize", "h-10 w-0.5 rounded-full"],
    ["NorthWest", "top-0 left-0 size-3 cursor-nwse-resize", "size-2 rounded-tl border-t-2 border-l-2"],
    ["NorthEast", "top-0 right-0 size-3 cursor-nesw-resize", "size-2 rounded-tr border-t-2 border-r-2"],
    ["SouthWest", "bottom-0 left-0 size-3 cursor-nesw-resize", "size-2 rounded-bl border-b-2 border-l-2"],
    ["SouthEast", "bottom-0 right-0 size-3 cursor-nwse-resize", "size-2 rounded-br border-b-2 border-r-2"],
  ] as const;

  return handles.map(([direction, area, grip]) => (
    <div
      key={direction}
      aria-hidden="true"
      className={cn("absolute z-50 flex touch-none items-center justify-center", area)}
      onPointerEnter={() => setHoveredDirection(direction)}
      onPointerMove={() => setHoveredDirection(direction)}
      onPointerLeave={() => setHoveredDirection((current) => (current === direction ? null : current))}
      onPointerCancel={() => setHoveredDirection(null)}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        void getCurrentWindow().startResizeDragging(direction);
      }}
    >
      <span
        className={cn(
          "border-foreground/50 cursor-inherit pointer-events-none transition-opacity",
          hoveredDirection === direction ? "opacity-100" : "opacity-0",
          direction.length <= 5 && "bg-foreground/50",
          grip,
        )}
      />
    </div>
  ));
}

/**
 * 窗口右上角的最小化，最大化，关闭等按钮（只在 Windows / Linux 上显示；置顶在菜单「视图 → 窗口置顶」里）
 */
function WindowButtons() {
  const [maximized] = useAtom(isWindowMaxsizedAtom);
  const [isClickThroughEnabled] = useAtom(isClickThroughEnabledAtom);
  return (
    <div className="flex h-full items-center rounded-full [&_button]:rounded-full">
      {isClickThroughEnabled && <span className="text-destructive font-bold">Alt + 2关闭窗口穿透点击</span>}
      <span className="flex h-full flex-row sm:gap-1">
        {/* 最小化 */}
        <Button
          className="size-4 sm:h-full sm:w-6"
          variant="ghost"
          size="icon"
          onClick={() => getCurrentWindow().minimize()}
        >
          <Minus strokeWidth={3} />
        </Button>
        {/* 最大化/还原 */}
        {maximized ? (
          <Button
            className="size-4 sm:h-full sm:w-6"
            variant="ghost"
            size="icon"
            onClick={() => getCurrentWindow().unmaximize()}
          >
            <Copy className="size-3" strokeWidth={3} />
          </Button>
        ) : (
          <Button
            className="size-4 sm:h-full sm:w-6"
            variant="ghost"
            size="icon"
            onClick={() => getCurrentWindow().maximize()}
          >
            <Square className="size-3" strokeWidth={4} />
          </Button>
        )}
        {/* 关闭 */}
        <Button
          className="size-4 sm:h-full sm:w-6"
          variant="ghost"
          size="icon"
          onClick={() => getCurrentWindow().close()}
        >
          <X strokeWidth={3} />
        </Button>
      </span>
    </div>
  );
}

export function Catch() {
  return <></>;
}
