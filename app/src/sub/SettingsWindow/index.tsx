import { OverlayHost } from "@/components/overlay-host";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { isResearchShell } from "@/core/research/ResearchShell";
import { createSubWindow } from "@/core/subWindowOpen";
import { ComponentTabContext } from "@/core/Tab";
import { activeTabAtom, store } from "@/state";
import { cn } from "@/utils/cn";
import { Vector } from "@graphif/data-structures";
import { Rectangle } from "@graphif/shapes";
import { atom, useAtomValue } from "jotai";
import { Blocks, Brush, HandHeart, Info, Keyboard, type LucideIcon, Settings, User, X } from "lucide-react";
import { Tabs as TabsPrimitive } from "radix-ui";
import { useContext, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import AboutTab from "./about";
import AccountTab from "./account";
import CreditsTab from "./credits";
import CustomizationTab from "./customization";
import QuickSettingsTab from "./customization/quick-settings";
import ExtensionsTab from "./extensions";
import KeyBindsPage from "./keybinds";
import SettingsTab, { type SettingsDialogTab, SettingsNavigationContext } from "./settings";

type TabName = "settings" | "linuxRuntime" | "keybinds" | "customization" | "about" | "extensions" | "account";

// 科研模式不需要账户、扩展和鸣谢（捐助）页
const researchHiddenTabs: ReadonlySet<string> = new Set(["account", "extensions", "credits"]);

export default function SettingsWindow({ defaultTab = "settings" }: { defaultTab?: TabName }) {
  const researchShell = isResearchShell();
  const [currentTab, setCurrentTab] = useState<TabName>(
    researchShell && researchHiddenTabs.has(defaultTab) ? "settings" : defaultTab,
  );
  const owner = useContext(ComponentTabContext);
  const activeTab = useAtomValue(activeTabAtom);
  const [navigationHost, setNavigationHost] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setNavigationHost(document.getElementById("pg-titlebar-navigation"));
  }, []);
  const portalHost = owner?.layout === "docked" && activeTab === owner ? navigationHost : null;
  const navigation = (
    <div className="scrollbar-hide h-full max-w-full min-w-0 overflow-x-auto rounded-full">
      <TabsList
        variant="capsule"
        className="w-max [&_[data-slot=tabs-indicator]]:rounded-full [&_[role=tab]]:shrink-0 [&_[role=tab]]:rounded-full"
      >
        <TabsTrigger value="settings">
          <Settings />
          设置
        </TabsTrigger>
        <TabsTrigger value="keybinds">
          <Keyboard />
          快捷键
        </TabsTrigger>
        <TabsTrigger value="customization">
          <Brush />
          个性化
        </TabsTrigger>
        {!researchShell && (
          <TabsTrigger value="account">
            <User />
            账户
          </TabsTrigger>
        )}
        {!researchShell && (
          <TabsTrigger value="extensions">
            <Blocks />
            扩展
          </TabsTrigger>
        )}
        <TabsTrigger value="about">
          <Info />
          关于
        </TabsTrigger>
        {!researchShell && (
          <TabsTrigger value="credits">
            <HandHeart />
            鸣谢
          </TabsTrigger>
        )}
      </TabsList>
    </div>
  );

  return (
    <Tabs
      data-pg-settings-view
      value={currentTab}
      onValueChange={setCurrentTab as any}
      className="h-full gap-0 overflow-hidden"
    >
      {portalHost ? createPortal(navigation, portalHost) : <div className="flex h-10 shrink-0">{navigation}</div>}
      <TabsContent value="settings" className="min-h-0 overflow-hidden">
        <SettingsTab />
      </TabsContent>
      <TabsContent value="keybinds" className="min-h-0 overflow-hidden">
        <KeyBindsPage />
      </TabsContent>
      <TabsContent value="customization" className="overflow-auto">
        <CustomizationTab />
      </TabsContent>
      {!researchShell && (
        <TabsContent value="account" className="overflow-auto">
          <AccountTab />
        </TabsContent>
      )}
      <TabsContent value="quickSettings" className="overflow-auto">
        <QuickSettingsTab />
      </TabsContent>
      {!researchShell && (
        <TabsContent value="extensions" className="overflow-auto">
          <ExtensionsTab />
        </TabsContent>
      )}
      <TabsContent value="about" className="overflow-auto">
        <AboutTab />
      </TabsContent>
      {!researchShell && (
        <TabsContent value="credits" className="overflow-auto">
          <CreditsTab />
        </TabsContent>
      )}
    </Tabs>
  );
}

const researchDialogTabs: { value: SettingsDialogTab; icon: LucideIcon }[] = [
  { value: "settings", icon: Settings },
  { value: "keybinds", icon: Keyboard },
  { value: "customization", icon: Brush },
  { value: "about", icon: Info },
];

function researchDialogTab(tab: TabName): SettingsDialogTab {
  return researchDialogTabs.some((it) => it.value === tab) ? (tab as SettingsDialogTab) : "settings";
}

// 每次 open 都换一个 seq，已经开着的弹窗据此切到要求的页面并拿回焦点
const researchDialogRequestAtom = atom<{ tab: SettingsDialogTab; seq: number }>({ tab: "settings", seq: 0 });
let researchDialogOpen = false;

