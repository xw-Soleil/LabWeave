import { Dialog } from "@/components/ui/dialog";
import { Project, ProjectState } from "@/core/Project";
import { loadWithProjectOwnership } from "@/core/ProjectOwnership";
import { ResearchFolder, notifyResearchFilesChanged } from "@/core/research/ResearchFolder";
import { resolveSourcePath } from "@/core/research/FileCardFactory";
import { RecentFileManager } from "@/core/service/dataFileService/RecentFileManager";
import { TabWorkspace } from "@/core/TabWorkspace";
import { store, tabsAtom } from "@/state";
import { exists, mkdir, readDir, readFile, readTextFile, remove, rename, writeFile } from "@tauri-apps/plugin-fs";
import i18next from "i18next";
import { toast } from "sonner";
import { URI, Utils } from "vscode-uri";
import { moveDocumentAnnotations } from "./PdfAnnotationStore";
import { documentKey } from "./DocumentFile";
import { documentError } from "./DocumentTab";

type TrashEntry = { directory: string; relativePath: string; fileName: string; deletedAt: number };
let busy = false;
const t = (key: string, options?: Record<string, unknown>) => i18next.t(`research:fileMenu.${key}`, options);
const samePath = (a: string, b: string) => documentKey(a).normalize("NFC") === documentKey(b).normalize("NFC");
const child = (directory: string, name: string) => Utils.joinPath(URI.file(directory), name).fsPath;

function refreshReferences(path: string, missing: boolean) {
  for (const tab of store.get(tabsAtom))
    if (tab instanceof Project && !tab.closing) {
      for (const card of tab.stageManager.getFileCardNodes())
        if (samePath(resolveSourcePath(tab, card.sourcePath), path)) {
          card.missing = missing;
          card.missingCheckedAt = Number.NEGATIVE_INFINITY;
        }
    }
  notifyResearchFilesChanged();
}

export async function trashResearchFile(path: string): Promise<TrashEntry> {
  if (busy) throw new Error(t("busy"));
  if (!ResearchFolder.isInside(path)) throw new Error(t("outside"));
  const root = ResearchFolder.getRoot();
  const relativePath = ResearchFolder.toRelative(path);
  busy = true;
  try {
    await ResearchFolder.ensureRootRegistered();
    if (ResearchFolder.getRoot() !== root) throw new Error(t("busy"));
    const workspace = /\.prg$/i.test(path);
    const open = store
      .get(tabsAtom)
      .find(
        (tab): tab is Project => tab instanceof Project && tab.uri.scheme === "file" && samePath(tab.uri.fsPath, path),
      );
    if (open) {
      if (open.closing || open.isSaving || open.fileMutationInProgress) throw new Error(t("busy"));
      await open.save();
      if (open.projectState !== ProjectState.Saved) throw new Error(t("busy"));
      await TabWorkspace.close(open.id);
    }
    const move = async () => {
      if (ResearchFolder.getRoot() !== root) throw new Error(t("busy"));
      const directory = child(root, `.workbench/trash/${crypto.randomUUID()}`);
      const record: TrashEntry = {
        directory,
        relativePath,
        fileName: Utils.basename(URI.file(path)),
        deletedAt: Date.now(),
      };
      await mkdir(directory, { recursive: true });
      // Write the recovery record before moving anything; a failed move leaves the original untouched.
      await writeFile(child(directory, "entry.json"), new TextEncoder().encode(JSON.stringify(record)), {
        createNew: true,
      });
      await moveDocumentAnnotations(
        path,
        child(directory, record.fileName),
        () => rename(path, child(directory, record.fileName)),
        { entryId: Utils.basename(URI.file(directory)) },
      );
      return record;
    };
    let record: TrashEntry;
    if (workspace) {
      const reserved = await loadWithProjectOwnership(path, async (lease) => {
        try {
          return await move();
        } finally {
          await lease?.dispose();
        }
      });
      if (reserved.status !== "opened") throw new Error(t("busy"));
      record = reserved.value;
    } else record = await move();
    refreshReferences(path, true);
    if (workspace) {
      await RecentFileManager.removeRecentFileByUri(URI.file(path));
      const { persistResearchSession } = await import("./ResearchSession");
      persistResearchSession();
    }
    return record;
  } finally {
    busy = false;
  }
}

export async function restoreResearchFile(record: TrashEntry): Promise<string> {
  if (busy) throw new Error(t("busy"));
  const path = ResearchFolder.toAbsolute(record.relativePath);
  const trashRoot = child(ResearchFolder.getRoot(), ".workbench/trash");
  if (
    !ResearchFolder.isInside(path) ||
    !documentKey(record.directory).startsWith(documentKey(trashRoot) + "/") ||
    Utils.basename(URI.file(path)) !== record.fileName
  )
    throw new Error(t("outside"));
  busy = true;
  try {
    await ResearchFolder.ensureRootRegistered();
    if (await exists(path)) throw new Error(t("restoreConflict"));
    const payload = child(record.directory, record.fileName);
    await mkdir(Utils.dirname(URI.file(path)).fsPath, { recursive: true });
    // Exclusive creation also prevents overwriting a file created after the existence check.
    await moveDocumentAnnotations(
      payload,
      path,
      async () => {
        const bytes = await readFile(payload);
        await writeFile(path, bytes, { createNew: true });
        try {
          await remove(payload);
        } catch (error) {
          try {
            const current = await readFile(path);
            if (current.length !== bytes.length || !current.every((byte, index) => byte === bytes[index]))
              throw new Error("fileChanged", { cause: error });
            await remove(path);
          } catch (rollback) {
            throw new AggregateError([error, rollback], "annotationRollbackFailed", { cause: rollback });
          }
          throw error;
        }
      },
      { entryId: Utils.basename(URI.file(record.directory)), restoring: true },
    );
    refreshReferences(path, false);
    return path;
  } finally {
    busy = false;
  }
}

export async function restoreLastResearchFile() {
  const root = child(ResearchFolder.getRoot(), ".workbench/trash");
  await ResearchFolder.ensureRootRegistered();
  if (!(await exists(root))) throw new Error(t("trashEmpty"));
  const entries: TrashEntry[] = [];
  for (const entry of await readDir(root)) {
    if (!entry.isDirectory || entry.isSymlink) continue;
    const directory = child(root, entry.name);
    if (!(await exists(child(directory, "entry.json")))) continue;
    const record = JSON.parse(await readTextFile(child(directory, "entry.json"))) as TrashEntry;
    if (
      typeof record.fileName !== "string" ||
      Utils.basename(URI.file(record.fileName)) !== record.fileName ||
      typeof record.relativePath !== "string" ||
      !Number.isFinite(record.deletedAt)
    )
      throw new Error(t("invalidTrash"));
    if (await exists(child(directory, record.fileName))) entries.push({ ...record, directory });
  }
  entries.sort((a, b) => b.deletedAt - a.deletedAt);
  if (!entries.length) throw new Error(t("trashEmpty"));
  return restoreResearchFile(entries[0]);
}

export async function promptTrashResearchFile(path: string) {
  if (
    !(await Dialog.confirm(t("delete"), t("deleteDescription", { name: Utils.basename(URI.file(path)) }), {
      destructive: true,
    }))
  )
    return;
  try {
    const record = await trashResearchFile(path);
    toast.success(t("deleted"), {
      action: {
        label: t("restore"),
        onClick: () => {
          restoreResearchFile(record)
            .then(() => toast.success(t("restored")))
            .catch((error) => toast.error(documentError(error)));
        },
      },
    });
  } catch (error) {
    toast.error(documentError(error));
  }
}
