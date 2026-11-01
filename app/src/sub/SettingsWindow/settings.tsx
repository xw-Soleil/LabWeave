import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { researchSettingText, SettingField, SettingRow } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "@/components/ui/sidebar";
import { SoundService } from "@/core/service/feedbackService/SoundService";
import { Settings, settingsSchema } from "@/core/service/Settings";
import { cn } from "@/utils/cn";
import { useVirtualizer } from "@tanstack/react-virtual";
import Fuse from "fuse.js";
import { isResearchShell } from "@/core/research/ResearchShell";
import _ from "lodash";
import {
  BookOpenText,
  Bot,
  Brain,
  Bug,
  ChevronRight,
  Cpu,
  Eye,
  FlaskConical,
  FolderOpen,
  FolderSync,
  Gamepad2,
  Gpu,
  Image,
  Import,
  Layers,
  type LucideIcon,
  MemoryStick,
  Mouse,
  MoveUpRight,
  Network,
  Palette,
  PanelTop,
  Pen,
  PictureInPicture,
  Proportions,
  RectangleHorizontal,
  Save,
  Scan,
  ScanSearch,
  Search,
  SlidersHorizontal,
  Sparkle,
  SplinePointer,
  SquareDashedMousePointer,
  SquareDashedTopSolid,
  SquareFunction,
  Star,
  TextCursorInput,
  TextQuote,
  Touchpad,
  Unplug,
  Wrench,
  X,
  Zap,
} from "lucide-react";
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

const SETTING_FIELD_ESTIMATE_SIZE = 88;

