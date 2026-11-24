import type { Project } from "@/core/Project";
import { cn } from "@/utils/cn";
import { History, Rewind } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { openLookback } from "./LookbackBoard";
import { lookbackFailed } from "./NodeStrip";
import { ResearchFolder } from "./ResearchFolder";
import { currentBaseline, isNode, onSnapshotTaken, readSnapshotBoard, snapshotFiles, type Snapshot } from "./Snapshot";
import { hideSinceLast, showSinceLast, sinceLastCounts } from "./SnapshotDiff";

type Counts = NonNullable<ReturnType<typeof sinceLastCounts>>;
const BUTTON =
  "text-muted-foreground hover:bg-accent hover:text-foreground flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-full px-1.5 text-[11px] font-medium disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent [&_svg]:size-3.5";

/** 快照文件夹名「2026-11-21 1030」写成「11-21 10:30」 */
const shortTime = (name: string) => name.replace(/^\d{4}-(\d\d-\d\d) (\d\d)(\d\d)(?:-\d+)?$/, "$1 $2:$3");

/**
 * 白板状态条上的两个按钮：
 * 「自上次小结以来」开关——和上一个节点比，新加的描边、改过的打点、删掉的留影，旁边写着各有几张；还没有快照时是灰的；
 * 回看——打开上一个节点定格时这块白板的样子，从那里能一个节点一个节点往回看（做过小结才亮）。
 */
export function SinceLastToggle({ project }: { project: Project }) {
  const { t } = useTranslation("research");
  // undefined：还在查；null：一份都没有
  const [base, setBase] = useState<Snapshot | null>();
  const [counts, setCounts] = useState<Counts>();
  const [opening, setOpening] = useState(false);
  const report = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    // 自己抛的错误是 snapshot.noBoard 这样的代码，有对应的文案；别的原样显示
    const code = /^snapshot\.(\w+)$/.exec(message)?.[1];
    toast.error(
      t(`snapshot.errors.${code}`, {
        defaultValue: t("snapshot.failed", { error: message, interpolation: { escapeValue: false } }),
      }),
    );
  };

  const compareWith = async (snapshot: Snapshot) => {
    const root = ResearchFolder.getRoot();
    const file = ResearchFolder.toRelative(project.uri.fsPath, root);
    showSinceLast(project, snapshot.name, await readSnapshotBoard(snapshotFiles, root, snapshot.name, file));
    setCounts(sinceLastCounts(project));
    // 白板可能暂停着渲染，让它马上重画
    project.loop();
  };

  useEffect(() => {
    let alive = true;
    setCounts(sinceLastCounts(project));
    currentBaseline().then((snapshot) => alive && setBase(snapshot ?? null), report);
    const off = onSnapshotTaken(() => {
      // 定格了新节点，基准就换成它；自动拍的不换（除非这是项目的第一份）
      currentBaseline().then((snapshot) => {
        if (!alive) return;
        setBase(snapshot ?? null);
        const shown = sinceLastCounts(project);
        // 整理状态下定格的，画布由整理那边收尾，这里不接手
        if (snapshot && shown && !shown.review && shown.name !== snapshot.name) {
          void compareWith(snapshot).catch(report);
        }
      }, report);
    });
    // 画布那边随着编辑重新比，这里跟着读数字
    const timer = setInterval(() => {
      const next = sinceLastCounts(project);
      setCounts((previous) =>
        previous?.name === next?.name &&
        previous?.review === next?.review &&
        previous?.added === next?.added &&
        previous?.edited === next?.edited &&
        previous?.removed === next?.removed
          ? previous
          : next,
      );
    }, 300);
    return () => {
      alive = false;
      off();
      clearInterval(timer);
    };
    // 只跟着白板换：report、compareWith 每次渲染都是新的函数，不能放进依赖里
  }, [project]);

  const root = ResearchFolder.getRoot();
  // 草稿、研究文件夹外临时打开的白板不进快照
  if (!root || project.uri.scheme !== "file" || !ResearchFolder.isInside(project.uri.fsPath, root)) return null;

  const toggle = () => {
    if (counts) {
      hideSinceLast(project);
      setCounts(undefined);
      project.loop();
    } else if (base) void compareWith(base).catch(report);
  };
  const lookBack = () => {
    setOpening(true);
    openLookback(project)
      .catch(lookbackFailed)
      .finally(() => setOpening(false));
  };
  const hasNode = !!base && isNode(base);

  // 和谁比：节点写它的名字；一次小结都没做过时，是和最早的那份快照比
  const hint = !base
    ? t("snapshot.none")
    : isNode(base)
      ? t("snapshot.sinceNodeHint", {
          title: base.manifest.node?.title ?? `${shortTime(base.name)} ${t("stageSummary.title")}`,
          interpolation: { escapeValue: false },
        })
      : t("snapshot.sinceFirstHint", { time: shortTime(base.name) });

  return (
    <div className="flex shrink-0 items-center">
      <button
        type="button"
        aria-pressed={!!counts}
        // 正在做阶段小结整理时，画布上的标记归整理管，退出整理再用这个开关
        disabled={!base || counts?.review}
        title={counts?.review ? t("stageReview.toggleBusy") : hint}
        className={cn(BUTTON, counts && "bg-accent text-foreground")}
        onClick={toggle}
      >
        <History />
        {counts ? t("snapshot.counts", counts) : t("snapshot.since")}
      </button>
      <button
        type="button"
        // 整理的时候不让开回看：那会把正在整理的这块白板切到后面去
        disabled={!hasNode || opening || counts?.review}
        title={hasNode ? t("lookback.openHint") : t("lookback.noNodeHint")}
        className={BUTTON}
        onClick={lookBack}
      >
        <Rewind />
        {t("lookback.open")}
      </button>
    </div>
  );
}
