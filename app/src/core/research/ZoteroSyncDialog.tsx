import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
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
import type { LibrarySnapshot } from "./Library";
import { libraryStatuses } from "./LibraryFormat";
import {
  planZoteroSync,
  readZotero,
  type SyncGroup,
  type SyncPreview,
  type SyncProgress,
  type SyncRow,
  type SyncValue,
} from "./ZoteroSync";

function previewPath(root: string, path: string): string {
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
  useEffect(() => {
    const controller = new AbortController();
    const local = latest.current;
    setBusy(true);
    setPreview(undefined);
    setError(undefined);
    const report = (value: SyncProgress) => {
      if (!controller.signal.aborted) setProgress(value);
    };
    void (async () => {
      try {
        const remote = await readZotero(controller.signal, report);
        const next = await planZoteroSync(local, remote, controller.signal, report);
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
    return () => controller.abort();
  }, [attempt]);

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
          <DialogDescription>{t("readOnly")}</DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-col gap-4 overflow-y-auto" aria-busy={busy}>
          {busy && <p role="status">{t(`progress.${progress.phase}`, { count: progress.count })}</p>}
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{t(`errors.${error}`)}</AlertDescription>
            </Alert>
          )}
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
                />
              ))}
            </>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => setAttempt((value) => value + 1)}>
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
}: {
  group: SyncGroup;
  rows: SyncRow[];
  root: string;
  summary?: SyncPreview["summary"];
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
