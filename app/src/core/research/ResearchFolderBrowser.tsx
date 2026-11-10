import { OverlayHost } from "@/components/overlay-host";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ResearchFolder } from "./ResearchFolder";
import {
  addResearchProject,
  createResearchProject,
  loadResearchWorkspace,
  projectName,
  projectPathSchema,
  readResearchDirectory,
  researchWorkspaceError,
  type ResearchTreeEntry,
} from "./ResearchWorkspace";
import { homeDir } from "@tauri-apps/api/path";
import { exists } from "@tauri-apps/plugin-fs";
import { isWindows } from "@/utils/platform";
import { cn } from "@/utils/cn";
import { ArrowUp, FileText, Folder, HardDrive, Home } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

export async function folderBrowserLocations(): Promise<{
  home: string;
  drives: string[];
  recent: string[];
  errors: string[];
}> {
  const [home, data] = await Promise.all([homeDir(), loadResearchWorkspace()]);
  const candidates = isWindows
    ? Array.from({ length: 26 }, (_, index) => `${String.fromCharCode(65 + index)}:/`)
    : ["/Volumes"];
  const results = await Promise.allSettled(candidates.map((path) => exists(path)));
  return {
    home,
    drives: candidates.filter((_, index) => results[index].status === "fulfilled" && results[index].value),
    recent: data.recentProjects,
    errors: results.flatMap((result, index) =>
      result.status === "rejected" ? [`${candidates[index]}: ${String(result.reason)}`] : [],
    ),
  };
}

export type LocalPathPick = { pick: "folder" | "pdf"; title: string; description: string; confirm: string };

