import { OverlayHost } from "@/components/overlay-host";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Settings } from "@/core/service/Settings";
import { store } from "@/state";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import { atom, useAtomValue } from "jotai";
import { Check, FileText, FolderOpen, LoaderCircle, Presentation, RefreshCw, X } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import i18next from "i18next";
import { toast } from "sonner";
import { ResearchFolder } from "./ResearchFolder";
import type { ReportProgress, ResearchReportResult } from "./ResearchHistoryTypes";
import { generateWeeklyResearchReport, listResearchReportDrafts, retryResearchReportExport } from "./ResearchReport";
import { listWeeklyRecords, weekStartDate, WEEKLY_PROGRESS_CHANGED_EVENT, type WeeklyRecord } from "./WeeklyProgress";

type Translate = (key: string, options?: Record<string, unknown>) => string;

function messageOf(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  const [code, ...detail] = message.split(": ");
  const key = code.startsWith("researchReport.")
    ? `progress.reportErrors.${code.slice("researchReport.".length)}`
    : code.startsWith("weekly.")
      ? `weekly.errors.${code.slice("weekly.".length)}`
      : code.startsWith("research.")
        ? code.slice("research.".length)
        : `progress.errors.${code}`;
  return i18next.exists(key, { ns: "research" })
    ? `${i18next.t(key, { ns: "research" })}${detail.length ? ` ${detail.join(": ")}` : ""}`
    : message;
}

export interface ResearchReportTask {
  root: string;
  weekStart?: string;
  state: "running" | "done" | "failed" | "cancelled";
  progress: ReportProgress;
  result?: ResearchReportResult;
  error?: string;
  retryJobId?: string;
  cancel: () => void;
}

export const researchReportTaskAtom = atom<ResearchReportTask | null>(null);

export function startResearchReportTask(options: { root: string; weekStart: string; instructions?: string }): boolean {
  if (store.get(researchReportTaskAtom)?.state === "running") return false;
  const controller = new AbortController();
  const cancel = () => controller.abort();
  const update = (patch: Partial<ResearchReportTask>) => {
    const current = store.get(researchReportTaskAtom);
    if (current?.cancel === cancel) store.set(researchReportTaskAtom, { ...current, ...patch });
  };
  store.set(researchReportTaskAtom, {
    root: options.root,
    weekStart: options.weekStart,
    state: "running",
    progress: { stage: "collecting" },
    cancel,
  });
  void generateWeeklyResearchReport({
    ...options,
    signal: controller.signal,
    onProgress: (progress) => update({ progress }),
  })
    .then((result) => update(controller.signal.aborted ? { state: "cancelled" } : { state: "done", result }))
    .catch((cause: unknown) =>
      update(
        controller.signal.aborted
          ? { state: "cancelled" }
          : { state: "failed", error: messageOf(cause), retryJobId: (cause as { jobId?: string })?.jobId },
      ),
    );
  return true;
}

export function retryResearchReportTask(task: ResearchReportTask): boolean {
  if (!task.retryJobId || store.get(researchReportTaskAtom)?.state === "running") return false;
  const controller = new AbortController();
  const cancel = () => controller.abort();
  store.set(researchReportTaskAtom, {
    ...task,
    state: "running",
    error: undefined,
    progress: { stage: "exporting" },
    cancel,
  });
  const update = (patch: Partial<ResearchReportTask>) => {
    const current = store.get(researchReportTaskAtom);
    if (current?.cancel === cancel) store.set(researchReportTaskAtom, { ...current, ...patch });
  };
  void retryResearchReportExport(task.root, task.retryJobId, controller.signal)
    .then((result) => update(controller.signal.aborted ? { state: "cancelled" } : { state: "done", result }))
    .catch((cause: unknown) =>
      update(controller.signal.aborted ? { state: "cancelled" } : { state: "failed", error: messageOf(cause) }),
    );
  return true;
}

function openOutput(path: string) {
  void shellOpen(path).catch((cause: unknown) => toast.error(messageOf(cause)));
}

