import { OverlayHost } from "@/components/overlay-host";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Settings } from "@/core/service/Settings";
import { cn } from "@/utils/cn";
import i18next from "i18next";
import {
  Check,
  ClipboardPaste,
  ExternalLink,
  FileText,
  ImagePlus,
  Link2,
  ListTodo,
  LoaderCircle,
  Lock,
  Pencil,
  Plus,
  RefreshCw,
  StickyNote,
  X,
} from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { toast } from "sonner";
import {
  appendRecordItem,
  currentContextLink,
  CURRENT_RECORD,
  displayRecordLink,
  ensureNodeRecord,
  hasOwnTitle,
  listSealedRecords,
  loadNodeRecord,
  NODE_RECORD_CHANGED_EVENT,
  openRecordLink,
  recordPath,
  RECORD_SECTIONS,
  sectionItems,
  setRecordItemDone,
  summarizeRecordItem,
  updateRecordItem,
  type NodeRecord,
  type RecordItem,
  type RecordLink,
  type RecordSection,
} from "./NodeRecord";
import { projectName, recordErrorText, showRecordFloat, useRecordText, type Translate } from "./NodeRecordFloat";
import { importRecordImages, loadRecordImagePreview, pasteRecordImage } from "./NodeRecordMedia";
import { ResearchFolder } from "./ResearchFolder";

/*
 * 记录面板：一个居中的窗口，分四节列出一段手填记录的全部事项。
 * 「进行中」那一段能加、能改（标题、详细内容、关联的链接、图片）、能勾；
 * 顶上可以切到以前的节点，看定格时封存的那一份，只能看。
 *
 * 界面和改一条的做法出自同伴 cleverfool-rnh 的 PR（xw-Soleil/LabWeave 第 1 号）里的 WeeklyProgressDialog。
 * 这里把「选哪一周」换成了「选哪个节点」，封存的改成只读，去掉了「AI 提炼标题」和从这里出汇报的按钮
 *（汇报从「阶段小结」出）。
 */

const fieldClass =
  "border-input bg-background focus-visible:ring-ring/50 h-8 min-w-0 rounded-md border px-2 text-xs outline-none focus-visible:ring-2 disabled:opacity-50";
const conflicted = (cause: unknown) => cause instanceof Error && cause.message === "nodeRecord.conflict";
/** 回车里只认真的回车：输入法还在选字时的那一下不算 */
const realEnter = (event: KeyboardEvent) =>
  event.key === "Enter" && !event.nativeEvent.isComposing && event.keyCode !== 229;

/** 「进行中」的文件还没有时，拿它来算链接该怎么写（链接是相对这份文件的） */
const emptyCurrent = (): NodeRecord => ({
  name: CURRENT_RECORD,
  path: recordPath(CURRENT_RECORD),
  markdown: "",
  revision: "",
  items: [],
  links: [],
});

/** 读一段记录；别处改了（便签、定格、切回窗口）就重读。同一段重读时先留着旧的，免得闪一下 */
function useRecord(root: string, name: string) {
  const [record, setRecord] = useState<NodeRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const reload = useCallback(() => setRefresh((value) => value + 1), []);
  const shown = useRef<string | undefined>(undefined);
  useEffect(() => {
    let stopped = false;
    if (shown.current !== name) {
      shown.current = name;
      setRecord(null);
      setError("");
      setLoading(true);
    }
    void loadNodeRecord(root, name)
      .then((value) => {
        if (!stopped) setRecord(value);
      })
      .catch((cause) => {
        if (!stopped) setError(recordErrorText(cause));
      })
      .finally(() => {
        if (!stopped) setLoading(false);
      });
    return () => {
      stopped = true;
    };
  }, [root, name, refresh]);
  useEffect(() => {
    const changed = (event: Event) => {
      const detail = (event as CustomEvent<{ root?: string }>).detail;
      if (!detail?.root || detail.root === root) reload();
    };
    window.addEventListener(NODE_RECORD_CHANGED_EVENT, changed);
    window.addEventListener("focus", reload);
    return () => {
      window.removeEventListener(NODE_RECORD_CHANGED_EVENT, changed);
      window.removeEventListener("focus", reload);
    };
  }, [root, reload]);
  return { record, setRecord, loading, error, setError, reload, version: refresh };
}

