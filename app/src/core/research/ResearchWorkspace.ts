import { ResearchFolder, isHiddenResearchName, type ResearchFileEntry } from "./ResearchFolder";
import { fileKindOf, emitResearchEvent } from "./ResearchShell";
import { Settings } from "@/core/service/Settings";
import { createStore } from "@/utils/store";
import { store } from "@/state";
import { invoke } from "@tauri-apps/api/core";
import { mkdir, readDir } from "@tauri-apps/plugin-fs";
import { atom } from "jotai";
import { z } from "zod";

const sessionSchema = z.object({ openWorkspaces: z.array(z.string()), active: z.string() });
const workspaceSchema = z.object({
  version: z.literal(1),
  activeId: z.string(),
  workspaces: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        projects: z.array(z.object({ path: z.string(), session: sessionSchema.optional() })),
      }),
    )
    .min(1),
  recentProjects: z.array(z.string()),
});
export type ResearchWorkspaceData = z.infer<typeof workspaceSchema>;
export const researchWorkspaceAtom = atom<ResearchWorkspaceData | null>(null);
let loading: Promise<ResearchWorkspaceData> | undefined;
let saving: Promise<unknown> = Promise.resolve();
const authorized = new Map<string, Promise<string>>();

export function projectPathKey(path: string): string {
  return ResearchFolder.toAbsolute(path, "").replace(/\/+$/, "").normalize("NFC").toLowerCase();
}

export function projectName(path: string): string {
  return path.replace(/\\/g, "/").split("/").filter(Boolean).at(-1) ?? path;
}

export function activeResearchWorkspace(data: ResearchWorkspaceData) {
  return data.workspaces.find((workspace) => workspace.id === data.activeId) ?? data.workspaces[0];
}

export async function loadResearchWorkspace(): Promise<ResearchWorkspaceData> {
  if (store.get(researchWorkspaceAtom)) return store.get(researchWorkspaceAtom)!;
  if (!loading) {
    loading = (async () => {
      const storage = await createStore("research-workspaces.json");
      const saved = await storage.get<unknown>("data");
      const root = ResearchFolder.getRoot();
      const data =
        saved === undefined
          ? {
              version: 1 as const,
              activeId: "default",
              workspaces: [{ id: "default", name: "", projects: root ? [{ path: root }] : [] }],
              recentProjects: root ? [root] : [],
            }
          : workspaceSchema.parse(saved);
      if (saved === undefined) {
        await storage.set("data", data);
        await storage.save();
      }
      store.set(researchWorkspaceAtom, data);
      return data;
    })().finally(() => {
      loading = undefined;
    });
  }
  return loading;
}

export function updateResearchWorkspace(update: (data: ResearchWorkspaceData) => void): Promise<void> {
  const task = saving.then(async () => {
    const data = structuredClone(await loadResearchWorkspace());
    update(data);
    workspaceSchema.parse(data);
    const storage = await createStore("research-workspaces.json");
    await storage.set("data", data);
    await storage.save();
    store.set(researchWorkspaceAtom, data);
  });
  // Each caller receives its own failure; a failed write must not block later retries.
  saving = task.then(
    () => undefined,
    () => undefined,
  );
  return task;
}

export async function addResearchProject(path: string): Promise<string> {
  const canonical = await invoke<string>("authorize_research_project", { path });
  await updateResearchWorkspace((data) => {
    const workspace = activeResearchWorkspace(data);
    if (!workspace.projects.some((project) => projectPathKey(project.path) === projectPathKey(canonical))) {
      workspace.projects.push({ path: canonical });
    }
    data.recentProjects = [
      canonical,
      ...data.recentProjects.filter((old) => projectPathKey(old) !== projectPathKey(canonical)),
    ].slice(0, 20);
  });
  authorized.set(projectPathKey(canonical), Promise.resolve(canonical));
  return canonical;
}

export async function authorizeResearchProject(path: string): Promise<string> {
  const data = await loadResearchWorkspace();
  if (
    !activeResearchWorkspace(data).projects.some((project) => projectPathKey(project.path) === projectPathKey(path))
  ) {
    throw new Error("projectNotInWorkspace");
  }
  const key = projectPathKey(path);
  let task = authorized.get(key);
  if (!task) {
    task = invoke<string>("authorize_research_project", { path });
    authorized.set(key, task);
    task.catch(() => {
      authorized.delete(key);
    });
  }
  return task;
}

export function checkProjectName(input: string): string {
  const name = input.trim();
  if (
    !name ||
    // eslint-disable-next-line no-control-regex -- Reject invalid filesystem names before creating anything.
    /[\\/:*?"<>|\u0000-\u001f]/.test(name) ||
    /[. ]$/.test(name) ||
    isHiddenResearchName(name) ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)
  ) {
    throw new Error("invalidProjectName");
  }
  return name;
}

export async function createResearchProject(parent: string, input: string): Promise<string> {
  const path = ResearchFolder.toAbsolute(checkProjectName(input), parent);
  // Non-recursive mkdir fails if a file or folder already has this name.
  await mkdir(path);
  return addResearchProject(path);
}

export type ResearchTreeEntry = ResearchFileEntry & { directory: boolean };

export async function readResearchDirectory(
  root: string,
  path: string,
  foldersOnly = false,
): Promise<ResearchTreeEntry[]> {
  if (!ResearchFolder.isInside(path, root)) throw new Error("directoryOutsideProject");
  return (await readDir(path))
    .filter(
      (entry) =>
        !entry.isSymlink && !isHiddenResearchName(entry.name) && (entry.isDirectory || (!foldersOnly && entry.isFile)),
    )
    .map((entry) => ({
      absPath: ResearchFolder.toAbsolute(entry.name, path),
      relPath: ResearchFolder.toRelative(ResearchFolder.toAbsolute(entry.name, path), root),
      name: entry.name,
      directory: Boolean(entry.isDirectory),
      kind: /\.prg$/i.test(entry.name) ? ("workspace" as const) : (fileKindOf(entry.name) ?? ("other" as const)),
    }))
    .sort(
      (a, b) =>
        Number(b.directory) - Number(a.directory) ||
        a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }),
    );
}

export function requestResearchProject(path: string, openPath?: string): Promise<boolean> {
  return new Promise((resolve, reject) => emitResearchEvent("switchProject", { path, openPath, resolve, reject }));
}

export async function rememberProjectSession(
  root: string,
  session: { openWorkspaces: string[]; active: string } = Settings.researchSession,
) {
  if (!root) return;
  const { openWorkspaces, active } = session;
  await updateResearchWorkspace((data) => {
    const project = activeResearchWorkspace(data).projects.find(
      (project) => projectPathKey(project.path) === projectPathKey(root),
    );
    if (project) project.session = { openWorkspaces, active };
  });
}
