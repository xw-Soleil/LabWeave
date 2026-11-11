import { Dialog } from "@/components/ui/dialog";
import { Project, ProjectState } from "@/core/Project";
import { parseProjectFile, rewriteProjectFile } from "@/core/ProjectFile";
import { loadWithProjectOwnership, type ProjectOwnershipLease } from "@/core/ProjectOwnership";
import { FileSystemProviderFile } from "@/core/fileSystemProvider/FileSystemProviderFile";
import { buildAiSidecar } from "@/core/research/AiSidecarBuilder";
import { resolveSourcePath, rewriteSerializedFileCardPaths, toStoredSourcePath } from "@/core/research/FileCardFactory";
import { notifyResearchFilesChanged, ResearchFolder } from "@/core/research/ResearchFolder";
import { isTemporaryWorkspace } from "./TemporaryWorkspace";
import { RecentFileManager } from "@/core/service/dataFileService/RecentFileManager";
import { Settings } from "@/core/service/Settings";
import { store, tabsAtom } from "@/state";
import { Decoder } from "@msgpack/msgpack";
import { exists, mkdir, readFile, remove, stat, writeFile } from "@tauri-apps/plugin-fs";
import i18next from "i18next";
import { toast } from "sonner";
import { URI, Utils } from "vscode-uri";
import { moveDocumentAnnotations } from "./PdfAnnotationStore";
import { documentError } from "./DocumentTab";

const fs = new FileSystemProviderFile();
let busy = false;
const pathKey = (path: string) => path.replaceAll("\\", "/").normalize("NFC").toLowerCase();
const text = (key: string) => i18next.t(`research:rename.${key}`);

