import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/core/Project", () => ({ Project: class {}, service: () => (value: unknown) => value }));
vi.mock("@/core/stage/stageObject/abstract/ConnectableEntity", () => ({ ConnectableEntity: class {} }));
vi.mock("@/core/stage/stageObject/association/Edge", () => ({ Edge: class {} }));
vi.mock("@/core/stage/stageObject/association/MutiTargetUndirectedEdge", () => ({
  MultiTargetUndirectedEdge: class {},
}));
vi.mock("@/core/stage/stageObject/entity/TextNode", () => ({ TextNode: class {} }));
vi.mock("@/core/stage/stageObject/entity/Section", () => ({ Section: class {} }));
vi.mock("@/core/stage/stageObject/entity/FileCardNode", () => ({ FileCardNode: class {} }));
vi.mock("@/core/stage/stageObject/entity/UrlNode", () => ({ UrlNode: class {} }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), warning: vi.fn() } }));

import type { Project } from "@/core/Project";
import { GraphMethods } from "@/core/stage/stageManager/basicMethods/GraphMethods";
import type { ConnectableEntity } from "@/core/stage/stageObject/abstract/ConnectableEntity";
import { FileCardNode } from "@/core/stage/stageObject/entity/FileCardNode";
import { Section } from "@/core/stage/stageObject/entity/Section";
import { TextNode } from "@/core/stage/stageObject/entity/TextNode";
import { UrlNode } from "@/core/stage/stageObject/entity/UrlNode";
import { getNodeDisplayName } from "./treeValidation";

afterEach(() => {
  vi.unstubAllEnvs();
});

function make(Class: { prototype: object }, fields: Record<string, unknown>): ConnectableEntity {
  return Object.assign(Object.create(Class.prototype), fields);
}

describe("getNodeDisplayName in the research shell", () => {
  it("names file cards, web links and sections by their titles", () => {
    expect(getNodeDisplayName(make(FileCardNode, { title: "ResNet 论文", sourcePath: "papers/resnet.pdf" }))).toBe(
      "ResNet 论文",
    );
    expect(getNodeDisplayName(make(UrlNode, { title: "PyTorch 文档", url: "https://pytorch.org" }))).toBe(
      "PyTorch 文档",
    );
    expect(getNodeDisplayName(make(Section, { text: "实验设计" }))).toBe("实验设计");
  });

  it("falls back to the file name or the address when a title is empty", () => {
    expect(getNodeDisplayName(make(FileCardNode, { title: "", sourcePath: "papers/v7_final.pdf" }))).toBe(
      "v7_final.pdf",
    );
    expect(getNodeDisplayName(make(UrlNode, { title: "", url: "https://a.io" }))).toBe("https://a.io");
    expect(getNodeDisplayName(make(TextNode, { text: "  " }))).toBe("未命名");
  });

  it("keeps up to 16 characters on one line", () => {
    expect(getNodeDisplayName(make(FileCardNode, { title: "Attention Is All You Need", sourcePath: "" }))).toBe(
      "Attention Is All...",
    );
    expect(getNodeDisplayName(make(TextNode, { text: "导入\n有点卡" }))).toBe("导入 有点卡");
  });

  it("still says 节点 for entities without a name", () => {
    expect(getNodeDisplayName({} as ConnectableEntity)).toBe("节点");
  });
});

describe("getNodeDisplayName in the original app", () => {
  it("keeps the five-character text node names and the generic label", () => {
    vi.stubEnv("LR_RESEARCH_SHELL", "false");
    expect(getNodeDisplayName(make(TextNode, { text: "Attention" }))).toBe("Atten...");
    expect(getNodeDisplayName(make(TextNode, { text: "" }))).toBe("未命名");
    expect(getNodeDisplayName(make(FileCardNode, { title: "ResNet 论文", sourcePath: "" }))).toBe("节点");
    expect(getNodeDisplayName(make(Section, { text: "实验设计" }))).toBe("节点");
  });
});

describe("tree validation messages", () => {
  it("name the file cards that share a child", () => {
    const root = make(TextNode, { uuid: "root", text: "综述" });
    const cardA = make(FileCardNode, { uuid: "a", title: "ResNet 论文", sourcePath: "papers/resnet.pdf" });
    const cardB = make(FileCardNode, { uuid: "b", title: "", sourcePath: "papers/vit.pdf" });
    const child = make(TextNode, { uuid: "c", text: "导入有点卡" });
    const nodes = [root, cardA, cardB, child];
    const edge = (source: ConnectableEntity, target: ConnectableEntity) => ({ source, target, lineType: "solid" });
    const edges = [edge(root, cardA), edge(root, cardB), edge(cardA, child), edge(cardB, child)];
    const project = {
      stageManager: {
        getLineEdges: () => edges,
        getEdges: () => edges,
        getConnectableEntityByUUID: (uuid: string) => nodes.find((node) => node.uuid === uuid),
      },
    } as unknown as Project;

    const result = new GraphMethods(project).validateTreeStructure(root, true);

    expect(result.isValid).toBe(false);
    expect(result.issues.map((issue) => issue.message)).toContain(
      '节点 "导入有点卡" 有多个父节点: "ResNet 论文", "vit.pdf"，形成菱形结构',
    );
  });
});
