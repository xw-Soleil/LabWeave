import { cn } from "@/utils/cn";
import { CircleGauge, Menu as MenuIcon } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import ContextMenuPage from "./context-menu";
import PieMenuPage from "./pie-menu";

// 主题、画布动画、音效在「设置 → 外观」里；顶部菜单栏是固定的（见 core/research/ResearchMenu.ts）
const pages = {
  contextMenu: { icon: MenuIcon, component: ContextMenuPage },
  pieMenu: { icon: CircleGauge, component: PieMenuPage },
};

/** 设置弹窗的「菜单」页：编辑右键菜单和饼状菜单 */
export default function MenusTab() {
  const { t } = useTranslation("research");
  const [current, setCurrent] = useState<keyof typeof pages>("contextMenu");
  const Component = pages[current].component;
  return (
    <div className="flex h-full min-h-0">
      <nav className="border-border flex w-40 shrink-0 flex-col gap-px overflow-auto border-r p-2">
        {(Object.keys(pages) as (keyof typeof pages)[]).map((key) => {
          const active = current === key;
          const Icon = pages[key].icon;
          return (
            <button
              key={key}
              type="button"
              aria-current={active ? "page" : undefined}
              onClick={() => setCurrent(key)}
              className={cn(
                "focus-visible:ring-ring/50 flex h-7 w-full shrink-0 items-center gap-2 rounded-[6px] px-2 text-left text-[13px] outline-none focus-visible:ring-2",
                active ? "bg-primary/10 text-primary font-medium" : "text-foreground hover:bg-accent",
              )}
            >
              <Icon className={cn("size-4 shrink-0", !active && "text-muted-foreground")} />
              <span className="min-w-0 flex-1 truncate">{t(`settings.menus.${key}`)}</span>
            </button>
          );
        })}
      </nav>
      <div className="flex min-w-0 flex-1 flex-col overflow-auto p-4">
        <Component />
      </div>
    </div>
  );
}
