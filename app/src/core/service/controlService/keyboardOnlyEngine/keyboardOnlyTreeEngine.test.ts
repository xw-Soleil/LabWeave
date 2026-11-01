import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/core/Project", () => ({ Project: class {}, service: () => (value: unknown) => value }));
vi.mock("@/core/service/Settings", () => ({ Settings: { autoLayoutWhenTreeGenerate: true } }));
vi.mock("@/core/service/feedbackService/SoundService", () => ({ SoundService: {} }));
vi.mock("@/core/service/feedbackService/effectEngine/concrete/LineEffect", () => ({ LineEffect: class {} }));
vi.mock("@/core/service/feedbackService/effectEngine/concrete/RectangleRenderEffect", () => ({
  RectangleRenderEffect: class {},
}));
vi.mock("@/core/service/feedbackService/effectEngine/concrete/EntityAlignEffect", () => ({
  EntityAlignEffect: class {},
}));
vi.mock("@/core/stage/stageObject/abstract/ConnectableEntity", () => ({ ConnectableEntity: class {} }));
vi.mock("@/core/stage/stageObject/abstract/StageEntity", () => ({ Entity: class {} }));
vi.mock("@/core/stage/stageObject/association/Edge", () => ({ Edge: class {} }));
vi.mock("@/core/stage/stageObject/entity/TextNode", () => ({ TextNode: class {} }));
vi.mock("@/core/stage/stageObject/entity/Section", () => ({ Section: class {} }));
vi.mock("@/core/stage/stageObject/entity/FileCardNode", () => ({ FileCardNode: class {} }));
vi.mock("@/core/stage/stageObject/entity/UrlNode", () => ({ UrlNode: class {} }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), warning: vi.fn(), success: vi.fn() } }));

import type { Project } from "@/core/Project";
import { Settings } from "@/core/service/Settings";
import type { TreeValidationResult } from "@/core/stage/stageManager/basicMethods/GraphMethods";
import { AutoAlign } from "@/core/stage/stageManager/concreteMethods/StageAutoAlignManager";
import type { ConnectableEntity } from "@/core/stage/stageObject/abstract/ConnectableEntity";
import { toast } from "sonner";
import { KeyboardOnlyTreeEngine } from "./keyboardOnlyTreeEngine";

const diamond: TreeValidationResult = {
  isValid: false,
  issues: [{ type: "diamond", message: '节点 "导入有点卡" 有多个父节点: "a.pdf", "b.pdf"，形成菱形结构' }],
};
const tree: TreeValidationResult = { isValid: true, issues: [] };

const root = { uuid: "root" } as ConnectableEntity;
const node = { uuid: "node" } as ConnectableEntity;

function setup({
  roots = [root],
  validation = diamond,
}: {
  roots?: ConnectableEntity[];
  validation?: TreeValidationResult;
}) {
  const project = {
    graphMethods: { getRoots: vi.fn(() => roots), validateTreeStructure: vi.fn(() => validation) },
    autoAlign: { autoLayoutSelectedFastTreeMode: vi.fn() },
    autoLayoutFastTree: { autoLayoutFastTreeMode: vi.fn() },
  };
  return { project, engine: new KeyboardOnlyTreeEngine(project as unknown as Project) };
}

beforeEach(() => {
  vi.mocked(toast.warning).mockClear();
  vi.mocked(toast.error).mockClear();
  Settings.autoLayoutWhenTreeGenerate = true;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("layout after Tab / \\ growth and probe connect in the research shell", () => {
  it("skips the layout without a warning when the structure is not a tree", () => {
    const { project, engine } = setup({ validation: diamond });
    expect(engine.layoutTreeAfterAutoGrowth(node)).toBeNull();
    expect(project.autoAlign.autoLayoutSelectedFastTreeMode).not.toHaveBeenCalled();
    expect(toast.warning).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("skips the layout without a warning when there is no single root", () => {
    const { project, engine } = setup({ roots: [] });
    expect(engine.layoutTreeAfterAutoGrowth(node)).toBeNull();
    expect(project.graphMethods.validateTreeStructure).not.toHaveBeenCalled();
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it("still lays out a real tree", () => {
    const { project, engine } = setup({ validation: tree });
    expect(engine.layoutTreeAfterAutoGrowth(node)).toBe(root);
    expect(project.autoAlign.autoLayoutSelectedFastTreeMode).toHaveBeenCalledWith(root);
  });

  it("leaves the layout alone when auto layout is switched off", () => {
    Settings.autoLayoutWhenTreeGenerate = false;
    const { project, engine } = setup({ validation: tree });
    expect(engine.layoutTreeAfterAutoGrowth(node)).toBe(root);
    expect(project.autoAlign.autoLayoutSelectedFastTreeMode).not.toHaveBeenCalled();
  });
});

describe("layout after tree growth in the original app", () => {
  beforeEach(() => {
    vi.stubEnv("LR_RESEARCH_SHELL", "false");
  });

  it("warns about the tree problems", () => {
    const { project, engine } = setup({ validation: diamond });
    expect(engine.layoutTreeAfterAutoGrowth(node)).toBeNull();
    expect(project.autoAlign.autoLayoutSelectedFastTreeMode).not.toHaveBeenCalled();
    expect(toast.warning).toHaveBeenCalledOnce();
    expect(vi.mocked(toast.warning).mock.calls[0][0]).toContain("菱形结构");
  });

  it("warns when there is no single root", () => {
    const { engine } = setup({ roots: [] });
    engine.layoutTreeAfterAutoGrowth(node);
    expect(toast.warning).toHaveBeenCalledWith("当前结构不符合树形结构：无法确定唯一的根节点");
  });

  it("stays quiet when auto layout is switched off", () => {
    Settings.autoLayoutWhenTreeGenerate = false;
    const { engine } = setup({ validation: diamond });
    engine.layoutTreeAfterAutoGrowth(node);
    expect(toast.warning).not.toHaveBeenCalled();
  });
});

describe("explicit tree formatting", () => {
  it("still reports a non-tree structure in the research shell", () => {
    const { project } = setup({ validation: diamond });
    new AutoAlign(project as unknown as Project).autoLayoutSelectedFastTreeMode(root);
    expect(toast.error).toHaveBeenCalledOnce();
    expect(vi.mocked(toast.error).mock.calls[0][0]).toContain("请修复上述问题后再进行树形格式化");
    expect(project.autoLayoutFastTree.autoLayoutFastTreeMode).not.toHaveBeenCalled();
  });
});
