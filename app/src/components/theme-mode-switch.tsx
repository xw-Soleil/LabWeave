import { Settings } from "@/core/service/Settings";
import { runThemeTransition } from "@/utils/themeTransition";
import { useRef } from "react";
import { flushSync } from "react-dom";
import { Moon, Sun } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

export default function ThemeModeSwitch() {
  const { t } = useTranslation("settings");
  const [themeMode] = Settings.use("themeMode");
  const isDark = themeMode === "dark";
  const switchRef = useRef<HTMLButtonElement>(null);
  const handleToggle = () => {
    const rect = switchRef.current?.getBoundingClientRect();
    const origin = rect
      ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
      : { x: innerWidth / 2, y: 0 };
    void runThemeTransition(origin, () => {
      flushSync(() => {
        Settings.themeMode = Settings.themeMode === "dark" ? "light" : "dark";
      });
    });
  };

  // 和其他工具按钮一样的幽灵图标按钮,不用带阴影的胶囊开关
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          ref={switchRef}
          aria-label={isDark ? "切换为浅色主题" : "切换为深色主题"}
          onClick={handleToggle}
          className="text-muted-foreground hover:bg-accent hover:text-foreground flex size-7 items-center justify-center rounded-[6px] transition-colors"
        >
          {isDark ? <Moon className="size-4" /> : <Sun className="size-4" />}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {isDark ? t("themeMode.options.dark") : t("themeMode.options.light")}
      </TooltipContent>
    </Tooltip>
  );
}
