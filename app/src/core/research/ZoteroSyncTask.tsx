import { Button } from "@/components/ui/button";
import { store } from "@/state";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import { atom, useAtomValue } from "jotai";
import { LoaderCircle, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

/**
 * 同步、回退、备份在后台跑：关掉同步窗口不会中断，进度和「取消」在窗口底部正中的小条上。
 * 这个文件只放任务状态和小条，不引同步代码，程序启动时不会把同步那一套加载进来。
 */
export type SyncTaskKind = "sync" | "rollback" | "backup";
export interface SyncTask {
  kind: SyncTaskKind;
  root: string;
  done: number;
  total?: number;
  state: "running" | "done" | "failed" | "cancelled";
  /** zoteroSync.errors 下的错误代码 */
  error?: string;
  /** 回退时发现的后续改动 */
  changes?: string[];
  /** 备份出来的文件夹 */
  result?: string;
  cancel: () => void;
}

export const syncTaskAtom = atom<SyncTask | null>(null);

const errorCode = (cause: unknown) =>
  cause instanceof Error && /^zoteroSync\.[a-zA-Z]+$/.test(cause.message)
    ? cause.message.slice("zoteroSync.".length)
    : "operationFailed";

/** 同一时间只跑一个任务；返回 false 表示已经有任务在跑 */
export function startSyncTask(
  kind: SyncTaskKind,
  root: string,
  work: (signal: AbortSignal, progress: (done: number, total?: number) => void) => Promise<string | void>,
): boolean {
  if (store.get(syncTaskAtom)?.state === "running") return false;
  const controller = new AbortController();
  const update = (patch: Partial<SyncTask>) => {
    const task = store.get(syncTaskAtom);
    if (task?.cancel === cancel) store.set(syncTaskAtom, { ...task, ...patch });
  };
  const cancel = () => controller.abort();
  store.set(syncTaskAtom, { kind, root, done: 0, state: "running", cancel });
  void work(controller.signal, (done, total) => update({ done, total }))
    .then((result) => update({ state: "done", result: result || undefined }))
    .catch((cause: unknown) =>
      update(
        controller.signal.aborted
          ? { state: "cancelled" }
          : {
              state: "failed",
              error: errorCode(cause),
              changes: (cause as { changes?: string[] })?.changes,
            },
      ),
    );
  return true;
}

export function SyncTaskBar() {
  const task = useAtomValue(syncTaskAtom, { store });
  const { t: translate } = useTranslation("research");
  if (!task) return null;
  const t = (key: string, options?: Record<string, unknown>) =>
    translate(`zoteroSync.${key}`, { ...options, interpolation: { escapeValue: false } });
  const running = task.state === "running";
  const text =
    task.state === "failed"
      ? `${t(`task.${task.kind}.failed`)}${t(`errors.${task.error}`)}`
      : t(`task.${task.kind}.${task.state}`, { done: task.done, total: task.total ?? "…" });
  return (
    <div
      role="status"
      className="bg-popover text-popover-foreground fixed bottom-3 left-1/2 z-50 flex h-8 max-w-[min(36rem,calc(100%-2rem))] -translate-x-1/2 items-center gap-2 rounded-full border pr-1 pl-3 text-xs shadow-md"
    >
      {running && <LoaderCircle className="size-3.5 shrink-0 animate-spin" aria-hidden="true" />}
      <span className="min-w-0 truncate tabular-nums" title={text}>
        {text}
      </span>
      {running && (
        <Button size="sm" variant="ghost" className="h-6 rounded-full px-2 text-xs" onClick={task.cancel}>
          {t("cancel")}
        </Button>
      )}
      {task.state === "done" && task.result && (
        <Button
          size="sm"
          variant="ghost"
          className="h-6 rounded-full px-2 text-xs"
          onClick={() => void shellOpen(task.result!).catch((cause) => toast.error(String(cause)))}
        >
          {t("openFolder")}
        </Button>
      )}
      {!running && (
        <Button
          size="icon"
          variant="ghost"
          className="size-6 rounded-full"
          aria-label={t("close")}
          onClick={() => store.set(syncTaskAtom, null)}
        >
          <X />
        </Button>
      )}
    </div>
  );
}
