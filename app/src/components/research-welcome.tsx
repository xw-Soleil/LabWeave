import { Button } from "@/components/ui/button";
import { FileName } from "@/components/ui/file-name";
import { Project } from "@/core/Project";
import { ResearchFolder } from "@/core/research/ResearchFolder";
import {
  chooseResearchFolder,
  listResearchWorkspaces,
  openResearchWorkspace,
  researchFilesVersionAtom,
  type ResearchWorkspaceItem,
} from "@/core/research/ResearchSession";
import { emitResearchEvent } from "@/core/research/ResearchShell";
import { closeEmptyDrafts, onNewDraft, onOpenFile } from "@/core/service/GlobalMenu";
import { Settings } from "@/core/service/Settings";
import { cn } from "@/utils/cn";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import { useAtomValue } from "jotai";
import { FilePlus, FolderOpen, FolderSearch, LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

/**
 * 没打开工作区时编辑区里显示的欢迎页：研究文件夹、新建或打开工作区、最近改过的工作区。
 * 侧栏照常停在旁边，所以这里不重复放面板开关。
 */
export default function ResearchWelcome() {
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
      (items) => !disposed && setWorkspaces([...items].sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0))),
      (error: unknown) => !disposed && setListError(String(error)),
    );
    return () => {
      disposed = true;
    };
  }, [root, filesVersion]);

  const showError = (error: unknown) => toast.error(t("workspace.failed", { message: String(error) }));

  const openOtherFile = async () => {
    const opened = await onOpenFile(undefined, "科研工作台-欢迎页");
    if (opened instanceof Project) await closeEmptyDrafts(opened);
  };

  const sectionTitle = "text-muted-foreground text-[11px] font-semibold tracking-wide";

  return (
    <div className="text-foreground flex size-full overflow-auto text-[13px]">
      <div className="m-auto flex w-full max-w-[560px] flex-col gap-8 px-8 py-12">
        <div className="flex flex-col gap-1.5">
          <h1 className="text-[20px] font-semibold">{t("welcome.title")}</h1>
          <p className="text-muted-foreground leading-[1.5]">{t("welcome.subtitle")}</p>
        </div>

        {root ? (
          <>
            <div className="flex flex-col gap-1">
              <span className={sectionTitle}>{t("welcome.folder")}</span>
              <div className="border-border flex h-10 items-center gap-2 rounded-[8px] border pr-1 pl-3">
                <FolderOpen className="text-muted-foreground size-4 shrink-0" />
                <PathTail path={root} className="flex-1" />
                <Button
                  variant="ghost"
                  className="h-7 rounded-[6px] px-2 text-[13px]"
                  onClick={() => void shellOpen(root).catch(showError)}
                >
                  {t("files.revealInFinder")}
                </Button>
                <Button
                  variant="ghost"
                  className="h-7 rounded-[6px] px-2 text-[13px]"
                  onClick={() => void chooseResearchFolder().catch(showError)}
                >
                  {t("welcome.changeFolder")}
                </Button>
              </div>
            </div>

            <div className="flex gap-2">
              <Button className="h-8 rounded-[6px] text-[13px]" onClick={() => emitResearchEvent("newWorkspace")}>
                <FilePlus className="size-4" />
                {t("welcome.newWorkspace")}
              </Button>
              <Button
                variant="outline"
                className="h-8 rounded-[6px] text-[13px]"
                onClick={() => void openOtherFile().catch(showError)}
              >
                <FolderOpen className="size-4" />
                {t("welcome.openOther")}
              </Button>
            </div>

            <div className="flex flex-col gap-1">
              <span className={sectionTitle}>
                {t("welcome.recent")}
                {workspaces && workspaces.length > 0 && (
                  <span className="ml-1.5 font-normal tabular-nums">{workspaces.length}</span>
                )}
              </span>
              <div className="-mx-2 flex max-h-72 flex-col overflow-y-auto">
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
                        className="hover:bg-accent flex h-8 w-full shrink-0 cursor-pointer items-center gap-3 rounded-[6px] px-2 text-left"
                        onClick={() => void openResearchWorkspace(item.absPath).catch(showError)}
                      >
                        <FileName name={item.name} title={item.absPath} className="flex-1" />
                        {folder && <PathTail path={folder} className="text-muted-foreground max-w-[35%] text-[12px]" />}
                        {item.mtime !== undefined && (
                          <span className="text-muted-foreground shrink-0 text-[12px] tabular-nums">
                            {formatModifiedTime(item.mtime)}
                          </span>
                        )}
                      </button>
                    );
                  })
                )}
              </div>
            </div>

            <p className="text-muted-foreground text-[12px]">{t("welcome.dropHint")}</p>
          </>
        ) : (
          <>
            <div className="flex flex-col gap-2">
              <Button
                className="h-8 self-start rounded-[6px] text-[13px]"
                onClick={() => void chooseResearchFolder().catch(showError)}
              >
                <FolderSearch className="size-4" />
                {t("welcome.chooseFolder")}
              </Button>
              <span className="text-muted-foreground text-[12px]">{t("welcome.noFolderHint")}</span>
            </div>
            <div className="flex flex-col gap-2">
              <span className={sectionTitle}>{t("welcome.howTo.title")}</span>
              <ol className="text-muted-foreground flex list-decimal flex-col gap-2 pl-5 leading-[1.5]">
                <li>{t("welcome.howTo.step1")}</li>
                <li>{t("welcome.howTo.step2")}</li>
                <li>{t("welcome.howTo.step3")}</li>
              </ol>
            </div>
          </>
        )}

        <button
          type="button"
          className="text-muted-foreground hover:text-foreground self-start text-[12px] underline-offset-2 hover:underline"
          onClick={() => void onNewDraft().catch(showError)}
        >
          {t("welcome.draft")}
        </button>
      </div>
    </div>
  );
}

/** 今年的写成「11-04 21:30」，往年的写成「2025-11-04」 */
export function formatModifiedTime(ms: number, now: Date = new Date()): string {
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, "0");
  const day = `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  if (date.getFullYear() !== now.getFullYear()) return `${date.getFullYear()}-${day}`;
  return `${day} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
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
