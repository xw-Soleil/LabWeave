import { Button } from "@/components/ui/button";
import { FileName } from "@/components/ui/file-name";
import Markdown from "@/components/ui/markdown";
import { Project } from "@/core/Project";
import { ResearchFolder } from "@/core/research/ResearchFolder";
import {
  chooseResearchFolder,
  listResearchWorkspaces,
  openResearchWorkspace,
  researchFilesVersionAtom,
  type ResearchWorkspaceItem,
} from "@/core/research/ResearchSession";
import { emitResearchEvent, isResearchShell } from "@/core/research/ResearchShell";
import { AssetsRepository } from "@/core/service/AssetsRepository";
import { RecentFileManager } from "@/core/service/dataFileService/RecentFileManager";
import { closeEmptyDrafts, onNewDraft, onOpenFile } from "@/core/service/GlobalMenu";
import { Telemetry } from "@/core/service/Telemetry";
import { Tutorials } from "@/core/service/Tutorials";
import { Settings } from "@/core/service/Settings";
import { createSubWindow } from "@/core/subWindowOpen";
import { TabWorkspace } from "@/core/TabWorkspace";
import { store, tabsAtom } from "@/state";
import RecentFilesWindow from "@/sub/RecentFilesWindow";
import SettingsWindow from "@/sub/SettingsWindow";
import { cn } from "@/utils/cn";
import { Path } from "@/utils/path";
import { isMac } from "@/utils/platform";
import { Vector } from "@graphif/data-structures";
import { Rectangle } from "@graphif/shapes";
import { getVersion } from "@tauri-apps/api/app";
import { join, tempDir } from "@tauri-apps/api/path";
import { writeFile } from "@tauri-apps/plugin-fs";
import { fetch } from "@tauri-apps/plugin-http";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import {
  AlertTriangle,
  Bell,
  Check,
  Earth,
  FilePlus,
  FolderOpen,
  FolderSearch,
  Info,
  LoaderCircle,
  Map as MapIcon,
  RefreshCw,
  Settings as SettingsIcon,
  TableProperties,
  X,
} from "lucide-react";
import { useAtomValue } from "jotai";
import { useEffect, useLayoutEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { cpuInfo } from "tauri-plugin-system-info-api";
import { URI } from "vscode-uri";

interface Announcement {
  id: string;
  title: string;
  time: string;
  author: string;
  content: string;
}

const welcomeTabIds = new Set<string>();

const slogans = [
  "思维框架图和思维导图的区别在于，思维框架图不局限于树形结构，可以自由连接节点，形成用于分析项目结构的网络结构",
  "目前一般不建议一个prg文件超过50MB，否则文件过大可能影响性能，保存缓慢",
  "格式化树形结构时，需要保证每个连线都是一种标准化的方向的连线，例如向右的连线从源头右侧发出，目标左侧接收",
  "alt shift f 可以格式化树形结构，它源自于 VS Code 格式化代码的快捷键。每当按下这个快捷键时，左手像个兰花指。",
  "移动视野有13种方法，具体可以在官网的摄像机章节查看",
  "这个软件不是传统的思维导图软件",
  "打开一个文件后，ctrl + 0 可以直接透明窗口。可以用于一边看视频一边纯键盘操作",
  "WSAD可以移动视野。但其他软件的全局快捷键可能会干扰此软件监听WSAD的松开事件，进而导致视野一直朝着某方向移动，可以手动触发一次松开解决",
  "当视野放大到极限时会回到宏观视角。源自《围观尽头》",
  "F键可以快速聚焦视野到选中的物体，再按下shift+F可以快速回到按下F键之前的宏观视角",
  "选中图片后右下角有一个绿色按钮，可以拖拽改变大小",
  "向左框选和向右框选逻辑不同，源自CAD，框选可以大幅度提升自由布局的移动效率",
  "windows系统中，可以将此软件的exe放入zip中，直接双击预览打开zip文件然后双击打开内部的exe，可以逃过某些禁止运行exe电脑的限制",
  "软件是开源的，可以放心使用。采用 GPL-3.0 许可协议",
  "prg文件是软件的专有格式，用于存储思维框架图数据。本质是一个zip压缩包，解压后可以看到里面的图片文件",
  "windows系统中，跨文件复制需要在一个软件中打开两个标签页，而非直接双击prg文件打开两个软件",
  "当一个文本节点的内容恰好为一个文件的绝对路径或者网页URL时，可以 中键双击/快捷键/右键 直接打开这个文件或者网页",
  "按住ctrl键框选，可以实现反选。进而可以实现先选中一些节点，再用反选框选一次，选中所有的连线。",
  "框选优先级：框选起点所在分组框 > 节点 > 连线",
  "文本节点的字体大小是指数级别的，因为缩放视野时鼠标滚动的圈数和视野内大小变化尺度也是指数级别的。",
  "WSAD移动时，如果是高空飞行，移动速度会很快，如果是低空飞行，移动速度会很慢。",
  "选中两个节点，按两次数字4，可以左对齐，6是右对齐，8、2是上下对齐，看九宫格小键盘非常直观",
  "当脑机接口与视网膜投屏实现的那一天出现时，这个软件的生命就终结了，获许会以一种新的形态出现",
  "小特性：鼠标在空白地方拖出一个框选框不松手时，按下ctrl+G会直接创建一个框选框大小的分组框。用于自顶向下的绘制大板块结构",
  "不要当一个囤积知识的笔记拷贝者，而是要当一个知识的创造者与思考者。",
  "鼠标移动到窗口顶部空白地方时会出现一个带颜色的框，可以拖动这个区域来移动整个软件窗口",
  "当窗口缩小到足够小时，导航栏等UI会变得极小，可以当成一个迷你小窗口软件来使用",
  "windows系统中，右上角的小黄点可以用于想关闭软件时，直接鼠标无脑顶到右上角直接点击关闭。不需要再看x的位置并瞄准了",
  "推荐使用新版的导出PNG图片功能而非旧版的拼接图片导出功能",
];

function isWelcomeTab(tab: { id: string }): boolean {
  return welcomeTabIds.has(tab.id);
}

function getWelcomeRect() {
  const scale = Settings.uiScalePercent / 100;
  const viewport = new Vector(innerWidth / scale, innerHeight / scale);
  const size = new Vector(Math.min(960, viewport.x * 0.85), Math.min(640, viewport.y * 0.8));
  return new Rectangle(viewport.subtract(size).divide(2), size);
}

export default function WelcomeWindow({ tabId }: { tabId: string }) {
  useLayoutEffect(() => {
    const recenter = () => {
      const tab = TabWorkspace.get(tabId);
      if (!tab || tab.layout !== "floating" || tab.closing) return;
      // floatingRect 使用缩放后的 UI 坐标，不能再按未缩放的视口裁剪。
      tab.floatingRect = getWelcomeRect();
      store.set(tabsAtom, [...store.get(tabsAtom)]);
    };
    recenter();
    window.addEventListener("resize", recenter);
    const unwatch = Settings.watch("uiScalePercent", recenter);
    return () => {
      window.removeEventListener("resize", recenter);
      unwatch();
    };
  }, [tabId]);
  // 点击外部 / Escape 等路径关闭时也要清掉标记，避免下次 open 误判
  useEffect(() => () => void welcomeTabIds.delete(tabId), [tabId]);

  return isResearchShell() ? <ResearchWelcome tabId={tabId} /> : <ClassicWelcome tabId={tabId} />;
}

async function closeWelcome(tabId: string) {
  await TabWorkspace.close(tabId);
  welcomeTabIds.delete(tabId);
}

function ResearchWelcome({ tabId }: { tabId: string }) {
  const { t } = useTranslation("research");
  const filesVersion = useAtomValue(researchFilesVersionAtom);
  const [root, setRoot] = useState(ResearchFolder.getRoot());
  const [workspaces, setWorkspaces] = useState<ResearchWorkspaceItem[] | null>(null);
  const [listError, setListError] = useState("");

  useEffect(() => Settings.watch("researchFolderPath", setRoot), []);

  useEffect(() => {
    if (!root) return;
    let disposed = false;
    setListError("");
    listResearchWorkspaces().then(
      (items) => !disposed && setWorkspaces(items),
      (error: unknown) => !disposed && setListError(String(error)),
    );
    return () => {
      disposed = true;
    };
  }, [root, filesVersion]);

  const showError = (error: unknown) => toast.error(t("workspace.failed", { message: String(error) }));

  const chooseFolder = () => {
    chooseResearchFolder().catch(showError);
  };

  const openWorkspace = async (absPath: string) => {
    await closeWelcome(tabId);
    await openResearchWorkspace(absPath).catch(showError);
  };

  const openOtherFile = async () => {
    // 先关欢迎窗，避免系统文件对话框触发 closeWhenClickOutside 的竞态
    await closeWelcome(tabId);
    const opened = await onOpenFile(undefined, "科研工作台-欢迎页");
    if (opened instanceof Project) await closeEmptyDrafts(opened);
  };

  const sectionTitle = "text-muted-foreground text-[11px] font-semibold tracking-wide";
  const actionRow =
    "hover:bg-accent flex h-7 w-full cursor-pointer items-center gap-2 rounded-[6px] px-2 text-left text-[13px] font-medium";

  return (
    <div className="text-foreground flex h-full w-full overflow-auto p-6 text-[13px]">
      <div className="m-auto flex w-full max-w-3xl flex-col gap-6">
        <div className="flex flex-col gap-1">
          <span className="text-[14px] font-semibold">{t("welcome.title")}</span>
          <span className="text-muted-foreground">{t("welcome.subtitle")}</span>
        </div>

        <div className="flex flex-col gap-8 sm:flex-row">
          <div className="flex min-w-0 flex-1 flex-col gap-6">
            {root ? (
              <div className="flex flex-col gap-1">
                <span className={sectionTitle}>{t("welcome.folder")}</span>
                <div className="border-border flex h-10 items-center gap-2 rounded-[8px] border pr-1 pl-3">
                  <FolderOpen className="text-muted-foreground size-4 shrink-0" />
                  <PathTail path={root} className="flex-1" />
                  <Button variant="ghost" className="h-7 rounded-[6px] px-2 text-[13px]" onClick={chooseFolder}>
                    {t("welcome.changeFolder")}
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                <Button className="h-8 rounded-[6px] text-[13px]" onClick={chooseFolder}>
                  <FolderSearch className="size-4" />
                  {t("welcome.chooseFolder")}
                </Button>
                <span className="text-muted-foreground text-[12px]">{t("welcome.noFolderHint")}</span>
              </div>
            )}

            {root && (
              <div className="flex flex-col gap-1">
                <div className="flex h-7 items-center justify-between gap-2">
                  <span className={sectionTitle}>
                    {t("welcome.workspaces")}
                    {workspaces && workspaces.length > 0 && (
                      <span className="ml-1.5 font-normal tabular-nums">{workspaces.length}</span>
                    )}
                  </span>
                  <Button
                    className="h-7 rounded-[6px] px-2 text-[13px]"
                    onClick={async () => {
                      // 输入框是模态对话框，点它也算点了欢迎窗外面，所以先关掉欢迎窗
                      await closeWelcome(tabId);
                      emitResearchEvent("newWorkspace");
                    }}
                  >
                    <FilePlus className="size-4" />
                    {t("welcome.newWorkspace")}
                  </Button>
                </div>
                <div className="flex max-h-64 flex-col overflow-y-auto">
                  {listError ? (
                    <span className="text-destructive px-2 py-1 text-[12px]">
                      {t("workspace.listFailed", { message: listError })}
                    </span>
                  ) : workspaces === null ? (
                    <LoaderCircle className="text-muted-foreground m-2 size-4 animate-spin" />
                  ) : workspaces.length === 0 ? (
                    <span className="text-muted-foreground px-2 py-1">{t("welcome.noWorkspaces")}</span>
                  ) : (
                    workspaces.map((item) => {
                      const folder = parentPath(item.relPath);
                      return (
                        <button
                          key={item.absPath}
                          type="button"
                          className="hover:bg-accent flex h-7 w-full shrink-0 cursor-pointer items-center gap-3 rounded-[6px] px-2 text-left"
                          onClick={() => void openWorkspace(item.absPath)}
                        >
                          <FileName name={item.name} title={item.absPath} className="flex-1" />
                          {item.open && (
                            <span className="text-muted-foreground shrink-0 text-[11px]">{t("workspace.opened")}</span>
                          )}
                          {folder && (
                            <PathTail path={folder} className="text-muted-foreground max-w-[40%] text-[12px]" />
                          )}
                        </button>
                      );
                    })
                  )}
                </div>
              </div>
            )}
          </div>

          <div className="flex flex-col gap-6 sm:w-64">
            <div className="flex flex-col gap-2">
              <span className={sectionTitle}>{t("welcome.howTo.title")}</span>
              <ol className="text-muted-foreground flex list-decimal flex-col gap-2 pl-5 leading-[1.5]">
                <li>{t("welcome.howTo.step1")}</li>
                <li>{t("welcome.howTo.step2")}</li>
                <li>{t("welcome.howTo.step3")}</li>
              </ol>
            </div>
            <div className="-mx-2 flex flex-col">
              <button
                type="button"
                className={actionRow}
                onClick={() =>
                  void (async () => {
                    await onNewDraft();
                    await closeWelcome(tabId);
                  })().catch(showError)
                }
              >
                <FilePlus className="text-muted-foreground size-4 shrink-0" />
                <span className="truncate">{t("welcome.draft")}</span>
              </button>
              <button type="button" className={actionRow} onClick={() => void openOtherFile().catch(showError)}>
                <FolderOpen className="text-muted-foreground size-4 shrink-0" />
                <span className="truncate">{t("welcome.openOther")}</span>
              </button>
              <button
                type="button"
                className={actionRow}
                onClick={() => {
                  void closeWelcome(tabId);
                  SettingsWindow.open("settings");
                }}
              >
                <SettingsIcon className="text-muted-foreground size-4 shrink-0" />
                <span className="truncate">{t("welcome.settings")}</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** 去掉最后一段，得到所在文件夹；没有上级时返回空字符串 */
function parentPath(path: string) {
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return index > 0 ? path.slice(0, index) : "";
}

/**
 * 路径从开头省略、只留最后两段：`…/parent/folder`，最后一段尽量完整显示，悬停看完整路径。
 * 有用的信息在结尾，普通的末尾省略号会把文件夹名本身截掉。
 */
function PathTail({ path, className }: { path: string; className?: string }) {
  const trimmed = path.replace(/[\\/]+$/, "") || path;
  const segments = trimmed.split(/[\\/]/).filter(Boolean);
  const last = segments.at(-1) ?? trimmed;
  const separator = trimmed.includes("\\") && !trimmed.includes("/") ? "\\" : "/";
  const head =
    segments.length > 2
      ? `…${separator}${segments.at(-2)}${separator}`
      : trimmed.slice(0, Math.max(0, trimmed.length - last.length));
  return (
    <span className={cn("flex min-w-0 overflow-hidden whitespace-nowrap", className)} title={path}>
      <span className="min-w-0 shrink-[999] truncate">{head}</span>
      <span className="min-w-0 truncate">{last}</span>
    </span>
  );
}

function ClassicWelcome({ tabId }: { tabId: string }) {
  const [recentFiles, setRecentFiles] = useState<RecentFileManager.RecentFile[]>([]);
  const { t } = useTranslation("welcome");
  const [appVersion, setAppVersion] = useState("unknown");
  const [isDownloadingGuideFile, setIsDownloadingGuideFile] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [lastClickFileURIPath, setLastClickFileURIPath] = useState("");
  const [isAmdCpu, setIsAmdCpu] = useState(false);
  const [isAmdWarningDismissed, setIsAmdWarningDismissed] = useState(true);
  const [currentSlogan, setCurrentSlogan] = useState("");
  const [isHoveringSlogan, setIsHoveringSlogan] = useState(false);
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [announcementLoadError, setAnnouncementLoadError] = useState(false);

  useEffect(() => {
    refresh();
    (async () => {
      setAppVersion(await getVersion());
      const dismissed = await Tutorials.isFinished("amdCpuWarning");
      setIsAmdWarningDismissed(dismissed);
      if (!dismissed) {
        try {
          const cpu = await cpuInfo();
          const cpuBrand = cpu.cpus[0].brand;
          setIsAmdCpu(cpuBrand.includes("AMD"));
        } catch (e) {
          console.error("检测CPU信息失败:", e);
        }
      }
    })();

    randomizeSlogan();

    const abortController = import.meta.env.LR_API_BASE_URL ? new AbortController() : null;
    if (import.meta.env.LR_API_BASE_URL && abortController) {
      fetch(`${import.meta.env.LR_API_BASE_URL}/api/announcements`, { signal: abortController.signal })
        .then(async (response) => {
          if (!response.ok) throw new Error(`获取公告失败：HTTP ${response.status}`);
          const result = (await response.json()) as Announcement[];
          const unfinishedAnnouncements = await Promise.all(
            result.map(async (announcement) => ({
              announcement,
              isFinished: await Tutorials.isFinished(`announcement:${announcement.id}`),
            })),
          );
          setAnnouncements(
            unfinishedAnnouncements.filter(({ isFinished }) => !isFinished).map(({ announcement }) => announcement),
          );
        })
        .catch((error: unknown) => {
          if (error instanceof DOMException && error.name === "AbortError") return;
          setAnnouncementLoadError(true);
        });
    }

    return () => {
      abortController?.abort();
    };
  }, [tabId]);

  async function confirmAnnouncement(id: string) {
    await Telemetry.event("announcement_confirmed", { announcementId: id });
    await Tutorials.finish(`announcement:${id}`);
    setAnnouncements((current) => current.filter((announcement) => announcement.id !== id));
  }

  const randomizeSlogan = () => {
    const randomIndex = Math.floor(Math.random() * slogans.length);
    setCurrentSlogan(slogans[randomIndex]);
  };

  async function refresh() {
    setIsLoading(true);
    await RecentFileManager.sortTimeRecentFiles();
    setRecentFiles(await RecentFileManager.getRecentFiles());
    setIsLoading(false);
  }

  async function closeSelf() {
    await closeWelcome(tabId);
  }

  async function openProject(uri: URI | undefined, source: string) {
    // 先关欢迎窗，避免系统文件对话框触发 closeWhenClickOutside 的竞态
    await closeSelf();
    const opened = await onOpenFile(uri, source);
    if (opened instanceof Project) {
      await closeEmptyDrafts(opened);
    } else if (opened) {
      await closeEmptyDrafts();
    }
  }

  async function handleNewDraft() {
    await closeSelf();
    const hasEmptyDraft = store
      .get(tabsAtom)
      .some((tab) => tab instanceof Project && tab.isDraft && tab.stage.length === 0 && !tab.closing);
    if (!hasEmptyDraft) {
      await onNewDraft();
    }
  }

  return (
    <div className="flex h-full w-full overflow-auto p-4">
      <div className="m-auto flex w-full max-w-3xl flex-col gap-6 sm:gap-8">
        <div className="flex flex-col sm:gap-2">
          <div className="flex items-center gap-2">
            <span className="text-2xl sm:text-3xl">{t("title")}</span>
            <a
              href="https://graphif.dev/docs/app/misc/history"
              target="_blank"
              rel="noopener noreferrer"
              className="border-card-foreground/30 hover:border-primary/90 hidden cursor-pointer border-2 opacity-50 sm:inline sm:rounded-lg sm:px-2 sm:py-1 md:text-lg"
            >
              {appVersion}
            </a>
          </div>
          <div
            className="relative hidden text-xs opacity-50 sm:block"
            onMouseEnter={() => setIsHoveringSlogan(true)}
            onMouseLeave={() => setIsHoveringSlogan(false)}
          >
            <span>{currentSlogan}</span>
            {isHoveringSlogan && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  randomizeSlogan();
                }}
                className="hover:bg-muted absolute top-0 right-0 ml-2 inline-flex cursor-pointer items-center justify-center rounded p-1 transition-all active:scale-90"
                title="换一条小技巧"
              >
                <RefreshCw size={14} />
              </button>
            )}
          </div>
          {isAmdCpu && !isAmdWarningDismissed && (
            <div className="flex items-center gap-2 rounded-lg border p-3 text-sm text-yellow-600/75">
              <AlertTriangle className="shrink-0" />
              <span className="flex-1">您的设备（AMD CPU）可能在大屏(4k)下使用时存在渲染卡顿问题</span>
              <button
                onClick={async () => {
                  setIsAmdWarningDismissed(true);
                  await Tutorials.finish("amdCpuWarning");
                }}
                className="hover:bg-muted shrink-0 cursor-pointer rounded p-1 transition-all active:scale-90"
                title="不再提醒"
              >
                <X size={14} />
              </button>
            </div>
          )}
          {announcementLoadError && (
            <div className="text-muted-foreground flex items-center gap-2 text-xs">
              <AlertTriangle className="size-4" />
              暂时无法获取公告
            </div>
          )}
          {announcements.length > 0 && (
            <section className="mt-2 grid max-h-40 gap-2 overflow-auto" aria-label="公告">
              {announcements.map((announcement) => (
                <article key={announcement.id} className="bg-card/60 rounded-lg border p-3 shadow-sm">
                  <div className="flex items-start gap-3">
                    <Bell className="text-primary mt-0.5 size-4 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <h2 className="text-sm font-medium">{announcement.title}</h2>
                      <p className="text-muted-foreground mt-0.5 text-xs">
                        {announcement.author} · {new Date(announcement.time).toLocaleString()}
                      </p>
                      <p className="mt-2 max-w-2xl text-sm leading-5 wrap-break-word whitespace-pre-wrap">
                        <Markdown source={announcement.content} />
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => void confirmAnnouncement(announcement.id)}
                      className="hover:bg-muted flex shrink-0 cursor-pointer items-center gap-1 rounded-md px-2 py-1 text-xs transition-colors"
                    >
                      <Check className="size-3.5" />
                      确认
                    </button>
                  </div>
                </article>
              ))}
            </section>
          )}
        </div>

        <div className="flex flex-col gap-8 sm:flex-row sm:gap-12">
          <div className="flex min-w-0 flex-1 flex-col gap-6 sm:gap-8">
            <div className="grid grid-cols-2 grid-rows-2 gap-2 *:flex *:w-max *:cursor-pointer *:items-center *:gap-2 *:hover:opacity-75 *:active:scale-90 sm:gap-x-4">
              <div
                onClick={() => {
                  if (isDownloadingGuideFile) return;
                  setIsDownloadingGuideFile(true);
                  toast.promise(
                    async () => {
                      const u8a = await AssetsRepository.fetchFile("tutorials/tutorial-main-3.2.prg");
                      const dir = await tempDir();
                      const path = await join(dir, `tutorial-${crypto.randomUUID()}.prg`);
                      await writeFile(path, u8a);
                      await openProject(URI.file(path), "功能说明书");
                    },
                    {
                      loading: "正在下载功能说明书",
                      error: async (err) => {
                        console.error("下载功能说明书失败:", err);
                        return (
                          `下载功能说明书失败，可以尝试访问${AssetsRepository.getGuideFileUrl("tutorials/tutorial-main-3.2.prg")}，请确保您能访问github。` +
                          err
                        );
                      },
                      finally: () => {
                        setIsDownloadingGuideFile(false);
                      },
                    },
                  );
                }}
              >
                <MapIcon className={cn(isDownloadingGuideFile && "animate-spin")} />
                <span className="hidden sm:inline">{t("newUserGuide")}</span>
              </div>
              <div onClick={() => void handleNewDraft()}>
                <FilePlus />
                <span className="hidden sm:inline">{t("newDraft")}</span>
                <span className="hidden text-xs opacity-50 sm:inline">{isMac ? "⌘ + N" : "Ctrl + N"}</span>
              </div>
              <div
                onClick={() => {
                  void closeSelf();
                  RecentFilesWindow.open();
                }}
              >
                <TableProperties />
                <span className="hidden sm:inline">{t("openRecentFiles")}</span>
                <span className="hidden text-xs opacity-50 sm:inline">Shift + #</span>
              </div>
              <div onClick={() => void openProject(undefined, "欢迎页面")}>
                <FolderOpen />
                <span className="hidden sm:inline">{t("openFile")}</span>
                <span className="hidden text-xs opacity-50 sm:inline">{isMac ? "⌘ + O" : "Ctrl + O"}</span>
              </div>
            </div>
            <div
              className={cn("hidden flex-col gap-2 *:cursor-pointer *:transition-opacity *:hover:opacity-75 sm:flex")}
            >
              {recentFiles.slice(0, 6).map((file, index) => (
                <div
                  className="flex flex-row items-center gap-2"
                  key={index}
                  onClick={async () => {
                    if (isLoading) {
                      toast.error("正在打开文件，请稍后");
                      return;
                    }
                    setIsLoading(true);
                    setLastClickFileURIPath(file.uri.fsPath);
                    try {
                      await openProject(file.uri, "欢迎页面-最近打开的文件");
                    } catch (e) {
                      toast.error(String(e));
                    }
                    setIsLoading(false);
                    setLastClickFileURIPath("");
                  }}
                >
                  {isLoading && lastClickFileURIPath === file.uri.fsPath && (
                    <LoaderCircle className={cn(isLoading && "animate-spin")} />
                  )}
                  <div className="flex min-w-0 flex-col gap-1">
                    <span className="text-sm">{new Path(file.uri).nameWithoutExt}</span>
                    <span className="truncate text-xs opacity-50">{file.uri.fsPath}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-2 *:flex *:w-max *:cursor-pointer *:gap-2 *:hover:opacity-75 *:active:scale-90">
            <div
              onClick={() => {
                void closeSelf();
                SettingsWindow.open("settings");
              }}
            >
              <SettingsIcon />
              <span className="hidden sm:inline">{t("settings")}</span>
            </div>
            <div
              onClick={() => {
                void closeSelf();
                SettingsWindow.open("about");
              }}
            >
              <Info />
              <span className="hidden sm:inline">{t("about")}</span>
            </div>
            <div onClick={() => shellOpen("https://project-graph.top")}>
              <Earth />
              <span className="hidden sm:inline">{t("website")}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

WelcomeWindow.open = () => {
  const existing = store.get(tabsAtom).find((tab) => !tab.closing && isWelcomeTab(tab));
  if (existing) {
    TabWorkspace.focus(existing.id);
    return existing;
  }

  const tab = createSubWindow("WelcomeWindow", {
    children: (componentTab) => <WelcomeWindow tabId={componentTab.id} />,
    rect: getWelcomeRect(),
    canDock: false,
    closable: true,
    titleBarOverlay: true,
    closeWhenClickOutside: false,
  });
  welcomeTabIds.add(tab.id);
  return tab;
};

WelcomeWindow.closeAll = async () => {
  const welcomeTabs = store.get(tabsAtom).filter((tab) => !tab.closing && isWelcomeTab(tab));
  await Promise.all(
    welcomeTabs.map(async (tab) => {
      await TabWorkspace.close(tab.id);
      welcomeTabIds.delete(tab.id);
    }),
  );
};