function SettingFieldVirtualList({ keys }: { keys: string[] }) {
  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: keys.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => SETTING_FIELD_ESTIMATE_SIZE,
    overscan: 6,
    getItemKey: (index) => keys[index] ?? index,
  });

  const keysIdentity = keys.join("\0");
  useEffect(() => {
    parentRef.current?.scrollTo({ top: 0 });
  }, [keysIdentity]);

  return (
    <div ref={parentRef} className="min-h-0 flex-1 overflow-auto">
      <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((virtualItem) => {
          const key = keys[virtualItem.index];
          if (!key) return null;
          return (
            <div
              key={virtualItem.key}
              data-index={virtualItem.index}
              ref={virtualizer.measureElement}
              className="absolute top-0 left-0 w-full"
              style={{ transform: `translateY(${virtualItem.start}px)` }}
            >
              <SettingField settingKey={key as keyof Settings} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

type SettingsTarget = { category: string; group: string };

let pendingInitialCategory: SettingsTarget | null = null;
// 科研模式的设置弹窗只有一个，已经开着时由它自己跳过去
const initialCategoryListeners = new Set<(target: SettingsTarget) => void>();

/** 下一次打开设置页时直接定位到某个分组，例如 AI 面板里的「去设置」按钮 */
export function setSettingsInitialCategory(category: string, group: string) {
  pendingInitialCategory = { category, group };
  for (const listener of initialCategoryListeners) listener(pendingInitialCategory);
}

export type SettingsDialogTab = "settings" | "keybinds" | "customization" | "about";

/** 科研模式的设置弹窗提供：在弹窗顶部的几页之间切换 */
export const SettingsNavigationContext = createContext<{ openTab: (tab: SettingsDialogTab) => void } | null>(null);

// 科研模式下强制关闭、用不上或者不起作用的设置，不在设置页出现
const researchHiddenSettingKeys = new Set([
  "telemetry",
  "allowGlobalHotKeys",
  // 专注(课堂)模式会把整圈界面设成透明,科研模式启动时强制关闭,这里也不再提供开关
  "isClassroomMode",
  "autoImportTxtFileWhenOpenPrg",
  "aiAutoApproveMcpTools",
  "researchSession",
  // 科研模式的滚轮由 researchWheelBehavior 一项决定(见 core/research/WheelGesture.ts),原版这些滚轮设置不起作用
  "mouseWheelMode",
  "mouseWheelModeReverse",
  "mouseWheelWithShiftMode",
  "mouseWheelWithShiftModeReverse",
  "mouseWheelWithCtrlMode",
  "mouseWheelWithCtrlModeReverse",
  "mouseWheelWithAltMode",
  "mouseWheelWithAltModeReverse",
  "mouseSideWheelMode",
  "macTrackpadAndMouseWheelDifference",
  "macMouseWheelIsSmoothed",
  // 科研模式的窗口始终不透明，也没有穿透模式
  "windowBackgroundAlpha",
  "windowBackgroundOpacityAfterOpenClickThrough",
  "windowBackgroundOpacityAfterCloseClickThrough",
  // 快捷设置栏在科研模式不显示
  "showQuickSettingsToolbar",
  // 科研模式拖动卡片不推开别的卡片（见 StageEntity），这个开关不起作用
  "isEnableEntityCollision",
  // 每次启动都恢复成「选择并移动」
  "mouseLeftMode",
  // 代码里没有任何地方读这两项
  "compatibilityMode",
  "nodeDetailsPanel",
]);

// 只有科研模式会用到的设置，原版模式下不显示
const researchOnlySettingKeys = new Set([
  "researchFolderPath",
  "writeAiSidecarOnSave",
  "researchShowFullMenu",
  "researchSession",
  "aiPdfTextPages",
  "researchWheelBehavior",
  "researchOutsideFileMode",
]);

function isSettingKeyVisible(key: string): boolean {
  return isResearchShell() ? !researchHiddenSettingKeys.has(key) : !researchOnlySettingKeys.has(key);
}

const researchCategory = {
  folder: ["researchFolderPath", "researchOutsideFileMode", "writeAiSidecarOnSave"],
  mouse: ["researchWheelBehavior"],
  ai: ["aiPdfTextPages"],
  menu: ["researchShowFullMenu"],
};

/** 科研模式只留下有内容的分组和大类 */
export function getVisibleCategories(): Record<string, Record<string, string[]>> {
  if (!isResearchShell()) return categories;
  const all: Record<string, Record<string, string[]>> = { research: researchCategory, ...categories };
  return Object.fromEntries(
    Object.entries(all)
      .map(
        ([category, groups]) =>
          [
            category,
            Object.fromEntries(
              Object.entries(groups)
                .map(([group, keys]) => [group, keys.filter(isSettingKeyVisible)] as const)
                .filter(([, keys]) => keys.length > 0),
            ),
          ] as const,
      )
      .filter(([, groups]) => Object.keys(groups).length > 0),
  );
}

/** 科研模式「常用」页：一页放完，「themePicker」是跳到「个性化 → 主题」的按钮 */
export const researchCommonSections: { id: string; items: (keyof Settings | "themePicker")[] }[] = [
  { id: "folder", items: ["researchFolderPath", "researchOutsideFileMode", "writeAiSidecarOnSave"] },
  { id: "board", items: ["researchWheelBehavior", "mouseRightDragBackground"] },
  { id: "ai", items: ["aiApiFormat", "aiApiBaseUrl", "aiApiKey", "aiModel", "aiPdfTextPages"] },
  { id: "appearance", items: ["themeMode", "themePicker", "language", "uiScalePercent"] },
  { id: "save", items: ["autoSave", "autoSaveInterval", "autoSaveWhenClose"] },
];

export default function SettingsTab() {
  return isResearchShell() ? <ResearchSettingsTab /> : <UpstreamSettingsTab />;
}

type ResearchPage = { kind: "common" } | { kind: "group"; category: string; group: string };

/** 外部要求打开的分组在科研模式下对应哪一页：AI 接口在「常用」里 */
function researchPageOf(
  target: SettingsTarget | null,
  visibleCategories: Record<string, Record<string, string[]>>,
): { page: ResearchPage; section: string | null } {
  if (!target) return { page: { kind: "common" }, section: null };
  if (target.category === "ai") return { page: { kind: "common" }, section: "ai" };
  if (visibleCategories[target.category]?.[target.group]) {
    return { page: { kind: "group", ...target }, section: null };
  }
  return { page: { kind: "common" }, section: null };
}

function ResearchSettingsTab() {
  const { t } = useTranslation("settings");
  const { t: tr } = useTranslation("research");
  const visibleCategories = useMemo(getVisibleCategories, []);
  const [initial] = useState(() => researchPageOf(pendingInitialCategory, visibleCategories));
  const [page, setPage] = useState<ResearchPage>(initial.page);
  const [advancedOpen, setAdvancedOpen] = useState(initial.page.kind === "group");
  const [openCategories, setOpenCategories] = useState<ReadonlySet<string>>(
    () => new Set(initial.page.kind === "group" ? [initial.page.category] : []),
  );
  const [scrollSection, setScrollSection] = useState<string | null>(initial.section);
  const [keyword, setKeyword] = useState("");
  const sectionElements = useRef(new Map<string, HTMLElement>());

  const goTo = ({ page, section }: { page: ResearchPage; section: string | null }) => {
    setKeyword("");
    setPage(page);
    setScrollSection(section);
    if (page.kind === "group") {
      setAdvancedOpen(true);
      setOpenCategories((prev) => new Set([...prev, page.category]));
    }
  };

  useEffect(() => {
    pendingInitialCategory = null;
    const listener = (target: SettingsTarget) => {
      pendingInitialCategory = null;
      goTo(researchPageOf(target, visibleCategories));
    };
    initialCategoryListeners.add(listener);
    return () => {
      initialCategoryListeners.delete(listener);
    };
  }, []);

  const searching = keyword.trim() !== "";
  useLayoutEffect(() => {
    if (!scrollSection || searching || page.kind !== "common") return;
    sectionElements.current.get(scrollSection)?.scrollIntoView({ block: "start" });
    setScrollSection(null);
  }, [scrollSection, searching, page]);

  // 搜索设置名、说明和选项文字；空格分开的几个词都要出现，标题里就有的排前面
  const searchIndex = useMemo(() => {
    const keys = _.uniq([
      ...researchCommonSections.flatMap((section) => section.items).filter((item) => item !== "themePicker"),
      ...Object.values(visibleCategories).flatMap((groups) => Object.values(groups).flat()),
    ]);
    return keys.map((key) => {
      const options: unknown = t(`${key}.options`, { returnObjects: true, defaultValue: {} });
      const optionText =
        options && typeof options === "object"
          ? Object.values(options)
              .filter((it) => typeof it === "string")
              .join("\n")
          : "";
      const { title, description } = researchSettingText(t, key);
      return {
        key: key as keyof Settings,
        title: title.toLowerCase(),
        rest: `${description}\n${optionText}`.toLowerCase(),
      };
    });
  }, [t, visibleCategories]);
  const searchResults = useMemo(() => {
    const terms = keyword.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return [];
    const matched = searchIndex.filter((entry) =>
      terms.every((term) => entry.title.includes(term) || entry.rest.includes(term)),
    );
    return _.sortBy(matched, (entry) => (terms.every((term) => entry.title.includes(term)) ? 0 : 1)).map(
      (entry) => entry.key,
    );
  }, [keyword, searchIndex]);

  const groupKeys =
    page.kind === "group" ? ((visibleCategories[page.category]?.[page.group] ?? []) as (keyof Settings)[]) : [];

  return (
    <div className="flex h-full min-h-0">
      <nav className="border-border flex w-56 shrink-0 flex-col border-r">
        <div className="p-2">
          <div className="bg-muted focus-within:ring-ring/50 flex h-7 items-center gap-2 rounded-[6px] px-2 focus-within:ring-2">
            <Search className="text-muted-foreground size-3.5 shrink-0" />
            <input
              // 弹窗按 Esc 时先清空搜索，不关弹窗（见 SettingsWindow 的 onEscapeKeyDown）
              data-pg-settings-search
              autoFocus
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape" && keyword) setKeyword("");
              }}
              placeholder={tr("settings.searchPlaceholder")}
              spellCheck={false}
              className="placeholder:text-muted-foreground min-w-0 flex-1 bg-transparent text-[13px] outline-none"
            />
            {keyword && (
              <button
                type="button"
                aria-label={tr("settings.clearSearch")}
                className="text-muted-foreground hover:text-foreground"
                onClick={() => setKeyword("")}
              >
                <X className="size-3.5" />
              </button>
            )}
          </div>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-px overflow-auto px-2 pb-2">
          <ResearchNavItem
            icon={Star}
            label={t("categories.common.title")}
            active={!searching && page.kind === "common"}
            onClick={() => goTo({ page: { kind: "common" }, section: null })}
          />
          <ResearchNavItem
            icon={SlidersHorizontal}
            label={tr("settings.advanced")}
            open={advancedOpen}
            onClick={() => setAdvancedOpen((open) => !open)}
          />
          {advancedOpen &&
            Object.entries(visibleCategories).map(([category, groups]) => {
              const icons = (categoryIcons as Record<string, Record<string, LucideIcon>>)[category];
              const open = openCategories.has(category);
              return (
                <div key={category} className="flex flex-col gap-px">
                  <ResearchNavItem
                    depth={1}
                    icon={icons.icon}
                    label={t(`categories.${category}.title`)}
                    open={open}
                    onClick={() =>
                      setOpenCategories((prev) => {
                        const next = new Set(prev);
                        if (!next.delete(category)) next.add(category);
                        return next;
                      })
                    }
                  />
                  {open &&
                    Object.keys(groups).map((group) => (
                      <ResearchNavItem
                        key={group}
                        depth={2}
                        icon={icons[group]}
                        label={t(`categories.${category}.${group}`)}
                        active={
                          !searching && page.kind === "group" && page.category === category && page.group === group
                        }
                        onClick={() => goTo({ page: { kind: "group", category, group }, section: null })}
                      />
                    ))}
                </div>
              );
            })}
        </div>
      </nav>
      <div
        key={searching ? "search" : page.kind === "group" ? `${page.category}/${page.group}` : "common"}
        className="min-w-0 flex-1 overflow-auto"
      >
        <div className="flex flex-col gap-6 px-6 py-5">
          {searching ? (
            <section className="flex flex-col gap-3">
              <h2 className="text-foreground text-[14px] font-semibold">
                {tr("settings.searchResults", { count: searchResults.length })}
              </h2>
              {searchResults.length === 0 ? (
                <p className="text-muted-foreground text-[13px]">
                  {tr("settings.noResults", { keyword: keyword.trim() })}
                </p>
              ) : (
                <ResearchSettingList keys={searchResults} />
              )}
            </section>
          ) : page.kind === "common" ? (
            <>
              <h2 className="text-foreground text-[14px] font-semibold">{t("categories.common.title")}</h2>
              {researchCommonSections.map((section) => (
                <section
                  key={section.id}
                  ref={(element) => {
                    if (element) sectionElements.current.set(section.id, element);
                    else sectionElements.current.delete(section.id);
                  }}
                  className="flex scroll-mt-5 flex-col gap-2"
                >
                  <h3 className="text-muted-foreground px-1 text-[11px] font-semibold tracking-wide">
                    {t(`categories.common.${section.id}`)}
                  </h3>
                  <div className="border-border divide-border flex flex-col divide-y rounded-[8px] border">
                    {section.items.map((item) =>
                      item === "themePicker" ? (
                        <ThemePickerRow key={item} />
                      ) : (
                        <SettingField key={item} settingKey={item} />
                      ),
                    )}
                  </div>
                </section>
              ))}
            </>
          ) : (
            <section className="flex flex-col gap-3">
              <h2 className="text-foreground text-[14px] font-semibold">
                <span className="text-muted-foreground font-medium">{t(`categories.${page.category}.title`)} / </span>
                {t(`categories.${page.category}.${page.group}`)}
              </h2>
              <ResearchSettingList keys={groupKeys} />
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

function ResearchSettingList({ keys }: { keys: (keyof Settings)[] }) {
  return (
    <div className="border-border divide-border flex flex-col divide-y rounded-[8px] border">
      {keys.map((key) => (
        <SettingField key={key} settingKey={key} />
      ))}
    </div>
  );
}

function ResearchNavItem({
  icon: Icon,
  label,
  depth = 0,
  active = false,
  open,
  onClick,
}: {
  icon?: LucideIcon;
  label: string;
  depth?: number;
  active?: boolean;
  /** 传了就是可以展开的节点 */
  open?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-current={active ? "page" : undefined}
      onClick={onClick}
      className={cn(
        "focus-visible:ring-ring/50 flex h-7 w-full shrink-0 items-center gap-2 rounded-[6px] pr-2 text-left text-[13px] outline-none focus-visible:ring-2",
        active ? "bg-primary/10 text-primary font-medium" : "text-foreground hover:bg-accent",
      )}
      style={{ paddingLeft: 8 + depth * 16 }}
    >
      {Icon && <Icon className={cn("size-4 shrink-0", !active && "text-muted-foreground")} />}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {open !== undefined && (
        <ChevronRight
          className={cn("text-muted-foreground size-3.5 shrink-0 transition-transform", open && "rotate-90")}
        />
      )}
    </button>
  );
}

function ThemePickerRow() {
  const { t } = useTranslation("research");
  const navigation = useContext(SettingsNavigationContext);
  return (
    <SettingRow title={t("settings.theme.title")} description={t("settings.theme.description")}>
      <Button
        variant="outline"
        size="sm"
        className="h-7 text-[13px]"
        disabled={!navigation}
        onClick={() => navigation?.openTab("customization")}
      >
        <Palette className="size-3.5" />
        {t("settings.theme.button")}
      </Button>
    </SettingRow>
  );
}

function UpstreamSettingsTab() {
  const { t } = useTranslation("settings");
  const [initialCategory] = useState(() => pendingInitialCategory);
  const [currentCategory, setCurrentCategory] = useState(initialCategory?.category ?? "search");
  const [currentGroup, setCurrentGroup] = useState(initialCategory?.group ?? "");
  useEffect(() => {
    pendingInitialCategory = null;
  }, []);
  const [searchKeyword, setSearchKeyword] = useState("");
  const [searchResult, setSearchResult] = useState<string[]>([]);
  const fuse = useRef<Fuse<{ key: string; i18n: { title: string; description: string } }>>(null);
  const visibleCategories = useMemo(getVisibleCategories, []);

  useEffect(() => {
    fuse.current = new Fuse(
      Object.keys(settingsSchema.shape)
        .filter(isSettingKeyVisible)
        .map(
          (key) =>
            ({
              key,
              i18n: t(key, { returnObjects: true }),
            }) as any,
        ),
      { keys: ["key", "i18n.title", "i18n.description"], useExtendedSearch: true },
    );
  }, []);
  useEffect(() => {
    if (!fuse.current) return;
    const result = fuse.current.search(searchKeyword).map((it) => it.item.key);
    setSearchResult(result);
  }, [searchKeyword, fuse]);

  const groupKeys = useMemo(() => {
    if (currentCategory === "search" || !currentCategory || !currentGroup) return [] as string[];
    return visibleCategories[currentCategory]?.[currentGroup] ?? [];
  }, [currentCategory, currentGroup, visibleCategories]);

  return (
    <div className="flex h-full min-h-0">
      <Sidebar className="h-full overflow-hidden">
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    asChild
                    isActive={currentCategory === "search"}
                    onClick={() => setCurrentCategory("search")}
                  >
                    <div>
                      <Search />
                      <span>搜索</span>
                    </div>
                  </SidebarMenuButton>
                </SidebarMenuItem>
                {Object.entries(visibleCategories).map(([category, value]) => {
                  // @ts-expect-error fuck ts
                  const CategoryIcon = categoryIcons[category].icon;
                  return (
                    <Collapsible key={category} defaultOpen className="group/collapsible">
                      <SidebarMenuItem>
                        <SidebarMenuButton asChild>
                          <CollapsibleTrigger
                            onMouseEnter={() => {
                              SoundService.play.mouseEnterButton();
                            }}
                            onMouseDown={() => {
                              SoundService.play.mouseClickButton();
                            }}
                          >
                            <CategoryIcon />
                            <span>{t(`categories.${category}.title`)}</span>
                            <ChevronRight className="ml-auto transition-transform group-data-[state=open]/collapsible:rotate-90" />
                          </CollapsibleTrigger>
                        </SidebarMenuButton>
                        <SidebarMenuSub>
                          <CollapsibleContent>
                            {Object.entries(value).map(([group]) => {
                              // @ts-expect-error fuck ts
                              const GroupIcon = categoryIcons[category][group];
                              return (
                                <SidebarMenuSubItem key={group}>
                                  <SidebarMenuSubButton
                                    onMouseEnter={() => {
                                      SoundService.play.mouseEnterButton();
                                    }}
                                    onMouseDown={() => {
                                      SoundService.play.mouseClickButton();
                                    }}
                                    asChild
                                    isActive={category === currentCategory && group === currentGroup}
                                    onClick={() => {
                                      setCurrentCategory(category);
                                      setCurrentGroup(group);
                                    }}
                                  >
                                    <a href="#">
                                      <GroupIcon />
                                      <span>{t(`categories.${category}.${group}`)}</span>
                                    </a>
                                  </SidebarMenuSubButton>
                                </SidebarMenuSubItem>
                              );
                            })}
                          </CollapsibleContent>
                        </SidebarMenuSub>
                      </SidebarMenuItem>
                    </Collapsible>
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
      </Sidebar>
      <div className="mx-auto flex min-h-0 w-2/3 min-w-0 flex-col py-2">
        {currentCategory === "search" ? (
          <>
            <Input
              value={searchKeyword}
              onChange={(e) => setSearchKeyword(e.target.value)}
              placeholder="搜索..."
              autoFocus
              className="shrink-0"
            />
            {searchResult.length === 0 ? (
              <div className="flex flex-col">
                <span className="h-4"></span>
                <span>直接输入: 模糊匹配</span>
                <span>空格分割: “与”</span>
                <span>竖线分割: “或”</span>
                <span>=: 精确匹配</span>
                <span>&apos;: 包含</span>
                <span>!: 反向匹配</span>
                <span>^: 匹配开头</span>
                <span>!^: 反向匹配开头</span>
                <span>$: 匹配结尾</span>
                <span>!$: 反向匹配结尾</span>
              </div>
            ) : (
              <SettingFieldVirtualList keys={searchResult} />
            )}
          </>
        ) : (
          groupKeys.length > 0 && <SettingFieldVirtualList keys={groupKeys} />
        )}
      </div>
    </div>
  );
}

export const categories = {
  visual: {
    basic: [
      "language",
      "allowGlobalHotKeys",
      "isClassroomMode",
      "viewerMode",
      "showQuickSettingsToolbar",
      "showRecentFilesThumbnails",
      "showKeyBindHint",
      "windowBackgroundAlpha",
      "windowBackgroundOpacityAfterOpenClickThrough",
      "windowBackgroundOpacityAfterCloseClickThrough",
      "uiScalePercent",
    ],
    background: [
      "isRenderCenterPointer",
      "centerCrosshairColor",
      "centerCrosshairShape",
      "centerCrosshairAlpha",
      "showBackgroundHorizontalLines",
      "showBackgroundVerticalLines",
      "showBackgroundDots",
      "showBackgroundCartesian",
      "isStealthModeEnabled",
      "stealthModeScopeRadius",
      "stealthModeReverseMask",
      "stealthModeMaskShape",
    ],
    node: [
      "enableTagTextNodesBigDisplay",
      "forceHideTextNodeBorder",
      "textNodeInitBorderStyle",
      "showTreeDirectionHint",
      "showEditModeHint",
      "textNodeEditModeOutlineOpacity",
      "colorPanelMouseEnterPreview",
      "defaultFontFamily",
    ],
    section: [
      "sectionBitTitleRenderType",
      "sectionBigTitleThresholdRatio",
      "sectionBigTitleCameraScaleThreshold",
      "sectionBigTitleOpacity",
      "hideSectionContentsWhenBigTitleActive",
      "sectionBackgroundFillMode",
      "sectionInitBorderStyle",
    ],
    edge: ["lineStyle", "hideArrowWhenPointingToConnectPoint", "enableAutoEdgeWidth"],
    selectedState: ["enableCollisionBoxAutoWidth"],
    entityDetails: [
      "nodeDetailsPanel",
      "alwaysShowDetails",
      "exportMermaidIncludeNodeDetails",
      "entityDetailsFontSize",
      "entityDetailsLinesLimit",
      "entityDetailsWidthLimit",
    ],
    debug: ["showDebug", "protectingPrivacy", "protectingPrivacyMode"],
    experimental: ["windowCollapsingWidth", "windowCollapsingHeight"],
  },
  automation: {
    autoNamer: [
      "autoNamerTemplate",
      "autoNamerSectionTemplate",
      "autoNamerDetailsTemplate",
      "autoNamerTreeNodeTemplate",
    ],
    autoSave: ["autoSaveWhenClose", "autoSave", "autoSaveInterval"],
    autoBackup: [
      "autoBackup",
      "autoBackupInterval",
      "autoBackupLimitCount",
      "autoBackupStrategy",
      "autoBackupCustomPath",
      "autoBackupCustomPath2",
    ],
    autoImport: ["autoImportTxtFileWhenOpenPrg", "imageImportOrder"],
  },
  control: {
    mouse: [
      "mouseRightDragBackground",
      "mouseLeftMode",
      "doubleClickEmptySpaceAction",
      "enableSpaceKeyMouseLeftDrag",
      "enableDragAutoAlign",
      "reverseTreeMoveMode",
      "mouseWheelMode",
      "mouseWheelModeReverse",
      "mouseWheelWithShiftMode",
      "mouseWheelWithShiftModeReverse",
      "mouseWheelWithCtrlMode",
      "mouseWheelWithCtrlModeReverse",
      "mouseWheelWithAltMode",
      "mouseWheelWithAltModeReverse",
      "doubleClickMiddleMouseButton",
      "doubleClickMiddleMouseButtonOnEntity",
      "mouseSideWheelMode",
      "macMouseWheelIsSmoothed",
      "macEnableControlToCut",
      "enableCtrlWheelRotateStructure",
    ],
    touchpad: ["enableWindowsTouchPad", "macTrackpadAndMouseWheelDifference", "macTrackpadScaleSensitivity"],
    pen: ["hideCursorInPenMode", "penPressureCurve"],
    cameraMove: ["moveAmplitude", "moveFriction"],
    cameraZoom: [
      "scaleExponent",
      "cameraZoomInLimitBehavior",
      "cameraZoomOutLimitBehavior",
      "cameraResetViewPaddingRate",
      "cameraResetMaxScale",
      "scaleCameraByMouseLocation",
      "cameraKeyboardScaleRate",
    ],
    objectSelect: [
      "rectangleSelectWhenRight",
      "rectangleSelectWhenLeft",
      "cameraFollowsSelectedNodeOnArrowKeys",
      "arrowKeySelectOnlyInViewport",
    ],
    textNode: [
      "textNodeStartEditMode",
      "textNodeContentLineBreak",
      "textNodeExitEditMode",
      "textNodeExitEditModeOnWheel",
      "textNodeSelectAllWhenStartEditByMouseClick",
      "textNodeSelectAllWhenStartEditByKeyboard",
      "textNodeBackspaceDeleteWhenEmpty",
      "textNodeBigContentThresholdWhenPaste",
      "textNodePasteSizeAdjustMode",
      "textNodeManualDefaultCharWidth",
      "newNodeScaleByCamera",
      "newNodeScaleByCameraOffset",
    ],
    section: ["isEnableSectionCollision", "autoEnterSectionEditMode"],
    edge: [
      "allowAddCycleEdge",
      "enableDragNodeShakeDetachFromEdge",
      "autoAdjustLineEndpointsByMouseTrack",
      "autoAdjustLineEndpointsWhenRightDragToBlank",
      "enableRightClickConnect",
      "rightClickConnectEdgeType",
      "defaultEdgeLineType",
      "defaultEdgeArrowType",
      "enableDragEdgeRotateStructure",
    ],
    generateNode: [
      "autoLayoutWhenTreeGenerate",
      "autoLayoutWhenSectionCollapseToggle",
      "enableTreeGenerateConnectByProbe",
      "treeGenerateInheritParentColor",
      "enableTabGenerateNodeInInput",
      "enableBackslashGenerateNodeInInput",
      "textNodeAutoFormatTreeWhenInput",
      "treeGenerateCameraBehavior",
    ],
    gamepad: ["gamepadDeadzone"],
    image: [
      "resizePastedImages",
      "maxPastedImageSize",
      "compressImageToWebp",
      "webpQuality",
      "compressImageToBlackAndWhite",
      "blackAndWhiteThreshold",
      "wrapImageInGroup",
      "clipboardPasteMode",
    ],
  },
  performance: {
    memory: ["historySize", "clearHistoryWhenManualSave", "historyManagerMode"],
    cpu: ["autoRefreshStageByMouseAction", "maxFps", "maxFpsUnfocused"],
    render: [
      "isPauseRenderWhenManipulateOvertime",
      "pauseRenderWhenTabUnfocused",
      "renderOverTimeWhenNoManipulateTime",
      "scaleExponent",
      "ignoreTextNodeTextRenderLessThanFontSize",
      "textIntegerLocationAndSizeRender",
      "antialiasing",
    ],
    experimental: ["compatibilityMode", "isEnableEntityCollision"],
  },
  ai: {
    api: [
      "aiApiFormat",
      "aiApiBaseUrl",
      "aiApiKey",
      "aiModel",
      "aiCustomHeaders",
      "aiContextWindow",
      "aiShowTokenCount",
      "aiAutoApproveMcpTools",
    ],
  },
};

// 每个大类和分组都要有图标，设置页按这里取，缺了会报错
export const categoryIcons = {
  common: {
    icon: Star,
    folder: FolderOpen,
    board: Mouse,
    ai: Brain,
    appearance: Palette,
    save: Save,
  },
  research: {
    icon: FlaskConical,
    folder: FolderOpen,
    mouse: Mouse,
    ai: BookOpenText,
    menu: PanelTop,
  },
  ai: {
    icon: Brain,
    api: Unplug,
  },
  automation: {
    icon: Bot,
    autoNamer: SquareFunction,
    autoSave: Save,
    autoBackup: FolderSync,
    autoImport: Import,
  },
  control: {
    icon: Wrench,
    pen: Pen,
    mouse: Mouse,
    touchpad: Touchpad,
    cameraMove: Scan,
    cameraZoom: ScanSearch,
    objectSelect: SquareDashedMousePointer,
    textNode: TextCursorInput,
    section: SquareDashedTopSolid,
    edge: SplinePointer,
    generateNode: Network,
    image: Image,
    gamepad: Gamepad2,
  },
  performance: {
    icon: Zap,
    memory: MemoryStick,
    cpu: Cpu,
    render: Gpu,
    experimental: Sparkle,
  },
  visual: {
    icon: Eye,
    basic: Proportions,
    background: Layers,
    node: RectangleHorizontal,
    edge: MoveUpRight,
    section: SquareDashedTopSolid,
    selectedState: SquareDashedMousePointer,
    entityDetails: TextQuote,
    debug: Bug,
    miniWindow: PictureInPicture,
    experimental: Sparkle,
  },
};
