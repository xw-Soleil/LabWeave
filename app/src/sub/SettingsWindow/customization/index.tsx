import {
  CircleGauge,
  LayoutPanelLeft,
  Menu as MenuIcon,
  Palette,
  PanelTop,
  SlidersHorizontal,
  Sparkles,
  Volume2,
} from "lucide-react";
import { cn } from "@/utils/cn";
import { useState } from "react";
import ThemesTab from "../themes";
import ContextMenuPage from "./context-menu";
import EffectsPage from "./effects";
import GlobalMenuPage from "./global-menu";
import PieMenuPage from "./pie-menu";
import QuickSettingsTab from "./quick-settings";
import SoundEffectsPage from "./sounds";
import WindowOpenModesPage from "./window-open-modes";

// 菜单栏是固定的（见 core/research/ResearchMenu.ts），快捷设置栏也不显示
const hiddenCategories: ReadonlySet<string> = new Set(["globalMenu", "quickSettings"]);

export default function CustomizationTab() {
  const [currentCategory, setCurrentCategory] = useState<keyof typeof categories>("themes");
  const visible = Object.entries(categories).filter(([key]) => !hiddenCategories.has(key));
  const Component = categories[currentCategory].component;
  return (
    <div className="flex h-full min-h-0">
      <nav className="border-border flex w-40 shrink-0 flex-col gap-px overflow-auto border-r p-2">
        {visible.map(([key, value]) => {
          const active = currentCategory === key;
          return (
            <button
              key={key}
              type="button"
              aria-current={active ? "page" : undefined}
              onClick={() => setCurrentCategory(key as keyof typeof categories)}
              className={cn(
                "focus-visible:ring-ring/50 flex h-7 w-full shrink-0 items-center gap-2 rounded-[6px] px-2 text-left text-[13px] outline-none focus-visible:ring-2",
                active ? "bg-primary/10 text-primary font-medium" : "text-foreground hover:bg-accent",
              )}
            >
              <value.icon className={cn("size-4 shrink-0", !active && "text-muted-foreground")} />
              <span className="min-w-0 flex-1 truncate">{value.name}</span>
            </button>
          );
        })}
      </nav>
      {/* 主题页自带左右两栏和内边距，其他页面要留边 */}
      <div className={cn("flex min-w-0 flex-1 flex-col overflow-auto", currentCategory !== "themes" && "p-4")}>
        <Component />
      </div>
    </div>
  );
}

const categories = {
  themes: {
    name: "主题",
    icon: Palette,
    component: ThemesTab,
  },
  effects: {
    name: "特效",
    icon: Sparkles,
    component: EffectsPage,
  },
  sounds: {
    name: "音效",
    icon: Volume2,
    component: SoundEffectsPage,
  },
  contextMenu: {
    name: "右键菜单",
    icon: MenuIcon,
    component: ContextMenuPage,
  },
  globalMenu: {
    name: "菜单栏",
    icon: PanelTop,
    component: GlobalMenuPage,
  },
  pieMenu: {
    name: "饼状菜单",
    icon: CircleGauge,
    component: PieMenuPage,
  },
  quickSettings: {
    name: "快捷设置",
    icon: SlidersHorizontal,
    component: QuickSettingsTab,
  },
  windowOpenModes: {
    name: "窗口打开方式",
    icon: LayoutPanelLeft,
    component: WindowOpenModesPage,
  },
};
