// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Vector } from "@graphif/data-structures";
import { Line, Rectangle } from "@graphif/shapes";

const clipboard = vi.hoisted(() => ({ text: "", writes: [] as string[] }));
const systemPaste = vi.hoisted(() => ({ files: vi.fn(), text: vi.fn(), image: vi.fn() }));

vi.mock("@/core/Project", () => ({
  Project: class Project {},
  ProjectState: { Saved: "saved", Unsaved: "unsaved" },
  service: (id: string) => (target: { id?: string }) => {
    target.id = id;
    return target;
  },
}));
vi.mock("@/core/render/canvas2d/renderer", () => ({ Renderer: { FONT_SIZE: 24, NODE_PADDING: 10 } }));
vi.mock("@/core/service/Settings", () => ({
  Settings: { watch: vi.fn(), isEnableEntityCollision: true, effectsPerferences: {} },
}));
vi.mock("@/core/service/feedbackService/SoundService", () => ({ SoundService: {} }));
vi.mock("@/utils/font", () => ({
  getMultiLineTextSize: () => new Vector(20, 20),
  getTextSize: () => new Vector(20, 20),
}));
vi.mock("@/utils/platform", () => ({ isMac: true, isWindows: false, isLinux: false }));
vi.mock("i18next", () => ({ default: { t: (key: string) => key } }));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), info: vi.fn(), error: vi.fn() }) }));
vi.mock("@tauri-apps/api/image", () => ({ Image: { fromBytes: vi.fn() } }));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  readText: vi.fn(async () => clipboard.text),
  writeText: vi.fn(async (text: string) => {
    clipboard.text = text;
    clipboard.writes.push(text);
  }),
  writeImage: vi.fn(),
  readImage: vi.fn(),
}));
vi.mock("@/core/research/FileCardFactory", () => ({
  rewriteSerializedFileCardPaths: vi.fn(),
  resolveSourcePath: (_project: unknown, sourcePath: string) => sourcePath,
  toStoredSourcePath: (_project: unknown, sourcePath: string) => sourcePath,
}));
vi.mock("@/core/research/OverlapResolver", () => ({ nudgeEntitiesOutOfOverlap: vi.fn() }));
vi.mock("@/core/research/ResearchDrop", () => ({ pasteClipboardFiles: systemPaste.files }));
vi.mock("./copyEngineImage", () => ({
  CopyEngineImage: class CopyEngineImage {
    pasteImageFromSystemClipboard = systemPaste.image;
  },
}));
vi.mock("./copyEngineText", () => ({
  CopyEngineText: class CopyEngineText {
    copyEnginePastePlainText = systemPaste.text;
  },
}));

import { nudgeEntitiesOutOfOverlap } from "@/core/research/OverlapResolver";
import { toast } from "sonner";
import type { Project } from "@/core/Project";
import { MouseLocation } from "@/core/service/controlService/MouseLocation";
import { StageManager } from "@/core/stage/stageManager/StageManager";
import type { Entity } from "@/core/stage/stageObject/abstract/StageEntity";
import { CollisionBox } from "@/core/stage/stageObject/collisionBox/collisionBox";
import { Section } from "@/core/stage/stageObject/entity/Section";
import { TextNode } from "@/core/stage/stageObject/entity/TextNode";
import { CopyEngine } from "./copyEngine";
import { CopyEngineUtils } from "./copyEngineUtils";
import { VirtualClipboard } from "./VirtualClipboard";

/** 视野坐标加上这个就是世界坐标 */
const VIEW_TO_WORLD = new Vector(1000, 500);
const CAMERA_LOCATION = new Vector(-300, -200);