/** 科研模式：设置是居中的弹窗，只开一个，不暂停白板 */
function openResearchSettingsDialog(tab: TabName) {
  const previous = store.get(researchDialogRequestAtom);
  store.set(researchDialogRequestAtom, { tab: researchDialogTab(tab), seq: previous.seq + 1 });
  if (researchDialogOpen) return;
  researchDialogOpen = true;
  OverlayHost.open(<ResearchSettingsDialog />);
}

function ResearchSettingsDialog({ overlayId }: { overlayId?: string }) {
  const { t } = useTranslation("research");
  const request = useAtomValue(researchDialogRequestAtom);
  const [open, setOpen] = useState(true);
  const [tab, setTab] = useState(request.tab);
  const contentRef = useRef<HTMLDivElement>(null);
  const firstSeq = useRef(request.seq);

  useEffect(() => {
    setTab(request.tab);
    // 刚打开时交给弹窗自己决定焦点（设置页是搜索框）
    if (request.seq !== firstSeq.current) contentRef.current?.focus();
  }, [request]);

  useEffect(() => {
    // 白板还是当前标签页，快捷键会照常作用到它身上（比如焦点在开关上按 Delete 会删掉选中的卡片）。
    // 在 document 上拦下，到不了 window 上的快捷键引擎；同在 document 上的监听（快捷键页的按键录制）不受影响
    const stop = (event: Event) => event.stopPropagation();
    document.addEventListener("keydown", stop);
    document.addEventListener("wheel", stop);
    return () => {
      document.removeEventListener("keydown", stop);
      document.removeEventListener("wheel", stop);
    };
  }, []);

  const close = () => {
    setOpen(false);
    researchDialogOpen = false;
    setTimeout(() => OverlayHost.close(overlayId!), 200);
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && close()}>
      <DialogContent
        ref={contentRef}
        tabIndex={-1}
        showCloseButton={false}
        aria-describedby={undefined}
        onEscapeKeyDown={(event) => {
          const target = event.target as HTMLElement | null;
          if (target instanceof HTMLInputElement && target.dataset.pgSettingsSearch !== undefined && target.value) {
            event.preventDefault();
          }
        }}
        className="flex h-[640px] max-h-[85vh] w-[880px] max-w-[90vw] flex-col gap-0 overflow-hidden rounded-[12px] p-0 shadow-xl outline-none sm:max-w-[90vw]"
      >
        <SettingsNavigationContext.Provider value={{ openTab: setTab }}>
          <Tabs
            value={tab}
            onValueChange={(value) => setTab(value as SettingsDialogTab)}
            className="min-h-0 flex-1 gap-0"
          >
            <div className="border-border flex h-10 shrink-0 items-center gap-2 border-b px-2">
              <DialogTitle className="sr-only">{t("settings.dialogTitle")}</DialogTitle>
              <TabsPrimitive.List className="flex items-center gap-1">
                {researchDialogTabs.map(({ value, icon: Icon }) => (
                  <TabsPrimitive.Trigger
                    key={value}
                    value={value}
                    className={cn(
                      "focus-visible:ring-ring/50 text-muted-foreground flex h-7 items-center gap-2 rounded-[6px] px-2 text-[13px] font-medium outline-none focus-visible:ring-2",
                      "hover:bg-accent hover:text-foreground data-[state=active]:bg-primary/10 data-[state=active]:text-primary",
                    )}
                  >
                    <Icon className="size-4" />
                    {t(`settings.tabs.${value}`)}
                  </TabsPrimitive.Trigger>
                ))}
              </TabsPrimitive.List>
              <Tooltip>
                <TooltipTrigger>
                  <DialogClose asChild>
                    <Button variant="ghost" size="icon" aria-label={t("settings.close")} className="ml-auto size-7">
                      <X />
                    </Button>
                  </DialogClose>
                </TooltipTrigger>
                <TooltipContent>{t("settings.close")}</TooltipContent>
              </Tooltip>
            </div>
            <TabsContent value="settings" className="min-h-0 overflow-hidden">
              <SettingsTab />
            </TabsContent>
            <TabsContent value="keybinds" className="min-h-0 overflow-hidden">
              <KeyBindsPage />
            </TabsContent>
            <TabsContent value="customization" className="min-h-0 overflow-hidden">
              <CustomizationTab />
            </TabsContent>
            <TabsContent value="about" className="min-h-0 overflow-auto">
              <AboutTab />
            </TabsContent>
          </Tabs>
        </SettingsNavigationContext.Provider>
      </DialogContent>
    </Dialog>
  );
}

// TODO: page参数
SettingsWindow.open = (tab: TabName = "settings") => {
  if (isResearchShell()) {
    openResearchSettingsDialog(tab);
    return;
  }
  store.get(activeTabAtom)?.pause();
  createSubWindow("SettingsWindow", {
    icon: Settings,
    title: "设置",
    children: <SettingsWindow defaultTab={tab} />,
    rect: Rectangle.inCenter(new Vector(innerWidth > 1653 ? 1240 : innerWidth * 0.75, innerHeight * 0.875)),
    titleBarOverlay: true,
  });
};
