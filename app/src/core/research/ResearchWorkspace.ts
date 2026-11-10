import { ResearchFolder, isHiddenResearchName, type ResearchFileEntry } from "./ResearchFolder";
import { fileKindOf, emitResearchEvent } from "./ResearchShell";
import { Settings } from "@/core/service/Settings";
import { createStore } from "@/utils/store";
import { isWeb } from "@/utils/platform";
import { store } from "@/state";
import { invoke } from "@tauri-apps/api/core";
import { mkdir, readDir } from "@tauri-apps/plugin-fs";
import { atom } from "jotai";
import { z } from "zod";
import i18next from "i18next";

const sessionSchema = z.object({ openWorkspaces: z.array(z.string()), active: z.string() });
export const projectPathSchema = z
  .string()
  .refine(
    (path) =>
      !path.includes("\0") && (/^\//.test(path) || /^[a-z]:[\\/]/i.test(path) || /^\\\\[^\\]+\\[^\\]+/.test(path)),
  );
const workspaceSchema = z
  .object({
    version: z.literal(1),
    activeId: z.string(),
    workspaces: z
      .array(
        z.object({
          id: z.string(),
          name: z.string(),
          projects: z.array(z.object({ path: projectPathSchema, session: sessionSchema.optional() })),
        }),
      )
      .min(1),
    recentProjects: z.array(projectPathSchema),
  })
  .refine((data) => data.workspaces.some((workspace) => workspace.id === data.activeId));
export type ResearchWorkspaceData = z.infer<typeof workspaceSchema>;
export const researchWorkspaceAtom = atom<ResearchWorkspaceData | null>(null);
let loading: Promise<ResearchWorkspaceData> | undefined;
let saving: Promise<unknown> = Promise.resolve();
const authorized = new Map<string, Promise<string>>();

export function projectPathKey(path: string): string {
  const normalized = ResearchFolder.toAbsolute(path, "");
  const key = (normalized === "/" ? "/" : normalized.replace(/\/+$/, "")).normalize("NFC");
  return /^[a-z]:\//i.test(normalized) || normalized.startsWith("//") ? key.toLowerCase() : key;
}

export function researchWorkspaceError(error: unknown): string {
  const code = error instanceof Error ? error.message : String(error);
  const key = `projectTree.errors.${code}`;
  return i18next.exists(key, { ns: "research" }) ? i18next.t(key, { ns: "research" }) : code;
}

async function readWorkspace(): Promise<unknown> {
  return isWeb
    ? ((await (await createStore("research-workspaces.json")).get("data")) ?? null)
    : invoke("load_research_workspace");
}

async function writeWorkspace(expected: unknown, data: ResearchWorkspaceData) {
  if (isWeb) {
    const storage = await createStore("research-workspaces.json");
    if (JSON.stringify((await storage.get("data")) ?? null) !== JSON.stringify(expected)) {
      throw new Error("workspaceChanged");
    }
    await storage.set("data", data);
    await storage.save();
  } else await invoke("save_research_workspace", { expected, data });
}

function parseWorkspace(saved: unknown): ResearchWorkspaceData {
  const parsed = workspaceSchema.safeParse(saved);
  if (!parsed.success) throw new Error("workspaceCorrupt");
  return saved as ResearchWorkspaceData;
}

export function projectName(path: string): string {
  return path.replace(/\\/g, "/").split("/").filter(Boolean).at(-1) ?? path;
}

export function activeResearchWorkspace(data: ResearchWorkspaceData) {
  return data.workspaces.find((workspace) => workspace.id === data.activeId) ?? data.workspaces[0];
}

export async function projectForFile(path: string): Promise<string | undefined> {
  const key = projectPathKey(path);
  const project = activeResearchWorkspace(await loadResearchWorkspace())
    .projects.filter((project) => ResearchFolder.isInside(path, project.path))
    .filter((project) => {
      const root = projectPathKey(project.path);
      return key === root || key.startsWith(root === "/" ? "/" : `${root}/`);
    })
    .sort((a, b) => b.path.length - a.path.length)[0]?.path;
  return project && projectPathKey(project) !== projectPathKey(ResearchFolder.getRoot()) ? project : undefined;
}

export async function loadResearchWorkspace(refresh = false): Promise<ResearchWorkspaceData> {
  if (!refresh && store.get(researchWorkspaceAtom)) return store.get(researchWorkspaceAtom)!;
  if (!loading) {
    loading = (async () => {
      const saved = await readWorkspace();
      const root = ResearchFolder.getRoot();
      const data =
        saved === null
          ? {
              version: 1 as const,
              activeId: "default",
              workspaces: [{ id: "default", name: "", projects: root ? [{ path: root }] : [] }],
              recentProjects: root ? [root] : [],
            }
          : parseWorkspace(saved);
      if (saved === null) await writeWorkspace(null, data);
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
    const previous = await loadResearchWorkspace(true);
    const data = structuredClone(previous);
    update(data);
    workspaceSchema.parse(data);
    await writeWorkspace(previous, data);
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

export async function authorizeResearchProject(path: string, refresh = false): Promise<string> {
  const data = await loadResearchWorkspace(refresh);
  if (
    !activeResearchWorkspace(data).projects.some((project) => projectPathKey(project.path) === projectPathKey(path))
  ) {
    throw new Error("projectNotInWorkspace");
  }
  const key = projectPathKey(path);
  let task = refresh ? undefined : authorized.get(key);
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

export function requestResearchProject(path: string, openPath?: string, removePath?: string): Promise<boolean> {
  return new Promise((resolve, reject) =>
    emitResearchEvent("switchProject", { path, openPath, removePath, resolve, reject }),
  );
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
