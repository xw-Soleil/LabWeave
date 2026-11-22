import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Settings } from "@/core/service/Settings";
import { store } from "@/state";
import { cn } from "@/utils/cn";
import i18next from "i18next";
import { atom, useAtomValue } from "jotai";
import {
  Check,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  FileText,
  GripHorizontal,
  Images,
  Link2,
  Maximize2,
  Minus,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  appendRecordItem,
  currentContextLink,
  displayRecordLink,
  ensureNodeRecord,
  loadNodeRecord,
  NODE_RECORD_CHANGED_EVENT,
  openRecordLink,
  RECORD_SECTIONS,
  sectionItems,
  setRecordItemDone,
  summarizeRecordItem,
  type NodeRecord,
  type RecordItem,
  type RecordSection,
} from "./NodeRecord";
import { isNode } from "./ProjectRecord";
import { ResearchFolder } from "./ResearchFolder";

/*
 * 便签：浮在窗口上的一小块，随手记待办、进展、问题、下一步，记下的进「进展记录/进行中.md」。
 * 能拖、能收起，位置按项目记着。外壳（拖动、不出窗口、记位置）出自同伴 cleverfool-rnh 的 PR
 *（xw-Soleil/LabWeave 第 1 号）里的事项浮窗；他的浮窗只能看和勾，这里加了顶上的输入框。
 */

export type Translate = (key: string, options?: Record<string, unknown>) => string;

export function useRecordText(): Translate {
  const { t } = useTranslation("research");
  return useCallback(
    (key, options) => t(`nodeRecord.${key}`, { ...options, interpolation: { escapeValue: false } }),
    [t],
  );
}

/** 错误代码换成给人看的话：nodeRecord.xxx 有专门的文案，别的原样给 */
export function recordErrorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const key = /^nodeRecord\.(\w+)$/.exec(message)?.[1];
  return key && i18next.exists(`nodeRecord.errors.${key}`, { ns: "research" })
    ? i18next.t(`nodeRecord.errors.${key}`, { ns: "research" })
    : message;
}

function useProjectRoot() {
  const [root, setRoot] = useState(() => ResearchFolder.getRoot());
  useEffect(() => Settings.watch("researchFolderPath", () => setRoot(ResearchFolder.getRoot())), []);
  return root;
}

export const projectName = (root: string) => root.replace(/\\/g, "/").split("/").filter(Boolean).at(-1) ?? root;

/** 打开记录面板（看全部、改、贴图）。itemId 给了就滚到那一条。面板的代码用到时才加载 */
export function openRecordPanel(itemId?: string): void {
  void import("./NodeRecordPanel")
    .then(({ openNodeRecordPanel }) => openNodeRecordPanel(undefined, itemId))
    .catch((cause) => toast.error(recordErrorText(cause)));
}

/** 读「进行中」这一份；别处改了（便签、面板、定格、切回窗口）就重读 */
function useCurrentRecord(root: string) {
  const [record, setRecord] = useState<NodeRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const reload = useCallback(() => setRefresh((value) => value + 1), []);
  useEffect(() => {
    let stopped = false;
    if (!root) {
      setRecord(null);
      setLoading(false);
      return;
    }
    void loadNodeRecord(root)
      .then((value) => {
        if (!stopped) setRecord(value);
      })
      .catch((cause) => {
        if (!stopped) toast.error(recordErrorText(cause));
      })
      .finally(() => {
        if (!stopped) setLoading(false);
      });
    return () => {
      stopped = true;
    };
  }, [root, refresh]);
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
  return { record, setRecord, loading, reload };
}

/** 距上次小结几天；还没做过小结给 undefined */
function useDaysSinceNode(root: string): number | undefined {
  const [at, setAt] = useState<string>();
  useEffect(() => {
    if (!root) return;
    let alive = true;
    let off: (() => void) | undefined;
    void import("./Snapshot").then(({ currentBaseline, onSnapshotTaken }) => {
      const read = () =>
        currentBaseline().then(
          (snapshot) => alive && setAt(snapshot && isNode(snapshot) ? snapshot.manifest.at : undefined),
          // 读不到快照不碍着记东西：这一行不显示就是了
          () => alive && setAt(undefined),
        );
      void read();
      if (alive) off = onSnapshotTaken(() => void read());
    });
    return () => {
      alive = false;
      off?.();
    };
  }, [root]);
  return at ? Math.max(0, Math.floor((Date.now() - Date.parse(at)) / 86_400_000)) : undefined;
}

