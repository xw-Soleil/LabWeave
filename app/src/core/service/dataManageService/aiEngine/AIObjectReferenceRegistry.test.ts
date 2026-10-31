import type { Project } from "@/core/Project";
import { Association } from "@/core/stage/stageObject/abstract/Association";
import type { StageObject } from "@/core/stage/stageObject/abstract/StageObject";
import { describe, expect, it } from "vitest";
import { AIObjectReferenceError, AIObjectReferenceRegistry } from "./AIObjectReferenceRegistry";

function createFixture() {
  const objects = new Map<string, StageObject>();
  const project = {
    stageManager: {
      get: (uuid: string) => objects.get(uuid),
    },
  } as unknown as Project;
  return { objects, registry: new AIObjectReferenceRegistry(project) };
}

function createNode(uuid: string): StageObject {
  return { uuid } as StageObject;
}

function createEdge(uuid: string): Association {
  return Object.assign(Object.create(Association.prototype), { uuid }) as Association;
}

describe("AIObjectReferenceRegistry", () => {
  it("快照丢失时不重用旧对话里出现过的引用号，旧引用视为失效", () => {
    const { objects, registry } = createFixture();
    registry.reserveRefsMentionedIn("[selected: n3 e2]\n看看 `n10`，e2e 不算");
    expect(registry.exportSnapshot()).toEqual({ entries: [], nextNodeRef: 11, nextEdgeRef: 3 });
    const node = createNode("node-new");
    objects.set(node.uuid, node);
    expect(registry.getOrCreateRef(node)).toBe("n11");
    expect(registry.tryResolve("n3")).toBeUndefined();
  });

  it("为节点和连线分配独立且稳定的短引用", () => {
    const { objects, registry } = createFixture();
    const firstNode = createNode("node-1");
    const secondNode = createNode("node-2");
    const edge = createEdge("edge-1");
    objects.set(firstNode.uuid, firstNode);
    objects.set(secondNode.uuid, secondNode);
    objects.set(edge.uuid, edge);

    expect(registry.getOrCreateRef(firstNode)).toBe("n1");
    expect(registry.getOrCreateRef(firstNode)).toBe("n1");
    expect(registry.getOrCreateRef(secondNode)).toBe("n2");
    expect(registry.getOrCreateRef(edge)).toBe("e1");
  });

  it("只在分配新引用时通知持久化", () => {
    const objects = new Map<string, StageObject>();
    const project = {
      stageManager: {
        get: (uuid: string) => objects.get(uuid),
      },
    } as unknown as Project;
    const snapshots: ReturnType<AIObjectReferenceRegistry["exportSnapshot"]>[] = [];
    const registry = new AIObjectReferenceRegistry(project, (snapshot) => snapshots.push(snapshot));
    const node = createNode("node-1");
    objects.set(node.uuid, node);

    expect(registry.getOrCreateRef(node)).toBe("n1");
    expect(registry.getOrCreateRef(node)).toBe("n1");
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].entries).toEqual([{ ref: "n1", uuid: "node-1" }]);
  });

  it("通过短引用解析当前舞台对象", () => {
    const { objects, registry } = createFixture();
    const node = createNode("node-1");
    objects.set(node.uuid, node);
    const ref = registry.getOrCreateRef(node);

    expect(registry.resolve(ref, "node")).toBe(node);
    expect(registry.tryResolve(ref)).toBe(node);
  });

  it("对象删除后保留引用但报告 stale_ref，且编号不复用", () => {
    const { objects, registry } = createFixture();
    const deletedNode = createNode("node-1");
    objects.set(deletedNode.uuid, deletedNode);
    expect(registry.getOrCreateRef(deletedNode)).toBe("n1");
    objects.delete(deletedNode.uuid);

    expect(() => registry.resolve("n1")).toThrowError(
      expect.objectContaining<Partial<AIObjectReferenceError>>({ code: "stale_ref" }),
    );
    expect(registry.tryResolve("n1")).toBeUndefined();

    const newNode = createNode("node-2");
    objects.set(newNode.uuid, newNode);
    expect(registry.getOrCreateRef(newNode)).toBe("n2");
  });

  it("相同UUID的对象被恢复后继续使用原引用", () => {
    const { objects, registry } = createFixture();
    const originalNode = createNode("node-1");
    objects.set(originalNode.uuid, originalNode);
    expect(registry.getOrCreateRef(originalNode)).toBe("n1");
    objects.delete(originalNode.uuid);

    const restoredNode = createNode("node-1");
    objects.set(restoredNode.uuid, restoredNode);
    expect(registry.resolve("n1")).toBe(restoredNode);
    expect(registry.getOrCreateRef(restoredNode)).toBe("n1");
  });

  it("导出并恢复引用快照", () => {
    const { objects, registry } = createFixture();
    const node = createNode("node-1");
    const edge = createEdge("edge-1");
    objects.set(node.uuid, node);
    objects.set(edge.uuid, edge);
    registry.getOrCreateRef(node);
    registry.getOrCreateRef(edge);

    const restoredRegistry = new AIObjectReferenceRegistry({
      stageManager: { get: (uuid: string) => objects.get(uuid) },
    } as unknown as Project);
    restoredRegistry.restoreSnapshot(registry.exportSnapshot());

    expect(restoredRegistry.resolve("n1")).toBe(node);
    expect(restoredRegistry.resolve("e1")).toBe(edge);
    expect(restoredRegistry.getOrCreateRef(createNode("node-2"))).toBe("n2");
  });

  it("区分无效、未知和类型错误引用", () => {
    const { objects, registry } = createFixture();
    const edge = createEdge("edge-1");
    objects.set(edge.uuid, edge);
    registry.getOrCreateRef(edge);

    expect(() => registry.resolve("bad-ref")).toThrowError(
      expect.objectContaining<Partial<AIObjectReferenceError>>({ code: "invalid_ref_format" }),
    );
    expect(() => registry.resolve("n1")).toThrowError(
      expect.objectContaining<Partial<AIObjectReferenceError>>({ code: "unknown_ref" }),
    );
    expect(() => registry.resolve("e1", "node")).toThrowError(
      expect.objectContaining<Partial<AIObjectReferenceError>>({ code: "wrong_ref_kind" }),
    );
  });
});