interface FakeProject {
  stage: object[];
  stageManager: StageManager;
  historyManager: { recordStep: ReturnType<typeof vi.fn> };
  deleteManager: { deleteEntities: ReturnType<typeof vi.fn> };
  sectionMethods: {
    getInnermostSectionByLocation: ReturnType<typeof vi.fn>;
    isObjectBeLockedBySection: ReturnType<typeof vi.fn>;
    getAllEntitiesInSelectedSectionsOrEntities: ReturnType<typeof vi.fn>;
  };
  sectionInOutManager: { goInSection: ReturnType<typeof vi.fn> };
  effects: { addEffect: ReturnType<typeof vi.fn>; addMoveShadow: ReturnType<typeof vi.fn> };
  renderer: { transformView2World: (location: Vector) => Vector };
  camera: { location: Vector };
  canvas: { element: { getBoundingClientRect: () => DOMRect } };
  attachments: Map<string, Blob>;
  addAttachment: (blob: Blob) => string;
  sectionMoveDepth: number;
}

function fakeProject(): FakeProject {
  const project = {
    stage: [] as object[],
    historyManager: { recordStep: vi.fn() },
    deleteManager: {
      deleteEntities: vi.fn((entities: Entity[]) => {
        project.stage = project.stage.filter((it) => !entities.includes(it as Entity));
      }),
    },
    sectionMethods: {
      getInnermostSectionByLocation: vi.fn(() => null),
      isObjectBeLockedBySection: vi.fn(() => false),
      getAllEntitiesInSelectedSectionsOrEntities: vi.fn(() => []),
    },
    sectionInOutManager: { goInSection: vi.fn() },
    effects: { addEffect: vi.fn(), addMoveShadow: vi.fn() },
    renderer: { transformView2World: (location: Vector) => location.add(VIEW_TO_WORLD) },
    textRenderer: { measureMultiLineTextSize: () => new Vector(80, 40) },
    camera: { location: CAMERA_LOCATION },
    canvas: {
      element: {
        getBoundingClientRect: () => ({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 }) as DOMRect,
      },
    },
    attachments: new Map<string, Blob>(),
    addAttachment: () => crypto.randomUUID(),
    sectionMoveDepth: 0,
  } as unknown as FakeProject;
  project.stageManager = new StageManager(project as never);
  return project;
}

function textNode(project: FakeProject, text: string, x: number, y: number): TextNode {
  const node = new TextNode(project as unknown as Project, {
    text,
    sizeAdjust: "manual",
    collisionBox: new CollisionBox([new Rectangle(new Vector(x, y), new Vector(100, 60))]),
  });
  project.stage.push(node);
  return node;
}

function engineOf(project: FakeProject) {
  return new CopyEngine(project as unknown as Project);
}

function stageTextNodes(project: FakeProject): TextNode[] {
  return project.stage.filter((it) => it instanceof TextNode) as TextNode[];
}

function pointerAt(clientX: number, clientY: number) {
  MouseLocation.clientX = clientX;
  MouseLocation.clientY = clientY;
  MouseLocation.x = clientX;
  MouseLocation.y = clientY;
}

beforeEach(() => {
  VirtualClipboard.clear();
  clipboard.text = "";
  clipboard.writes = [];
  vi.mocked(nudgeEntitiesOutOfOverlap).mockClear();
  systemPaste.files.mockReset().mockResolvedValue(false);
  systemPaste.text.mockClear();
  systemPaste.image.mockClear();
  vi.mocked(toast.error).mockClear();
  pointerAt(400, 300);
});

describe("computePasteOffset", () => {
  it("moves the center of the pasted bounds onto the target", () => {
    const bounds = new Rectangle(new Vector(10, 20), new Vector(100, 60));
    expect(CopyEngineUtils.computePasteOffset(bounds, new Vector(300, 200)).toArray()).toEqual([240, 150]);
  });

  it("rounds to whole numbers so pasted coordinates stay tidy", () => {
    const bounds = new Rectangle(new Vector(0, 0), new Vector(101, 51));
    const offset = CopyEngineUtils.computePasteOffset(bounds, new Vector(0.2, 0));
    expect(offset.toArray()).toEqual([-50, -25]);
  });
});

