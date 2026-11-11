import { Button } from "@/components/ui/button";
import { researchSettingText, SettingField, SettingRow } from "@/components/ui/field";
import { Settings } from "@/core/service/Settings";
import { cn } from "@/utils/cn";
import _ from "lodash";
import {
  Brain,
  ChevronLeft,
  EyeOff,
  FolderOpen,
  Image,
  type LucideIcon,
  Mouse,
  Plug,
  Network,
  Palette,
  RectangleHorizontal,
  Save,
  Search,
  Sparkles,
  SplinePointer,
  Terminal,
  Volume2,
  X,
} from "lucide-react";
import { type ComponentType, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import EffectsPage from "./customization/effects";
import SoundEffectsPage from "./customization/sounds";
import ExternalAiPage from "./ExternalAiPage";
import LocalAgentsPage from "./LocalAgentsPage";
import ThemesTab from "./themes";

export type SettingsDialogTab = "settings" | "keybinds" | "menus" | "about";

/** 主题、画布动画、音效各有自己的整页界面，从「外观」里点进去 */
export type SettingsSubPageId = "themes" | "effects" | "sounds" | "externalAi" | "localAgents";

type SettingsItem = keyof Settings | { subPage: SettingsSubPageId };

export interface SettingsPage {
  id: string;
  icon: LucideIcon;
  /** 只有一节的页面不显示小标题 */
  sections: { id: string; items: SettingsItem[] }[];
}

/**
 * 设置页按「在做什么事」分页，每页把这件事的设置放全、常用的在前。
 * 没列在这里的设置不在界面上出现（照旧保存、照旧生效），比如十字准星、游戏手柄、帧率这类，
 * 以及启动时强制关掉、或者已经不起作用的项（遥测、全局热键、窗口透明度、原版滚轮设置……）。
 */
export const settingsPages: SettingsPage[] = [
  {
    id: "folder",
    icon: FolderOpen,
    sections: [
      {
        id: "main",
        items: ["researchFolderPath", "literatureLibraryPath", "researchOutsideFileMode", "writeAiSidecarOnSave"],
      },
    ],
  },
  {
    id: "save",
    icon: Save,
    sections: [
      { id: "save", items: ["autoSave", "autoSaveInterval", "autoSaveWhenClose"] },
      { id: "backup", items: ["autoBackup", "autoBackupInterval", "autoBackupLimitCount", "autoBackupCustomPath"] },
      { id: "undo", items: ["historySize"] },
    ],
  },
  {
    id: "ai",
    icon: Brain,
    sections: [
      {
        id: "source",
        items: ["aiBackend", "aiLocalAgent", { subPage: "localAgents" }],
      },
      { id: "api", items: ["aiApiFormat", "aiApiBaseUrl", "aiApiKey", "aiModel", "aiCustomHeaders"] },
      { id: "context", items: ["aiPdfTextPages", "aiContextWindow", "aiShowTokenCount"] },
      { id: "translation", items: ["translateService"] },
      {
        id: "external",
        items: ["mcpAllowEdits", "mcpAllowDelete", "mcpAllowNetwork", { subPage: "externalAi" }],
      },
    ],
  },
  {
    id: "appearance",
    icon: Palette,
    sections: [
      { id: "theme", items: ["themeMode", { subPage: "themes" }, "language", "uiScalePercent"] },
      {
        id: "background",
        items: ["showBackgroundDots", "showBackgroundHorizontalLines", "showBackgroundVerticalLines"],
      },
      {
        id: "other",
        items: [
          "defaultFontFamily",
          "showRecentFilesThumbnails",
          "showKeyBindHint",
          "researchShowFullMenu",
          { subPage: "effects" },
          { subPage: "sounds" },
        ],
      },
    ],
  },
  {
    id: "card",
    icon: RectangleHorizontal,
    sections: [
      { id: "style", items: ["textNodeInitBorderStyle", "forceHideTextNodeBorder", "textNodeManualDefaultCharWidth"] },
      {
        id: "edit",
        items: [
          "textNodeStartEditMode",
          "textNodeExitEditMode",
          "textNodeContentLineBreak",
          "textNodeSelectAllWhenStartEditByMouseClick",
          "textNodeSelectAllWhenStartEditByKeyboard",
          "textNodeBackspaceDeleteWhenEmpty",
          "textNodeExitEditModeOnWheel",
        ],
      },
      {
        id: "details",
        items: ["alwaysShowDetails", "entityDetailsFontSize", "entityDetailsLinesLimit", "entityDetailsWidthLimit"],
      },
    ],
  },
  {
    id: "edge",
    icon: SplinePointer,
    sections: [
      {
        id: "edge",
        items: [
          "lineStyle",
          "defaultEdgeLineType",
          "defaultEdgeArrowType",
          "allowAddCycleEdge",
          "enableDragNodeShakeDetachFromEdge",
          "enableRightClickConnect",
          "rightClickConnectEdgeType",
        ],
      },
      {
        id: "section",
        items: [
          "sectionInitBorderStyle",
          "sectionBackgroundFillMode",
          "sectionBitTitleRenderType",
          "autoEnterSectionEditMode",
          "isEnableSectionCollision",
        ],
      },
    ],
  },
  {
    id: "mouse",
    icon: Mouse,
    sections: [
      {
        id: "wheel",
        items: [
          "researchWheelBehavior",
          "researchMouseWheelPanStep",
          "researchMouseWheelZoomStep",
          "scaleCameraByMouseLocation",
          "scaleExponent",
        ],
      },
      {
        id: "drag",
        items: [
          "mouseRightDragBackground",
          "enableSpaceKeyMouseLeftDrag",
          "enableDragAutoAlign",
          "doubleClickEmptySpaceAction",
        ],
      },
      { id: "select", items: ["rectangleSelectWhenRight", "rectangleSelectWhenLeft"] },
    ],
  },
  {
    id: "generate",
    icon: Network,
    sections: [
      {
        id: "main",
        items: [
          "autoLayoutWhenTreeGenerate",
          "treeGenerateInheritParentColor",
          "treeGenerateCameraBehavior",
          "enableTabGenerateNodeInInput",
          "enableBackslashGenerateNodeInInput",
          "enableTreeGenerateConnectByProbe",
        ],
      },
    ],
  },
  {
    id: "image",
    icon: Image,
    sections: [
      {
        id: "main",
        items: ["maxPastedImageSize", "resizePastedImages", "compressImageToWebp", "webpQuality", "wrapImageInGroup"],
      },
    ],
  },
  {
    id: "privacy",
    icon: EyeOff,
    sections: [{ id: "main", items: ["protectingPrivacy", "protectingPrivacyMode", "viewerMode"] }],
  },
];

const subPages: Record<SettingsSubPageId, { icon: LucideIcon; component: ComponentType; padded: boolean }> = {
  // 主题页自带左右两栏，不加内边距
  themes: { icon: Palette, component: ThemesTab, padded: false },
  effects: { icon: Sparkles, component: EffectsPage, padded: true },
  sounds: { icon: Volume2, component: SoundEffectsPage, padded: true },
  externalAi: { icon: Plug, component: ExternalAiPage, padded: true },
  localAgents: { icon: Terminal, component: LocalAgentsPage, padded: true },
};

/** 每页里的设置项（不含点进去的子页面），搜索和测试用 */
export function settingKeysOf(page: SettingsPage): (keyof Settings)[] {
  return page.sections.flatMap((section) =>
    section.items.filter((item): item is keyof Settings => typeof item === "string"),
  );
}

type SettingsTarget = { pageId: string; subPage?: SettingsSubPageId };

let pendingInitialPage: SettingsTarget | null = null;
// 设置弹窗只有一个，已经开着时由它自己跳过去
const initialPageListeners = new Set<(target: SettingsTarget) => void>();

/** 下一次打开设置页时直接停在某一页（或页里的子页面），例如 AI 面板里的「去设置」按钮停在 AI 页 */
export function setSettingsInitialPage(pageId: string, subPage?: SettingsSubPageId) {
  pendingInitialPage = { pageId, subPage };
  for (const listener of initialPageListeners) listener(pendingInitialPage);
}

function knownPageId(pageId: string | null): string {
  return settingsPages.some((page) => page.id === pageId) ? pageId! : settingsPages[0].id;
}

export default function SettingsTab() {
  const { t } = useTranslation("settings");
  const { t: tr } = useTranslation("research");
  const [pageId, setPageId] = useState(() => knownPageId(pendingInitialPage?.pageId ?? null));
  const [subPage, setSubPage] = useState<SettingsSubPageId | null>(() => pendingInitialPage?.subPage ?? null);
  const [keyword, setKeyword] = useState("");

  const goTo = (next: string, nextSubPage: SettingsSubPageId | null = null) => {
    setKeyword("");
    setSubPage(nextSubPage);
    setPageId(knownPageId(next));
  };

  useEffect(() => {
    pendingInitialPage = null;
    const listener = (next: SettingsTarget) => {
      pendingInitialPage = null;
      goTo(next.pageId, next.subPage ?? null);
    };
    initialPageListeners.add(listener);
    return () => {
      initialPageListeners.delete(listener);
    };
  }, []);

  // 搜索设置名、说明和选项文字；空格分开的几个词都要出现，标题里就有的排前面
  const searchIndex = useMemo(
    () =>
      settingsPages.flatMap(settingKeysOf).map((key) => {
        const options: unknown = t(`${key}.options`, { returnObjects: true, defaultValue: {} });
        const optionText =
          options && typeof options === "object"
            ? Object.values(options)
                .filter((it) => typeof it === "string")
                .join("\n")
            : "";
        const { title, description } = researchSettingText(t, key);
        return { key, title: title.toLowerCase(), rest: `${description}\n${optionText}`.toLowerCase() };
      }),
    [t],
  );
  const searching = keyword.trim() !== "";
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

  const page = settingsPages.find((candidate) => candidate.id === pageId) ?? settingsPages[0];
  const pageTitle = (id: string) => tr(`settings.pages.${id}.title`);

  return (
    <div className="flex h-full min-h-0">
      <nav className="border-border flex w-48 shrink-0 flex-col border-r">
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
          {settingsPages.map((candidate) => (
            <SettingsNavItem
              key={candidate.id}
              icon={candidate.icon}
              label={pageTitle(candidate.id)}
              active={!searching && candidate.id === page.id}
              onClick={() => goTo(candidate.id)}
            />
          ))}
        </div>
      </nav>
      {!searching && subPage ? (
        <SubPageView
          id={subPage}
          parentTitle={pageTitle(page.id)}
          title={tr(`settings.subPages.${subPage}.title`)}
          onBack={() => setSubPage(null)}
        />
      ) : (
        <div key={searching ? "search" : page.id} className="min-w-0 flex-1 overflow-auto">
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
                  <SettingList items={searchResults} onOpenSubPage={setSubPage} />
                )}
              </section>
            ) : (
              <>
                <h2 className="text-foreground text-[14px] font-semibold">{pageTitle(page.id)}</h2>
                {page.sections.map((section) => (
                  <section key={section.id} className="flex flex-col gap-2">
                    {page.sections.length > 1 && (
                      <h3 className="text-muted-foreground px-1 text-[11px] font-semibold tracking-wide">
                        {tr(`settings.pages.${page.id}.${section.id}`)}
                      </h3>
                    )}
                    <SettingList items={section.items} onOpenSubPage={setSubPage} />
                  </section>
                ))}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function SettingList({
  items,
  onOpenSubPage,
}: {
  items: SettingsItem[];
  onOpenSubPage: (id: SettingsSubPageId) => void;
}) {
  return (
    <div className="border-border divide-border flex flex-col divide-y rounded-[8px] border">
      {items.map((item) =>
        typeof item === "string" ? (
          <SettingField key={item} settingKey={item} />
        ) : (
          <SubPageRow key={item.subPage} id={item.subPage} onOpen={() => onOpenSubPage(item.subPage)} />
        ),
      )}
    </div>
  );
}

function SubPageRow({ id, onOpen }: { id: SettingsSubPageId; onOpen: () => void }) {
  const { t } = useTranslation("research");
  const Icon = subPages[id].icon;
  return (
    <SettingRow title={t(`settings.subPages.${id}.title`)} description={t(`settings.subPages.${id}.description`)}>
      <Button variant="outline" size="sm" className="h-7 text-[13px]" onClick={onOpen}>
        <Icon className="size-3.5" />
        {t(`settings.subPages.${id}.button`)}
      </Button>
    </SettingRow>
  );
}

function SubPageView({
  id,
  parentTitle,
  title,
  onBack,
}: {
  id: SettingsSubPageId;
  parentTitle: string;
  title: string;
  onBack: () => void;
}) {
  const { component: Component, padded } = subPages[id];
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="border-border flex h-10 shrink-0 items-center gap-1 border-b px-3 text-[13px]">
        <Button
          variant="ghost"
          size="sm"
          className="text-muted-foreground h-7 gap-1 px-1.5 text-[13px]"
          onClick={onBack}
        >
          <ChevronLeft className="size-4" />
          {parentTitle}
        </Button>
        <span className="text-muted-foreground">/</span>
        <span className="font-semibold">{title}</span>
      </div>
      <div className={cn("min-h-0 flex-1", padded ? "overflow-auto p-4" : "overflow-hidden")}>
        <Component />
      </div>
    </div>
  );
}

function SettingsNavItem({
  icon: Icon,
  label,
  active,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-current={active ? "page" : undefined}
      onClick={onClick}
      className={cn(
        "focus-visible:ring-ring/50 flex h-7 w-full shrink-0 items-center gap-2 rounded-[6px] px-2 text-left text-[13px] outline-none focus-visible:ring-2",
        active ? "bg-primary/10 text-primary font-medium" : "text-foreground hover:bg-accent",
      )}
    >
      <Icon className={cn("size-4 shrink-0", !active && "text-muted-foreground")} />
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </button>
  );
}
