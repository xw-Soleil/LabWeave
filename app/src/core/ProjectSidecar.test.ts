// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { URI as URIType } from "vscode-uri";

const toastWarning = vi.hoisted(() => vi.fn());

vi.mock("sonner", () => ({ toast: { warning: toastWarning, error: vi.fn(), success: vi.fn() } }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => true), isTauri: vi.fn(() => false) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn() }));
vi.mock("@/core/stage/ProjectUpgrader", () => ({
  ProjectUpgrader: class ProjectUpgrader {
    static NLatestVersion = "2.7.0";
    static upgradeNAnyToNLatest(stage: unknown, metadata: unknown) {
      return [stage, metadata];
    }
  },
}));
vi.mock("@/core/service/Settings", () => ({ Settings: { writeAiSidecarOnSave: true, watch: vi.fn() } }));
vi.mock("@/utils/font", async () => {
  const { Vector } = await import("@graphif/data-structures");
  return { getMultiLineTextSize: () => new Vector(80, 36), getTextSize: () => new Vector(80, 24) };
});
vi.mock("@/core/stage/stageObject/tools/entityDetailsManager", () => ({ DetailsManager: class {} }));
vi.mock("@/core/service/feedbackService/SoundService", () => ({ SoundService: {} }));
vi.mock("@/core/render/canvas2d/renderer", () => ({ Renderer: { FONT_SIZE: 24, NODE_PADDING: 10 } }));
vi.mock("@/core/research/ResearchFolder", async () => {
  const { posix } = await import("node:path");
  return {
    ResearchFolder: {
      getRoot: () => "/research",
      isInside: (path: string) => path.startsWith("/research/"),
      toRelative: (path: string, baseDir = "/research") => posix.relative(baseDir, path),
      toAbsolute: (path: string, baseDir = "/research") =>
        posix.isAbsolute(path) ? posix.normalize(path) : posix.join(baseDir, path),
    },
  };
});
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
import { StageManager } from "@/core/stage/stageManager/StageManager";
import { TextNode } from "@/core/stage/stageObject/entity/TextNode";
import { Section } from "@/core/stage/stageObject/entity/Section";
import { LineEdge } from "@/core/stage/stageObject/association/LineEdge";
import { parseProjectFile } from "@/core/ProjectFile";
import { Settings } from "@/core/service/Settings";
import { Decoder, encode } from "@msgpack/msgpack";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import { toast } from "sonner";
import { URI } from "vscode-uri";

const files = new Map<string, Uint8Array>();
const directories = new Set<string>();
let failSidecarWrites = false;
let failPrgWrites = false;
/** 写 .prg 之前调用：模拟写盘期间用户又做了编辑 */
let beforePrgWrite: (() => void) | undefined;

class MemoryFileSystemProvider {
  async read(uri: URIType) {
    return files.get(uri.path)!;
  }
  async readDir() {
    return [];
  }
  async write(uri: URIType, content: Uint8Array) {
    if (failSidecarWrites && uri.path.includes("/.workbench/")) throw new Error("disk full");
    if (uri.path.endsWith(".prg")) {
      if (failPrgWrites) throw new Error("volume unplugged");
      beforePrgWrite?.();
    }
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
  failPrgWrites = false;
  beforePrgWrite = undefined;
  toastWarning.mockClear();
  Object.assign(Settings, { writeAiSidecarOnSave: true });
});

