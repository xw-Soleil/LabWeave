import { Button } from "@/components/ui/button";
import { Settings } from "@/core/service/Settings";
import { cn } from "@/utils/cn";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Copy, Highlighter, Languages, X, Zap } from "lucide-react";
import { useEffect, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { translateText, type TranslateResult } from "./Translate";

/** 「选中即译」开着没有。开关在设置页「阅读与文献」里，翻译卡片上那个小按钮改的是同一项 */
export const autoTranslateEnabled = () => Settings.translateOnSelect;
// 这个开关以前只记在浏览器存储里（只有翻译卡片上能改），挪进设置；原来开着的照旧开着
const OLD_KEY = "labweave.autoTranslate";
if (globalThis.localStorage?.getItem(OLD_KEY)) {
  if (globalThis.localStorage.getItem(OLD_KEY) === "1") Settings.translateOnSelect = true;
  globalThis.localStorage.removeItem(OLD_KEY);
}

/** PDF、Markdown 里选中文字后，把选区的几行拼回一句话再送去翻译 */
export function selectionForTranslation(text: string) {
  return text
    .replace(/-\n(?=[a-z])/g, "")
    .replace(/\s*\n\s*/g, " ")
    .trim();
}

const KNOWN_ERRORS = ["translate.network", "translate.rateLimited", "translate.aiNotConfigured", "translate.failed"];

/**
 * 划词翻译卡片，照用户 Obsidian 文献库插件的样子：浮在选区下方，可以拖动；
 * 单词给音标和释义，句子给译文。
 */
export function TranslateCard({
  text,
  left,
  top,
  bounds,
  onClose,
  onHighlight,
}: {
  text: string;
  left: number;
  top: number;
  /** 卡片所在容器的大小，拖动和初始位置都不出界 */
  bounds: { width: number; height: number };
  onClose: () => void;
  /** 高亮选区，并把译文写进这条批注；选区已经没了就不给这个按钮 */
  onHighlight?: (translation: string) => void;
}) {
  const { t } = useTranslation("research");
  const [result, setResult] = useState<TranslateResult>();
  const [error, setError] = useState("");
  const [auto, setAuto] = Settings.use("translateOnSelect");
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  useEffect(() => {
    const controller = new AbortController();
    setResult(undefined);
    setError("");
    setOffset({ x: 0, y: 0 });
    translateText(text, { signal: controller.signal })
      .then(setResult)
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        const code = reason instanceof Error ? reason.message : String(reason);
        setError(
          KNOWN_ERRORS.includes(code) ? t(`translate.errors.${code.split(".")[1]}`) : t("translate.errors.failed"),
        );
      });
    return () => controller.abort();
  }, [text, t]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const width = Math.min(380, bounds.width - 16);
  const x = Math.max(8, Math.min(left - width / 2, bounds.width - width - 8)) + offset.x;
  const y = Math.max(8, Math.min(top, bounds.height - 120)) + offset.y;
  const drag = (event: ReactPointerEvent) => {
    if ((event.target as HTMLElement).closest("button")) return;
    event.preventDefault();
    const start = { x: event.clientX - offset.x, y: event.clientY - offset.y };
    const move = (next: PointerEvent) => setOffset({ x: next.clientX - start.x, y: next.clientY - start.y });
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const isWord = /^[A-Za-z][A-Za-z'-]{0,39}$/.test(text);

  return (
    <div
      role="dialog"
      aria-label={t("translate.title")}
      className="bg-popover text-popover-foreground absolute z-50 flex max-h-[60%] flex-col overflow-hidden rounded-xl border shadow-xl"
      style={{ left: x, top: y, width }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div
        className="flex h-9 shrink-0 cursor-grab items-center gap-1.5 border-b pr-1.5 pl-3 select-none"
        onPointerDown={drag}
      >
        <Languages className="text-muted-foreground size-3.5" />
        <span className="text-xs font-medium">{t("translate.title")}</span>
        {result && (
          <span className="text-muted-foreground text-[11px]">· {t(`translate.services.${result.service}`)}</span>
        )}
        <span className="flex-1" />
        <button
          type="button"
          aria-pressed={auto}
          title={t("translate.auto")}
          className={cn(
            "flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px]",
            auto ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-foreground/[0.05]",
          )}
          onClick={() => setAuto(!auto)}
        >
          <Zap className="size-3" />
          {t("translate.autoShort")}
        </button>
        <button
          type="button"
          aria-label={t("translate.close")}
          className="text-muted-foreground hover:text-foreground hover:bg-foreground/[0.05] flex size-6 items-center justify-center rounded-md"
          onClick={onClose}
        >
          <X className="size-3.5" />
        </button>
      </div>
      <div className="flex min-h-0 flex-col gap-2.5 overflow-y-auto px-3.5 py-3 select-text">
        <p
          className={cn(
            "text-muted-foreground line-clamp-3 text-xs leading-relaxed",
            isWord && "text-foreground text-sm font-semibold",
          )}
        >
          {text}
        </p>
        {error ? (
          <p role="alert" className="text-destructive text-[13px]">
            {error}
          </p>
        ) : !result ? (
          <div className="flex flex-col gap-1.5" aria-label={t("translate.loading")}>
            <span className="bg-foreground/[0.07] h-3 w-11/12 animate-pulse rounded" />
            <span className="bg-foreground/[0.07] h-3 w-3/4 animate-pulse rounded" />
          </div>
        ) : result.word ? (
          <div className="flex flex-col gap-1.5 text-[13px]">
            {result.word.phonetic && (
              <span className="text-muted-foreground font-mono text-xs">/{result.word.phonetic}/</span>
            )}
            {result.word.meanings.map((meaning) => (
              <p key={meaning.pos} className="leading-relaxed">
                <span className="text-muted-foreground mr-1.5 text-xs italic">{meaning.pos}</span>
                {meaning.terms.join("；")}
              </p>
            ))}
            {!result.word.meanings.length && <p className="leading-relaxed">{result.text}</p>}
          </div>
        ) : (
          <p className="text-[13.5px] leading-relaxed">{result.text}</p>
        )}
      </div>
      {result && (
        <div className="flex shrink-0 items-center gap-1 border-t px-2 py-1.5">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs"
            onClick={() =>
              void writeText(result.text)
                .then(() => toast.success(t("translate.copied")))
                .catch((reason) => toast.error(String(reason)))
            }
          >
            <Copy data-icon="inline-start" />
            {t("translate.copy")}
          </Button>
          {onHighlight && (
            <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => onHighlight(result.text)}>
              <Highlighter data-icon="inline-start" />
              {t("translate.highlightWithNote")}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
