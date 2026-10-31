// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { URI as URIType } from "vscode-uri";

const toastWarning = vi.hoisted(() => vi.fn());

vi.mock("sonner", () => ({ toast: { warning: toastWarning, error: vi.fn(), success: vi.fn() } }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => true), isTauri: vi.fn(() => false) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn() }));
vi.mock("@/core/stage/ProjectUpgrader", () => ({ ProjectUpgrader: class ProjectUpgrader {} }));
vi.mock("@/core/service/Settings", () => ({ Settings: { writeAiSidecarOnSave: true } }));
vi.mock("@/core/research/ResearchFolder", () => ({
  ResearchFolder: {
    getRoot: () => "/research",
    isInside: (path: string) => path.startsWith("/research/"),
    toRelative: (path: string) => path.slice("/research/".length),
  },
}));
vi.mock("@/core/Tab", () => ({
  Tab: class Tab {
    readonly services = new Map<string, unknown>();
    protected readonly fileSystemProviders = new Map<string, unknown>();

    getService(id: string) {
      return this.services.get(id);
    }

    emit() {}

    registerFileSystemProvider(scheme: string, provider: { new (project: unknown): unknown }) {
      this.fileSystemProviders.set(scheme, new provider(this));
    }

    get fs() {
      return this.fileSystemProviders.get((this as unknown as { uri: URIType }).uri.scheme);
    }
  },
  isResourceTab: () => false,
}));

import { Project, ProjectState } from "@/core/Project";
import { parseProjectFile } from "@/core/ProjectFile";
import { Settings } from "@/core/service/Settings";
import { Decoder } from "@msgpack/msgpack";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { URI } from "vscode-uri";

const files = new Map<string, Uint8Array>();
const directories = new Set<string>();
let failSidecarWrites = false;

class MemoryFileSystemProvider {
  async read(uri: URIType) {
    return files.get(uri.path)!;
  }
  async readDir() {
    return [];
  }
  async write(uri: URIType, content: Uint8Array) {
    if (failSidecarWrites && uri.path.includes("/.workbench/")) throw new Error("disk full");
    files.set(uri.path, content);
  }
  async remove() {}
  async exists(uri: URIType) {
    return directories.has(uri.path) || files.has(uri.path);
  }
  async mkdir(uri: URIType) {
    directories.add(uri.path);
  }
  async rename() {}
}

function makeProject(path: string) {
  const project = new Project(URI.file(path));
  project.registerFileSystemProvider("file", MemoryFileSystemProvider);
  return project;
}

const readText = (path: string) => new TextDecoder().decode(files.get(path));

afterEach(() => {
  files.clear();
  directories.clear();
  failSidecarWrites = false;
  toastWarning.mockClear();
  vi.unstubAllEnvs();
  Object.assign(Settings, { writeAiSidecarOnSave: true });
});

describe("saving a workspace in the research shell", () => {
  it("writes the AI sidecar into .workbench next to the .prg", async () => {
    const project = makeProject("/research/topic/综述.prg");
    project.readme = "为什么注意力有效？";
    await project.save({ includeThumbnail: false });

    expect(files.has("/research/topic/综述.prg")).toBe(true);
    expect(directories.has("/research/topic/.workbench")).toBe(true);
    const sidecar = JSON.parse(readText("/research/topic/.workbench/综述.ai.json"));
    expect(sidecar.schema).toBe("research-workbench.sidecar/1");
    expect(sidecar.workspace.file).toBe("综述.prg");
    expect(sidecar.workspace.id).toBe(project.metadata.workbench?.id);
    expect(readText("/research/topic/.workbench/综述.ai.md")).toBe("# 综述\n\n## 研究问题\n\n为什么注意力有效？\n");
    expect(project.projectState).toBe(ProjectState.Saved);
    expect(toastWarning).not.toHaveBeenCalled();
  });

  it("gives the workspace a stable id and records the camera and folder-relative path", async () => {
    const project = makeProject("/research/topic/a.prg");
    (project as unknown as { services: Map<string, unknown> }).services.set("camera", {
      isInitialViewSettled: true,
      location: { x: 120, y: -40 },
      currentScale: 0.5,
    });
    await project.save({ includeThumbnail: false });
    const workbench = project.metadata.workbench!;
    expect(workbench.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(workbench.camera).toEqual({ x: 120, y: -40, scale: 0.5 });
    expect(workbench.workspacePath).toBe("topic/a.prg");
    expect(typeof workbench.createdAt).toBe("number");

    await project.save({ includeThumbnail: false });
    expect(project.metadata.workbench?.id).toBe(workbench.id);
    expect(project.metadata.workbench?.createdAt).toBe(workbench.createdAt);

    const parsed = await parseProjectFile(files.get("/research/topic/a.prg")!, new Decoder(), new Map());
    expect(parsed.metadata.workbench).toEqual(workbench);
  });

  it("does not save the default camera before the opening view is settled", async () => {
    const project = makeProject("/research/a.prg");
    project.metadata = { version: "2.7.0", workbench: { id: "kept", camera: { x: 1, y: 2, scale: 3 } } };
    (project as unknown as { services: Map<string, unknown> }).services.set("camera", {
      isInitialViewSettled: false,
      location: { x: 0, y: 0 },
      currentScale: 1,
    });
    await project.save({ includeThumbnail: false });
    expect(project.metadata.workbench).toMatchObject({ id: "kept", camera: { x: 1, y: 2, scale: 3 } });
  });

  it("still saves the .prg when the sidecar cannot be written, with one warning", async () => {
    failSidecarWrites = true;
    const project = makeProject("/research/a.prg");
    await expect(project.save({ includeThumbnail: false })).resolves.toBeUndefined();
    expect(files.has("/research/a.prg")).toBe(true);
    expect(project.projectState).toBe(ProjectState.Saved);
    expect(toastWarning).toHaveBeenCalledOnce();
  });

  it("skips the sidecar when the setting is off", async () => {
    Object.assign(Settings, { writeAiSidecarOnSave: false });
    const project = makeProject("/research/a.prg");
    await project.save({ includeThumbnail: false });
    expect(files.has("/research/a.prg")).toBe(true);
    expect([...files.keys()].some((path) => path.includes(".workbench"))).toBe(false);
  });

  it("opens the draft save dialog in the research folder and refuses targets outside it", async () => {
    const draft = new Project(URI.parse("draft:1"));
    draft.registerFileSystemProvider("file", MemoryFileSystemProvider);
    vi.mocked(saveDialog).mockResolvedValueOnce(null);
    await expect(draft.save()).rejects.toThrow("未选择路径");
    expect(vi.mocked(saveDialog).mock.calls[0][0]).toMatchObject({ defaultPath: "/research" });

    vi.mocked(saveDialog).mockResolvedValueOnce("/Users/me/Desktop/elsewhere.prg");
    await expect(draft.save()).rejects.toThrow();
    expect(files.size).toBe(0);
    expect(draft.isDraft).toBe(true);
  });

  it("leaves upstream saves untouched outside the research shell", async () => {
    vi.stubEnv("LR_RESEARCH_SHELL", "false");
    const project = makeProject("/research/a.prg");
    await project.save({ includeThumbnail: false });
    expect(files.has("/research/a.prg")).toBe(true);
    expect([...files.keys()].some((path) => path.includes(".workbench"))).toBe(false);
    expect(project.metadata.workbench).toBeUndefined();
  });
});
