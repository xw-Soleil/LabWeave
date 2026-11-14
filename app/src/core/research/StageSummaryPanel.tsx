import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import type { Project } from "@/core/Project";
import { Settings } from "@/core/service/Settings";
import { open as chooseFolder } from "@tauri-apps/plugin-dialog";
import { open as openWithSystem } from "@tauri-apps/plugin-shell";
import i18next from "i18next";
import { FileText, LoaderCircle, Presentation } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { localTime } from "./ProjectRecord";
import {
  cardImage,
  exportSlides,
  loadSummaryStart,
  looksLikeReport,
  parseSlidesRequest,
  parseSummaryRequest,
  progressFolder,
  requestSlides,
  saveStageReport,
  startStageSummary,
  type SummaryRequest,
} from "./StageSummary";

/* 「阶段小结」的界面：竖栏按钮弹出来的那一小块（选范围、开始写），和 AI 回答下面的两个按钮。 */

const text = (key: string, options?: Record<string, unknown>) =>
  i18next.t(`stageSummary.${key}`, { ns: "research", interpolation: { escapeValue: false }, ...options });

/** 错误代码换成给人看的话：stageSummary.xxx、snapshot.xxx 有专门的文案，别的原样给 */
function errorText(error: unknown): string {
  const code = error instanceof Error ? error.message : String(error);
  const [group, name] = code.split(".");
  if ((group === "stageSummary" || group === "snapshot") && name && code.split(".").length === 2) {
    return i18next.t(`${group}.errors.${name}`, { ns: "research" });
  }
  return code;
}

const fail = (error: unknown) => void toast.error(text("failed", { error: errorText(error) }));
const fileName = (path: string) => path.replace(/\\/g, "/").split("/").pop() ?? path;
const day = (time: string) => time.slice(0, 10);
const shownTime = (time: string) => `${time.slice(0, 10)} ${time.slice(11, 16)}`;

/** 竖栏「阶段小结」按钮弹出来的内容：看默认范围、改日期、开始 */
export function StageSummaryForm({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation("research");
  const [start, setStart] = useState<Awaited<ReturnType<typeof loadSummaryStart>>>();
  const [since, setSince] = useState("");
  const [until, setUntil] = useState(() => day(localTime(new Date())));
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    let disposed = false;
    loadSummaryStart().then((loaded) => {
      if (disposed) return;
      setStart(loaded);
      setSince(day(loaded.since));
    }, fail);
    return () => {
      disposed = true;
    };
  }, []);

  const begin = async () => {
    if (!start || !since || !until) return;
    if (since > until) {
      toast.error(t("stageSummary.badRange"));
      return;
    }
    setStarting(true);
    try {
      const now = localTime(new Date());
      await startStageSummary({
        // 日期没动过就用精确到秒的时间：从上一次小结写到的那一刻接着算，到此刻为止
        since: since === day(start.since) ? start.since : since,
        until: until === day(now) ? now : until,
      });
      onDone();
    } catch (error) {
      fail(error);
    } finally {
      setStarting(false);
    }
  };

  const dateInput = "border-input bg-background h-7 min-w-0 flex-1 rounded-[6px] border px-2 text-[13px]";
  return (
    <div className="flex flex-col gap-2.5 px-1 text-[13px]">
      <div className="font-semibold">{t("stageSummary.title")}</div>
      <div className="text-muted-foreground text-[12px]">
        {!start
          ? t("stageSummary.loading")
          : start.lastSummary
            ? t("stageSummary.lastSummary", { time: shownTime(start.lastSummary) })
            : start.startedAt
              ? t("stageSummary.firstTime", { time: shownTime(start.startedAt) })
              : t("stageSummary.noRecords")}
      </div>
      <label className="flex items-center gap-2">
        <span className="w-5 shrink-0">{t("stageSummary.from")}</span>
        <input
          type="date"
          className={dateInput}
          value={since}
          max={until}
          onChange={(event) => setSince(event.target.value)}
        />
      </label>
      <label className="flex items-center gap-2">
        <span className="w-5 shrink-0">{t("stageSummary.to")}</span>
        <input
          type="date"
          className={dateInput}
          value={until}
          min={since}
          onChange={(event) => setUntil(event.target.value)}
        />
      </label>
      <div className="text-muted-foreground text-[12px]">{t("stageSummary.hint")}</div>
      <Button size="sm" className="h-7 rounded-[6px] text-[13px]" disabled={!start || starting} onClick={begin}>
        {starting && <LoaderCircle className="animate-spin" />}
        {t(starting ? "stageSummary.starting" : "stageSummary.start")}
      </Button>
    </div>
  );
}