export function ResearchFolderBrowser({
  create,
  picking,
  onDone,
}: {
  create: boolean;
  /** 只挑一个位置交回去，不登记成项目：文献库选文件夹、导入 PDF 都用这个 */
  picking?: LocalPathPick;
  onDone: (path: string | null) => void;
}) {
  const { t } = useTranslation("research");
  const [pickedFile, setPickedFile] = useState("");
  const [locations, setLocations] = useState<Awaited<ReturnType<typeof folderBrowserLocations>>>();
  const [path, setPath] = useState("");
  const [address, setAddress] = useState("");
  const [entries, setEntries] = useState<ResearchTreeEntry[]>();
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  const [visibleCount, setVisibleCount] = useState(200);

  useEffect(() => {
    if (locations) return;
    let alive = true;
    void folderBrowserLocations()
      .then((value) => {
        if (alive) {
          setLocations(value);
          setPath(value.home);
        }
      })
      .catch((error) => {
        if (alive) setError(researchWorkspaceError(error));
      });
    return () => {
      alive = false;
    };
  }, [locations, retry]);

  useEffect(() => {
    if (!path) return;
    setAddress(path);
    let alive = true;
    setEntries(undefined);
    setVisibleCount(200);
    setError("");
    setPickedFile("");
    void readResearchDirectory(path, path, picking?.pick !== "pdf")
      .then((value) => {
        if (alive) setEntries(value.filter((entry) => entry.directory || entry.kind === "pdf"));
      })
      .catch((error) => {
        if (alive) setError(String(error));
      });
    return () => {
      alive = false;
    };
  }, [path, retry, picking?.pick]);

  const select = async () => {
    if (picking) {
      onDone(picking.pick === "folder" ? path : pickedFile || null);
      return;
    }
    setBusy(true);
    try {
      onDone(create ? await createResearchProject(path, name) : await addResearchProject(path));
    } catch (error) {
      setError(
        error instanceof Error && error.message === "invalidProjectName"
          ? t("projectTree.invalidProjectName")
          : researchWorkspaceError(error),
      );
    } finally {
      setBusy(false);
    }
  };
  const parent = ResearchFolder.toAbsolute("..", path);
  const navigate = () => {
    const target = address.trim();
    if (!projectPathSchema.safeParse(target).success) {
      setError(t("projectTree.errors.projectPathNotAbsolute"));
      return;
    }
    setPath(target);
    setRetry((value) => value + 1);
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onDone(null);
      }}
    >
      <DialogContent className="sm:max-w-2xl" showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>{picking?.title ?? t(create ? "projectTree.create" : "projectTree.add")}</DialogTitle>
          <DialogDescription>
            {picking?.description ?? t(create ? "projectTree.createHint" : "projectTree.addHint")}
          </DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 gap-3">
          <nav aria-label={t("projectTree.locations")} className="flex w-40 shrink-0 flex-col gap-1 overflow-y-auto">
            <Button variant="ghost" disabled={busy || !locations} onClick={() => setPath(locations!.home)}>
              <Home />
              {t("projectTree.home")}
            </Button>
            <p className="text-muted-foreground px-2 pt-2 text-xs">{t("projectTree.drives")}</p>
            {locations?.drives.map((drive) => (
              <Button key={drive} variant="ghost" disabled={busy} onClick={() => setPath(drive)}>
                <HardDrive />
                {isWindows ? drive : t("projectTree.drives")}
              </Button>
            ))}
            <p className="text-muted-foreground px-2 pt-2 text-xs">{t("projectTree.recent")}</p>
            {locations?.recent.map((recent) => (
              <Button key={recent} title={recent} variant="ghost" disabled={busy} onClick={() => setPath(recent)}>
                <span className="truncate">{projectName(recent)}</span>
              </Button>
            ))}
          </nav>
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <div className="flex items-center gap-2">
              <Button
                size="icon"
                variant="outline"
                disabled={!path || path === parent || busy}
                aria-label={t("projectTree.parent")}
                onClick={() => setPath(parent)}
              >
                <ArrowUp />
              </Button>
              <Input
                aria-label={t("projectTree.path")}
                value={address}
                disabled={busy}
                onChange={(event) => setAddress(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    event.stopPropagation();
                    navigate();
                  }
                }}
              />
              <Button variant="outline" disabled={busy || !address.trim()} onClick={navigate}>
                {t("projectTree.go")}
              </Button>
            </div>
            <div
              className="flex h-64 flex-col gap-1 overflow-auto rounded-md border p-1"
              aria-label={t("projectTree.folders")}
            >
              {entries?.slice(0, visibleCount).map((entry) => (
                <Button
                  key={entry.absPath}
                  variant="ghost"
                  className={cn("justify-start", entry.absPath === pickedFile && "bg-accent")}
                  disabled={busy}
                  onClick={() => (entry.directory ? setPath(entry.absPath) : setPickedFile(entry.absPath))}
                  onDoubleClick={() => {
                    if (!entry.directory) onDone(entry.absPath);
                  }}
                >
                  {entry.directory ? <Folder /> : <FileText />}
                  <span className="truncate">{entry.name}</span>
                </Button>
              ))}
              {entries && entries.length > visibleCount && (
                <Button variant="ghost" onClick={() => setVisibleCount((count) => count + 200)}>
                  {t("projectTree.showMore", { count: entries.length - visibleCount })}
                </Button>
              )}
              {entries?.length === 0 && (
                <p className="text-muted-foreground p-2 text-sm">{t("projectTree.noFolders")}</p>
              )}
              {!entries && !error && <p className="text-muted-foreground p-2 text-sm">{t("files.loading")}</p>}
            </div>
            {create && (
              <label className="flex flex-col gap-2 text-sm">
                {t("projectTree.projectName")}
                <Input value={name} disabled={busy} onChange={(event) => setName(event.target.value)} />
              </label>
            )}
          </div>
        </div>
        {(error || !!locations?.errors.length) && (
          <div role="alert" className="text-destructive flex flex-col gap-2 text-sm break-all">
            <p>{t("files.loadFailed", { error: error || locations?.errors.join("\n") })}</p>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => {
                if (locations?.errors.length) setLocations(undefined);
                setRetry((value) => value + 1);
              }}
            >
              {t("files.retry")}
            </Button>
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={() => onDone(null)}>
            {t("document.cancel")}
          </Button>
          <Button
            disabled={busy || !entries || (create && !name.trim()) || (picking?.pick === "pdf" && !pickedFile)}
            onClick={() => void select()}
          >
            {picking?.confirm ?? t(create ? "projectTree.createHere" : "projectTree.useFolder")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 用程序自带的浏览器挑一个文件夹或 PDF，不弹系统窗口 */
export function browseLocalPath(picking: LocalPathPick): Promise<string | null> {
  return new Promise((resolve) => {
    const overlay = OverlayHost.open(
      <ResearchFolderBrowser
        create={false}
        picking={picking}
        onDone={(path) => {
          OverlayHost.close(overlay.id);
          resolve(path);
        }}
      />,
    );
  });
}

export function browseResearchProject(create = false): Promise<string | null> {
  return new Promise((resolve) => {
    const overlay = OverlayHost.open(
      <ResearchFolderBrowser
        create={create}
        onDone={(path) => {
          OverlayHost.close(overlay.id);
          resolve(path);
        }}
      />,
    );
  });
}