interface FloatPreference {
  open: boolean;
  minimized: boolean;
  x: number;
  y: number;
}
const floatRevisionAtom = atom(0);
const floatPreferences = new Map<string, FloatPreference>();
const preferenceKey = (root: string) => `labweave-record-float:${root.replace(/\\/g, "/").toLowerCase()}`;

function readPreference(root: string): FloatPreference {
  if (floatPreferences.has(root)) return floatPreferences.get(root)!;
  // 默认放在左上：右边常开着 AI 面板，底下是状态条和阶段小结的素材卡片
  const fallback: FloatPreference = { open: false, minimized: false, x: 72, y: 72 };
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
        floatPreferences.set(root, value as FloatPreference);
        return value as FloatPreference;
      }
    }
  } catch {
    // 记着的位置读不出来：用默认位置，不值得打扰
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
    // 存不下位置：这次照样能用，下次回到默认位置
  }
  store.set(floatRevisionAtom, (value) => value + 1);
}

/** 竖栏按钮用：便签现在是不是开着 */
export function useRecordFloatOpen(): boolean {
  const root = useProjectRoot();
  useAtomValue(floatRevisionAtom, { store });
  return !!root && readPreference(root).open;
}

/** 把便签显示出来（面板上的「显示便签」用） */
export function showRecordFloat(root: string): void {
  savePreference(root, { open: true, minimized: false });
}

/** 显示或者关掉便签。没选项目时提示一句 */
export function toggleRecordFloat(): void {
  const root = ResearchFolder.getRoot();
  if (!root) {
    toast.warning(i18next.t("nodeRecord.noProject", { ns: "research" }));
    return;
  }
  const state = readPreference(root);
  savePreference(root, state.open && !state.minimized ? { open: false } : { open: true, minimized: false });
}