function ReportTaskView({ task, t }: { task: ResearchReportTask; t: Translate }) {
  return (
    <div className="border-border/70 rounded-xl border p-4" role="status" aria-live="polite">
      <div className="flex items-center gap-2 text-sm font-medium">
        {task.state === "running" ? (
          <LoaderCircle className="size-4 animate-spin" />
        ) : task.state === "done" ? (
          <Check className="size-4" />
        ) : (
          <FileText className="size-4" />
        )}
        {task.state === "running" ? t(`stage.${task.progress.stage}`) : t(`task.${task.state}`)}
        {task.state === "running" && (
          <Button className="ml-auto h-7 px-2 text-xs" variant="ghost" onClick={task.cancel}>
            {t("cancel")}
          </Button>
        )}
      </div>
      {task.progress.message && task.state === "running" && (
        <p className="text-muted-foreground mt-2 text-xs">{task.progress.message}</p>
      )}
      {task.state === "running" && <p className="text-muted-foreground mt-2 text-xs">{t("backgroundHint")}</p>}
      {task.error && <p className="text-destructive mt-2 text-sm break-words">{task.error}</p>}
      {task.state !== "running" && task.retryJobId && !task.result && (
        <Button size="sm" variant="outline" className="mt-3" onClick={() => retryResearchReportTask(task)}>
          <RefreshCw />
          {t("retryExport")}
        </Button>
      )}
      {task.result && (
        <div className="mt-3 space-y-3">
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => openOutput(task.result!.pptxPath)}>
              <Presentation />
              {t("openPpt")}
            </Button>
            <Button size="sm" variant="outline" onClick={() => openOutput(task.result!.markdownPath)}>
              <FileText />
              {t("openReport")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => openOutput(task.result!.directory)}>
              <FolderOpen />
              {t("openFolder")}
            </Button>
          </div>
          {task.result.warnings.length > 0 && (
            <details className="border-border/70 bg-muted/30 rounded-lg border px-3 py-2 text-xs">
              <summary className="text-muted-foreground cursor-pointer">
                {t("warnings", { count: task.result.warnings.length })}
              </summary>
              <ul className="mt-2 list-inside list-disc space-y-1 break-words">
                {task.result.warnings.map((warning, index) => (
                  <li key={index}>{warning}</li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

export function ResearchProgressDialog({
  root,
  initialWeek,
  onClose,
}: {
  root: string;
  initialWeek?: string;
  onClose: () => void;
}) {
  const { t: translate } = useTranslation("research");
  const t: Translate = (key, options) => translate(`progress.${key}`, options);
  const w: Translate = (key, options) => translate(`weekly.${key}`, options);
  const formId = useId();
  const task = useAtomValue(researchReportTaskAtom, { store });
  const running = task?.state === "running";
  const thisTask = task?.root === root ? task : null;
  const [weeks, setWeeks] = useState<WeeklyRecord[]>([]);
  const [week, setWeek] = useState(initialWeek ?? weekStartDate());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [instructions, setInstructions] = useState("");
  const [drafts, setDrafts] = useState<Awaited<ReturnType<typeof listResearchReportDrafts>>["entries"]>([]);
  const [draftWarnings, setDraftWarnings] = useState(0);
  const [draftError, setDraftError] = useState("");

  useEffect(
    () =>
      Settings.watch("researchFolderPath", () => {
        if (ResearchFolder.getRoot() !== root) onClose();
      }),
    [root, onClose],
  );

  useEffect(() => {
    let active = true;
    let request = 0;
    const refresh = () => {
      const id = ++request;
      setLoading(true);
      void listWeeklyRecords(root)
        .then((records) => {
          if (!active || id !== request) return;
          setWeeks(records);
          setWeek((current) =>
            records.some((record) => record.weekStart === current) ? current : (records[0]?.weekStart ?? ""),
          );
          setError("");
        })
        .catch((cause: unknown) => {
          if (active && id === request) {
            setWeeks([]);
            setError(messageOf(cause));
          }
        })
        .finally(() => {
          if (active && id === request) setLoading(false);
        });
    };
    refresh();
    window.addEventListener(WEEKLY_PROGRESS_CHANGED_EVENT, refresh);
    return () => {
      active = false;
      window.removeEventListener(WEEKLY_PROGRESS_CHANGED_EVENT, refresh);
    };
  }, [root]);

  useEffect(() => {
    let active = true;
    void listResearchReportDrafts(root)
      .then(({ entries, warnings }) => {
        if (!active) return;
        setDrafts(entries);
        setDraftWarnings(warnings.length);
        setDraftError("");
      })
      .catch((cause: unknown) => {
        if (active) {
          setDrafts([]);
          setDraftError(messageOf(cause));
        }
      });
    return () => {
      active = false;
    };
  }, [root, thisTask?.state]);

  const editWeek = () => {
    onClose();
    void import("./WeeklyProgressPanel")
      .then(({ openWeeklyProgressDialog }) => openWeeklyProgressDialog(week || undefined))
      .catch((cause: unknown) => toast.error(messageOf(cause)));
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="flex max-h-[82vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-[min(42rem,calc(100%-2rem))]">
        <DialogHeader className="px-5 pt-5 pb-4">
          <DialogTitle className="flex items-center gap-2 text-base">
            <Presentation className="size-4" />
            {w("reportTitle")}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {root.replace(/\\/g, "/").split("/").filter(Boolean).pop()} · {w("linkedScope")}
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 pb-5">
          <p className="text-muted-foreground text-xs leading-relaxed">{w("reportHint")}</p>
          {error && (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          )}
          <div className="space-y-1.5">
            <label htmlFor={`${formId}-week`} className="text-xs font-medium">
              {w("reportWeek")}
            </label>
            <div className="flex items-center gap-2">
              <select
                id={`${formId}-week`}
                className="border-input bg-background focus-visible:ring-ring/50 h-9 min-w-0 flex-1 rounded-md border px-2 text-sm outline-none focus-visible:ring-2 disabled:opacity-50"
                value={week}
                disabled={running || loading || !weeks.length}
                onChange={(event) => setWeek(event.target.value)}
              >
                {!weeks.length && <option value="">{loading ? t("loading") : w("noReportWeeks")}</option>}
                {weeks.map((record) => (
                  <option key={record.weekStart} value={record.weekStart}>
                    {record.weekStart}
                  </option>
                ))}
              </select>
              <Button size="sm" variant="outline" onClick={editWeek}>
                {w("editWeek")}
              </Button>
            </div>
          </div>
          <div className="space-y-1.5">
            <label htmlFor={`${formId}-instructions`} className="text-xs font-medium">
              {t("instructions")}
            </label>
            <Textarea
              id={`${formId}-instructions`}
              className="min-h-24 resize-y text-sm"
              value={instructions}
              maxLength={4000}
              disabled={running}
              placeholder={t("instructionsPlaceholder")}
              onChange={(event) => setInstructions(event.target.value)}
            />
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button
              size="sm"
              disabled={running || loading || !weeks.some((record) => record.weekStart === week)}
              onClick={() =>
                startResearchReportTask({ root, weekStart: week, instructions: instructions.trim() || undefined })
              }
            >
              <Presentation />
              {w("reportGenerate")}
            </Button>
            <span className="text-muted-foreground text-xs">{t("outputHint")}</span>
          </div>
          {running && !thisTask && (
            <p role="status" className="text-muted-foreground text-xs">
              {t("otherProjectBusy")}
            </p>
          )}
          {thisTask && <ReportTaskView task={thisTask} t={t} />}
          {draftWarnings > 0 && (
            <p role="alert" className="text-muted-foreground text-xs leading-relaxed">
              {t("draftsSkipped", { count: draftWarnings })}
            </p>
          )}
          {(drafts.length > 0 || draftError) && (
            <details className="border-border/70 rounded-lg border">
              <summary className="text-muted-foreground cursor-pointer px-3 py-2.5 text-xs">
                {t("savedDrafts", { count: drafts.length })}
              </summary>
              <div className="border-t px-3 py-2">
                <p className="text-muted-foreground mb-2 text-xs leading-relaxed">{t("draftsHint")}</p>
                {draftError && (
                  <p role="alert" className="text-destructive py-2 text-xs">
                    {draftError}
                  </p>
                )}
                {drafts.map((draft) => (
                  <div key={draft.jobId} className="flex items-center gap-2 py-2 text-xs">
                    <FileText className="text-muted-foreground size-3.5 shrink-0" />
                    <span className="min-w-0 flex-1 truncate" title={draft.title}>
                      {draft.title}
                    </span>
                    <span className="text-muted-foreground shrink-0 tabular-nums">
                      {new Date(draft.createdAt).toLocaleDateString()}
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={running}
                      className="h-7 px-2 text-xs"
                      onClick={() =>
                        retryResearchReportTask({
                          root,
                          state: "failed",
                          progress: { stage: "exporting" },
                          retryJobId: draft.jobId,
                          cancel: () => undefined,
                        })
                      }
                    >
                      {t("reexport")}
                    </Button>
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>
        <div className="border-border/60 flex items-center justify-between gap-3 border-t px-5 py-3">
          <span className="text-muted-foreground text-[11px]">{t("footerHint")}</span>
          <Button variant="ghost" size="sm" className="h-7 px-3 text-xs" onClick={onClose}>
            {t("close")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

let openedOverlay: string | undefined;
export function openResearchProgressDialog(initialTab: "history" | "report" = "report", weekStart?: string): void {
  if (initialTab === "history") {
    void import("./WeeklyProgressPanel")
      .then(({ openWeeklyProgressDialog }) => openWeeklyProgressDialog(weekStart))
      .catch((cause: unknown) => toast.error(messageOf(cause)));
    return;
  }
  const root = ResearchFolder.getRoot();
  if (!root) {
    toast.warning(i18next.t("progress.errors.noRoot", { ns: "research" }));
    return;
  }
  if (openedOverlay) OverlayHost.close(openedOverlay);
  const overlay = OverlayHost.open(
    <ResearchProgressDialog
      root={root}
      initialWeek={weekStart}
      onClose={() => {
        OverlayHost.close(overlay.id);
        if (openedOverlay === overlay.id) openedOverlay = undefined;
      }}
    />,
  );
  openedOverlay = overlay.id;
}

export function ResearchReportTaskBar() {
  const task = useAtomValue(researchReportTaskAtom, { store });
  const { t: translate } = useTranslation("research");
  if (!task) return null;
  const t: Translate = (key, options) => translate(`progress.${key}`, options);
  return (
    <div
      role="status"
      className="bg-popover text-popover-foreground fixed right-3 bottom-3 z-40 flex max-w-[min(28rem,calc(100%-2rem))] items-center gap-2 rounded-full border py-1 pr-1 pl-3 text-xs shadow-md"
    >
      {task.state === "running" ? (
        <LoaderCircle className="size-3.5 shrink-0 animate-spin" />
      ) : (
        <Presentation className="size-3.5 shrink-0" />
      )}
      <span className="min-w-0 truncate">
        {task.state === "running" ? t(`stage.${task.progress.stage}`) : t(`task.${task.state}`)}
      </span>
      {task.state === "done" && task.result ? (
        <Button
          size="sm"
          variant="ghost"
          className="h-6 rounded-full px-2 text-xs"
          onClick={() => openOutput(task.result!.directory)}
        >
          {t("openFolder")}
        </Button>
      ) : (
        task.root === ResearchFolder.getRoot() && (
          <Button
            size="sm"
            variant="ghost"
            className="h-6 rounded-full px-2 text-xs"
            onClick={() => openResearchProgressDialog("report", task.weekStart)}
          >
            {t("viewTask")}
          </Button>
        )
      )}
      {task.state === "running" ? (
        <Button size="sm" variant="ghost" className="h-6 rounded-full px-2 text-xs" onClick={task.cancel}>
          {t("cancel")}
        </Button>
      ) : (
        <Button
          size="icon"
          variant="ghost"
          className="size-6 rounded-full"
          aria-label={t("close")}
          onClick={() => store.set(researchReportTaskAtom, null)}
        >
          <X className="size-3" />
        </Button>
      )}
    </div>
  );
}
