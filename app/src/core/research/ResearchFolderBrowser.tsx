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
  readResearchDirectory,
  type ResearchTreeEntry,
} from "./ResearchWorkspace";
import { homeDir } from "@tauri-apps/api/path";
import { exists } from "@tauri-apps/plugin-fs";
import { isWindows } from "@/utils/platform";
import { ArrowUp, Folder, HardDrive, Home } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

export async function folderBrowserLocations(): Promise<{ home: string; drives: string[]; recent: string[] }> {
  const [home, data] = await Promise.all([homeDir(), loadResearchWorkspace()]);
  const candidates = isWindows
    ? Array.from({ length: 26 }, (_, index) => `${String.fromCharCode(65 + index)}:/`)
    : ["/Volumes"];
  const available = await Promise.all(candidates.map(async (path) => ((await exists(path)) ? path : null)));
  return { home, drives: available.filter((path): path is string => path !== null), recent: data.recentProjects };
}

export function ResearchFolderBrowser({ create, onDone }: { create: boolean; onDone: (path: string | null) => void }) {
  const { t } = useTranslation("research");
  const [locations, setLocations] = useState<Awaited<ReturnType<typeof folderBrowserLocations>>>();
  const [path, setPath] = useState("");
  const [entries, setEntries] = useState<ResearchTreeEntry[]>();
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);

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
        if (alive) setError(String(error));
      });
    return () => {
      alive = false;
    };
  }, [locations, retry]);

  useEffect(() => {
    if (!path) return;
    let alive = true;
    setEntries(undefined);
    setError("");
    void readResearchDirectory(path, path, true)
      .then((value) => {
        if (alive) setEntries(value);
      })
      .catch((error) => {
        if (alive) setError(String(error));
      });
    return () => {
      alive = false;
    };
  }, [path, retry]);

  const select = async () => {
    setBusy(true);
    try {
      onDone(create ? await createResearchProject(path, name) : await addResearchProject(path));
    } catch (error) {
      setError(
        error instanceof Error && error.message === "invalidProjectName"
          ? t("projectTree.invalidProjectName")
          : String(error),
      );
    } finally {
      setBusy(false);
    }
  };
  const parent = ResearchFolder.toAbsolute("..", path);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onDone(null);
      }}
    >
      <DialogContent className="sm:max-w-2xl" showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>{t(create ? "projectTree.create" : "projectTree.add")}</DialogTitle>
          <DialogDescription>{t(create ? "projectTree.createHint" : "projectTree.addHint")}</DialogDescription>
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
              <span className="min-w-0 truncate text-xs" title={path}>
                {path}
              </span>
            </div>
            <div
              className="flex h-64 flex-col gap-1 overflow-auto rounded-md border p-1"
              aria-label={t("projectTree.folders")}
            >
              {entries?.map((entry) => (
                <Button
                  key={entry.absPath}
                  variant="ghost"
                  className="justify-start"
                  disabled={busy}
                  onClick={() => setPath(entry.absPath)}
                >
                  <Folder />
                  <span className="truncate">{entry.name}</span>
                </Button>
              ))}
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
        {error && (
          <div role="alert" className="text-destructive flex flex-col gap-2 text-sm break-all">
            <p>{t("files.loadFailed", { error })}</p>
            <Button variant="outline" disabled={busy} onClick={() => setRetry((value) => value + 1)}>
              {t("files.retry")}
            </Button>
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={() => onDone(null)}>
            {t("document.cancel")}
          </Button>
          <Button disabled={busy || !entries || (create && !name.trim())} onClick={() => void select()}>
            {t(create ? "projectTree.createHere" : "projectTree.useFolder")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
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