export function clampFloat(
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

/** 挂在程序最外层。便签关着、或者没选项目时什么都不画 */
export function NodeRecordFloat() {
  const root = useProjectRoot();
  const revision = useAtomValue(floatRevisionAtom, { store });
  if (!root) return null;
  const preference = readPreference(root);
  return preference.open ? <Float key={root} root={root} preference={preference} revision={revision} /> : null;
}

const INPUT_SECTIONS: readonly RecordSection[] = ["todo", "done", "notes", "next"];
const SHOWN = 3;

function Float({ root, preference, revision }: { root: string; preference: FloatPreference; revision: number }) {
  const t = useRecordText();
  const { record, setRecord, loading, reload } = useCurrentRecord(root);
  const days = useDaysSinceNode(root);
  const [busy, setBusy] = useState(false);
  const [section, setSection] = useState<RecordSection>("todo");
  const [text, setText] = useState("");
  const [attach, setAttach] = useState(false);
  const [expanded, setExpanded] = useState<RecordSection[]>([]);
  const [position, setPosition] = useState({ x: preference.x, y: preference.y });
  const positionRef = useRef(position);
  positionRef.current = position;
  const panel = useRef<HTMLDivElement>(null);
  const dragCleanup = useRef<(() => void) | undefined>(undefined);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      dragCleanup.current?.();
    };
  }, []);
  // 窗口变小、便签变高以后不能跑到窗口外面去
  useEffect(() => {
    const clamp = () => {
      const rect = panel.current?.getBoundingClientRect();
      if (rect)
        setPosition((value) => clampFloat(value, rect.width, rect.height, window.innerWidth, window.innerHeight));
    };
    clamp();
    window.addEventListener("resize", clamp);
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(clamp) : null;
    if (panel.current) observer?.observe(panel.current);
    return () => {
      window.removeEventListener("resize", clamp);
      observer?.disconnect();
    };
  }, [preference.minimized, revision]);

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
      const value = clampFloat(
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

  /**
   * 改记录的两个动作都走这里。文件在别处改过（你在 Obsidian 里改了、面板里改了）时存不进去：
   * 重读一遍；retry 给了就拿新读到的再做一次，不给就提示再点一次（那一条可能已经不是原来那一条了）。
   */
  async function change(action: (base: NodeRecord) => Promise<NodeRecord>, retry: boolean): Promise<boolean> {
    if (busy) return false;
    setBusy(true);
    try {
      let saved: NodeRecord;
      try {
        saved = await action(record ?? (await ensureNodeRecord(root)));
      } catch (cause) {
        if (!(cause instanceof Error) || cause.message !== "nodeRecord.conflict") throw cause;
        if (!retry) {
          reload();
          toast.info(t("reloaded"));
          return false;
        }
        saved = await action(await ensureNodeRecord(root));
      }
      if (alive.current) setRecord(saved);
      return true;
    } catch (cause) {
      toast.error(t("failed", { error: recordErrorText(cause) }));
      return false;
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  const add = () => {
    const content = text.trim();
    if (!content) return;
    void change(async (base) => {
      const link = attach ? await currentContextLink(root, base) : undefined;
      if (attach && !link) toast.info(t("noContext"));
      return appendRecordItem(root, base, section, content, link);
    }, true).then((added) => {
      if (added && alive.current) setText("");
    });
  };
  const toggle = (item: RecordItem) => void change((base) => setRecordItemDone(root, base, item.id, !item.done), false);
  const openFile = () =>
    void (async () => {
      const current = record ?? (await ensureNodeRecord(root));
      const { openDocumentFile } = await import("./DocumentTab");
      await openDocumentFile(ResearchFolder.toAbsolute(current.path, root));
    })().catch((cause) => toast.error(recordErrorText(cause)));

  const pending = sectionItems(record, "todo").length;
  const since = days === undefined ? t("noNode") : days === 0 ? t("sinceToday") : t("sinceNode", { days });
  const icon = "size-6";

  return (
    <div
      ref={panel}
      role="region"
      aria-label={t("float")}
      style={{ left: position.x, top: position.y }}
      className={cn(
        "bg-popover text-popover-foreground fixed z-40 flex max-w-[calc(100vw-1.5rem)] flex-col overflow-hidden border shadow-lg",
        preference.minimized ? "rounded-full" : "max-h-[calc(100vh-2rem)] w-[20rem] rounded-xl",
      )}
      // 在便签里点、滚、打字，都不能漏到下面的画布上去
      onPointerDown={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
      onKeyUp={(event) => event.stopPropagation()}
    >
      <div
        className={cn(
          "flex cursor-grab touch-none items-center gap-1.5 select-none",
          preference.minimized ? "py-1 pr-1 pl-2" : "border-border/60 border-b px-3 py-2",
        )}
        onPointerDown={beginDrag}
      >
        <GripHorizontal className="text-muted-foreground size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate text-xs font-medium">
          {t("float")}
          {preference.minimized && (
            <span className="text-muted-foreground font-normal">
              {" · "}
              {t("pending", { count: pending })}
              {" · "}
              {since}
            </span>
          )}
        </span>
        {!preference.minimized && (
          <>
            <Button
              variant="ghost"
              size="icon"
              className={icon}
              title={t("showAll")}
              aria-label={t("showAll")}
              onClick={() => openRecordPanel()}
            >
              <Maximize2 className="size-3" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className={icon}
              title={t("openFile")}
              aria-label={t("openFile")}
              onClick={openFile}
            >
              <FileText className="size-3" />
            </Button>
          </>
        )}
        <Button
          variant="ghost"
          size="icon"
          className={icon}
          title={t(preference.minimized ? "expand" : "minimize")}
          aria-label={t(preference.minimized ? "expand" : "minimize")}
          onClick={() => savePreference(root, { minimized: !preference.minimized })}
        >
          {preference.minimized ? <ChevronUp className="size-3" /> : <Minus className="size-3" />}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className={icon}
          title={t("close")}
          aria-label={t("close")}
          onClick={() => savePreference(root, { open: false })}
        >
          <X className="size-3" />
        </Button>
      </div>
      {!preference.minimized && (
        <>
          <div className="flex flex-col gap-1.5 px-3 pt-2.5">
            <div className="flex items-center gap-1">
              {INPUT_SECTIONS.map((candidate) => (
                <Button
                  key={candidate}
                  size="sm"
                  variant={candidate === section ? "secondary" : "ghost"}
                  className="h-6 rounded-[6px] px-2 text-[11px]"
                  onClick={() => setSection(candidate)}
                >
                  {t(`short.${candidate}`)}
                </Button>
              ))}
              <Button
                size="icon"
                variant={attach ? "secondary" : "ghost"}
                className="ml-auto size-6 rounded-[6px]"
                aria-pressed={attach}
                title={t("attachHint")}
                aria-label={t("attach")}
                onClick={() => setAttach((value) => !value)}
              >
                <Link2 className="size-3" />
              </Button>
            </div>
            <Input
              className="h-8 text-xs md:text-xs"
              value={text}
              disabled={busy}
              placeholder={t(`placeholder.${section}`)}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                // 输入法还在选字时的回车不算
                if (event.key === "Enter" && !event.nativeEvent.isComposing && event.keyCode !== 229) add();
              }}
            />
          </div>
          <div className="text-muted-foreground flex items-center justify-between gap-2 px-3 pt-1.5 text-[11px]">
            <span className="truncate" title={root}>
              {projectName(root)}
            </span>
            <span className="shrink-0">{since}</span>
          </div>
          <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto px-3 py-2.5">
            {!loading && !record?.items.length && <p className="text-muted-foreground text-xs">{t("empty")}</p>}
            {RECORD_SECTIONS.map((name) => {
              const items = sectionItems(record, name);
              if (items.length === 0) return null;
              // 待办和问题是要一直盯着的，全列；别的只列最近几条
              const whole = name === "todo" || expanded.includes(name);
              const shown = whole ? items : items.slice(-SHOWN);
              return (
                <section key={name} aria-label={t(`section.${name}`)}>
                  <div className="mb-0.5 flex items-center gap-2">
                    <h3 className="text-[11px] font-medium">{t(`section.${name}`)}</h3>
                    <span className="text-muted-foreground text-[11px]">{items.length}</span>
                    {name !== "todo" && items.length > SHOWN && (
                      <button
                        type="button"
                        className="text-muted-foreground ml-auto flex cursor-pointer items-center gap-0.5 text-[11px] hover:underline"
                        onClick={() =>
                          setExpanded((value) =>
                            value.includes(name) ? value.filter((key) => key !== name) : [...value, name],
                          )
                        }
                      >
                        <ChevronDown className={cn("size-3", whole && "rotate-180")} />
                        {t(whole ? "less" : "more", { count: items.length - SHOWN })}
                      </button>
                    )}
                  </div>
                  {shown.map((item) => (
                    <Row key={item.id} root={root} record={record!} item={item} busy={busy} onToggle={toggle} t={t} />
                  ))}
                </section>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

function Row({
  root,
  record,
  item,
  busy,
  onToggle,
  t,
}: {
  root: string;
  record: NodeRecord;
  item: RecordItem;
  busy: boolean;
  onToggle: (item: RecordItem) => void;
  t: Translate;
}) {
  const title = item.summary || summarizeRecordItem(item.text, item.section) || t("untitled");
  return (
    <div className="flex items-start gap-2 py-1">
      {item.section === "done" ? (
        <Check className="text-primary mt-0.5 size-3.5 shrink-0" />
      ) : (
        <input
          type="checkbox"
          checked={item.done}
          disabled={busy}
          aria-label={t(item.done ? "markPending" : "markDone", { text: title })}
          className="accent-primary mt-0.5 size-3.5 shrink-0 cursor-pointer"
          onChange={() => onToggle(item)}
        />
      )}
      <div className="min-w-0 flex-1">
        {/* 点这一条：在面板里看全、改、贴图 */}
        <button
          type="button"
          className={cn(
            "hover:text-primary block w-full cursor-pointer text-left text-xs leading-relaxed break-words",
            // 只有勾掉的问题划掉；做完的待办已经挪到「进展」里，和别的进展一个样子
            item.done && item.section === "notes" && "text-muted-foreground line-through",
          )}
          title={item.text}
          aria-label={t("inspect", { text: title })}
          onClick={() => openRecordPanel(item.id)}
        >
          {title}
        </button>
        {!!item.images?.length && (
          <button
            type="button"
            className="text-muted-foreground flex cursor-pointer items-center gap-1 text-[11px] hover:underline"
            onClick={() => openRecordPanel(item.id)}
          >
            <Images className="size-3" />
            {t("imageCount", { count: item.images.length })}
          </button>
        )}
        {item.links.length > 0 && (
          <div className="flex flex-wrap gap-x-3">
            {item.links.map((link, index) => (
              <button
                key={`${link.href}-${index}`}
                type="button"
                title={displayRecordLink(record.path, link.href)}
                className="text-primary inline-flex max-w-full cursor-pointer items-center gap-1 text-[11px] hover:underline"
                onClick={() =>
                  void openRecordLink(root, record, link).catch((cause) => toast.error(recordErrorText(cause)))
                }
              >
                <ExternalLink className="size-3 shrink-0" />
                <span className="truncate">{link.label || displayRecordLink(record.path, link.href)}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
