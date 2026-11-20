import { OverlayHost } from "@/components/overlay-host";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Settings } from "@/core/service/Settings";
import { store } from "@/state";
import { cn } from "@/utils/cn";
import { atom, useAtomValue } from "jotai";
import i18next from "i18next";
import {
  CalendarDays,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ClipboardPaste,
  ExternalLink,
  FileText,
  GripHorizontal,
  ImagePlus,
  Images,
  Link,
  ListTodo,
  LoaderCircle,
  Maximize2,
  Minimize2,
  Minus,
  NotebookPen,
  Pencil,
  Plus,
  Presentation,
  RefreshCw,
  Sparkles,
  X,
} from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { openDocumentFile } from "./DocumentTab";
import { ResearchFolder } from "./ResearchFolder";
import { RESEARCH_CONTENT_SAVED_EVENT } from "./ResearchShell";
import {
  appendWeeklyItem,
  currentWeeklyContextLink,
  displayWeeklyLink,
  ensureWeeklyRecord,
  listWeeklyRecords,
  loadWeeklyRecord,
  openWeeklyLink,
  setWeeklyItemDone,
  summarizeWeeklyItem,
  updateWeeklyItem,
  WEEKLY_PROGRESS_CHANGED_EVENT,
  weekStartDate,
  type WeeklyItem,
  type WeeklyLink,
  type WeeklyRecord,
  type WeeklySection,
} from "./WeeklyProgress";
import { importWeeklyImages, loadWeeklyImagePreview, pasteWeeklyImage } from "./WeeklyProgressMedia";
import { generateWeeklyItemSummary } from "./WeeklyProgressSummary";

type Translate = (key: string, options?: Record<string, unknown>) => string;
const sections: WeeklySection[] = ["done", "todo", "notes", "next"];
const fieldClass =
  "border-input bg-background focus-visible:ring-ring/50 h-9 min-w-0 rounded-md border px-2 text-sm outline-none focus-visible:ring-2 disabled:opacity-50";

function useWeeklyText(): Translate {
  const { t } = useTranslation("research");
  return useCallback((key, options) => t(`weekly.${key}`, { ...options, interpolation: { escapeValue: false } }), [t]);
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const [code, ...details] = message.split(": ");
  const key = code.startsWith("researchReport.")
    ? `progress.reportErrors.${code.replace(/^researchReport\./, "")}`
    : code.startsWith("history.")
      ? `progress.errors.${code}`
      : `weekly.errors.${code.replace(/^weekly\./, "")}`;
  return i18next.exists(key, { ns: "research" }) ? [i18next.t(key, { ns: "research" }), ...details].join(" ") : message;
}

function useProjectRoot() {
  const [root, setRoot] = useState(() => ResearchFolder.getRoot());
  useEffect(() => Settings.watch("researchFolderPath", () => setRoot(ResearchFolder.getRoot())), []);
  return root;
}

function projectName(root: string) {
  return root.replace(/\\/g, "/").split("/").filter(Boolean).at(-1) ?? root;
}

export function weeklySectionItems(record: WeeklyRecord | null, section: WeeklySection) {
  return (record?.items ?? []).filter((item) => {
    const completedTask = (item.section === "todo" || item.section === "next") && item.done;
    if (section === "done") return item.section === "done" || completedTask;
    return item.section === section && !completedTask;
  });
}

