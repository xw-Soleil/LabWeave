import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { confirm } from "@tauri-apps/plugin-dialog";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { documentKey, documentPath } from "./DocumentFile";
import { loadLibrary, type LibrarySnapshot } from "./Library";
import { libraryStatuses } from "./LibraryFormat";
import {
  planZoteroSync,
  readSyncHistory,
  captureSyncFiles,
  resolveZoteroSync,
  applyZoteroSync,
  rollbackZoteroSync,
  pendingSync,
  conflictId,
  SyncRollbackError,
  readZotero,
  type SyncChoice,
  type SyncHistory,
  type SyncGroup,
  type SyncPreview,
  type SyncProgress,
  type SyncRow,
  type SyncValue,
} from "./ZoteroSync";

function previewPath(root: string, path: string): string {
  if (!/^(?:\/|[a-z]:[\\/]|\\\\)/i.test(path)) return path;
  const prefix = documentPath(root).replace(/\/$/, "") + "/";
  return documentKey(path).startsWith(documentKey(prefix).replace(/\/$/, "") + "/")
    ? documentPath(path).slice(prefix.length)
    : documentPath(path);
}

export default function ZoteroSyncDialog({ snapshot, onClose }: { snapshot: LibrarySnapshot; onClose: () => void }) {
  const { t: translate } = useTranslation("research");
  const t = (key: string, options?: Record<string, unknown>) =>
    translate(`zoteroSync.${key}`, { ...options, interpolation: { escapeValue: false } });
  const latest = useRef(snapshot);
  latest.current = snapshot;
  const [attempt, setAttempt] = useState(0);
  const [progress, setProgress] = useState<SyncProgress>({ phase: "connect", count: 0 });
  const [preview, setPreview] = useState<SyncPreview>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(true);
  const [history, setHistory] = useState<SyncHistory>();
  const [choices, setChoices] = useState<Record<string, SyncChoice>>({});
  const [changed, setChanged] = useState<string[]>([]);
  const operation = useRef<AbortController | null>(null);
  const reportError = (cause: unknown) => {
    setError(
      cause instanceof Error && /^zoteroSync\.[a-zA-Z]+$/.test(cause.message)
        ? cause.message.slice("zoteroSync.".length)
        : "operationFailed",
    );
    setChanged(cause instanceof SyncRollbackError ? cause.changes : []);
  };
  useEffect(() => {
    const controller = new AbortController();
    const local = latest.current;
    setBusy(true);
    setPreview(undefined);
    setError(undefined);
    setChoices({});
    setChanged([]);
    const report = (value: SyncProgress) => {
      if (!controller.signal.aborted) setProgress(value);
    };
    void (async () => {
      try {
        const stored = await readSyncHistory(local.root);
        if (controller.signal.aborted) return;
        setHistory(stored);
        if (pendingSync(stored.run)) return;
        const remote = await readZotero(controller.signal, report);
        const next = await planZoteroSync(
          attempt ? await loadLibrary(local.root) : local,
          remote,
          controller.signal,
          report,
          stored.baseline,
        );
        await captureSyncFiles(next);
        if (!controller.signal.aborted) setPreview(next);
      } catch (cause) {
        if (!controller.signal.aborted)
          setError(
            cause instanceof Error && cause.message.startsWith("zoteroSync.")
              ? cause.message.slice("zoteroSync.".length)
              : "previewFailed",
          );
      } finally {
        if (!controller.signal.aborted) setBusy(false);
      }
    })();
    return () => {
      controller.abort();
      operation.current?.abort();
    };
  }, [attempt]);

  const execute = async (rollback: boolean) => {
    const controller = new AbortController();
    operation.current = controller;
    setBusy(true);
    setError(undefined);
    setChanged([]);
    try {
      if (rollback) {
        if (!(await confirm(t("confirmRollback"), { title: t("title"), kind: "warning" }))) return;
        await rollbackZoteroSync(snapshot.root, controller.signal, setProgress);
      } else if (preview) {
        const run = await resolveZoteroSync(preview, choices, controller.signal);
        if (!(await confirm(t("confirmSync", { count: run.actions.length }), { title: t("title"), kind: "warning" })))
          return;
        await applyZoteroSync(preview, run, controller.signal, setProgress);
      }
      setPreview(undefined);
    } catch (cause) {
      if (!controller.signal.aborted) reportError(cause);
    } finally {
      if (!controller.signal.aborted) {
        try {
          const stored = await readSyncHistory(snapshot.root);
          setHistory(stored);
          if (pendingSync(stored.run)) setPreview(undefined);
        } catch (cause) {
          reportError(cause);
        }
        setBusy(false);
      }
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-3xl" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-col gap-4 overflow-y-auto" aria-busy={busy}>
          {busy && <p role="status">{t(`progress.${progress.phase}`, { count: progress.count })}</p>}
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{t(`errors.${error}`)}</AlertDescription>
            </Alert>
          )}
          {!!changed.length && (
            <ul>
              {changed.map((path) => (
                <li key={path}>{previewPath(snapshot.root, path)}</li>
              ))}
            </ul>
          )}
          {pendingSync(history?.run) && (
            <Alert>
              <AlertDescription>{t("unfinished")}</AlertDescription>
            </Alert>
          )}
          {history?.run?.status === "complete" && (
            <p role="status">{t("completed", { count: history.run.actions.length, skipped: history.run.skipped })}</p>
          )}
          {history?.run?.status === "rolled-back" && <p role="status">{t("rolledBack")}</p>}
          {preview && (
            <>
              <p role="status" className="text-muted-foreground text-sm">
                {t("connected", {
                  local: preview.source.local.items.length,
                  remote: preview.source.remote.items.length,
                })}
              </p>
              {preview.blocked && (
                <Alert variant="destructive">
                  <AlertDescription>{t("blocked")}</AlertDescription>
                </Alert>
              )}
              {!!preview.pairingIssues.length && (
                <section aria-label={t("pairingIssues")} className="flex flex-col gap-3">
                  <h3 className="font-medium">{t("pairingIssues")}</h3>
                  {preview.pairingIssues.map((issue, index) => (
                    <div
                      key={index}
                      className="flex flex-col gap-1 rounded-md border p-3 text-sm [overflow-wrap:anywhere]"
                    >
                      <p>
                        {t(`match.${issue.by}`)}: {issue.value}
                      </p>
                      <ul className="flex list-disc flex-col gap-1 pl-5">
                        {issue.candidates.map((candidate, i) => (
                          <li key={i}>
                            {candidate.title} · {candidate.path ? t("local") : t("remote")}:{" "}
                            {candidate.path ? previewPath(preview.source.local.root, candidate.path) : candidate.key}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </section>
              )}
              {(["push", "pull", "conflict", "skip"] as const).map((group) => (
                <PreviewGroup
                  key={`${attempt}:${group}`}
                  group={group}
                  rows={preview.rows.filter((row) => row.group === group)}
                  root={preview.source.local.root}
                  summary={group === "skip" ? preview.summary : undefined}
                  choices={choices}
                  disabled={busy}
                  choose={(rows, choice) =>
                    setChoices((old) => ({
                      ...old,
                      ...Object.fromEntries(rows.map((row) => [conflictId(row), choice])),
                    }))
                  }
                />
              ))}
            </>
          )}
        </div>
        <DialogFooter>
          {history?.runPath && (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => void shellOpen(history.runPath!).catch(reportError)}
            >
              {t("openBackup")}
            </Button>
          )}
          {history?.run && history.run.status !== "rolled-back" && (
            <Button variant="outline" disabled={busy} onClick={() => void execute(true)}>
              {t(preview || pendingSync(history.run) ? "rollbackLast" : "rollbackThis")}
            </Button>
          )}
          {preview && (
            <Button disabled={busy || preview.blocked} onClick={() => void execute(false)}>
              {t("sync")}
            </Button>
          )}
          <Button
            variant="outline"
            disabled={busy || pendingSync(history?.run)}
            onClick={() => setAttempt((value) => value + 1)}
          >
            {t("refresh")}
          </Button>
          <DialogClose asChild>
            <Button variant="outline">{t("close")}</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PreviewGroup({
  group,
  rows,
  root,
  summary,
  choices,
  choose,
  disabled,
}: {
  group: SyncGroup;
  rows: SyncRow[];
  root: string;
  summary?: SyncPreview["summary"];
  choices: Record<string, SyncChoice>;
  choose: (rows: SyncRow[], choice: SyncChoice) => void;
  disabled: boolean;
}) {
  const { t: translate } = useTranslation("research");
  const t = (key: string, options?: Record<string, unknown>) =>
    translate(`zoteroSync.${key}`, { ...options, interpolation: { escapeValue: false } });
  const [limit, setLimit] = useState(50);
  const summaries = [
    summary?.unchanged ? t("summary.unchanged", { count: summary.unchanged }) : "",
    summary?.deferred.total ? t("summary.deferred", { ...summary.deferred, count: summary.deferred.total }) : "",
    summary?.missingCollections ? t("summary.missingCollections", { count: summary.missingCollections }) : "",
  ].filter(Boolean);
  const value = (value: SyncValue | undefined, row: SyncRow): string => {
    if (value === undefined || value === "" || (Array.isArray(value) && !value.length)) return t("emptyValue");
    if (row.field === "status") {
      return (Array.isArray(value) ? value : [value])
        .map((v) => {
          const status = Object.entries(libraryStatuses).find(([, label]) => label === v)?.[0];
          return status ? translate(`library.status.${status}`) : v;
        })
        .join("\n");
    }
    return Array.isArray(value) ? value.join("\n") : value;
  };
  return (
    <section aria-label={t(`groups.${group}`)} className="flex flex-col gap-2">
      <h3 className="font-medium">
        {t(`groups.${group}`)} ({rows.length + summaries.length})
      </h3>
      {group === "conflict" && !!rows.length && (
        <div className="flex gap-2">
          {(["local", "remote"] as const).map((side) => (
            <Button key={side} variant="outline" disabled={disabled} onClick={() => choose(rows, side)}>
              {t(`all.${side}`)}
            </Button>
          ))}
        </div>
      )}
      {!rows.length && !summaries.length && <p className="text-muted-foreground text-sm">{t("noChanges")}</p>}
      {summaries.map((summary, index) => (
        <p key={index} className="rounded-md border p-3 text-sm">
          {summary}
        </p>
      ))}
      {rows.slice(0, limit).map((row, index) => (
        <div key={index} className="flex flex-col gap-2 rounded-md border p-3 text-sm [overflow-wrap:anywhere]">
          {row.title && <p className="font-medium">{row.title}</p>}
          {(row.path || row.key) && (
            <p className="text-muted-foreground text-xs">
              {[row.path ? previewPath(root, row.path) : undefined, row.key].filter(Boolean).join(" · ")}
            </p>
          )}
          {row.field && <p>{t(`fields.${row.field}`)}</p>}
          {row.reason && <p>{t(`reasons.${row.reason}`)}</p>}
          {row.matchedBy && <p>{t("matchedBy", { method: t(`match.${row.matchedBy}`) })}</p>}
          {(row.local !== undefined || row.remote !== undefined) && (
            <dl className="grid grid-cols-2 gap-3">
              <div>
                <dt className="text-muted-foreground">{t("local")}</dt>
                <dd className="whitespace-pre-wrap">{value(row.local, row)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t("remote")}</dt>
                <dd className="whitespace-pre-wrap">{value(row.remote, row)}</dd>
              </div>
            </dl>
          )}
          {group === "conflict" && (
            <Select
              value={choices[conflictId(row)] ?? "skip"}
              disabled={disabled}
              onValueChange={(value) => choose([row], value as SyncChoice)}
            >
              <SelectTrigger aria-label={`${row.title} ${row.field ? t(`fields.${row.field}`) : t("choiceLabel")}`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {(["local", "remote", "skip"] as const).map((side) => (
                    <SelectItem key={side} value={side}>
                      {t(`choices.${side}`)}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          )}
        </div>
      ))}
      {rows.length > limit && (
        <Button variant="outline" onClick={() => setLimit((value) => value + 50)}>
          {t("showMore", { count: rows.length - limit })}
        </Button>
      )}
    </section>
  );
}
