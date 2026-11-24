import type { Project } from "@/core/Project";
import { cn } from "@/utils/cn";
import i18next from "i18next";
import { ChevronLeft, ChevronRight, FileText, LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { LookbackBoard, leaveLookback, nodeChip, nodeLabel, openLookback } from "./LookbackBoard";
import { reportErrorText } from "./ReportTask";

/*
 * 回看历史时白板上方的节点条：从左到右是每个节点，最右边是「现在」。
 * 点一个节点，画布换成那个节点定格时的样子；下面一行写它和再前一个节点比变了多少、当时敲的原话。
 */

/** 回看没打开时提示一句。自己抛的错误是 lookback.noBoard 这样的代码，有对应的文案；别的交给 reportErrorText */
export function lookbackFailed(error: unknown) {
  const code = error instanceof Error ? error.message : String(error);
  const [group, name, ...rest] = code.split(".");
  const known = ["lookback", "stageReview", "stageSummary"].includes(group) && name && rest.length === 0;
  toast.error(
    i18next.t("lookback.failed", {
      ns: "research",
      error: known ? i18next.t(`${group}.errors.${name}`, { ns: "research" }) : reportErrorText(error),
      interpolation: { escapeValue: false },
    }),
  );
}

/** 这块白板是回看的才显示 */
export function NodeStrip({ project, left, right }: { project: Project } & Insets) {
  return project instanceof LookbackBoard ? <Strip board={project} left={left} right={right} /> : null;
}

/** 离左右两边多远：让开显示着的侧栏，节点条在剩下的那一段里居中 */
interface Insets {
  left: string;
  right: string;
}

function Strip({ board, left, right }: { board: LookbackBoard } & Insets) {
  const { t } = useTranslation("research");
  const { nodes, node, base, counts, report } = board.lookback;
  const [busy, setBusy] = useState(false);
  const current = useRef<HTMLButtonElement>(null);
  // 节点多的时候条子能横着滚：把正在看的那个滚到看得见的地方
  useEffect(() => current.current?.scrollIntoView({ block: "nearest", inline: "center" }), []);

  const run = (task: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    // 切成了，这个标签会被关掉；没切成才需要把按钮放开
    task()
      .catch(lookbackFailed)
      .finally(() => setBusy(false));
  };
  const index = nodes.findIndex((candidate) => candidate.name === node.name);
  const go = (offset: number) => {
    const target = nodes[index + offset];
    if (target) run(() => openLookback(board, target.name));
  };
  const note = node.manifest.node?.note?.replace(/\s+/g, " ").trim();
  const arrow =
    "text-muted-foreground hover:bg-accent hover:text-foreground flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-full disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent [&_svg]:size-4";
  const chip = "h-6 shrink-0 cursor-pointer rounded-full px-2.5 text-[12px] whitespace-nowrap";

  return (
    <div className="pointer-events-none absolute top-11 z-10 flex justify-center px-3" style={{ left, right }}>
      <div className="bg-background/95 border-border/60 text-foreground pointer-events-auto flex max-w-full min-w-0 flex-col gap-1 rounded-[14px] border px-2 py-1.5 text-[12px] shadow-md select-none">
        <div className="flex min-w-0 items-center gap-1">
          <button
            type="button"
            className={arrow}
            aria-label={t("lookback.previous")}
            title={t("lookback.previous")}
            disabled={busy || index <= 0}
            onClick={() => go(-1)}
          >
            <ChevronLeft />
          </button>
          <div className="flex min-w-0 items-center gap-1 overflow-x-auto [scrollbar-width:none]">
            {nodes.map((candidate) => {
              const active = candidate.name === node.name;
              return (
                <button
                  key={candidate.name}
                  ref={active ? current : undefined}
                  type="button"
                  aria-current={active}
                  title={nodeLabel(candidate)}
                  disabled={busy}
                  className={cn(
                    chip,
                    active
                      ? "bg-primary text-primary-foreground font-medium"
                      : "text-muted-foreground hover:bg-accent hover:text-foreground",
                  )}
                  onClick={() => !active && run(() => openLookback(board, candidate.name))}
                >
                  {nodeChip(candidate)}
                </button>
              );
            })}
          </div>
          <button
            type="button"
            className={arrow}
            aria-label={t("lookback.next")}
            title={t("lookback.next")}
            disabled={busy || index >= nodes.length - 1}
            onClick={() => go(1)}
          >
            <ChevronRight />
          </button>
          <span className="bg-border/70 mx-0.5 h-4 w-px shrink-0" />
          <button
            type="button"
            disabled={busy}
            title={t("lookback.nowHint")}
            className={cn(chip, "text-foreground hover:bg-accent border-border/70 border")}
            onClick={() => run(() => leaveLookback(board))}
          >
            {t("lookback.now")}
          </button>
          {busy && <LoaderCircle className="text-muted-foreground size-3.5 shrink-0 animate-spin" />}
        </div>
        <div className="text-muted-foreground flex min-w-0 items-center gap-2 px-1 text-[11px]">
          <span className="shrink-0">
            {base
              ? t("lookback.since", { title: nodeLabelOrTime(base), interpolation: { escapeValue: false } })
              : t("lookback.first")}
          </span>
          <span className="text-foreground shrink-0 tabular-nums">{t("lookback.counts", counts)}</span>
          {note && (
            <span className="min-w-0 truncate" title={note}>
              {t("lookback.note", { note, interpolation: { escapeValue: false } })}
            </span>
          )}
          {report && (
            <button
              type="button"
              className="text-foreground hover:bg-accent ml-auto flex h-5 shrink-0 cursor-pointer items-center gap-1 rounded-full px-1.5 [&_svg]:size-3"
              onClick={() =>
                run(async () => {
                  const { openDocumentFile } = await import("./DocumentTab");
                  await openDocumentFile(report);
                })
              }
            >
              <FileText />
              {t("lookback.report")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** 当初比的那一份：是节点就写节点名，不是（项目最早的那份快照）就写时间 */
function nodeLabelOrTime(snapshot: LookbackBoard["lookback"]["node"]): string {
  return snapshot.manifest.node || snapshot.manifest.reason === "summary"
    ? nodeLabel(snapshot)
    : i18next.t("lookback.firstSnapshot", {
        ns: "research",
        time: snapshot.manifest.at.slice(0, 16).replace("T", " "),
      });
}