function weekLabel(week: string) {
  const date = new Date(`${week}T12:00:00`);
  date.setDate(date.getDate() + 6);
  return `${week} — ${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function shiftedWeek(week: string, days: number) {
  const date = new Date(`${week}T12:00:00`);
  date.setDate(date.getDate() + days);
  return weekStartDate(date);
}

function useRecord(root: string, week: string) {
  const [record, setRecord] = useState<WeeklyRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const reload = useCallback(() => setRefresh((value) => value + 1), []);
  useEffect(() => {
    let stopped = false;
    setRecord(null);
    setError("");
    setLoading(true);
    if (!root) {
      setLoading(false);
      return;
    }
    void loadWeeklyRecord(root, week)
      .then((value) => {
        if (!stopped) setRecord(value);
      })
      .catch((cause) => {
        if (!stopped) setError(errorMessage(cause));
      })
      .finally(() => {
        if (!stopped) setLoading(false);
      });
    return () => {
      stopped = true;
    };
  }, [root, week, refresh]);
  useEffect(() => {
    const changed = (event: Event) => {
      const detail = (event as CustomEvent<{ root?: string; path?: string }>).detail;
      if (detail?.root && detail.root !== root) return;
      if (
        event.type === RESEARCH_CONTENT_SAVED_EVENT &&
        detail?.path &&
        record &&
        detail.path.replace(/\\/g, "/").toLowerCase() !==
          ResearchFolder.toAbsolute(record.path, root).replace(/\\/g, "/").toLowerCase()
      )
        return;
      reload();
    };
    window.addEventListener(WEEKLY_PROGRESS_CHANGED_EVENT, changed);
    window.addEventListener(RESEARCH_CONTENT_SAVED_EVENT, changed);
    window.addEventListener("focus", reload);
    return () => {
      window.removeEventListener(WEEKLY_PROGRESS_CHANGED_EVENT, changed);
      window.removeEventListener(RESEARCH_CONTENT_SAVED_EVENT, changed);
      window.removeEventListener("focus", reload);
    };
  }, [root, record, reload]);
  return { record, setRecord, loading, error, setError, reload, refreshVersion: refresh };
}

function readLink(root: string, record: WeeklyRecord, link: WeeklyLink, onNavigate?: () => void) {
  void openWeeklyLink(root, record, link)
    .then(() => onNavigate?.())
    .catch((error) => toast.error(errorMessage(error)));
}

function openFullRecord(root: string, record: WeeklyRecord) {
  void openDocumentFile(ResearchFolder.toAbsolute(record.path, root)).catch((error) =>
    toast.error(errorMessage(error)),
  );
}

function useSummarySuggestion({
  root,
  week,
  text,
  section,
  title,
  scope,
  onResult,
  onError,
}: {
  root: string;
  week: string;
  text: string;
  section: WeeklySection;
  title: string;
  scope?: string;
  onResult: (value: string) => void;
  onError: (message: string) => void;
}) {
  const [summarizing, setSummarizing] = useState(false);
  const request = useRef<AbortController | undefined>(undefined);
  const alive = useRef(true);
  const identity = JSON.stringify([root, week, scope, text, section, title]);
  const latest = useRef(identity);
  latest.current = identity;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      request.current?.abort();
    };
  }, []);
  useEffect(() => () => request.current?.abort(), [identity]);
  async function suggest() {
    if (!text.trim() || summarizing) return;
    const controller = new AbortController();
    request.current?.abort();
    request.current = controller;
    const expected = identity;
    setSummarizing(true);
    onError("");
    try {
      const value = await generateWeeklyItemSummary(text, section, controller.signal);
      if (alive.current && !controller.signal.aborted && latest.current === expected) onResult(value);
    } catch (cause) {
      if (alive.current && !controller.signal.aborted && latest.current === expected) onError(errorMessage(cause));
    } finally {
      if (alive.current && request.current === controller) setSummarizing(false);
    }
  }
  return { summarizing, suggest };
}

function ImagePreview({
  root,
  record,
  link,
  onRemove,
  onNavigate,
  disabled,
  t,
}: {
  root: string;
  record: WeeklyRecord;
  link: WeeklyLink;
  onRemove?: () => void;
  onNavigate?: () => void;
  disabled?: boolean;
  t: Translate;
}) {
  const [src, setSrc] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let stopped = false;
    setSrc("");
    setError("");
    void loadWeeklyImagePreview(root, record, link)
      .then((value) => {
        if (!stopped) setSrc(value);
      })
      .catch((cause) => {
        if (!stopped) setError(errorMessage(cause));
      });
    return () => {
      stopped = true;
    };
  }, [root, record.path, link.href]);
  return (
    <div className="group border-border/70 bg-background relative w-24 overflow-hidden rounded-lg border">
      <button
        type="button"
        className="flex h-20 w-full items-center justify-center overflow-hidden"
        title={displayWeeklyLink(record.path, link.href)}
        aria-label={t("viewImage", { name: link.label })}
        disabled={disabled}
        onClick={() => readLink(root, record, link, onNavigate)}
      >
        {src ? (
          <img src={src} alt={link.label} className="h-full w-full object-cover" />
        ) : error ? (
          <span role="alert" className="text-destructive px-1 text-[10px] leading-tight">
            {error}
          </span>
        ) : (
          <LoaderCircle className="text-muted-foreground size-4 animate-spin" />
        )}
      </button>
      <p className="text-muted-foreground truncate px-1.5 py-1 text-[10px]" title={link.label}>
        {link.label}
      </p>
      {onRemove && (
        <Button
          type="button"
          size="icon"
          variant="secondary"
          className="absolute top-1 right-1 size-5 rounded-full"
          aria-label={t("removeImage", { name: link.label })}
          onClick={onRemove}
        >
          <X className="size-3" />
        </Button>
      )}
    </div>
  );
}

function ItemRow({
  root,
  record,
  item,
  busy,
  onToggle,
  compact,
  onNavigate,
  onEdit,
  focused,
  t,
}: {
  root: string;
  record: WeeklyRecord;
  item: WeeklyItem;
  busy: boolean;
  onToggle: (item: WeeklyItem) => void;
  compact?: boolean;
  onNavigate?: () => void;
  onEdit?: (item: WeeklyItem) => void;
  focused?: boolean;
  t: Translate;
}) {
  const checkable = item.section === "todo" || item.section === "next";
  const title = item.summary || summarizeWeeklyItem(item.text, item.section) || t("imageRecord");
  const row = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focused) row.current?.scrollIntoView?.({ block: "center" });
  }, [focused]);
  return (
    <div
      ref={row}
      data-weekly-item={item.id}
      className={cn(
        "flex items-start gap-2.5 rounded-md",
        compact ? "py-1.5" : "py-2",
        focused && "bg-primary/5 ring-primary/30 -mx-1 px-1 ring-1",
      )}
    >
      {checkable ? (
        <input
          type="checkbox"
          checked={item.done}
          disabled={busy}
          aria-label={t(item.done ? "markPending" : "markDone", { text: item.text })}
          className="accent-primary mt-1 size-3.5 shrink-0"
          onChange={() => onToggle(item)}
        />
      ) : item.section === "done" ? (
        <Check className="text-primary mt-0.5 size-4 shrink-0" />
      ) : (
        <span className="bg-muted-foreground/50 mt-2 size-1.5 shrink-0 rounded-full" />
      )}
      <div className="min-w-0 flex-1">
        {compact ? (
          <button
            type="button"
            className="hover:text-primary text-left text-xs leading-relaxed font-medium break-words"
            aria-label={t("inspectItem", { title })}
            onClick={() => openWeeklyProgressDialog(record.weekStart, item.id)}
          >
            {title}
          </button>
        ) : (
          <div className="flex items-start gap-1">
            <p className="min-w-0 flex-1 text-sm leading-relaxed font-medium break-words">{title}</p>
            {onEdit && (
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="text-muted-foreground size-6 shrink-0"
                title={t("editItem")}
                aria-label={t("editItemNamed", { title })}
                disabled={busy}
                onClick={() => onEdit(item)}
              >
                <Pencil className="size-3" />
              </Button>
            )}
          </div>
        )}
        {!compact && item.text && item.text !== title && (
          <p className="text-muted-foreground mt-1 text-xs leading-relaxed break-words whitespace-pre-wrap">
            {item.text}
          </p>
        )}
        {!!item.links.length && (
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
            {item.links.map((link, index) => (
              <button
                key={`${link.href}-${index}`}
                type="button"
                title={displayWeeklyLink(record.path, link.href)}
                disabled={busy}
                className="text-primary inline-flex max-w-full items-center gap-1 text-xs hover:underline"
                onClick={() => readLink(root, record, link, onNavigate)}
              >
                <ExternalLink className="size-3 shrink-0" />
                <span className="truncate">{link.label}</span>
              </button>
            ))}
          </div>
        )}
        {!!item.images?.length &&
          (compact ? (
            <button
              type="button"
              className="text-muted-foreground mt-1 flex items-center gap-1 text-[10px] hover:underline"
              onClick={() => openWeeklyProgressDialog(record.weekStart, item.id)}
            >
              <Images className="size-3" />
              {t("imageCount", { count: item.images.length })}
            </button>
          ) : (
            <div className="mt-2 flex flex-wrap gap-2">
              {item.images.map((link, index) => (
                <ImagePreview
                  key={`${index}-${link.href}`}
                  {...{ root, record, link, onNavigate, t }}
                  disabled={busy}
                />
              ))}
            </div>
          ))}
      </div>
    </div>
  );
}

function RecordSections({
  root,
  record,
  busy,
  onToggle,
  compact,
  onNavigate,
  onEdit,
  focusedItemId,
  t,
}: {
  root: string;
  record: WeeklyRecord | null;
  busy: boolean;
  onToggle: (item: WeeklyItem) => void;
  compact?: boolean;
  onNavigate?: () => void;
  onEdit?: (item: WeeklyItem) => void;
  focusedItemId?: string;
  t: Translate;
}) {
  const [expanded, setExpanded] = useState<WeeklySection[]>([]);
  useEffect(() => setExpanded([]), [record?.weekStart]);
  return (
    <div className={compact ? "space-y-3" : "grid gap-3 sm:grid-cols-2"}>
      {sections.map((section) => {
        const items = weeklySectionItems(record, section);
        const visible = compact && !expanded.includes(section) ? items.slice(0, 3) : items;
        return (
          <section
            key={section}
            aria-label={t(`section.${section}`)}
            className={cn(!compact && "border-border/65 rounded-xl border px-4 py-3")}
          >
            <div className="mb-1.5 flex items-center gap-2">
              <h3 className="text-xs font-medium">{t(`section.${section}`)}</h3>
              <span className="text-muted-foreground text-[11px]">{items.length}</span>
            </div>
            {record &&
              visible.map((item) => (
                <ItemRow
                  key={item.id}
                  {...{ root, record, item, busy, onToggle, compact, onNavigate, onEdit, t }}
                  focused={item.id === focusedItemId}
                />
              ))}
            {!items.length && <p className="text-muted-foreground py-1 text-xs">{t(`empty.${section}`)}</p>}
            {compact && items.length > 3 && (
              <button
                type="button"
                className="text-muted-foreground mt-1 flex items-center gap-1 text-[11px] hover:underline"
                onClick={() =>
                  setExpanded((value) =>
                    value.includes(section) ? value.filter((key) => key !== section) : [...value, section],
                  )
                }
              >
                <ChevronDown className="size-3" />
                {t(expanded.includes(section) ? "less" : "more", { count: items.length - 3 })}
              </button>
            )}
          </section>
        );
      })}
    </div>
  );
}

interface WeeklyDraft {
  section: WeeklySection;
  text: string;
  manualTitle?: string;
  images: WeeklyLink[];
  links: WeeklyLink[];
  linkLabel: string;
  linkHref: string;
  showLink: boolean;
  linkIndex?: number;
}

interface WeeklyEdit {
  base: WeeklyRecord;
  itemId: string;
  token: string;
}

export function WeeklyProgressDialog({
  root,
  initialWeek,
  initialItemId,
  onClose,
}: {
  root: string;
  initialWeek?: string;
  initialItemId?: string;
  onClose: () => void;
}) {
  const t = useWeeklyText();
  const [week, setWeek] = useState(initialWeek ?? weekStartDate());
  const [records, setRecords] = useState<WeeklyRecord[]>([]);
  const { record, setRecord, loading, error, setError, reload, refreshVersion } = useRecord(root, week);
  const [busy, setBusy] = useState(false);
  const [section, setSection] = useState<WeeklySection>("done");
  const [text, setText] = useState("");
  const [manualTitle, setManualTitle] = useState<string | undefined>(undefined);
  const [images, setImages] = useState<WeeklyLink[]>([]);
  const [links, setLinks] = useState<WeeklyLink[]>([]);
  const [linkLabel, setLinkLabel] = useState("");
  const [linkHref, setLinkHref] = useState("");
  const [showLink, setShowLink] = useState(false);
  const [linkIndex, setLinkIndex] = useState<number | undefined>(undefined);
  const [editing, setEditing] = useState<WeeklyEdit | null>(null);
  const editSequence = useRef(0);
  const form = useRef<HTMLFormElement>(null);
  const drafts = useRef(new Map<string, WeeklyDraft>());
  const attachmentRequest = useRef<AbortController | undefined>(undefined);
  const scope = editing?.token ?? "create";
  const identity = useRef({ root, week, scope });
  identity.current = { root, week, scope };
  const alive = useRef(true);
  const id = useId();
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      attachmentRequest.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (editing) {
      form.current?.scrollIntoView?.({ block: "start" });
      document.getElementById(`${id}-title`)?.focus({ preventScroll: true });
    }
  }, [editing?.token]);
  useEffect(
    () =>
      Settings.watch("researchFolderPath", () => {
        if (ResearchFolder.getRoot() !== root) {
          attachmentRequest.current?.abort();
          onClose();
        }
      }),
    [root, onClose],
  );
  useEffect(() => {
    let stopped = false;
    void listWeeklyRecords(root)
      .then((value) => {
        if (!stopped) setRecords(value);
      })
      .catch((cause) => {
        if (!stopped) setError(errorMessage(cause));
      });
    return () => {
      stopped = true;
    };
  }, [root, record?.revision, refreshVersion, setError]);
  const weeks = [...new Set([weekStartDate(), week, ...records.map((value) => value.weekStart)])].sort().reverse();
  const draftRecord = editing?.base ??
    record ?? {
      weekStart: week,
      path: `进展记录/周进展/${week}.md`,
      markdown: "",
      revision: "",
      items: [],
      links: [],
    };
  const title =
    manualTitle ??
    (summarizeWeeklyItem(text, section) || (images.length ? t("imageRecord") : links.length ? t("linkedRecord") : ""));
  const canSave = !!(text.trim() || title.trim() || images.length || links.length || linkHref.trim());
  const { summarizing, suggest } = useSummarySuggestion({
    root,
    week,
    text,
    section,
    title,
    scope,
    onResult: setManualTitle,
    onError: setError,
  });
  const itemLinkTargets = new Set(
    record?.items.flatMap((item) => [...item.links, ...(item.images ?? [])]).map((link) => link.href),
  );
  const detailLinks = record?.links.filter((link) => !itemLinkTargets.has(link.href)) ?? [];

  function currentDraft(): WeeklyDraft {
    return { section, text, manualTitle, images, links, linkLabel, linkHref, showLink, linkIndex };
  }
  function restoreDraft(draft?: WeeklyDraft) {
    setSection(draft?.section ?? "done");
    setText(draft?.text ?? "");
    setManualTitle(draft?.manualTitle);
    setImages(draft?.images ?? []);
    setLinks(draft?.links ?? []);
    setLinkLabel(draft?.linkLabel ?? "");
    setLinkHref(draft?.linkHref ?? "");
    setShowLink(draft?.showLink ?? false);
    setLinkIndex(draft?.linkIndex);
  }

  function beginEdit(item: WeeklyItem) {
    if (busy || loading || editing || !record) return;
    drafts.current.set(week, currentDraft());
    attachmentRequest.current?.abort();
    restoreDraft({
      section: item.section,
      text: item.text,
      manualTitle: item.summary || summarizeWeeklyItem(item.text, item.section),
      images: [...(item.images ?? [])],
      links: [...item.links],
      linkLabel: "",
      linkHref: "",
      showLink: false,
    });
    setEditing({ base: record, itemId: item.id, token: `edit-${++editSequence.current}` });
    setError("");
  }

  function cancelEdit() {
    attachmentRequest.current?.abort();
    setEditing(null);
    restoreDraft(drafts.current.get(week));
    setError("");
  }

  function selectedLinks(): WeeklyLink[] | undefined {
    if (!showLink) return links;
    if (!linkHref.trim()) {
      if (linkLabel.trim() || linkIndex !== undefined) {
        setError(t("linkRequired"));
        return;
      }
      return links;
    }
    const value = { label: linkLabel.trim() || t("source"), href: linkHref.trim() };
    const next =
      linkIndex === undefined ? [...links, value] : links.map((link, index) => (index === linkIndex ? value : link));
    return next.filter(
      (link, index, all) => all.findIndex((other) => other.href === link.href && other.label === link.label) === index,
    );
  }

  function confirmLink() {
    const next = selectedLinks();
    if (!next) return;
    setLinks(next);
    setShowLink(false);
    setLinkIndex(undefined);
    setLinkLabel("");
    setLinkHref("");
    setError("");
  }

  async function saveItem() {
    const nextLinks = selectedLinks();
    if (!nextLinks) return;
    const currentEdit = editing;
    const summary =
      title.trim() || summarizeWeeklyItem(text, section) || t(images.length ? "imageRecord" : "linkedRecord");
    const saved = await mutate(
      (base) =>
        currentEdit
          ? updateWeeklyItem(root, base, currentEdit.itemId, { summary, text, links: nextLinks, images })
          : appendWeeklyItem(root, base, section, text.trim(), undefined, { summary, images, links: nextLinks }),
      !currentEdit,
      currentEdit?.base,
    );
    if (saved && currentEdit && alive.current && identity.current.scope === currentEdit.token) {
      cancelEdit();
      reload();
    }
  }

  function changeWeek(next: string) {
    if (busy || editing || next === week) return;
    drafts.current.set(week, currentDraft());
    const draft = drafts.current.get(next);
    setWeek(next);
    restoreDraft(draft);
  }

  async function mutate(
    action: (current: WeeklyRecord) => Promise<WeeklyRecord>,
    clear = false,
    fixedBase?: WeeklyRecord,
  ) {
    if (busy || loading) return false;
    const requested = { root, week, scope };
    const current = () =>
      alive.current &&
      identity.current.root === requested.root &&
      identity.current.week === requested.week &&
      identity.current.scope === requested.scope;
    setBusy(true);
    setError("");
    try {
      const base = fixedBase ?? record ?? (await ensureWeeklyRecord(root, week));
      if (!current()) return false;
      const saved = await action(base);
      if (current()) {
        setRecord(saved);
        if (clear) {
          drafts.current.delete(week);
          restoreDraft();
        }
        return true;
      }
    } catch (cause) {
      if (current()) setError(errorMessage(cause));
    } finally {
      if (current()) setBusy(false);
    }
    return false;
  }

  async function attachCurrent() {
    if (busy) return;
    const requestedScope = scope;
    setBusy(true);
    setError("");
    try {
      const link = await currentWeeklyContextLink(root, draftRecord);
      if (
        !alive.current ||
        identity.current.week !== week ||
        identity.current.root !== root ||
        identity.current.scope !== requestedScope
      )
        return;
      if (!link) {
        setError(t("noContext"));
        return;
      }
      setLinks((previous) => (previous.some((value) => value.href === link.href) ? previous : [...previous, link]));
    } catch (cause) {
      if (alive.current) setError(errorMessage(cause));
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  async function attachImages(paste = false) {
    if (busy) return;
    const controller = new AbortController();
    attachmentRequest.current?.abort();
    attachmentRequest.current = controller;
    const requested = { root, week, scope };
    const current = () =>
      alive.current &&
      !controller.signal.aborted &&
      identity.current.root === requested.root &&
      identity.current.week === requested.week &&
      identity.current.scope === requested.scope;
    setBusy(true);
    setError("");
    try {
      const added = paste
        ? [await pasteWeeklyImage(root, draftRecord, controller.signal)].filter((value): value is WeeklyLink => !!value)
        : await importWeeklyImages(root, draftRecord, controller.signal);
      if (!current()) return;
      if (paste && !added.length) setError(t("noClipboardImage"));
      setImages((previous) => {
        const seen = new Set(previous.map((link) => link.href));
        return [
          ...previous,
          ...added.filter((link) => {
            if (seen.has(link.href)) return false;
            seen.add(link.href);
            return true;
          }),
        ];
      });
    } catch (cause) {
      if (current()) setError(errorMessage(cause));
    } finally {
      if (alive.current && attachmentRequest.current === controller) setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="flex max-h-[min(84vh,54rem)] flex-col gap-0 overflow-hidden rounded-xl p-0 sm:max-w-[min(52rem,calc(100%-2rem))]">
        <DialogHeader className="gap-1 px-5 pt-5 pb-4 text-left">
          <DialogTitle className="flex items-center gap-2 text-base">
            <ListTodo className="size-4" />
            {t("title")}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {projectName(root)} · {t("subtitle")}
          </DialogDescription>
        </DialogHeader>
        <div className="border-border/60 flex flex-wrap items-center gap-2 border-b px-5 pb-3">
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            disabled={busy || !!editing}
            aria-label={t("previousWeek")}
            onClick={() => changeWeek(shiftedWeek(week, -7))}
          >
            <ChevronLeft className="size-4" />
          </Button>
          <select
            aria-label={t("chooseWeek")}
            className={cn(fieldClass, "h-8 max-w-full flex-1 text-xs sm:flex-none")}
            value={week}
            disabled={busy || !!editing}
            onChange={(event) => changeWeek(event.target.value)}
          >
            {weeks.map((value) => (
              <option key={value} value={value}>
                {weekLabel(value)}
                {value === weekStartDate() ? ` · ${t("thisWeek")}` : ""}
              </option>
            ))}
          </select>
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            disabled={busy || !!editing}
            aria-label={t("nextWeek")}
            onClick={() => changeWeek(shiftedWeek(week, 7))}
          >
            <ChevronRight className="size-4" />
          </Button>
          {week !== weekStartDate() && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              disabled={busy || !!editing}
              onClick={() => changeWeek(weekStartDate())}
            >
              {t("thisWeek")}
            </Button>
          )}
          <Button variant="ghost" size="sm" className="ml-auto h-7 px-2 text-xs" disabled={busy} onClick={reload}>
            <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
            {t("refresh")}
          </Button>
        </div>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
          {error && !editing && (
            <p role="alert" className="text-destructive rounded-lg border px-3 py-2 text-sm break-words">
              {error}
            </p>
          )}
          {loading ? (
            <p role="status" className="text-muted-foreground flex items-center gap-2 py-8 text-sm">
              <LoaderCircle className="size-4 animate-spin" />
              {t("loading")}
            </p>
          ) : (
            <>
              {!record && (
                <p className="text-muted-foreground rounded-lg border border-dashed px-3 py-2 text-xs leading-relaxed">
                  {t("emptyWeek")}
                </p>
              )}
              <RecordSections
                root={root}
                record={record}
                busy={busy || !!editing}
                onToggle={(item) => void mutate((current) => setWeeklyItemDone(root, current, item.id, !item.done))}
                onNavigate={onClose}
                onEdit={beginEdit}
                focusedItemId={week === (initialWeek ?? weekStartDate()) ? initialItemId : undefined}
                t={t}
              />
              {!!record && !!detailLinks.length && (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t pt-3">
                  <span className="text-muted-foreground text-xs">{t("detailLinks")}</span>
                  {detailLinks.map((link, index) => (
                    <button
                      type="button"
                      className="text-primary inline-flex max-w-full items-center gap-1 text-xs hover:underline"
                      title={displayWeeklyLink(record.path, link.href)}
                      disabled={busy || !!editing}
                      key={`${link.href}-${index}`}
                      onClick={() => readLink(root, record, link, onClose)}
                    >
                      <ExternalLink className="size-3 shrink-0" />
                      <span className="truncate">{link.label}</span>
                    </button>
                  ))}
                </div>
              )}
              <form
                ref={form}
                aria-label={t(editing ? "editItem" : "addItem")}
                className={cn(
                  "space-y-3 rounded-xl border p-3",
                  editing ? "bg-primary/5 border-primary/30" : "bg-muted/20 border-border/60",
                )}
                onPaste={(event) => {
                  if ([...event.clipboardData.items].some((value) => value.type.startsWith("image/"))) {
                    event.preventDefault();
                    void attachImages(true);
                  }
                }}
                onSubmit={(event) => {
                  event.preventDefault();
                  if (canSave) void saveItem();
                }}
              >
                <div className="flex items-center gap-2">
                  {editing ? (
                    <Pencil className="text-primary size-3.5" />
                  ) : (
                    <Plus className="text-muted-foreground size-3.5" />
                  )}
                  <label htmlFor={`${id}-title`} className="text-xs font-medium">
                    {t(editing ? "editItem" : "addItem")}
                  </label>
                  <select
                    className={cn(fieldClass, "ml-auto h-7 text-xs")}
                    value={section}
                    disabled={busy || !!editing}
                    aria-label={t("itemSection")}
                    onChange={(event) => setSection(event.target.value as WeeklySection)}
                  >
                    {sections.map((value) => (
                      <option key={value} value={value}>
                        {t(`section.${value}`)}
                      </option>
                    ))}
                  </select>
                </div>
                {editing && <p className="text-muted-foreground text-xs leading-relaxed">{t("editItemHint")}</p>}
                {editing && error && (
                  <p role="alert" className="text-destructive text-xs break-words">
                    {error}
                  </p>
                )}
                <div className="space-y-1.5">
                  <div className="flex items-center gap-2">
                    <Input
                      id={`${id}-title`}
                      aria-label={t("itemTitle")}
                      placeholder={t("titlePlaceholder")}
                      value={title}
                      maxLength={64}
                      disabled={busy}
                      onChange={(event) => setManualTitle(event.target.value)}
                      className="h-9 text-sm font-medium"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-8 shrink-0 px-2 text-xs"
                      disabled={busy || summarizing || !text.trim()}
                      onClick={() => void suggest()}
                    >
                      {summarizing ? (
                        <LoaderCircle className="size-3.5 animate-spin" />
                      ) : (
                        <Sparkles className="size-3.5" />
                      )}
                      {t("aiSummary")}
                    </Button>
                  </div>
                  <p className="text-muted-foreground text-[11px]">{t("summaryHint")}</p>
                </div>
                <Textarea
                  id={`${id}-text`}
                  aria-label={t("itemDetails")}
                  value={text}
                  disabled={busy}
                  rows={2}
                  className="min-h-16 resize-y text-sm"
                  placeholder={t("detailsPlaceholder")}
                  onChange={(event) => setText(event.target.value)}
                />
                {!!links.length && (
                  <div className="space-y-2">
                    {links.map((link, index) => (
                      <div
                        key={`${index}-${link.href}`}
                        className="border-border/70 bg-background flex items-start gap-2 rounded-lg border p-2.5"
                      >
                        <FileText className="text-primary mt-0.5 size-4 shrink-0" />
                        <div className="min-w-0 flex-1">
                          <p className="text-xs font-medium break-words">{link.label || t("source")}</p>
                          <p className="text-muted-foreground mt-1 text-[11px] break-words">
                            {displayWeeklyLink(draftRecord.path, link.href)}
                          </p>
                        </div>
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          className="size-6 shrink-0"
                          aria-label={t("editNamedLink", { name: link.label })}
                          title={t("editLink")}
                          disabled={busy || showLink}
                          onClick={() => {
                            setLinkIndex(index);
                            setLinkHref(link.href);
                            setLinkLabel(link.label);
                            setShowLink(true);
                          }}
                        >
                          <Pencil className="size-3" />
                        </Button>
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          className="size-6 shrink-0"
                          aria-label={t("removeNamedLink", { name: link.label })}
                          disabled={busy || showLink}
                          onClick={() => setLinks((previous) => previous.filter((_, position) => position !== index))}
                        >
                          <X className="size-3" />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
                {showLink && (
                  <div className="border-border/70 bg-background space-y-2 rounded-lg border p-2.5">
                    <div className="grid gap-2 sm:grid-cols-[1fr_2fr]">
                      <Input
                        aria-label={t("linkLabel")}
                        placeholder={t("linkLabel")}
                        value={linkLabel}
                        disabled={busy}
                        onChange={(event) => setLinkLabel(event.target.value)}
                      />
                      <Input
                        aria-label={t("linkTarget")}
                        placeholder={t("linkPlaceholder")}
                        value={linkHref}
                        disabled={busy}
                        onChange={(event) => setLinkHref(event.target.value)}
                      />
                    </div>
                    <div className="flex gap-2">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-6 px-1.5 text-[11px]"
                        disabled={!linkHref.trim() || busy}
                        onClick={confirmLink}
                      >
                        {t("confirmLink")}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-6 px-1.5 text-[11px]"
                        disabled={busy}
                        onClick={() => {
                          setShowLink(false);
                          setLinkIndex(undefined);
                          setLinkHref("");
                          setLinkLabel("");
                        }}
                      >
                        {t("cancelLink")}
                      </Button>
                    </div>
                  </div>
                )}
                {!!images.length && (
                  <div className="flex flex-wrap gap-2">
                    {images.map((link, index) => (
                      <ImagePreview
                        key={`${index}-${link.href}`}
                        root={root}
                        record={draftRecord}
                        link={link}
                        t={t}
                        onRemove={
                          busy
                            ? undefined
                            : () => setImages((value) => value.filter((_, position) => position !== index))
                        }
                      />
                    ))}
                  </div>
                )}
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    disabled={busy}
                    onClick={() => void attachCurrent()}
                  >
                    <Link className="size-3.5" />
                    {t("attachCurrent")}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    disabled={busy || showLink}
                    onClick={() => {
                      setShowLink(true);
                      setLinkIndex(undefined);
                      setLinkHref("");
                      setLinkLabel("");
                    }}
                  >
                    {t("attachFile")}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    disabled={busy}
                    onClick={() => void attachImages()}
                  >
                    <ImagePlus className="size-3.5" />
                    {t("addImage")}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    disabled={busy}
                    onClick={() => void attachImages(true)}
                  >
                    <ClipboardPaste className="size-3.5" />
                    {t("pasteImage")}
                  </Button>
                  {editing && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="ml-auto h-7 px-2 text-xs"
                      disabled={busy}
                      onClick={cancelEdit}
                    >
                      {t("cancelEdit")}
                    </Button>
                  )}
                  <Button
                    type="submit"
                    size="sm"
                    className={cn("h-7 text-xs", !editing && "ml-auto")}
                    disabled={busy || !canSave}
                  >
                    {busy && <LoaderCircle className="size-3.5 animate-spin" />}
                    {t(editing ? "saveChanges" : "saveItem")}
                  </Button>
                </div>
              </form>
            </>
          )}
        </div>
        <div className="border-border/60 flex flex-wrap items-center gap-2 border-t px-5 py-3">
          <Button
            size="sm"
            variant="ghost"
            className="h-8 px-2 text-xs"
            disabled={!record || busy || !!editing}
            onClick={() => {
              if (record) {
                onClose();
                openFullRecord(root, record);
              }
            }}
          >
            <FileText className="size-3.5" />
            {t("fullRecord")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-8 px-2 text-xs"
            disabled={busy || !!editing}
            onClick={() => {
              showWeeklyFloat(root);
              onClose();
            }}
          >
            <ListTodo className="size-3.5" />
            {t("showFloat")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="ml-auto h-8 text-xs"
            disabled={busy || !record || !!editing}
            onClick={() => {
              onClose();
              void import("./ResearchProgressDialog")
                .then(({ openResearchProgressDialog }) => openResearchProgressDialog("report", week))
                .catch((cause) => toast.error(errorMessage(cause)));
            }}
          >
            <Presentation className="size-3.5" />
            {t("report")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

let openedWeeklyOverlay: string | undefined;
export function openWeeklyProgressDialog(week?: string, itemId?: string): void {
  const root = ResearchFolder.getRoot();
  if (!root) {
    toast.warning(i18next.t("weekly.noProject", { ns: "research" }));
    return;
  }
  if (openedWeeklyOverlay) OverlayHost.close(openedWeeklyOverlay);
  const overlay = OverlayHost.open(
    <WeeklyProgressDialog
      root={root}
      initialWeek={week}
      initialItemId={itemId}
      onClose={() => {
        OverlayHost.close(overlay.id);
        if (openedWeeklyOverlay === overlay.id) openedWeeklyOverlay = undefined;
      }}
    />,
  );
  openedWeeklyOverlay = overlay.id;
}

interface FloatPreference {
  open: boolean;
  minimized: boolean;
  enlarged: boolean;
  x: number;
  y: number;
}
const floatRevisionAtom = atom(0);
const floatPreferences = new Map<string, FloatPreference>();
const preferenceKey = (root: string) => `labweave-weekly-float:${root.replace(/\\/g, "/").toLowerCase()}`;
function readPreference(root: string): FloatPreference {
  if (floatPreferences.has(root)) return floatPreferences.get(root)!;
  const fallback: FloatPreference = {
    open: false,
    minimized: false,
    enlarged: false,
    x: Math.max(16, window.innerWidth - 370),
    y: 90,
  };
  try {
    const raw = localStorage.getItem(preferenceKey(root));
    if (raw) {
      const value = JSON.parse(raw) as Partial<FloatPreference>;
      if (
        typeof value.open === "boolean" &&
        typeof value.minimized === "boolean" &&
        Number.isFinite(value.x) &&
        Number.isFinite(value.y)
      ) {
        const preference = { ...value, enlarged: value.enlarged === true } as FloatPreference;
        floatPreferences.set(root, preference);
        return preference;
      }
    }
  } catch {
    toast.warning(i18next.t("weekly.preferenceReadFailed", { ns: "research" }));
  }
  floatPreferences.set(root, fallback);
  return fallback;
}

function savePreference(root: string, patch: Partial<FloatPreference>) {
  const next = { ...readPreference(root), ...patch };
  floatPreferences.set(root, next);
  try {
    localStorage.setItem(preferenceKey(root), JSON.stringify(next));
  } catch {
    toast.warning(i18next.t("weekly.preferenceWriteFailed", { ns: "research" }), { id: "weekly-float-preference" });
  }
  store.set(floatRevisionAtom, (value) => value + 1);
}

function showWeeklyFloat(root: string) {
  savePreference(root, { open: true, minimized: false });
}
export function toggleWeeklyProgressFloat(): void {
  const root = ResearchFolder.getRoot();
  if (!root) {
    toast.warning(i18next.t("weekly.noProject", { ns: "research" }));
    return;
  }
  const state = readPreference(root);
  savePreference(root, state.open && !state.minimized ? { open: false } : { open: true, minimized: false });
}

export function WeeklyProgressLauncher() {
  const t = useWeeklyText();
  return (
    <div className="flex items-center gap-0.5">
      <Button
        variant="ghost"
        size="sm"
        className="h-7 gap-1.5 rounded-md px-2 text-xs"
        onClick={() => openWeeklyProgressDialog()}
      >
        <CalendarDays className="size-3.5" />
        {t("title")}
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="size-7 rounded-md"
        aria-label={t("toggleFloat")}
        title={t("toggleFloat")}
        onClick={toggleWeeklyProgressFloat}
      >
        <ListTodo className="size-3.5" />
      </Button>
    </div>
  );
}

export function clampWeeklyFloat(
  position: { x: number; y: number },
  width: number,
  height: number,
  viewportWidth: number,
  viewportHeight: number,
) {
  const margin = 12;
  return {
    x: Math.max(margin, Math.min(position.x, viewportWidth - width - margin)),
    y: Math.max(margin, Math.min(position.y, viewportHeight - height - margin)),
  };
}

export function WeeklyProgressFloat() {
  const root = useProjectRoot();
  const revision = useAtomValue(floatRevisionAtom, { store });
  if (!root) return null;
  const preference = readPreference(root);
  return preference.open ? (
    <WeeklyProgressFloatContent key={root} root={root} preference={preference} revision={revision} />
  ) : null;
}

function WeeklyProgressFloatContent({
  root,
  preference,
  revision,
}: {
  root: string;
  preference: FloatPreference;
  revision: number;
}) {
  const t = useWeeklyText();
  const [week, setWeek] = useState(weekStartDate);
  const { record, setRecord, loading, error, setError, reload } = useRecord(root, week);
  const [busy, setBusy] = useState(false);
  const [position, setPosition] = useState({ x: preference.x, y: preference.y });
  const positionRef = useRef(position);
  positionRef.current = position;
  const panel = useRef<HTMLDivElement>(null);
  const dragCleanup = useRef<(() => void) | undefined>(undefined);
  const alive = useRef(true);
  const identity = useRef({ root, week });
  identity.current = { root, week };
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      dragCleanup.current?.();
    };
  }, []);
  useEffect(() => {
    const currentWeek = () => setWeek(weekStartDate());
    const timer = setInterval(currentWeek, 60_000);
    window.addEventListener("focus", currentWeek);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", currentWeek);
    };
  }, []);
  useEffect(() => {
    const clamp = () => {
      const rect = panel.current?.getBoundingClientRect();
      if (rect)
        setPosition((value) => clampWeeklyFloat(value, rect.width, rect.height, window.innerWidth, window.innerHeight));
    };
    clamp();
    window.addEventListener("resize", clamp);
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(clamp) : null;
    if (panel.current) observer?.observe(panel.current);
    return () => {
      window.removeEventListener("resize", clamp);
      observer?.disconnect();
    };
  }, [preference.minimized, preference.enlarged, revision]);

  function beginDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || (event.target as Element).closest("button,input,a,select")) return;
    event.preventDefault();
    event.stopPropagation();
    dragCleanup.current?.();
    const mouse = { x: event.clientX, y: event.clientY };
    const origin = { ...positionRef.current };
    const move = (next: PointerEvent) => {
      if (next.pointerId !== event.pointerId) return;
      const rect = panel.current?.getBoundingClientRect();
      if (!rect) return;
      const value = clampWeeklyFloat(
        { x: origin.x + next.clientX - mouse.x, y: origin.y + next.clientY - mouse.y },
        rect.width,
        rect.height,
        window.innerWidth,
        window.innerHeight,
      );
      positionRef.current = value;
      setPosition(value);
    };
    const stop = (next: PointerEvent) => {
      if (next.pointerId !== event.pointerId) return;
      cleanup();
      savePreference(root, positionRef.current);
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      dragCleanup.current = undefined;
    };
    dragCleanup.current = cleanup;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
  }

  async function toggle(item: WeeklyItem) {
    if (!record || busy || loading) return;
    const requested = { root, week };
    const current = () =>
      alive.current && identity.current.root === requested.root && identity.current.week === requested.week;
    setBusy(true);
    setError("");
    try {
      const saved = await setWeeklyItemDone(root, record, item.id, !item.done);
      if (current()) setRecord(saved);
    } catch (cause) {
      if (current()) setError(errorMessage(cause));
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  const pending = weeklySectionItems(record, "todo").length;
  return (
    <div
      ref={panel}
      role="region"
      aria-label={t("floatTitle")}
      style={{ left: position.x, top: position.y }}
      className={cn(
        "bg-popover text-popover-foreground fixed z-40 flex max-w-[calc(100vw-1.5rem)] flex-col overflow-hidden border shadow-lg",
        preference.minimized
          ? "rounded-full"
          : cn("max-h-[calc(100vh-2rem)] rounded-xl", preference.enlarged ? "w-[32rem]" : "w-[21rem]"),
      )}
      onPointerDown={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
      onKeyUp={(event) => event.stopPropagation()}
    >
      <div
        data-weekly-drag-region
        className={cn(
          "flex touch-none items-center gap-1.5 select-none",
          preference.minimized ? "cursor-grab py-1 pr-1 pl-2" : "border-border/60 cursor-grab border-b px-3 py-2",
        )}
        onPointerDown={beginDrag}
      >
        <GripHorizontal className="text-muted-foreground size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate text-xs font-medium">
          {t("floatTitle")}
          {preference.minimized && pending > 0 ? ` · ${t("pendingCount", { count: pending })}` : ""}
        </span>
        {!preference.minimized && (
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            title={t("fullProgress")}
            aria-label={t("fullProgress")}
            onClick={() => openWeeklyProgressDialog(week)}
          >
            <NotebookPen className="size-3" />
          </Button>
        )}
        {!preference.minimized && (
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            title={t(preference.enlarged ? "shrinkFloat" : "enlargeFloat")}
            aria-label={t(preference.enlarged ? "shrinkFloat" : "enlargeFloat")}
            onClick={() => savePreference(root, { enlarged: !preference.enlarged })}
          >
            {preference.enlarged ? <Minimize2 className="size-3" /> : <Maximize2 className="size-3" />}
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="size-6"
          aria-label={t(preference.minimized ? "expand" : "minimize")}
          onClick={() => savePreference(root, { minimized: !preference.minimized })}
        >
          {preference.minimized ? <ChevronUp className="size-3" /> : <Minus className="size-3" />}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-6"
          aria-label={t("closeFloat")}
          onClick={() => savePreference(root, { open: false })}
        >
          <X className="size-3" />
        </Button>
      </div>
      {!preference.minimized && (
        <>
          <div className="text-muted-foreground flex items-center justify-between gap-2 px-3 pt-2 text-[11px]">
            <span className="truncate" title={root}>
              {projectName(root)}
            </span>
            <span className="shrink-0">{week.slice(5)}</span>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
            {error && (
              <div role="alert" className="text-destructive mb-2 text-xs break-words">
                {error}
                <button type="button" className="ml-2 underline" onClick={reload}>
                  {t("refresh")}
                </button>
              </div>
            )}
            {loading ? (
              <p role="status" className="text-muted-foreground flex items-center gap-2 text-xs">
                <LoaderCircle className="size-3 animate-spin" />
                {t("loading")}
              </p>
            ) : record ? (
              <RecordSections
                root={root}
                record={record}
                busy={busy}
                onToggle={(item) => void toggle(item)}
                compact
                t={t}
              />
            ) : (
              <p className="text-muted-foreground py-3 text-xs leading-relaxed">{t("floatEmpty")}</p>
            )}
          </div>
          <div className="border-border/60 flex items-center justify-between gap-2 border-t px-2 py-1.5">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => openWeeklyProgressDialog(week)}
            >
              <Plus className="size-3" />
              {t("recordProgress")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              disabled={!record}
              onClick={() => record && openFullRecord(root, record)}
            >
              <FileText className="size-3" />
              {t("fullRecord")}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