/** 第一次存报告时问一次放哪；选过以后不再问（设置里能改）。用户点了「先不存」返回 false */
async function confirmProgressFolder(): Promise<boolean> {
  if (Settings.progressFolderPath) return true;
  const fallback = progressFolder();
  const answer = await Dialog.buttons(text("folderTitle"), text("folderDescription", { path: fallback }), [
    { id: "cancel", label: text("cancel"), variant: "ghost" },
    { id: "choose", label: text("chooseFolder"), variant: "outline" },
    { id: "default", label: text("useDefault") },
  ]);
  if (answer === "default") {
    Settings.progressFolderPath = fallback;
    return true;
  }
  if (answer !== "choose") return false;
  const picked = await chooseFolder({ directory: true, title: text("chooseTitle") });
  if (typeof picked !== "string") return false;
  Settings.progressFolderPath = picked;
  return true;
}

/** 把报告存进「我的进展」。返回文件路径；用户没选好放哪时返回 undefined */
async function saveReport(reply: string, request: SummaryRequest): Promise<string | undefined> {
  if (!(await confirmProgressFolder())) return undefined;
  return saveStageReport(reply, request);
}

async function saveReportAndOpen(reply: string, request: SummaryRequest) {
  const path = await saveReport(reply, request);
  if (!path) return;
  const { openDocumentFile } = await import("./DocumentTab");
  await openDocumentFile(path);
  toast.success(text("saved", { name: fileName(path) }));
}

async function makeSlides(reply: string, report: string, project: Project) {
  const path = await exportSlides(reply, report, (card) => cardImage(project, card));
  toast.success(text("slidesSaved", { name: fileName(path) }), {
    action: { label: text("open"), onClick: () => void openWithSystem(path).catch(fail) },
    duration: 15000,
  });
}

/**
 * AI 刚回答完时调：这条回答要是阶段小结的报告，就存下来并在标签页里打开；要是 PPT 的提纲，就转成文件。
 * userText 是它前面那条用户消息。
 */
export function stageReplyFinished(userText: string, reply: string, project: Project) {
  const summary = parseSummaryRequest(userText);
  // 中途被停掉、报了错的回答不像一份报告，不自动存；用户可以自己点按钮
  if (summary && looksLikeReport(reply)) void saveReportAndOpen(reply, summary).catch(fail);
  const slides = summary ? undefined : parseSlidesRequest(userText);
  if (slides) void makeSlides(reply, slides.report, project).catch(fail);
}

/** userText 是不是「阶段小结」或「出 PPT」的请求（它后面那条回答下面要放按钮） */
export const isStageRequest = (userText: string) => !!(parseSummaryRequest(userText) ?? parseSlidesRequest(userText));

/** 放在 AI 回答下面：报告下面是「存进我的进展」「出 PPT」，提纲下面是「转成 PPT 文件」 */
export function StageReplyActions({ userText, reply, project }: { userText: string; reply: string; project: Project }) {
  const { t } = useTranslation("research");
  const [busy, setBusy] = useState(false);
  const summary = parseSummaryRequest(userText);
  const slides = summary ? undefined : parseSlidesRequest(userText);
  if (!reply || (!summary && !slides)) return null;

  const run = (task: () => Promise<unknown>) => () => {
    setBusy(true);
    task()
      .catch(fail)
      .finally(() => setBusy(false));
  };
  const button = "h-6 gap-1 rounded-[6px] px-2 text-[12px]";
  return (
    <div className="flex flex-wrap items-center gap-1.5 select-none [&_*]:select-none">
      {busy && <LoaderCircle className="text-muted-foreground size-3.5 animate-spin" />}
      {summary ? (
        <>
          <Button
            size="sm"
            variant="outline"
            className={button}
            disabled={busy}
            onClick={run(() => saveReportAndOpen(reply, summary))}
          >
            <FileText className="size-3.5" />
            {t("stageSummary.save")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            className={button}
            disabled={busy}
            onClick={run(async () => {
              // PPT 放在报告旁边，所以先要有报告文件；已经存过的不会再存一份
              const report = await saveReport(reply, summary);
              if (report) requestSlides(report);
            })}
          >
            <Presentation className="size-3.5" />
            {t("stageSummary.slides")}
          </Button>
        </>
      ) : (
        <Button
          size="sm"
          variant="outline"
          className={button}
          disabled={busy}
          onClick={run(() => makeSlides(reply, slides!.report, project))}
        >
          <Presentation className="size-3.5" />
          {t("stageSummary.makeSlides")}
        </Button>
      )}
    </div>
  );
}