function followLink(root: string, record: NodeRecord, link: RecordLink, onNavigate?: () => void) {
  void openRecordLink(root, record, link)
    .then(() => onNavigate?.())
    .catch((cause) => toast.error(recordErrorText(cause)));
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
  record: NodeRecord;
  link: RecordLink;
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
    void loadRecordImagePreview(root, record, link)
      .then((value) => {
        if (!stopped) setSrc(value);
      })
      .catch((cause) => {
        if (!stopped) setError(recordErrorText(cause));
      });
    return () => {
      stopped = true;
    };
  }, [root, record.path, link.href]);
  return (
    <div className="group border-border/70 bg-background relative w-24 overflow-hidden rounded-lg border">
      <button
        type="button"
        className="flex h-20 w-full cursor-pointer items-center justify-center overflow-hidden"
        title={displayRecordLink(record.path, link.href)}
        aria-label={t("panel.viewImage", { name: link.label })}
        disabled={disabled}
        onClick={() => followLink(root, record, link, onNavigate)}
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
          aria-label={t("panel.removeImage", { name: link.label })}
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
  onEdit,
  onNavigate,
  focused,
  t,
}: {
  root: string;
  record: NodeRecord;
  item: RecordItem;
  busy: boolean;
  /** 不给就是只读：勾选框换成不能点的记号 */
  onToggle?: (item: RecordItem) => void;
  onEdit?: (item: RecordItem) => void;
  onNavigate?: () => void;
  focused?: boolean;
  t: Translate;
}) {
  const title = item.summary || summarizeRecordItem(item.text, item.section) || t("untitled");
  const row = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focused) row.current?.scrollIntoView?.({ block: "center" });
  }, [focused]);
  const finished = item.done && item.section !== "done";
  return (
    <div
      ref={row}
      data-record-item={item.id}
      className={cn(
        "flex items-start gap-2.5 rounded-md py-2",
        focused && "bg-primary/5 ring-primary/30 -mx-1 px-1 ring-1",
      )}
    >
      {item.section === "done" || (!onToggle && item.done) ? (
        <Check className="text-primary mt-0.5 size-4 shrink-0" />
      ) : onToggle ? (
        <input
          type="checkbox"
          checked={item.done}
          disabled={busy}
          aria-label={t(item.done ? "markPending" : "markDone", { text: title })}
          className="accent-primary mt-1 size-3.5 shrink-0 cursor-pointer"
          onChange={() => onToggle(item)}
        />
      ) : (
        <span className="bg-muted-foreground/50 mt-2 size-1.5 shrink-0 rounded-full" />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-start gap-1">
          <p
            className={cn(
              "min-w-0 flex-1 text-sm leading-relaxed font-medium break-words",
              finished && "text-muted-foreground line-through",
            )}
          >
            {title}
          </p>
          {onEdit && (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="text-muted-foreground size-6 shrink-0"
              title={t("panel.editItem")}
              aria-label={t("panel.editItemNamed", { title })}
              disabled={busy}
              onClick={() => onEdit(item)}
            >
              <Pencil className="size-3" />
            </Button>
          )}
        </div>
        {item.text && item.text !== title && (
          <p className="text-muted-foreground mt-1 text-xs leading-relaxed break-words whitespace-pre-wrap">
            {item.text}
          </p>
        )}
        {item.links.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
            {item.links.map((link, index) => (
              <button
                key={`${link.href}-${index}`}
                type="button"
                title={displayRecordLink(record.path, link.href)}
                disabled={busy}
                className="text-primary inline-flex max-w-full cursor-pointer items-center gap-1 text-xs hover:underline"
                onClick={() => followLink(root, record, link, onNavigate)}
              >
                <ExternalLink className="size-3 shrink-0" />
                <span className="truncate">{link.label || displayRecordLink(record.path, link.href)}</span>
              </button>
            ))}
          </div>
        )}
        {!!item.images?.length && (
          <div className="mt-2 flex flex-wrap gap-2">
            {item.images.map((link, index) => (
              <ImagePreview key={`${index}-${link.href}`} {...{ root, record, link, onNavigate, t }} disabled={busy} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function RecordSections({
  root,
  record,
  busy,
  onToggle,
  onEdit,
  onNavigate,
  focusedItemId,
  t,
}: {
  root: string;
  record: NodeRecord | null;
  busy: boolean;
  onToggle?: (item: RecordItem) => void;
  onEdit?: (item: RecordItem) => void;
  onNavigate?: () => void;
  focusedItemId?: string;
  t: Translate;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {RECORD_SECTIONS.map((section) => {
        const items = sectionItems(record, section);
        return (
          <section
            key={section}
            aria-label={t(`section.${section}`)}
            className="border-border/65 rounded-xl border px-4 py-3"
          >
            <div className="mb-1.5 flex items-center gap-2">
              <h3 className="text-xs font-medium">{t(`section.${section}`)}</h3>
              <span className="text-muted-foreground text-[11px]">{items.length}</span>
            </div>
            {record &&
              items.map((item) => (
                <ItemRow
                  key={item.id}
                  {...{ root, record, item, busy, onToggle, onEdit, onNavigate, t }}
                  focused={item.id === focusedItemId}
                />
              ))}
            {!items.length && (
              <p className="text-muted-foreground py-1 text-xs">{t(`panel.emptySection.${section}`)}</p>
            )}
          </section>
        );
      })}
    </div>
  );
}

/** 表单里正填着的东西 */
interface Draft {
  section: RecordSection;
  text: string;
  /** 用户自己在标题框里敲的；没碰过标题框就是 undefined，标题跟着内容走 */
  manualTitle?: string;
  images: RecordLink[];
  links: RecordLink[];
  linkLabel: string;
  linkHref: string;
  showLink: boolean;
  linkIndex?: number;
}

/** 正在改的那一条：改的是点「改」那一刻读到的记录，存的时候文件要是变了就不覆盖 */
interface Edit {
  base: NodeRecord;
  item: RecordItem;
  ownTitle: boolean;
  token: string;
}

export function NodeRecordPanel({
  root,
  initialName,
  initialItemId,
  onClose,
}: {
  root: string;
  initialName?: string;
  initialItemId?: string;
  onClose: () => void;
}) {
  const t = useRecordText();
  const [name, setName] = useState(initialName ?? CURRENT_RECORD);
  const [sealed, setSealed] = useState<string[]>([]);
  const { record, setRecord, loading, error, setError, reload, version } = useRecord(root, name);
  const [busy, setBusy] = useState(false);
  const [section, setSection] = useState<RecordSection>("todo");
  const [text, setText] = useState("");
  const [manualTitle, setManualTitle] = useState<string | undefined>(undefined);
  const [images, setImages] = useState<RecordLink[]>([]);
  const [links, setLinks] = useState<RecordLink[]>([]);
  const [linkLabel, setLinkLabel] = useState("");
  const [linkHref, setLinkHref] = useState("");
  const [showLink, setShowLink] = useState(false);
  const [linkIndex, setLinkIndex] = useState<number | undefined>(undefined);
  const [editing, setEditing] = useState<Edit | null>(null);
  const editSequence = useRef(0);
  const form = useRef<HTMLFormElement>(null);
  /** 点「改」之前表单里正填着的新事项，取消修改时放回去 */
  const parked = useRef<Draft | undefined>(undefined);
  const attachmentRequest = useRef<AbortController | undefined>(undefined);
  const readOnly = name !== CURRENT_RECORD;
  const scope = editing?.token ?? "create";
  const identity = useRef({ name, scope });
  identity.current = { name, scope };
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
  // 换了项目：这个面板里的东西都是上一个项目的，关掉
  useEffect(
    () =>
      Settings.watch("researchFolderPath", () => {
        if (ResearchFolder.getRoot() !== root) onClose();
      }),
    [root, onClose],
  );
  useEffect(() => {
    let stopped = false;
    void listSealedRecords(root)
      .then((value) => {
        if (!stopped) setSealed(value);
      })
      .catch((cause) => {
        if (!stopped) setError(recordErrorText(cause));
      });
    return () => {
      stopped = true;
    };
  }, [root, record?.revision, version, setError]);

  // 「进行中」在最前，封存的按时间倒着排；正看着的那份要是不在列表里（文件刚被挪走），也留一项，免得下拉框对不上
  const names = [CURRENT_RECORD, ...sealed, ...(readOnly && !sealed.includes(name) ? [name] : [])];
  const draftRecord = editing?.base ?? (readOnly ? null : record) ?? emptyCurrent();
  const derivedTitle =
    summarizeRecordItem(text, section) ||
    (images.length ? t("panel.imageRecord") : links.length ? t("panel.linkedRecord") : "");
  // 没碰过标题框时显示什么：改一条时，自己写过标题的、或者内容还没动的，就是它原来的标题；别的跟着内容提炼
  const title =
    manualTitle ??
    (editing && (editing.ownTitle || text === editing.item.text) ? (editing.item.summary ?? "") : derivedTitle);
  const canSave = !!(text.trim() || manualTitle?.trim() || images.length || links.length || linkHref.trim());
  const itemTargets = new Set(
    record?.items.flatMap((item) => [...item.links, ...(item.images ?? [])]).map((link) => link.href),
  );
  const otherLinks = record?.links.filter((link) => !itemTargets.has(link.href)) ?? [];

  function currentDraft(): Draft {
    return { section, text, manualTitle, images, links, linkLabel, linkHref, showLink, linkIndex };
  }
  function restoreDraft(draft?: Draft) {
    setSection(draft?.section ?? "todo");
    setText(draft?.text ?? "");
    setManualTitle(draft?.manualTitle);
    setImages(draft?.images ?? []);
    setLinks(draft?.links ?? []);
    setLinkLabel(draft?.linkLabel ?? "");
    setLinkHref(draft?.linkHref ?? "");
    setShowLink(draft?.showLink ?? false);
    setLinkIndex(draft?.linkIndex);
  }

  function beginEdit(item: RecordItem) {
    if (busy || loading || editing || readOnly || !record) return;
    parked.current = currentDraft();
    attachmentRequest.current?.abort();
    restoreDraft({
      section: item.section,
      text: item.text,
      images: [...(item.images ?? [])],
      links: [...item.links],
      linkLabel: "",
      linkHref: "",
      showLink: false,
    });
    setEditing({
      base: record,
      item,
      ownTitle: hasOwnTitle(record, item.id),
      token: `edit-${++editSequence.current}`,
    });
    setError("");
  }

  function endEdit() {
    attachmentRequest.current?.abort();
    setEditing(null);
    restoreDraft(parked.current);
    parked.current = undefined;
    setError("");
    reload();
  }

  /** 表单里现在算数的链接：链接编辑框开着、填了东西的，也算进去 */
  function selectedLinks(): RecordLink[] | undefined {
    if (!showLink) return links;
    if (!linkHref.trim()) {
      if (linkLabel.trim() || linkIndex !== undefined) {
        setError(t("panel.linkRequired"));
        return;
      }
      return links;
    }
    const value = { label: linkLabel.trim() || t("panel.source"), href: linkHref.trim() };
    const next =
      linkIndex === undefined ? [...links, value] : links.map((link, index) => (index === linkIndex ? value : link));
    return next.filter(
      (link, index, all) => all.findIndex((other) => other.href === link.href && other.label === link.label) === index,
    );
  }

  function closeLinkEditor() {
    setShowLink(false);
    setLinkIndex(undefined);
    setLinkLabel("");
    setLinkHref("");
  }

  function confirmLink() {
    const next = selectedLinks();
    if (!next) return;
    setLinks(next);
    closeLinkEditor();
    setError("");
  }

  /**
   * 改记录都走这里。base 给了就在那一份上改（改一条用：改的是点「改」时读到的那份）。
   * 文件在别处改过时存不进去：onConflict 是 "retry" 就重读一遍再做一次（加一条用，加在末尾不会弄错）；
   * 否则重读、把 onConflict 那句话亮出来，让人自己再来一次。
   */
  async function mutate(
    action: (current: NodeRecord) => Promise<NodeRecord>,
    onConflict: string,
    base?: NodeRecord,
  ): Promise<boolean> {
    if (busy || loading || readOnly) return false;
    const requested = { name, scope };
    const current = () =>
      alive.current && identity.current.name === requested.name && identity.current.scope === requested.scope;
    setBusy(true);
    setError("");
    try {
      let saved: NodeRecord;
      try {
        saved = await action(base ?? record ?? (await ensureNodeRecord(root)));
      } catch (cause) {
        if (!conflicted(cause)) throw cause;
        if (onConflict !== "retry") {
          if (current()) {
            if (!base) reload();
            setError(onConflict);
          }
          return false;
        }
        saved = await action(await ensureNodeRecord(root));
      }
      if (current()) setRecord(saved);
      return current();
    } catch (cause) {
      if (current()) setError(recordErrorText(cause));
      return false;
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  async function saveItem() {
    const nextLinks = selectedLinks();
    if (!nextLinks) return;
    const typed = manualTitle?.trim();
    if (editing) {
      const { base, item, ownTitle } = editing;
      // 没碰标题：原来自己写了标题的照旧；标题是提炼出来的，内容没变就不动它，内容变了让它跟着新内容重新提炼
      const summary =
        typed && typed !== (item.summary ?? "") ? typed : ownTitle || text === item.text ? (item.summary ?? "") : "";
      const saved = await mutate(
        (current) => updateRecordItem(root, current, item.id, { summary, text, links: nextLinks, images }),
        t("panel.editConflict"),
        base,
      );
      if (saved) endEdit();
      return;
    }
    // 标题和从内容里提炼的一样就不另写一遍；只有图片或链接、没有字的，给一个通用的标题
    const summary =
      typed && typed !== summarizeRecordItem(text, section)
        ? typed
        : text.trim()
          ? ""
          : t(images.length ? "panel.imageRecord" : "panel.linkedRecord");
    const saved = await mutate(
      (current) =>
        appendRecordItem(root, current, section, text.trim(), undefined, { summary, images, links: nextLinks }),
      "retry",
    );
    if (saved) restoreDraft();
  }

  function changeName(next: string) {
    if (busy || editing || next === name) return;
    attachmentRequest.current?.abort();
    setName(next);
  }

  async function attachCurrent() {
    if (busy) return;
    const requested = scope;
    setBusy(true);
    setError("");
    try {
      const link = await currentContextLink(root, draftRecord);
      if (!alive.current || identity.current.scope !== requested) return;
      if (!link) {
        setError(t("noContext"));
        return;
      }
      setLinks((previous) => (previous.some((value) => value.href === link.href) ? previous : [...previous, link]));
    } catch (cause) {
      if (alive.current) setError(recordErrorText(cause));
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  async function attachImages(paste = false) {
    if (busy) return;
    const controller = new AbortController();
    attachmentRequest.current?.abort();
    attachmentRequest.current = controller;
    const requested = scope;
    const current = () => alive.current && !controller.signal.aborted && identity.current.scope === requested;
    setBusy(true);
    setError("");
    try {
      const added = paste
        ? [await pasteRecordImage(root, draftRecord, controller.signal)].filter((value): value is RecordLink => !!value)
        : await importRecordImages(root, draftRecord, controller.signal);
      if (!current()) return;
      if (paste && !added.length) setError(t("panel.noClipboardImage"));
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
      if (current()) setError(recordErrorText(cause));
    } finally {
      if (alive.current && attachmentRequest.current === controller) setBusy(false);
    }
  }

  const locked = busy || !!editing;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        className="flex max-h-[min(84vh,54rem)] flex-col gap-0 overflow-hidden rounded-xl p-0 sm:max-w-[min(52rem,calc(100%-2rem))]"
        // 在面板里按键不能漏到下面的画布上去（Esc 关面板是 Dialog 自己在最外层听的，不受影响）
        onKeyDown={(event) => event.stopPropagation()}
        onKeyUp={(event) => event.stopPropagation()}
      >
        <DialogHeader className="gap-1 px-5 pt-5 pb-4 text-left">
          <DialogTitle className="flex items-center gap-2 text-base">
            <ListTodo className="size-4" />
            {t("panel.title")}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {projectName(root)} · {t("panel.subtitle")}
          </DialogDescription>
        </DialogHeader>
        <div className="border-border/60 flex flex-wrap items-center gap-2 border-b px-5 pb-3">
          <select
            aria-label={t("panel.choose")}
            className={cn(fieldClass, "max-w-full flex-1 sm:max-w-80 sm:flex-none")}
            value={name}
            disabled={locked}
            onChange={(event) => changeName(event.target.value)}
          >
            {names.map((value) => (
              <option key={value} value={value}>
                {value === CURRENT_RECORD ? t("panel.current") : value}
              </option>
            ))}
          </select>
          {readOnly && (
            <span className="text-muted-foreground inline-flex items-center gap-1 text-xs">
              <Lock className="size-3" />
              {t("panel.sealed")}
            </span>
          )}
          <Button variant="ghost" size="sm" className="ml-auto h-7 px-2 text-xs" disabled={busy} onClick={reload}>
            <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
            {t("panel.refresh")}
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
              {t("panel.loading")}
            </p>
          ) : (
            <>
              {readOnly ? (
                <p className="text-muted-foreground rounded-lg border border-dashed px-3 py-2 text-xs leading-relaxed">
                  {t(record ? "panel.sealedHint" : "panel.missing", { name })}
                </p>
              ) : (
                !record?.items.length && (
                  <p className="text-muted-foreground rounded-lg border border-dashed px-3 py-2 text-xs leading-relaxed">
                    {t("panel.emptyCurrent")}
                  </p>
                )
              )}
              <RecordSections
                root={root}
                record={record}
                busy={locked}
                onToggle={
                  readOnly
                    ? undefined
                    : (item) =>
                        void mutate((current) => setRecordItemDone(root, current, item.id, !item.done), t("reloaded"))
                }
                onEdit={readOnly ? undefined : beginEdit}
                onNavigate={onClose}
                focusedItemId={name === (initialName ?? CURRENT_RECORD) ? initialItemId : undefined}
                t={t}
              />
              {!!record && otherLinks.length > 0 && (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t pt-3">
                  <span className="text-muted-foreground text-xs">{t("panel.otherLinks")}</span>
                  {otherLinks.map((link, index) => (
                    <button
                      type="button"
                      className="text-primary inline-flex max-w-full cursor-pointer items-center gap-1 text-xs hover:underline"
                      title={displayRecordLink(record.path, link.href)}
                      disabled={locked}
                      key={`${link.href}-${index}`}
                      onClick={() => followLink(root, record, link, onClose)}
                    >
                      <ExternalLink className="size-3 shrink-0" />
                      <span className="truncate">{link.label || displayRecordLink(record.path, link.href)}</span>
                    </button>
                  ))}
                </div>
              )}
              {!readOnly && (
                <form
                  ref={form}
                  aria-label={t(editing ? "panel.editItem" : "panel.addItem")}
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
                      {t(editing ? "panel.editItem" : "panel.addItem")}
                    </label>
                    <select
                      className={cn(fieldClass, "ml-auto h-7")}
                      value={section}
                      disabled={locked}
                      aria-label={t("panel.itemSection")}
                      onChange={(event) => setSection(event.target.value as RecordSection)}
                    >
                      {RECORD_SECTIONS.map((value) => (
                        <option key={value} value={value}>
                          {t(`section.${value}`)}
                        </option>
                      ))}
                    </select>
                  </div>
                  {editing && <p className="text-muted-foreground text-xs leading-relaxed">{t("panel.editHint")}</p>}
                  {editing && error && (
                    <p role="alert" className="text-destructive text-xs break-words">
                      {error}
                    </p>
                  )}
                  <Input
                    id={`${id}-title`}
                    aria-label={t("panel.itemTitle")}
                    placeholder={t("panel.titlePlaceholder")}
                    value={title}
                    maxLength={64}
                    disabled={busy}
                    onChange={(event) => setManualTitle(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter") return;
                      // 标题框里的回车自己管：输入法选字的那一下不能把表单交了
                      event.preventDefault();
                      if (realEnter(event) && canSave) void saveItem();
                    }}
                    className="h-9 text-sm font-medium"
                  />
                  <Textarea
                    id={`${id}-text`}
                    aria-label={t("panel.itemDetails")}
                    value={text}
                    disabled={busy}
                    rows={2}
                    className="min-h-16 resize-y text-sm"
                    placeholder={t("panel.detailsPlaceholder")}
                    onChange={(event) => setText(event.target.value)}
                  />
                  {links.length > 0 && (
                    <div className="space-y-2">
                      {links.map((link, index) => (
                        <div
                          key={`${index}-${link.href}`}
                          className="border-border/70 bg-background flex items-start gap-2 rounded-lg border p-2.5"
                        >
                          <FileText className="text-primary mt-0.5 size-4 shrink-0" />
                          <div className="min-w-0 flex-1">
                            <p className="text-xs font-medium break-words">{link.label || t("panel.source")}</p>
                            <p className="text-muted-foreground mt-1 text-[11px] break-words">
                              {displayRecordLink(draftRecord.path, link.href)}
                            </p>
                          </div>
                          <Button
                            type="button"
                            size="icon"
                            variant="ghost"
                            className="size-6 shrink-0"
                            aria-label={t("panel.editNamedLink", { name: link.label })}
                            title={t("panel.editLink")}
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
                            aria-label={t("panel.removeNamedLink", { name: link.label })}
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
                          aria-label={t("panel.linkLabel")}
                          placeholder={t("panel.linkLabel")}
                          value={linkLabel}
                          disabled={busy}
                          className="h-8 text-xs md:text-xs"
                          onChange={(event) => setLinkLabel(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key !== "Enter") return;
                            event.preventDefault();
                            if (realEnter(event)) confirmLink();
                          }}
                        />
                        <Input
                          aria-label={t("panel.linkTarget")}
                          placeholder={t("panel.linkPlaceholder")}
                          value={linkHref}
                          disabled={busy}
                          className="h-8 text-xs md:text-xs"
                          onChange={(event) => setLinkHref(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key !== "Enter") return;
                            event.preventDefault();
                            if (realEnter(event)) confirmLink();
                          }}
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
                          {t("panel.confirmLink")}
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-6 px-1.5 text-[11px]"
                          disabled={busy}
                          onClick={closeLinkEditor}
                        >
                          {t("panel.cancelLink")}
                        </Button>
                      </div>
                    </div>
                  )}
                  {images.length > 0 && (
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
                      title={t("attachHint")}
                      disabled={busy}
                      onClick={() => void attachCurrent()}
                    >
                      <Link2 className="size-3.5" />
                      {t("panel.attachCurrent")}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-xs"
                      disabled={busy || showLink}
                      onClick={() => {
                        closeLinkEditor();
                        setShowLink(true);
                      }}
                    >
                      <Plus className="size-3.5" />
                      {t("panel.addLink")}
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
                      {t("panel.addImage")}
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
                      {t("panel.pasteImage")}
                    </Button>
                    {editing && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="ml-auto h-7 px-2 text-xs"
                        disabled={busy}
                        onClick={endEdit}
                      >
                        {t("panel.cancelEdit")}
                      </Button>
                    )}
                    <Button
                      type="submit"
                      size="sm"
                      className={cn("h-7 text-xs", !editing && "ml-auto")}
                      disabled={busy || !canSave}
                    >
                      {busy && <LoaderCircle className="size-3.5 animate-spin" />}
                      {t(editing ? "panel.saveChanges" : "panel.save")}
                    </Button>
                  </div>
                </form>
              )}
            </>
          )}
        </div>
        <div className="border-border/60 flex flex-wrap items-center gap-2 border-t px-5 py-3">
          <Button
            size="sm"
            variant="ghost"
            className="h-8 px-2 text-xs"
            disabled={!record || locked}
            onClick={() => {
              if (!record) return;
              onClose();
              void import("./DocumentTab")
                .then(({ openDocumentFile }) => openDocumentFile(ResearchFolder.toAbsolute(record.path, root)))
                .catch((cause) => toast.error(recordErrorText(cause)));
            }}
          >
            <FileText className="size-3.5" />
            {t("panel.openFile")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-8 px-2 text-xs"
            disabled={locked}
            onClick={() => {
              showRecordFloat(root);
              onClose();
            }}
          >
            <StickyNote className="size-3.5" />
            {t("panel.showFloat")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

let opened: string | undefined;
/** 打开记录面板；已经开着就换成新的。name 不给是「进行中」，itemId 给了就滚到那一条 */
export function openNodeRecordPanel(name?: string, itemId?: string): void {
  const root = ResearchFolder.getRoot();
  if (!root) {
    toast.warning(i18next.t("nodeRecord.noProject", { ns: "research" }));
    return;
  }
  if (opened) OverlayHost.close(opened);
  const overlay = OverlayHost.open(
    <NodeRecordPanel
      root={root}
      initialName={name}
      initialItemId={itemId}
      onClose={() => {
        OverlayHost.close(overlay.id);
        if (opened === overlay.id) opened = undefined;
      }}
    />,
  );
  opened = overlay.id;
}
