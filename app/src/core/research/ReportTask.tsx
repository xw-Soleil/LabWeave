import { Button } from "@/components/ui/button";
import { store } from "@/state";
import { cn } from "@/utils/cn";
import { open as openWithSystem } from "@tauri-apps/plugin-shell";
import i18next from "i18next";
import { atom, useAtomValue } from "jotai";
import { Check, FileText, FolderOpen, LoaderCircle, Presentation, RefreshCw, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { retryResearchReportExport, type ReportProgress, type ResearchReportResult } from "./ResearchReport";

/*
 * 汇报在后台生成：任务的状态，和窗口左下角的小条（进度、取消、打开报告和 PPT、导出失败后重新导出）。
 * 任务状态和小条出自同伴 cleverfool-rnh 的 PR（xw-Soleil/LabWeave 第 1 号）里的 ResearchProgressDialog.tsx；
 * 他那个选周、填重点的对话框没有搬，材料在阶段小结整理时就挑好了（StageReviewTray.tsx）。
 */

export interface ReportTask {
  root: string;
  /** 节点的名字：2026-11-21 组会 */
  title: string;
  state: "running" | "done" | "failed" | "cancelled";
  progress: ReportProgress;
  result?: ResearchReportResult;
  error?: string;
  /** 草稿已经存好、只是导出没成时有：凭它重新导出，不用再调 AI */
  retryJobId?: string;
  cancel: () => void;
}

export const reportTaskAtom = atom<ReportTask | null>(null);

/** 是不是有一份汇报正在生成（同一时间只生成一份） */
export const reportBusy = () => store.get(reportTaskAtom)?.state === "running";

/** 错误代码换成给人看的话：researchReport.xxx、snapshot.xxx 有专门的文案，别的原样给 */
export function reportErrorText(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  const [code, ...detail] = message.split(": ");
  const [group, name, ...rest] = code.split(".");
  const section = group === "researchReport" ? "report" : group === "snapshot" ? "snapshot" : undefined;
  const key = section && name && rest.length === 0 ? `${section}.errors.${name}` : undefined;
  return key && i18next.exists(key, { ns: "research" })
    ? `${i18next.t(key, { ns: "research" })}${detail.length ? ` ${detail.join(": ")}` : ""}`
    : message;
}

const fail = (cause: unknown) => void toast.error(reportErrorText(cause));

async function openReport(path: string) {
  const { openDocumentFile } = await import("./DocumentTab");
  await openDocumentFile(path);
}

/** 跑完以后：报告在标签页里打开 */
function finish(
  update: (patch: Partial<ReportTask>) => void,
  signal: AbortSignal,
  onDone?: (r: ResearchReportResult) => void,
) {
  return (result: ResearchReportResult) => {
    if (signal.aborted) {
      update({ state: "cancelled" });
      return;
    }
    update({ state: "done", result, error: undefined, retryJobId: undefined });
    onDone?.(result);
    void openReport(result.markdownPath).catch(fail);
  };
}

/**
 * 开始生成一份汇报。run 里做全部的事（取材料、调 AI、导出），通过 onProgress 报进度。
 * 已经有一份在生成时返回 false，什么都不做。
 */
export function startReportTask(options: {
  root: string;
  title: string;
  run: (signal: AbortSignal, onProgress: (progress: ReportProgress) => void) => Promise<ResearchReportResult>;
  /** 生成好了（没被取消）时调一次 */
  onDone?: (result: ResearchReportResult) => void;
}): boolean {
  if (reportBusy()) return false;
  const controller = new AbortController();
  const cancel = () => controller.abort();
  const update = (patch: Partial<ReportTask>) => {
    const current = store.get(reportTaskAtom);
    // 这一份已经被关掉、或者后面又开了新的一份：不再动它
    if (current?.cancel === cancel) store.set(reportTaskAtom, { ...current, ...patch });
  };
  store.set(reportTaskAtom, {
    root: options.root,
    title: options.title,
    state: "running",
    progress: { stage: "collecting" },
    cancel,
  });
  void options
    .run(controller.signal, (progress) => update({ progress }))
    .then(finish(update, controller.signal, options.onDone))
    .catch((cause: unknown) =>
      update(
        controller.signal.aborted
          ? { state: "cancelled" }
          : { state: "failed", error: reportErrorText(cause), retryJobId: (cause as { jobId?: string })?.jobId },
      ),
    );
  return true;
}

/** 导出没成的那一份，拿存好的草稿再导出一遍 */
export function retryReportTask(task: ReportTask): boolean {
  if (!task.retryJobId || reportBusy()) return false;
  const controller = new AbortController();
  const cancel = () => controller.abort();
  const update = (patch: Partial<ReportTask>) => {
    const current = store.get(reportTaskAtom);
    if (current?.cancel === cancel) store.set(reportTaskAtom, { ...current, ...patch });
  };
  store.set(reportTaskAtom, { ...task, state: "running", error: undefined, progress: { stage: "exporting" }, cancel });
  void retryResearchReportExport(task.root, task.retryJobId, controller.signal)
    .then(finish(update, controller.signal))
    .catch((cause: unknown) =>
      update(controller.signal.aborted ? { state: "cancelled" } : { state: "failed", error: reportErrorText(cause) }),
    );
  return true;
}

const openOutside = (path: string) => void openWithSystem(path).catch(fail);

/** 窗口左下角的小条，在白板状态条的上面一行（Zotero 同步的小条在底部正中，两个互不挡着） */
export function ReportTaskBar() {
  const task = useAtomValue(reportTaskAtom, { store });
  const { t: translate } = useTranslation("research");
  if (!task) return null;
  const t = (key: string, options?: Record<string, unknown>) =>
    translate(`report.${key}`, { ...options, interpolation: { escapeValue: false } });
  const running = task.state === "running";
  const text = running
    ? t(`stage.${task.progress.stage}`)
    : task.state === "failed"
      ? t("task.failed", { error: task.error ?? "" })
      : t(`task.${task.state}`, { title: task.title });
  const warnings = task.result?.warnings.length ?? 0;
  const small = "h-6 gap-1 rounded-full px-2 text-xs [&_svg]:size-3.5";
  return (
    <div
      role="status"
      className={cn(
        // 靠左、在白板状态条的上面一行：正中会压住状态条的缩放按钮，窗口窄时还会伸到右边的 AI 面板上
        "bg-popover text-popover-foreground fixed bottom-12 left-16 z-50 flex min-h-8 max-w-[min(44rem,calc(100%-5rem))] items-center gap-1.5 rounded-full border py-0.5 pr-1 pl-3 text-xs shadow-md",
      )}
    >
      {running ? (
        <LoaderCircle className="size-3.5 shrink-0 animate-spin" aria-hidden="true" />
      ) : (
        task.state === "done" && <Check className="size-3.5 shrink-0" aria-hidden="true" />
      )}
      <span className="min-w-0 truncate" title={text}>
        {text}
      </span>
      {running && (
        <Button size="sm" variant="ghost" className={small} onClick={task.cancel}>
          {t("cancel")}
        </Button>
      )}
      {task.state === "done" && task.result && (
        <>
          {warnings > 0 && (
            <span className="text-muted-foreground shrink-0" title={task.result.warnings.join("\n")}>
              {t("warnings", { count: warnings })}
            </span>
          )}
          <Button
            size="sm"
            variant="ghost"
            className={small}
            onClick={() => void openReport(task.result!.markdownPath).catch(fail)}
          >
            <FileText />
            {t("openReport")}
          </Button>
          <Button size="sm" variant="ghost" className={small} onClick={() => openOutside(task.result!.pptxPath)}>
            <Presentation />
            {t("openSlides")}
          </Button>
          <Button size="sm" variant="ghost" className={small} onClick={() => openOutside(task.result!.directory)}>
            <FolderOpen />
            {t("openFolder")}
          </Button>
        </>
      )}
      {task.state === "failed" && task.retryJobId && (
        <Button size="sm" variant="ghost" className={small} onClick={() => retryReportTask(task)}>
          <RefreshCw />
          {t("retryExport")}
        </Button>
      )}
      {!running && (
        <Button
          size="icon"
          variant="ghost"
          className="size-6 shrink-0 rounded-full"
          aria-label={t("close")}
          onClick={() => store.set(reportTaskAtom, null)}
        >
          <X />
        </Button>
      )}
    </div>
  );
}