export function renamedPath(path: string, name: string): string {
  name = name.trim();
  // eslint-disable-next-line no-control-regex -- 文件名必须拒绝控制字符。
  if (!name || name === "." || name === ".." || /[\\/:*?"<>|\u0000-\u001f]/.test(name) || /[. ]$/.test(name)) {
    throw new Error(text("invalid"));
  }
  const old = Utils.basename(URI.file(path));
  const extension = old.slice(old.lastIndexOf("."));
  if (!name.toLowerCase().endsWith(extension.toLowerCase())) name += extension;
  return Utils.joinPath(Utils.dirname(URI.file(path)), name).fsPath;
}

type Rewrite = (stage: unknown) => void;
type WritePlan = { path: string; before: Uint8Array; after: Uint8Array; project?: Project; rewrite: Rewrite };

export async function renameResearchFile(oldPath: string, name: string): Promise<string> {
  if (busy) throw new Error(text("busy"));
  return relocateResearchFile(oldPath, renamedPath(oldPath, name));
}

/**
 * 把文件挪进研究文件夹里的另一个文件夹，白板里指向它的卡片跟着改（和改名同一套流程）。
 * 白板（.prg）不能挪：它里面卡片的路径是按它自己所在的位置存的，挪了会全部对不上
 */
export async function moveResearchFile(oldPath: string, directory: string): Promise<string> {
  if (busy) throw new Error(text("busy"));
  if (/\.prg$/i.test(oldPath)) throw new Error(text("moveBoard"));
  return relocateResearchFile(oldPath, Utils.joinPath(URI.file(directory), Utils.basename(URI.file(oldPath))).fsPath);
}

async function relocateResearchFile(oldPath: string, newPath: string): Promise<string> {
  if (newPath === oldPath) return oldPath;
  if (!ResearchFolder.isInside(oldPath) || !ResearchFolder.isInside(newPath)) throw new Error(text("outside"));
  busy = true;
  const projects = store
    .get(tabsAtom)
    .filter((tab): tab is Project => tab instanceof Project && !tab.closing && !isTemporaryWorkspace(tab));
  const locked: Project[] = [];
  const leases: ProjectOwnershipLease[] = [];
  const plans: WritePlan[] = [];
  const written: WritePlan[] = [];
  const liveRewrites = new Map<Project, Rewrite>();
  const revisions = new Map<Project, number>();
  const owner = projects.find(
    (project) => project.uri.scheme === "file" && pathKey(project.uri.fsPath) === pathKey(oldPath),
  );
  let created = false;
  let committed = false;
  try {
    await ResearchFolder.ensureRootRegistered();
    // On case-insensitive filesystems exists() also catches case-only aliases; never overwrite one.
    if (await exists(newPath)) throw new Error(text("exists"));
    for (const project of projects) {
      if (project.isSaving || project.fileMutationInProgress) throw new Error(text("busy"));
      project.fileMutationInProgress = true;
      project.isSaving = true;
      locked.push(project);
      revisions.set(project, project.editRevision);
    }
    const workspace = /\.prg$/i.test(oldPath);
    const scan = workspace ? null : await ResearchFolder.scan();
    if (scan && (scan.truncated || scan.unreadableDirs.length)) throw new Error(text("incompleteScan"));
    const paths = workspace
      ? [oldPath]
      : scan!.entries.filter((entry) => entry.kind === "workspace").map((entry) => entry.absPath);
    const makeRewrite =
      (project: Project): Rewrite =>
      (stage) => {
        rewriteSerializedFileCardPaths(stage, (source) =>
          pathKey(resolveSourcePath(project, source)) === pathKey(oldPath)
            ? toStoredSourcePath(project, newPath)
            : source,
        );
      };
    for (const path of paths) {
      const project = projects.find(
        (candidate) => candidate.uri.scheme === "file" && pathKey(candidate.uri.fsPath) === pathKey(path),
      );
      if (!project) {
        const reservation = await loadWithProjectOwnership(path, async (lease) => lease);
        if (reservation.status !== "opened") throw new Error(`${text("busy")}: ${path}`);
        if (reservation.value) leases.push(reservation.value);
      }
      const before = await readFile(path);
      const content = project ? await project.getFileContent({ includeThumbnail: false }) : before;
      const context = project ?? ({ uri: URI.file(path) } as Project);
      const rewrite: Rewrite = workspace ? () => {} : makeRewrite(context);
      const updated = await rewriteProjectFile(
        content,
        rewrite,
        workspace ? ResearchFolder.toRelative(newPath) : undefined,
      );
      if (updated.changed || workspace) plans.push({ path, before, after: updated.content, project, rewrite });
      if (project && updated.changed && !workspace) liveRewrites.set(project, rewrite);
    }
    if (!workspace)
      for (const project of projects) {
        // Includes drafts and histories containing cards which are currently deleted.
        liveRewrites.set(project, makeRewrite(project));
      }
    const source = workspace ? plans[0].after : await readFile(oldPath);
    const mode = (await stat(oldPath)).mode;
    const create = async () => {
      await writeFile(newPath, source, { createNew: true, ...(mode === null ? {} : { mode: mode & 0o7777 }) });
      created = true;
    };
    const checkRevisions = () => {
      for (const [project, revision] of revisions) {
        if (project.closing || project.editRevision !== revision) throw new Error(text("changed"));
      }
    };
    checkRevisions();
    if (owner) await owner.rebindRenamedFile(URI.file(newPath), create);
    else await create();
    for (const plan of plans) {
      if (workspace) continue;
      // Add before attempting the write: a failed in-place write also needs restoring.
      written.push(plan);
      await fs.write(URI.file(plan.path), plan.after);
    }
    checkRevisions();
    await moveDocumentAnnotations(oldPath, newPath, () => remove(oldPath));
    committed = true;
    for (const [project, rewrite] of liveRewrites) {
      let changed = false;
      for (const card of project.stageManager.getFileCardNodes()) {
        if (pathKey(resolveSourcePath(project, card.sourcePath)) === pathKey(oldPath)) {
          changed = true;
          card.sourcePath = toStoredSourcePath(project, newPath);
          card.missing = false;
          card.missingCheckedAt = Number.NEGATIVE_INFINITY;
        }
      }
      project.historyManager.rewriteSnapshots(rewrite);
      if (changed) project.projectState = ProjectState.Unsaved;
    }
    if (owner) {
      if (owner.metadata.workbench) owner.metadata.workbench.workspacePath = ResearchFolder.toRelative(newPath);
      owner.projectState = ProjectState.Unsaved;
    }
    store.set(tabsAtom, [...store.get(tabsAtom)]);
    if (workspace) {
      await RecentFileManager.removeRecentFileByUri(URI.file(oldPath));
      await RecentFileManager.addRecentFileByUri(URI.file(newPath));
    }
    const { renameSessionWorkspace, persistResearchSession } = await import("./ResearchSession");
    if (workspace) renameSessionWorkspace(oldPath, newPath);
    else persistResearchSession();
    for (const plan of plans) {
      await refreshSidecars(workspace ? newPath : plan.path, plan.after);
    }
    if (workspace && Settings.writeAiSidecarOnSave)
      for (const suffix of [".ai.json", ".ai.md"]) {
        const oldSidecar = Utils.joinPath(
          Utils.dirname(URI.file(oldPath)),
          ".workbench",
          Utils.basename(URI.file(oldPath)).replace(/\.prg$/i, "") + suffix,
        );
        if (await exists(oldSidecar.fsPath)) await remove(oldSidecar.fsPath);
      }
    notifyResearchFilesChanged();
    return newPath;
  } catch (error) {
    if (committed) {
      notifyResearchFilesChanged();
      throw new Error(`${text("followupFailed")}: ${String(error)}`, { cause: error });
    }
    const errors: unknown[] = [error];
    for (const plan of written.reverse()) {
      try {
        await fs.write(URI.file(plan.path), plan.before);
      } catch (rollback) {
        errors.push(rollback);
      }
    }
    if (owner && owner.uri.fsPath !== oldPath) {
      try {
        await owner.rebindRenamedFile(URI.file(oldPath), async () => {});
      } catch (rollback) {
        errors.push(rollback);
      }
    }
    // Keep both files if rollback was incomplete: a remaining reference may still need the new path.
    if (created && errors.length === 1 && !(error instanceof Error && error.message === "annotationRollbackFailed")) {
      try {
        await remove(newPath);
      } catch (rollback) {
        errors.push(rollback);
      }
    }
    throw errors.length === 1 ? error : new AggregateError(errors, text("rollbackFailed"));
  } finally {
    for (const project of locked) {
      project.fileMutationInProgress = false;
      project.isSaving = false;
    }
    const released = await Promise.allSettled(leases.map((lease) => lease.dispose()));
    busy = false;
    for (const result of released) if (result.status === "rejected") toast.error(String(result.reason));
  }
}

async function refreshSidecars(path: string, content: Uint8Array) {
  if (!Settings.writeAiSidecarOnSave) return;
  const data = await parseProjectFile(content, new Decoder(), new Map());
  const sidecar = buildAiSidecar({
    serializedStage: data.serializedStageObjects,
    tags: data.tags,
    metadata: data.metadata,
    readme: data.readme,
    workspaceFile: path,
    researchRoot: ResearchFolder.getRoot(),
  });
  const dir = Utils.joinPath(Utils.dirname(URI.file(path)), ".workbench");
  if (!(await exists(dir.fsPath))) await mkdir(dir.fsPath);
  const name = Utils.basename(URI.file(path)).replace(/\.prg$/i, "");
  await fs.write(
    Utils.joinPath(dir, name + ".ai.json"),
    new TextEncoder().encode(JSON.stringify(sidecar.json, null, 2)),
  );
  await fs.write(Utils.joinPath(dir, name + ".ai.md"), new TextEncoder().encode(sidecar.markdown));
}

export async function promptResearchRename(path: string) {
  const name = await Dialog.input(text("title"), text("description"), { defaultValue: Utils.basename(URI.file(path)) });
  if (name === undefined) return;
  try {
    await renameResearchFile(path, name);
  } catch (error) {
    toast.error(documentError(error));
  }
}