describe("rawShiftEntity", () => {
  it("shifts a section's expanded and collapsed boxes even while it is locked", () => {
    const section = Object.create(Section.prototype) as Section;
    const normal = new CollisionBox([new Line(new Vector(0, 0), new Vector(100, 0))]);
    const collapsed = new CollisionBox([new Rectangle(new Vector(10, 10), new Vector(50, 20))]);
    Object.assign(section, {
      _collisionBoxNormal: normal,
      _collisionBoxWhenCollapsed: collapsed,
      locked: true,
      isCollapsed: false,
      children: [],
    });
    CopyEngineUtils.rawShiftEntity(section, new Vector(5, 7));
    const line = normal.shapes[0] as Line;
    expect([line.start.toArray(), line.end.toArray()]).toEqual([
      [5, 7],
      [105, 7],
    ]);
    expect((collapsed.shapes[0] as Rectangle).location.toArray()).toEqual([15, 17]);
    expect(section.locked).toBe(true);
    expect(section.isCollapsed).toBe(false);
  });
});

describe("VirtualClipboard outdated check", () => {
  it("is not outdated until the system clipboard text after the copy is known", () => {
    VirtualClipboard.copy({ stageObjects: [] });
    expect(VirtualClipboard.isOutdatedBy("anything")).toBe(false);
  });

  it("is outdated once the system clipboard differs from what it was right after the copy", () => {
    const generation = VirtualClipboard.copy({ stageObjects: [] });
    VirtualClipboard.rememberSystemClipboardText(generation, "copied text");
    expect(VirtualClipboard.isOutdatedBy("copied text")).toBe(false);
    expect(VirtualClipboard.isOutdatedBy("something copied elsewhere")).toBe(true);
    expect(VirtualClipboard.isOutdatedBy("")).toBe(true);
  });

  it("ignores the system clipboard text read by an older copy that finished late", () => {
    const first = VirtualClipboard.copy({ stageObjects: [] });
    const second = VirtualClipboard.copy({ stageObjects: [] });
    VirtualClipboard.rememberSystemClipboardText(second, "second");
    VirtualClipboard.rememberSystemClipboardText(first, "first");
    expect(VirtualClipboard.isOutdatedBy("second")).toBe(false);
  });

  it("forgets the baseline when cleared", () => {
    const generation = VirtualClipboard.copy({ stageObjects: [] });
    VirtualClipboard.rememberSystemClipboardText(generation, "copied text");
    VirtualClipboard.clear();
    expect(VirtualClipboard.hasData()).toBe(false);
    expect(VirtualClipboard.isOutdatedBy("other")).toBe(false);
  });
});

