import Markdown from "@/components/ui/markdown";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { readingThemeVars, resolveReadingTheme, type ReadingTheme } from "@/core/research/ReadingTheme";
import { Settings } from "@/core/service/Settings";
import { cn } from "@/utils/cn";
import { RotateCcw } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { useTranslation } from "react-i18next";

const PRESETS: ReadingTheme["preset"][] = ["default", "obsidian", "notion"];
const BODY_FONTS = {
  preset: "",
  sans: '-apple-system, BlinkMacSystemFont, system-ui, "PingFang SC", "Noto Sans CJK SC", sans-serif',
  inter: '"Inter", -apple-system, system-ui, "PingFang SC", sans-serif',
  serif: '"Songti SC", "Noto Serif CJK SC", Georgia, serif',
};
const CODE_FONTS = {
  preset: "",
  jetbrains: '"JetBrains Mono", ui-monospace, monospace',
  system: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
};
const fontId = <T extends Record<string, string>>(fonts: T, value?: string) =>
  (Object.keys(fonts).find((key) => fonts[key] === (value ?? "")) ?? "preset") as keyof T;

/** 设置 → 阅读与文献 → 阅读外观：选预设，再细调字号、行高、宽度和字体，下面实时预览 */
export default function ReadingThemePage() {
  const { t } = useTranslation("research");
  const [theme, setTheme] = Settings.use("readingTheme");
  const resolved = resolveReadingTheme(theme);
  const change = (patch: Partial<ReadingTheme>) => setTheme({ ...theme, ...patch });
  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">{t("readingTheme.presets")}</h3>
        <div className="grid grid-cols-3 gap-3">
          {PRESETS.map((preset) => {
            const sample = resolveReadingTheme({ preset });
            return (
              <button
                key={preset}
                type="button"
                aria-pressed={theme.preset === preset}
                className={cn(
                  "flex flex-col gap-2 rounded-xl border p-3 text-left transition-colors",
                  theme.preset === preset ? "border-primary ring-primary/30 ring-2" : "hover:bg-foreground/[0.03]",
                )}
                onClick={() => setTheme({ preset })}
              >
                <div
                  className="reading-view bg-background pointer-events-none h-24 overflow-hidden rounded-md border px-3 py-2"
                  style={{ ...(readingThemeVars(sample) as CSSProperties), fontSize: 11 }}
                >
                  <div className="markdown-body">
                    <h2 style={{ marginTop: 0 }}>{t("readingTheme.sampleHeading")}</h2>
                    <p>{t("readingTheme.sampleText")}</p>
                  </div>
                </div>
                <span className="text-sm font-medium">
                  {t(`readingTheme.names.${preset}`)}
                  {preset === "obsidian" && (
                    <span className="text-primary ml-1.5 text-xs font-normal">{t("readingTheme.recommended")}</span>
                  )}
                </span>
                <span className="text-muted-foreground text-xs">{t(`readingTheme.descriptions.${preset}`)}</span>
              </button>
            );
          })}
        </div>
      </section>
      <section className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium">{t("readingTheme.adjust")}</h3>
          <Button variant="ghost" size="sm" onClick={() => setTheme({ preset: theme.preset })}>
            <RotateCcw data-icon="inline-start" />
            {t("readingTheme.reset")}
          </Button>
        </div>
        <Row label={t("readingTheme.fontSize")} value={`${resolved.fontSize}px`}>
          <Slider
            min={13}
            max={20}
            step={0.5}
            value={[resolved.fontSize]}
            onValueChange={([fontSize]) => change({ fontSize })}
          />
        </Row>
        <Row label={t("readingTheme.lineHeight")} value={resolved.lineHeight.toFixed(2)}>
          <Slider
            min={1.3}
            max={2}
            step={0.05}
            value={[resolved.lineHeight]}
            onValueChange={([lineHeight]) => change({ lineHeight })}
          />
        </Row>
        <Row label={t("readingTheme.lineWidth")} value={`${resolved.lineWidth}rem`}>
          <Slider
            min={34}
            max={72}
            step={1}
            value={[resolved.lineWidth]}
            onValueChange={([lineWidth]) => change({ lineWidth })}
          />
        </Row>
        <Row label={t("readingTheme.fontBody")}>
          <Select
            value={fontId(BODY_FONTS, theme.fontBody) as string}
            onValueChange={(id) => change({ fontBody: BODY_FONTS[id as keyof typeof BODY_FONTS] || undefined })}
          >
            <SelectTrigger className="w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.keys(BODY_FONTS).map((id) => (
                <SelectItem key={id} value={id}>
                  {t(`readingTheme.fonts.${id}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Row>
        <Row label={t("readingTheme.fontCode")}>
          <Select
            value={fontId(CODE_FONTS, theme.fontCode) as string}
            onValueChange={(id) => change({ fontCode: CODE_FONTS[id as keyof typeof CODE_FONTS] || undefined })}
          >
            <SelectTrigger className="w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.keys(CODE_FONTS).map((id) => (
                <SelectItem key={id} value={id}>
                  {t(`readingTheme.fonts.${id}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Row>
      </section>
      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">{t("readingTheme.preview")}</h3>
        <div className="bg-background max-h-96 overflow-y-auto rounded-xl border px-8 py-6">
          <article className="reading-view" style={readingThemeVars(resolved) as CSSProperties}>
            <h1 className="reading-title">{t("readingTheme.previewTitle")}</h1>
            <Markdown source={t("readingTheme.previewBody")} />
          </article>
        </div>
      </section>
    </div>
  );
}

function Row({ label, value, children }: { label: string; value?: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[8rem_minmax(0,1fr)_4rem] items-center gap-4 text-sm">
      <span className="text-muted-foreground">{label}</span>
      {children}
      <span className="text-muted-foreground text-right text-xs tabular-nums">{value}</span>
    </div>
  );
}