describe("saving a workspace", () => {
  it.each(["2.0.0", "2.7.0"])(
    "opens legacy formula cards from %s with stable references and saves only text cards",
    async (version) => {
      const path = "/research/legacy-math.prg";
      const original = {
        _: "LatexNode",
        uuid: "math",
        latexSource: String.raw`\TeX`,
        fontScaleLevel: 2,
        color: { _: "Color", r: 20, g: 60, b: 100, a: 1 },
        details: [{ type: "p", children: [{ text: "note" }] }],
        collisionBox: {
          _: "CollisionBox",
          shapes: [{ _: "Rectangle", location: { _: "Vector", x: 120, y: 90 }, size: { _: "Vector", x: 400, y: 200 } }],
        },
      };
      const output = new Uint8ArrayWriter();
      const writer = new ZipWriter(output);
      await writer.add(
        "stage.msgpack",
        new Uint8ArrayReader(
          encode([
            original,
            { _: "TextNode", uuid: "text", text: String.raw`$\TeX$` },
            { _: "LineEdge", uuid: "edge", associationList: [{ $: "/0" }, { $: "/1" }] },
            { _: "Section", uuid: "group", children: [{ $: "/0" }] },
          ]),
        ),
      );
      await writer.add("metadata.msgpack", new Uint8ArrayReader(encode({ version })));
      await writer.close();
      files.set(path, await output.getData());
      const open = async () => {
        const project = makeProject(path);
        const stageManager = new StageManager(project);
        Object.assign(project, { stageManager });
        (project as unknown as { services: Map<string, unknown> }).services.set("stageManager", stageManager);
        vi.spyOn(
          project as unknown as { checkAndConfirmUpgrade: () => Promise<boolean> },
          "checkAndConfirmUpgrade",
        ).mockResolvedValue(true);
        await project.init();
        return project;
      };
      const check = (project: Project) => {
        const [math, text, edge, section] = project.stage as [TextNode, TextNode, LineEdge, Section];
        expect(math).toBeInstanceOf(TextNode);
        expect(math).toMatchObject({
          uuid: "math",
          text: String.raw`$$\TeX$$`,
          fontScaleLevel: 2,
          borderStyle: "none",
          sizeAdjust: "auto",
          fontFamily: "",
          fontWeight: "",
          details: original.details,
        });
        expect(math.color).toMatchObject({ r: 20, g: 60, b: 100, a: 1 });
        expect(math.rectangle.location.toArray()).toEqual([120, 90]);
        expect(text).toBeInstanceOf(TextNode);
        expect(text.text).toBe(String.raw`$\TeX$`);
        expect(edge.source).toBe(math);
        expect(edge.target).toBe(text);
        expect(section.children).toEqual([math]);
        expect(math.parentSection).toBe(section);
        return math.rectangle;
      };
      const project = await open();
      const rectangle = check(project).clone();
      await project.save({ includeThumbnail: false });
      const saved = await parseProjectFile(files.get(path)!, new Decoder(), new Map());
      expect(saved.serializedStageObjects[0]).not.toHaveProperty("latexSource");
      expect(saved.serializedStageObjects[0]._).toBe("TextNode");
      const sidecar = JSON.parse(readText("/research/.workbench/legacy-math.ai.json"));
      expect(sidecar.cards[0]).toMatchObject({ id: "math", type: "TextNode", text: String.raw`$$\TeX$$` });
      expect(check(await open())).toEqual(rectangle);
    },
  );

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
});

describe("saved state while a save is in flight", () => {
  it("stays unsaved when an edit lands after the stage was serialized, and the next save clears it", async () => {
    const project = makeProject("/research/a.prg");
    beforePrgWrite = () => {
      // recordStep 在写盘期间运行：状态本来就是未保存，不会发事件
      project.projectState = ProjectState.Unsaved;
    };
    await project.save({ includeThumbnail: false });
    expect(project.projectState).toBe(ProjectState.Unsaved);

    beforePrgWrite = undefined;
    await project.save({ includeThumbnail: false });
    expect(project.projectState).toBe(ProjectState.Saved);
  });
});

describe("workbench id", () => {
  /** 写一个元数据里没有 workbench 的旧 .prg */
  async function writeLegacyFile(path: string) {
    const output = new Uint8ArrayWriter();
    const writer = new ZipWriter(output);
    await writer.add("stage.msgpack", new Uint8ArrayReader(encode([])));
    await writer.add("metadata.msgpack", new Uint8ArrayReader(encode({ version: "2.7.0" })));
    await writer.close();
    files.set(path, await output.getData());
    const parsed = await parseProjectFile(files.get(path)!, new Decoder(), new Map());
    expect(parsed.metadata.workbench).toBeUndefined();
  }

  it("is assigned when a draft is created, and kept when the draft is saved", async () => {
    const draft = new Project(URI.parse("draft:1"));
    draft.registerFileSystemProvider("draft", MemoryFileSystemProvider);
    draft.registerFileSystemProvider("file", MemoryFileSystemProvider);
    await draft.init();
    const id = draft.metadata.workbench?.id;
    expect(id).toMatch(/^[0-9a-f-]{36}$/);

    vi.mocked(saveDialog).mockResolvedValueOnce("/research/draft.prg");
    await draft.save({ includeThumbnail: false });
    expect(draft.metadata.workbench?.id).toBe(id);
    const parsed = await parseProjectFile(files.get("/research/draft.prg")!, new Decoder(), new Map());
    expect(parsed.metadata.workbench?.id).toBe(id);
  });

  it("is assigned when a legacy .prg without one is opened, and the project is marked unsaved so it gets written", async () => {
    await writeLegacyFile("/research/old.prg");
    const project = makeProject("/research/old.prg");
    await project.init();
    const id = project.metadata.workbench?.id;
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(project.projectState).toBe(ProjectState.Unsaved);

    await project.save({ includeThumbnail: false });
    expect(project.metadata.workbench?.id).toBe(id);
    const reopened = makeProject("/research/old.prg");
    await reopened.init();
    expect(reopened.metadata.workbench?.id).toBe(id);
    expect(reopened.projectState).toBe(ProjectState.Saved);
  });

  it("is not changed by backups, which also leave the in-memory metadata alone", async () => {
    const project = makeProject("/research/a.prg");
    project.metadata = { version: "2.7.0", workbench: { id: "kept", createdAt: 1 } };
    (project as unknown as { services: Map<string, unknown> }).services.set("camera", {
      isInitialViewSettled: true,
      location: { x: 5, y: 6 },
      currentScale: 2,
    });
    const before = structuredClone(project.metadata);
    const content = await project.getFileContent({ includeThumbnail: false });
    expect(project.metadata).toEqual(before);
    const parsed = await parseProjectFile(content, new Decoder(), new Map());
    expect(parsed.metadata.workbench).toMatchObject({ id: "kept", camera: { x: 5, y: 6, scale: 2 } });
  });
});

