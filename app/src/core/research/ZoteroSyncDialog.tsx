import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/utils/cn";
import { confirm } from "@tauri-apps/plugin-dialog";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import { ArrowDown, ArrowUp, ChevronRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { documentKey, documentPath } from "./DocumentFile";
import { loadLibrary, type LibrarySnapshot } from "./Library";
import { libraryStatuses } from "./LibraryFormat";
import {
  applyZoteroSync,
  captureSyncFiles,
  pendingSync,
  planZoteroSync,
  readSyncHistory,
  readZotero,
  resolveZoteroSync,
  rollbackZoteroSync,
  rowId,
  SyncRollbackError,
  type SyncChoice,
  type SyncHistory,
  type SyncPreview,
  type SyncProgress,
  type SyncRow,
  type SyncValue,
} from "./ZoteroSync";

type Translate = (key: string, options?: Record<string, unknown>) => string;
type Section = "collection" | "item" | "field" | "attachment" | "conflict";
type Filter = "all" | "push" | "pull" | "conflict";
const sections: Section[] = ["collection", "item", "field", "attachment", "conflict"];
const ROW_LIMIT = 200;

function previewPath(root: string, path: string): string {
  if (!/^(?:\/|[a-z]:[\\/]|\\\\)/i.test(path)) return path;
  const prefix = documentPath(root).replace(/\/$/, "") + "/";
  return documentKey(path).startsWith(documentKey(prefix).replace(/\/$/, "") + "/")
    ? documentPath(path).slice(prefix.length)
    : documentPath(path);
}

/** 「保留／跳过」里的行只是提示，不能勾 */
const sectionOf = (row: SyncRow): Section | undefined =>
  row.group === "skip"
    ? undefined
    : row.group === "conflict"
      ? "conflict"
      : row.group === "attachment" || row.reason === "exportNotes"
        ? "attachment"
        : row.kind === "collection"
          ? "collection"
          : row.kind === "field"
            ? "field"
            : "item";
/** ↑ 写到 Zotero；↓ 写到本地 */
const upward = (row: SyncRow) => row.group === "push" || /^upload/.test(row.reason ?? "");
const matches = (row: SyncRow, filter: Filter) =>
  filter === "all" ||
  (filter === "conflict" ? row.group === "conflict" : row.group !== "conflict" && upward(row) === (filter === "push"));

export default function ZoteroSyncDialog({ snapshot, onClose }: { snapshot: LibrarySnapshot; onClose: () => void }) {
  const { t: translate } = useTranslation("research");
  const t: Translate = (key, options) =>
    translate(`zoteroSync.${key}`, { ...options, interpolation: { escapeValue: false } });
  const latest = useRef(snapshot);
  latest.current = snapshot;
  const [attempt, setAttempt] = useState(0);
  const [progress, setProgress] = useState<SyncProgress>({ phase: "connect", count: 0 });
  const [preview, setPreview] = useState<SyncPreview>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(true);
  const [history, setHistory] = useState<SyncHistory>();
  // Unticked rows and conflict decisions; a row missing here is ticked (or, for a conflict, skipped).
  const [choices, setChoices] = useState<Record<string, SyncChoice>>({});
  const [filter, setFilter] = useState<Filter>("all");
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
        await captureSyncFiles(next, controller.signal, report);
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

  const rows = preview?.rows ?? [];
  // Unticking a DOI/title match also drops that paper's field changes (they only make sense once linked).
  const unlinked = new Set(rows.filter((r) => r.kind === "link" && choices[rowId(r)] === "skip").map((r) => r.path));
  const locked = (row: SyncRow) => row.kind === "field" && row.group !== "conflict" && unlinked.has(row.path);
  const ticked = (row: SyncRow) =>
    row.group === "conflict"
      ? (choices[rowId(row)] ?? "skip") !== "skip"
      : choices[rowId(row)] !== "skip" && !locked(row);
  const actionable = rows.filter((row) => sectionOf(row));
  const selected = actionable.filter(ticked).length;
  const tick = (list: SyncRow[], on: boolean) =>
    setChoices((old) => {
      const next = { ...old };
      for (const row of list) {
        if (row.group === "conflict") continue;
        if (on) delete next[rowId(row)];
        else next[rowId(row)] = "skip";
      }
      return next;
    });
  const choose = (list: SyncRow[], choice: SyncChoice) =>
    setChoices((old) => ({ ...old, ...Object.fromEntries(list.map((row) => [rowId(row), choice])) }));

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

  const papers = preview?.source.remote.items.filter(
    (d) => !d.parentItem && !d.deleted && !["annotation", "note", "attachment"].includes(d.itemType ?? ""),
  ).length;
  const visible = actionable.filter((row) => matches(row, filter));
  const filters: { id: Filter; count: number }[] = (["all", "push", "pull", "conflict"] as const).map((id) => ({
    id,
    count: actionable.filter((row) => matches(row, id)).length,
  }));

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
          <DialogDescription>
            {preview ? t("connected", { local: preview.source.local.items.length, remote: papers }) : t("description")}
          </DialogDescription>
        </DialogHeader>
        {preview && !preview.blocked && (
          <div className="flex flex-wrap items-center gap-1" role="toolbar" aria-label={t("filterLabel")}>
            {filters.map(({ id, count }) => (
              <Button
                key={id}
                size="sm"
                variant={filter === id ? "secondary" : "ghost"}
                aria-pressed={filter === id}
                onClick={() => setFilter(id)}
              >
                {t(`filters.${id}`)} {count}
              </Button>
            ))}
            <span className="flex-1" />
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => tick(visible, true)}>
              {t("selectAll")}
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => tick(visible, false)}>
              {t("selectNone")}
            </Button>
          </div>
        )}
        <div className="flex min-h-0 flex-col gap-3 overflow-y-auto" aria-busy={busy}>
          {busy && <p role="status">{t(`progress.${progress.phase}`, { count: progress.count })}</p>}
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{t(`errors.${error}`)}</AlertDescription>
            </Alert>
          )}
          {!!changed.length && (
            <ul className="text-sm">
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
            <p role="status" className="text-sm">
              {t("completed", { count: history.run.actions.length, skipped: history.run.skipped })}
            </p>
          )}
          {history?.run?.status === "rolled-back" && (
            <p role="status" className="text-sm">
              {t("rolledBack")}
            </p>
          )}
          {preview?.blocked && (
            <Alert variant="destructive">
              <AlertDescription>{t("blocked")}</AlertDescription>
            </Alert>
          )}
          {!!preview?.pairingIssues.length && (
            <section aria-label={t("pairingIssues")} className="flex flex-col gap-2 text-sm">
              <h3 className="font-medium">{t("pairingIssues")}</h3>
              {preview.pairingIssues.map((issue, index) => (
                <div key={index} className="rounded-md border p-2 [overflow-wrap:anywhere]">
                  <p>
                    {t(`match.${issue.by}`)}: {issue.value}
                  </p>
                  <ul className="list-disc pl-5">
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
          {preview && !preview.blocked && !visible.length && (
            <p className="text-muted-foreground text-sm">{t("noChanges")}</p>
          )}
          {preview &&
            sections.map((section) => {
              const list = visible.filter((row) => sectionOf(row) === section);
              return list.length ? (
                <RowGroup
                  key={`${attempt}:${section}`}
                  section={section}
                  rows={list}
                  root={preview.source.local.root}
                  t={t}
                  translate={translate}
                  disabled={busy}
                  choices={choices}
                  ticked={ticked}
                  locked={locked}
                  tick={tick}
                  choose={choose}
                />
              ) : null;
            })}
          {preview && <SkippedGroup preview={preview} t={t} />}
        </div>
        <DialogFooter className="items-center">
          {preview && !preview.blocked && (
            <span className="text-muted-foreground mr-auto text-sm" role="status">
              {t("selected", { count: selected, total: actionable.length })}
            </span>
          )}
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
          {preview && (
            <Button disabled={busy || preview.blocked || !selected} onClick={() => void execute(false)}>
              {t("syncCount", { count: selected })}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RowGroup({
  section,
  rows,
  root,
  t,
  translate,
  disabled,
  choices,
  ticked,
  locked,
  tick,
  choose,
}: {
  section: Section;
  rows: SyncRow[];
  root: string;
  t: Translate;
  translate: Translate;
  disabled: boolean;
  choices: Record<string, SyncChoice>;
  ticked: (row: SyncRow) => boolean;
  locked: (row: SyncRow) => boolean;
  tick: (rows: SyncRow[], on: boolean) => void;
  choose: (rows: SyncRow[], choice: SyncChoice) => void;
}) {
  const [open, setOpen] = useState(true);
  const [limit, setLimit] = useState(ROW_LIMIT);
  const conflict = section === "conflict";
  const on = rows.filter(ticked).length;
  const title = `${t(`sections.${section}`)}（${rows.length}）`;
  return (
    <section aria-label={t(`sections.${section}`)} className="flex flex-col">
      <div className="flex items-center gap-2 px-2 py-1">
        <button
          type="button"
          className="text-muted-foreground"
          aria-label={title}
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <ChevronRight className={cn("size-4 transition-transform", open && "rotate-90")} />
        </button>
        {!conflict && (
          <Checkbox
            aria-label={t("tickSection", { section: t(`sections.${section}`) })}
            checked={on === rows.length ? true : on ? "indeterminate" : false}
            disabled={disabled}
            onCheckedChange={() => tick(rows, on !== rows.length)}
          />
        )}
        <h3 className="flex-1 text-sm font-medium">{title}</h3>
        {conflict &&
          (["local", "remote"] as const).map((side) => (
            <Button key={side} size="sm" variant="ghost" disabled={disabled} onClick={() => choose(rows, side)}>
              {t(`all.${side}`)}
            </Button>
          ))}
      </div>
      {open && (
        <ul className="flex flex-col">
          {rows.slice(0, limit).map((row) => (
            <PreviewRow
              key={rowId(row)}
              row={row}
              root={root}
              t={t}
              translate={translate}
              disabled={disabled || locked(row)}
              on={ticked(row)}
              choice={choices[rowId(row)] ?? "skip"}
              tick={(value) => tick([row], value)}
              choose={(choice) => choose([row], choice)}
            />
          ))}
          {rows.length > limit && (
            <Button variant="ghost" size="sm" onClick={() => setLimit((value) => value + ROW_LIMIT)}>
              {t("showMore", { count: rows.length - limit })}
            </Button>
          )}
        </ul>
      )}
    </section>
  );
}

function PreviewRow({
  row,
  root,
  t,
  translate,
  disabled,
  on,
  choice,
  tick,
  choose,
}: {
  row: SyncRow;
  root: string;
  t: Translate;
  translate: Translate;
  disabled: boolean;
  on: boolean;
  choice: SyncChoice;
  tick: (on: boolean) => void;
  choose: (choice: SyncChoice) => void;
}) {
  const [open, setOpen] = useState(false);
  const conflict = row.group === "conflict";
  const up = upward(row);
  const value = (v: SyncValue | undefined) => {
    if (v === undefined || v === "" || (Array.isArray(v) && !v.length)) return t("emptyValue");
    const list = (Array.isArray(v) ? v : [v]).map((item) =>
      row.field === "status"
        ? (() => {
            const status = Object.entries(libraryStatuses).find(([, label]) => label === item)?.[0];
            return status ? translate(`library.status.${status}`) : item;
          })()
        : item,
    );
    return list.join("、");
  };
  const [from, to] = up ? [row.remote, row.local] : [row.local, row.remote];
  const note = conflict
    ? t("row.conflict", { field: t(`fields.${row.field}`), local: value(row.local), remote: value(row.remote) })
    : row.kind === "field"
      ? t("row.field", { field: t(`fields.${row.field}`), from: value(from), to: value(to) })
      : row.kind === "collection" && row.reason === "renameCollection"
        ? t("row.rename", { from: value(from), to: value(to) })
        : row.kind === "link"
          ? t("row.link", { method: t(`match.${row.matchedBy}`) })
          : t(
              `row.${row.reason}${row.reason === "newItem" || row.reason === "newCollection" ? (up ? "Push" : "Pull") : ""}`,
              {
                size: formatSize(row.size),
              },
            );
  const Arrow = up ? ArrowUp : ArrowDown;
  return (
    <li className={cn("flex flex-col rounded", !on && !conflict && "opacity-60")}>
      <div className="hover:bg-accent/50 flex items-center gap-2 rounded px-2 py-1 text-sm">
        {conflict ? (
          <span className="size-4 shrink-0" />
        ) : (
          <Checkbox
            aria-label={`${row.title} ${note}`}
            checked={on}
            disabled={disabled}
            onCheckedChange={(v) => tick(!!v)}
          />
        )}
        {!conflict && (
          <Arrow
            className={cn("size-3.5 shrink-0", up ? "text-sky-600" : "text-emerald-600")}
            aria-label={t(up ? "filters.push" : "filters.pull")}
          />
        )}
        <button
          type="button"
          className="min-w-0 flex-1 truncate text-left"
          title={row.title}
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {row.title || row.key}
        </button>
        <span className="text-muted-foreground max-w-[50%] truncate text-xs" title={note}>
          {note}
        </span>
        {conflict && (
          <div className="flex shrink-0 rounded-md border" role="group" aria-label={`${row.title} ${t("choiceLabel")}`}>
            {(["local", "remote", "skip"] as const).map((side) => (
              <Button
                key={side}
                size="sm"
                variant={choice === side ? "secondary" : "ghost"}
                className="h-6 rounded-none px-2 text-xs first:rounded-l-md last:rounded-r-md"
                aria-pressed={choice === side}
                disabled={disabled}
                onClick={() => choose(side)}
              >
                {t(`choices.${side}`)}
              </Button>
            ))}
          </div>
        )}
      </div>
      {open && (
        <div className="text-muted-foreground mb-1 ml-14 flex flex-col gap-1 text-xs [overflow-wrap:anywhere]">
          <p>
            {[row.path && previewPath(root, row.path), row.key && !row.key.startsWith("local:") && row.key]
              .filter(Boolean)
              .join(" · ")}
          </p>
          {row.reason && <p>{t(`reasons.${row.reason}`)}</p>}
          {(row.local !== undefined || row.remote !== undefined) && (
            <dl className="text-foreground grid grid-cols-2 gap-3">
              <div>
                <dt className="text-muted-foreground">{t("local")}</dt>
                <dd className="whitespace-pre-wrap">{value(row.local)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t("remote")}</dt>
                <dd className="whitespace-pre-wrap">{value(row.remote)}</dd>
              </div>
            </dl>
          )}
        </div>
      )}
    </li>
  );
}

function SkippedGroup({ preview, t }: { preview: SyncPreview; t: Translate }) {
  const [open, setOpen] = useState(false);
  const { summary } = preview;
  const lines = [
    summary.unchanged ? t("summary.unchanged", { count: summary.unchanged }) : "",
    summary.deferred.total ? t("summary.deferred", { ...summary.deferred, count: summary.deferred.total }) : "",
    summary.missingCollections ? t("summary.missingCollections", { count: summary.missingCollections }) : "",
    ...preview.rows
      .filter((row) => row.group === "skip")
      .map((row) =>
        [row.title, row.path ? previewPath(preview.source.local.root, row.path) : row.key, t(`reasons.${row.reason}`)]
          .filter(Boolean)
          .join(" · "),
      ),
  ].filter(Boolean);
  if (!lines.length) return null;
  return (
    <section aria-label={t("sections.skip")} className="flex flex-col">
      <button
        type="button"
        className="flex items-center gap-2 px-2 py-1 text-left text-sm font-medium"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <ChevronRight className={cn("text-muted-foreground size-4 transition-transform", open && "rotate-90")} />
        {t("sections.skip")}（{lines.length}）
      </button>
      {open && (
        <ul className="text-muted-foreground ml-8 flex list-disc flex-col gap-1 pl-4 text-xs">
          {lines.map((line, index) => (
            <li key={index}>{line}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

function formatSize(size?: number) {
  if (size === undefined) return "";
  return size < 1024
    ? `${size} B`
    : size < 1024 * 1024
      ? `${Math.round(size / 1024)} KB`
      : `${(size / 1024 / 1024).toFixed(1)} MB`;
}