describe("paste", () => {
  it.each([false, true])("pastes legacy formula data through the shared migration (envelope: %s)", (envelope) => {
    const project = fakeProject();
    const source = [
      {
        _: "LatexNode",
        uuid: "old-math",
        latexSource: String.raw`\TeX`,
        fontScaleLevel: 2,
        color: { _: "Color", r: 20, g: 30, b: 40, a: 1 },
      },
    ];
    VirtualClipboard.copy(envelope ? { stageObjects: source } : source);
    const engine = engineOf(project);
    engine.virtualClipboardPaste("origin");
    engine.virtualClipboardPaste("origin");
    const nodes = stageTextNodes(project);
    expect(nodes).toHaveLength(2);
    for (const node of nodes) {
      expect(node).toBeInstanceOf(TextNode);
      expect(node).toMatchObject({ text: String.raw`$$\TeX$$`, fontScaleLevel: 2, borderStyle: "none" });
      expect(node.color).toMatchObject({ r: 20, g: 30, b: 40, a: 1 });
      expect(node.uuid).not.toBe("old-math");
    }
    expect(nodes[0].uuid).not.toBe(nodes[1].uuid);
    expect(source[0]._).toBe("LatexNode");
  });

  async function copyOneNode(project: FakeProject) {
    const original = textNode(project, "原节点", 0, 0);
    original.isSelected = true;
    await engineOf(project).copy();
    return original;
  }

  it("centers the pasted content on the mouse when the mouse is over the canvas, as one history step", async () => {
    const project = fakeProject();
    const original = await copyOneNode(project);
    project.historyManager.recordStep.mockClear();

    await engineOf(project).paste();

    const pasted = stageTextNodes(project).filter((it) => it !== original);
    expect(pasted).toHaveLength(1);
    expect(pasted[0].uuid).not.toBe(original.uuid);
    expect(pasted[0].collisionBox.getRectangle().center.toArray()).toEqual(
      new Vector(400, 300).add(VIEW_TO_WORLD).toArray(),
    );
    expect(original.collisionBox.getRectangle().location.toArray()).toEqual([0, 0]);
    expect(pasted[0].isSelected).toBe(true);
    expect(nudgeEntitiesOutOfOverlap).toHaveBeenCalledWith(project, [pasted[0]]);
    expect(project.historyManager.recordStep).toHaveBeenCalledTimes(1);
  });

  it("falls back to the view center when the mouse is not over this board's canvas", async () => {
    const project = fakeProject();
    await copyOneNode(project);
    pointerAt(1200, 300);

    await engineOf(project).paste();

    const pasted = stageTextNodes(project)[1];
    expect(pasted.collisionBox.getRectangle().center.toArray()).toEqual(CAMERA_LOCATION.toArray());
  });

  it("pastes a fresh, independent copy every time Cmd+V is pressed", async () => {
    const project = fakeProject();
    const original = await copyOneNode(project);
    const engine = engineOf(project);

    await engine.paste();
    pointerAt(100, 100);
    await engine.paste();

    const pasted = stageTextNodes(project).filter((it) => it !== original);
    expect(pasted).toHaveLength(2);
    expect(pasted[0].uuid).not.toBe(pasted[1].uuid);
    expect(pasted[0].collisionBox).not.toBe(pasted[1].collisionBox);
    expect(pasted[1].collisionBox.getRectangle().center.toArray()).toEqual(
      new Vector(100, 100).add(VIEW_TO_WORLD).toArray(),
    );
    expect(pasted[0].collisionBox.getRectangle().center.toArray()).toEqual(
      new Vector(400, 300).add(VIEW_TO_WORLD).toArray(),
    );
    expect(pasted[0].isSelected).toBe(false);
    expect(pasted[1].isSelected).toBe(true);
  });

  it("pastes the system clipboard instead once something new was copied elsewhere", async () => {
    const project = fakeProject();
    await copyOneNode(project);
    expect(clipboard.writes).toEqual(["原节点"]);
    const engine = engineOf(project);

    await engine.paste();
    expect(systemPaste.text).not.toHaveBeenCalled();

    clipboard.text = "copied from the browser";
    await engine.paste();
    expect(systemPaste.text).toHaveBeenCalledExactlyOnceWith("copied from the browser");
    expect(systemPaste.image).not.toHaveBeenCalled();
    expect(VirtualClipboard.hasData()).toBe(false);
    expect(stageTextNodes(project)).toHaveLength(2);
  });

  it("places files copied in Finder at the mouse instead of pasting their names as text", async () => {
    clipboard.text = "invoice.pdf";
    systemPaste.files.mockResolvedValue(true);
    const project = fakeProject();
    await engineOf(project).paste();
    expect(systemPaste.files).toHaveBeenCalledExactlyOnceWith(project, new Vector(400, 300).add(VIEW_TO_WORLD));
    expect(systemPaste.text).not.toHaveBeenCalled();
    expect(systemPaste.image).not.toHaveBeenCalled();
  });

  it("reads an image from the system clipboard when it holds no text", async () => {
    clipboard.text = "";
    await engineOf(fakeProject()).paste();
    expect(systemPaste.text).not.toHaveBeenCalled();
    expect(systemPaste.image).toHaveBeenCalledOnce();
  });

  it("says so when the system clipboard has nothing it can paste", async () => {
    clipboard.text = "";
    systemPaste.image.mockRejectedValueOnce("The clipboard contents were not available in the requested format");
    await engineOf(fakeProject()).paste();
    expect(toast.error).toHaveBeenCalledExactlyOnceWith("clipboard.nothingToPaste", {
      description: "The clipboard contents were not available in the requested format",
    });
  });

  it("puts the pasted content into the section under the drop point", async () => {
    const project = fakeProject();
    await copyOneNode(project);
    const section = { collisionBox: new CollisionBox([new Rectangle(new Vector(0, 0), new Vector(5000, 5000))]) };
    project.sectionMethods.getInnermostSectionByLocation.mockReturnValue(section);

    await engineOf(project).paste();

    const pasted = stageTextNodes(project)[1];
    expect(project.sectionInOutManager.goInSection).toHaveBeenCalledWith([pasted], section);
  });

  it("does not put the pasted content into a locked section", async () => {
    const project = fakeProject();
    await copyOneNode(project);
    const section = { collisionBox: new CollisionBox([new Rectangle(new Vector(0, 0), new Vector(5000, 5000))]) };
    project.sectionMethods.getInnermostSectionByLocation.mockReturnValue(section);
    project.sectionMethods.isObjectBeLockedBySection.mockImplementation((it: unknown) => it === section);

    await engineOf(project).paste();

    expect(project.sectionInOutManager.goInSection).not.toHaveBeenCalled();
  });

  it("Cmd+Shift+V keeps the exact original coordinates and does not nudge", async () => {
    const project = fakeProject();
    const original = await copyOneNode(project);
    project.historyManager.recordStep.mockClear();

    await engineOf(project).pasteWithOriginLocation();

    const pasted = stageTextNodes(project).filter((it) => it !== original);
    expect(pasted).toHaveLength(1);
    expect(pasted[0].collisionBox.getRectangle().location.toArray()).toEqual([0, 0]);
    expect(nudgeEntitiesOutOfOverlap).not.toHaveBeenCalled();
    expect(project.historyManager.recordStep).toHaveBeenCalledTimes(1);
  });
});

