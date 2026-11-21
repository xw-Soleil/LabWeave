import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import type { Project } from "@/core/Project";
import { cn } from "@/utils/cn";
import i18next from "i18next";
import { useAtomValue } from "jotai";
import { LoaderCircle, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { recordErrorText } from "./NodeRecordFloat";
import { NODE_TYPES, isNode, type NodeType } from "./ProjectRecord";
import { followReportLink } from "./ReportLinks";
import { reportErrorText, reportTaskAtom } from "./ReportTask";
import { sinceLastLive } from "./SnapshotDiff";
import { freezeAndReport } from "./StageReport";
import {
  cardItems,
  dropSelected,
  enterStageReview,
  freezeStageReview,
  leaveStageReview,
  onlySelected,
  setReviewDropped,
  setReviewNote,
  stageReviewAtom,
  type ReviewItem,
  type StageReviewState,
} from "./StageReview";

/*
 * 阶段小结整理时浮在白板右下角的素材卡片：列出上个节点以来的事，去掉不讲的，敲两句原话，定格。
 * 它不拦画布：整理的时候照样能选卡片、改卡片，清单跟着变。
 */

/** 快照文件夹名「2026-11-21 1030」写成「11-21 10:30」 */
const shortTime = (name: string) => name.replace(/^\d{4}-(\d\d-\d\d) (\d\d)(\d\d)(?:-\d+)?$/, "$1 $2:$3");

/** 整理、定格没做成时提示一句。自己抛的错误是 stageReview.outside 这样的代码，有对应的文案；别的原样显示 */
export function stageReviewFailed(error: unknown) {
  const code = error instanceof Error ? error.message : String(error);
  // 节点定格了、手填的记录没封存成：不是「没做成」，单独说清楚
  if (code === "nodeRecord.sealFailed") {
    toast.error(
      i18next.t("nodeRecord.sealFailed", {
        ns: "research",
        error: recordErrorText((error as Error).cause),
        interpolation: { escapeValue: false },
      }),
      { duration: 12000 },
    );
    return;
  }
  const [group, name, ...rest] = code.split(".");
  const known = ["stageReview", "stageSummary"].includes(group) && name && rest.length === 0;
  toast.error(
    i18next.t("stageReview.failed", {
      ns: "research",
      // 汇报和快照的错误代码由 reportErrorText 管
      error: known ? i18next.t(`${group}.errors.${name}`, { ns: "research" }) : reportErrorText(error),
      interpolation: { escapeValue: false },
    }),
  );
}

/** 这块白板在整理时才显示；right 是离右边多远（让开固定住的右侧栏） */
export function StageReviewTray({ project, right }: { project: Project; right: string }) {
  const state = useAtomValue(stageReviewAtom);
  if (!state || state.project !== project) return null;
  return <Tray state={state} right={right} />;
}

function Tray({ state, right }: { state: StageReviewState; right: string }) {
  const { t } = useTranslation("research");
  const { project, root, board, base, marks, dropped, others } = state;
  const [busy, setBusy] = useState<"freeze" | "summarize" | "type">();
  // 同一时间只生成一份汇报：上一份还在跑的时候只能先「只定格」
  const reporting = useAtomValue(reportTaskAtom)?.state === "running";

  // 这块白板上的卡片跟着修改现算：画布那边每重新比一次，这里跟着换
  const cardsNow = () => {
    const live = sinceLastLive(project);
    return {
      at: live?.computedAt,
      cards: live ? cardItems(root, board, live.diff, live.items, marks) : [],
      removed: live?.diff.removed.length ?? 0,
    };
  };
  const [listed, setListed] = useState(cardsNow);
  useEffect(() => {
    setListed(cardsNow());
    const timer = setInterval(() => {
      setListed((previous) => (sinceLastLive(project)?.computedAt === previous.at ? previous : cardsNow()));
    }, 400);
    return () => clearInterval(timer);
    // cardsNow 每次渲染都是新的函数，不能放进依赖里；它用到的就是下面这几样
  }, [project, root, board, marks]);
  const { cards, removed } = listed;

  const run = (kind: NonNullable<typeof busy>, task: () => Promise<unknown>) => {
    setBusy(kind);
    task()
      .catch(stageReviewFailed)
      .finally(() => setBusy(undefined));
  };

  const toggle = (id: string, keep: boolean) => {
    const next = new Set(dropped);
    if (keep) next.delete(id);
    else next.add(id);
    setReviewDropped(next);
  };
  // 照画布上选中的卡片来：只认列在这里的（这段时间新加的、改过的、标记过的）
  const bySelection = (change: typeof onlySelected) => () => {
    const selected = new Set(project.stageManager.getSelectedEntities().map((entity) => entity.uuid));
    if (!cards.some((card) => selected.has(card.id))) {
      toast.info(t("stageReview.selectFirst"));
      return;
    }
    setReviewDropped(change(cards, selected, dropped));
  };

  const total = cards.length + others.length;
  const picked = [...cards, ...others].filter((item) => !dropped.has(item.id)).length;
  const since = !base
    ? t("stageReview.sinceNothing")
    : isNode(base)
      ? t("stageReview.sinceNode", {
          title: base.manifest.node?.title ?? `${shortTime(base.name)} ${t("stageSummary.title")}`,
          interpolation: { escapeValue: false },
        })
      : t("stageReview.sinceFirst", { time: shortTime(base.name) });

  const row = (item: ReviewItem) => (
    <li key={item.id} className="flex items-start gap-2 py-1">
      <Checkbox
        className="mt-0.5 size-3.5 rounded-[3px] [&_svg]:size-3"
        checked={!dropped.has(item.id)}
        aria-label={item.title}
        onCheckedChange={(checked) => toggle(item.id, checked === true)}
      />
      <button
        type="button"
        className={cn(
          "min-w-0 flex-1 cursor-pointer text-left hover:underline",
          dropped.has(item.id) && "text-muted-foreground line-through",
        )}
        title={item.text || item.title}
        onClick={() => item.link && void followReportLink(item.link)}
      >
        <span className="line-clamp-2 break-words">
          {item.mark && (
            <span className="bg-accent text-foreground mr-1 rounded-[4px] px-1 text-[10px] font-medium">
              {t(`activityLog.mark.${item.mark}`)}
            </span>
          )}
          {item.title || item.text || t("stageReview.untitled")}
        </span>
        {item.kind !== "card" && (
          <span className="text-muted-foreground block text-[11px]">
            {item.kind === "note" ? t("stageReview.noteSaved") : t(`stageReview.${item.kind}Counts`, item.counts)}
          </span>
        )}
      </button>
      {item.change && (
        <span
          className={cn(
            "mt-0.5 shrink-0 text-[10px] font-medium",
            item.change === "added" ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400",
          )}
        >
          {t(`stageReview.${item.change}`)}
        </span>
      )}
    </li>
  );
  const small = "h-6 rounded-[6px] px-2 text-[11px]";

  return (
    <div
      className="bg-background/95 border-border/60 text-foreground absolute bottom-2 z-10 flex max-h-[min(72%,36rem)] w-72 flex-col rounded-[10px] border text-[12px] shadow-md select-none"
      style={{ right }}
    >
      <div className="flex items-start gap-2 px-3 pt-2.5 pb-1.5">
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold">{t("stageReview.title")}</div>
          <div className="text-muted-foreground text-[11px]">{since}</div>
        </div>
        <button
          type="button"
          aria-label={t("stageReview.leave")}
          title={t("stageReview.leave")}
          className="text-muted-foreground hover:bg-accent hover:text-foreground cursor-pointer rounded-[6px] p-1 [&_svg]:size-3.5"
          onClick={leaveStageReview}
        >
          <X />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3">
        {total === 0 && <div className="text-muted-foreground py-2">{t("stageReview.empty")}</div>}
        {cards.length > 0 && (
          <>
            <div className="flex items-center gap-1 pt-1">
              <span className="text-muted-foreground flex-1 text-[11px] font-medium">{t("stageReview.thisBoard")}</span>
              <Button size="sm" variant="ghost" className={small} onClick={bySelection(onlySelected)}>
                {t("stageReview.onlySelected")}
              </Button>
              <Button size="sm" variant="ghost" className={small} onClick={bySelection(dropSelected)}>
                {t("stageReview.dropSelected")}
              </Button>
            </div>
            <ul>{cards.map(row)}</ul>
          </>
        )}
        {removed > 0 && (
          <div className="text-muted-foreground py-1 text-[11px]">{t("stageReview.removed", { count: removed })}</div>
        )}
        {others.length > 0 && (
          <>
            <div className="text-muted-foreground pt-2 text-[11px] font-medium">{t("stageReview.elsewhere")}</div>
            <ul>{others.map(row)}</ul>
          </>
        )}
      </div>

      <div className="border-border/60 flex flex-col gap-2 border-t px-3 pt-2 pb-2.5">
        <Textarea
          className="max-h-28 min-h-12 rounded-[6px] px-2 py-1.5 text-[12px] select-text md:text-[12px]"
          placeholder={t("stageReview.notePlaceholder")}
          value={state.note}
          onChange={(event) => setReviewNote(event.target.value)}
        />
        <div className="flex items-center gap-1">
          <span className="text-muted-foreground mr-1 text-[11px]">{t("stageReview.type")}</span>
          {NODE_TYPES.map((type: NodeType) => (
            <Button
              key={type}
              size="sm"
              variant={type === state.type ? "secondary" : "ghost"}
              className={small}
              disabled={!!busy}
              // 换一种类型，和谁比可能不一样（今天有没有定格过这一种）：重新进一次，敲好的话带着
              onClick={() => type !== state.type && run("type", () => enterStageReview(project, type, state.note))}
            >
              {t(`stageNode.types.${type}`)}
            </Button>
          ))}
          <span className="text-muted-foreground ml-auto text-[11px] tabular-nums">
            {t("stageReview.picked", { picked, total })}
          </span>
        </div>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            className="h-7 flex-1 rounded-[6px] text-[12px]"
            disabled={!!busy}
            title={t("stageReview.freezeHint")}
            onClick={() =>
              run("freeze", async () => {
                const snapshot = await freezeStageReview(cards);
                const title = snapshot?.manifest.node?.title;
                if (title) toast.success(t("stageReview.frozen", { title, interpolation: { escapeValue: false } }));
              })
            }
          >
            {busy === "freeze" && <LoaderCircle className="animate-spin" />}
            {t("stageReview.freeze")}
          </Button>
          <Button
            size="sm"
            className="h-7 flex-1 rounded-[6px] text-[12px]"
            disabled={!!busy || reporting}
            title={reporting ? t("report.errors.busy") : t("stageReview.summarizeHint")}
            onClick={() => run("summarize", () => freezeAndReport(cards))}
          >
            {busy === "summarize" && <LoaderCircle className="animate-spin" />}
            {t("stageReview.summarize")}
          </Button>
        </div>
      </div>
    </div>
  );
}