describe("Save As", () => {
  async function workspaceWithCards() {
    const { FileCardNode } = await import("@/core/stage/stageObject/entity/FileCardNode");
    const project = makeProject("/research/topic/a.prg");
    project.metadata = { version: "2.7.0", workbench: { id: "original", createdAt: 1 } };
    const cards = [
      new FileCardNode(project, { sourcePath: "papers/a.pdf" }),
      // 从草稿存下来的卡片还是绝对路径，保持不变
      new FileCardNode(project, { sourcePath: "/research/c.pdf" }),
      // 相对路径指到了另一块盘，新位置和它之间没有相对路径，改存绝对路径
      new FileCardNode(project, { sourcePath: "../../Volumes/Archive/d.pdf" }),
    ];
    project.stage = [...cards];
    return { project, cards };
  }

  const originalPaths = ["papers/a.pdf", "/research/c.pdf", "../../Volumes/Archive/d.pdf"];

  async function storedSourcePaths(path: string) {
    const parsed = await parseProjectFile(files.get(path)!, new Decoder(), new Map());
    return (parsed.serializedStageObjects as { sourcePath?: string }[]).map((object) => object.sourcePath);
  }

  it("rebases file card paths onto the new folder and gives the copy its own workbench id", async () => {
    const { project, cards } = await workspaceWithCards();
    await project.saveAs(URI.file("/research/b.prg"), { includeThumbnail: false });

    const expected = ["topic/papers/a.pdf", "/research/c.pdf", "/Volumes/Archive/d.pdf"];
    expect(await storedSourcePaths("/research/b.prg")).toEqual(expected);
    expect(cards.map((card) => card.sourcePath)).toEqual(expected);
    expect(project.uri.fsPath).toBe("/research/b.prg");
    expect(project.projectState).toBe(ProjectState.Saved);

    const id = project.metadata.workbench?.id;
    expect(id).not.toBe("original");
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const parsed = await parseProjectFile(files.get("/research/b.prg")!, new Decoder(), new Map());
    expect(parsed.metadata.workbench?.id).toBe(id);
    expect(parsed.metadata.workbench?.workspacePath).toBe("b.prg");
  });

  it("leaves the open workspace untouched when the write fails", async () => {
    const { project, cards } = await workspaceWithCards();
    failPrgWrites = true;
    await expect(project.saveAs(URI.file("/research/b.prg"), { includeThumbnail: false })).rejects.toThrow(
      "volume unplugged",
    );
    expect(cards.map((card) => card.sourcePath)).toEqual(originalPaths);
    expect(project.uri.fsPath).toBe("/research/topic/a.prg");
    expect(project.metadata.workbench?.id).toBe("original");
  });

  it("keeps paths and the id when a file is saved again in place", async () => {
    const { project, cards } = await workspaceWithCards();
    await project.saveAs(URI.file("/research/topic/a.prg"), { includeThumbnail: false });
    expect(cards.map((card) => card.sourcePath)).toEqual(originalPaths);
    expect(project.metadata.workbench?.id).toBe("original");
  });

  it("does not rewrite the absolute paths of a draft when it is saved", async () => {
    const { FileCardNode } = await import("@/core/stage/stageObject/entity/FileCardNode");
    const draft = new Project(URI.parse("draft:1"));
    draft.registerFileSystemProvider("file", MemoryFileSystemProvider);
    const card = new FileCardNode(draft, { sourcePath: "/research/papers/a.pdf" });
    draft.stage = [card];
    await draft.saveAs(URI.file("/research/topic/draft.prg"), { includeThumbnail: false });
    expect(await storedSourcePaths("/research/topic/draft.prg")).toEqual(["/research/papers/a.pdf"]);
    expect(card.sourcePath).toBe("/research/papers/a.pdf");
  });

  it("refuses targets outside the research folder", async () => {
    const { project } = await workspaceWithCards();
    vi.mocked(toast.error).mockClear();
    await expect(project.saveAs(URI.file("/Users/me/Desktop/b.prg"), { includeThumbnail: false })).rejects.toThrow();
    expect(toast.error).toHaveBeenCalledOnce();
    expect(files.size).toBe(0);
    expect(project.uri.fsPath).toBe("/research/topic/a.prg");
  });
});