describe("cut", () => {
  it("copies, then deletes exactly the copied entities as one history step, keeping locked ones", async () => {
    const project = fakeProject();
    const first = textNode(project, "一", 0, 0);
    const second = textNode(project, "二", 200, 0);
    const locked = textNode(project, "锁", 400, 0);
    const untouched = textNode(project, "别动", 600, 0);
    for (const node of [first, second, locked]) node.isSelected = true;
    project.sectionMethods.isObjectBeLockedBySection.mockImplementation((it: unknown) => it === locked);

    await engineOf(project).cut();

    expect(project.deleteManager.deleteEntities).toHaveBeenCalledTimes(1);
    expect(project.deleteManager.deleteEntities).toHaveBeenCalledWith([first, second]);
    expect(project.historyManager.recordStep).toHaveBeenCalledTimes(1);
    expect(stageTextNodes(project)).toEqual([locked, untouched]);
    expect(VirtualClipboard.hasData()).toBe(true);
    expect(clipboard.writes).toEqual(["一\n\n二\n\n锁"]);
  });

  it("does nothing more than clearing the clipboard when no entity is selected", async () => {
    const project = fakeProject();
    textNode(project, "没选中", 0, 0);

    await engineOf(project).cut();

    expect(project.deleteManager.deleteEntities).not.toHaveBeenCalled();
    expect(project.historyManager.recordStep).not.toHaveBeenCalled();
    expect(VirtualClipboard.hasData()).toBe(false);
  });

  it("pasting after a cut brings the content back once per Cmd+V", async () => {
    const project = fakeProject();
    const node = textNode(project, "剪下来", 0, 0);
    node.isSelected = true;
    const engine = engineOf(project);

    await engine.cut();
    expect(stageTextNodes(project)).toEqual([]);
    await engine.pasteWithOriginLocation();

    const restored = stageTextNodes(project);
    expect(restored).toHaveLength(1);
    expect(restored[0].text).toBe("剪下来");
    expect(restored[0].collisionBox.getRectangle().location.toArray()).toEqual([0, 0]);
  });
});
