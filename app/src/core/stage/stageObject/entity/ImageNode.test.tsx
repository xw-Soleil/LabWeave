// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/core/Project", () => ({
  Project: class Project {},
  ProjectState: { Saved: 0, Stashed: 1, Unsaved: 2 },
  service: () => () => undefined,
}));
vi.mock("@/core/render/canvas2d/renderer", () => ({ Renderer: { FONT_SIZE: 24 } }));
vi.mock("@/core/service/feedbackService/SoundService", () => ({ SoundService: { play: {} } }));
vi.mock("@/core/stage/stageObject/tools/entityDetailsManager", () => ({ DetailsManager: class DetailsManager {} }));
vi.mock("@/core/research/LegacyMathCards", async () => ({
  deserializeStageObjects: (await import("@graphif/serializer")).deserialize,
}));
vi.mock("@/utils/font", async () => {
  const { Vector } = await import("@graphif/data-structures");
  return { getTextSize: () => new Vector(20, 20), getMultiLineTextSize: () => new Vector(20, 20) };
});
vi.mock("@/core/stage/stageObject/abstract/ConnectableEntity", () => ({
  ConnectableEntity: class ConnectableEntity {
    details = [];
    parentSection = null;
    isHiddenBySectionCollapse = false;
    clipConnectionToBoundary = false;
    updateFatherSectionByMove() {}
  },
}));
vi.mock("@/core/service/Settings", () => ({
  Settings: {
    compressImageToBlackAndWhite: false,
    compressImageToWebp: false,
    maxPastedImageSize: 1024,
    resizePastedImages: false,
    webpQuality: 0.8,
    enableAutoEdgeWidth: false,
    historyRecordMode: "timeEfficient",
    historySize: 20,
    showDebug: false,
    viewerMode: false,
    watch: (_key: string, callback: (value: string) => void) => {
      callback("timeEfficient");
      return vi.fn();
    },
  },
}));
vi.mock("@/core/service/dataManageService/imageUtils", () => ({ applyBlackAndWhite: vi.fn() }));

import { LineEdge } from "@/core/stage/stageObject/association/LineEdge";
import { CollisionBox } from "@/core/stage/stageObject/collisionBox/collisionBox";
import { HistoryManager } from "@/core/stage/stageManager/StageHistoryManager";
import { Vector } from "@graphif/data-structures";
import { deserialize, serialize } from "@graphif/serializer";
import { Rectangle } from "@graphif/shapes";
import { ImageNode, rotateSelectedImageNodes } from "./ImageNode";

describe("ImageNode cleanup", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("waits for an in-flight bitmap and closes it when disposal has started", async () => {
    let resolveBitmap: ((bitmap: ImageBitmap) => void) | undefined;
    const bitmap = { close: vi.fn(), width: 20, height: 10 } as unknown as ImageBitmap;
    const createBitmap = vi.fn(
      () =>
        new Promise<ImageBitmap>((resolve) => {
          resolveBitmap = resolve;
        }),
    );
    vi.stubGlobal("createImageBitmap", createBitmap);
    const project = {
      addAttachment: vi.fn(),
      attachments: new Map([["image", new Blob(["image"])]]),
    };
    const node = new ImageNode(project as never, { attachmentId: "image" });
    const dispose = (node as unknown as { dispose?: () => Promise<void> }).dispose;

    expect(dispose).toBeTypeOf("function");
    const disposal = dispose!.call(node);
    resolveBitmap?.(bitmap);
    await disposal;

    expect(bitmap.close).toHaveBeenCalledOnce();
    expect(node.bitmap).toBeUndefined();
  });

  it("reports bitmap loading failure to the DOM and preserves it for cleanup", async () => {
    const failure = new Error("bitmap decode failed");
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => Promise.reject(failure)),
    );
    const project = {
      addAttachment: vi.fn(),
      attachments: new Map([["image", new Blob(["image"])]]),
    };
    const onError = vi.fn((event: ErrorEvent) => event.preventDefault());
    window.addEventListener("error", onError);
    const node = new ImageNode(project as never, { attachmentId: "image" });

    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
    expect(onError.mock.calls[0][0].error).toBe(failure);
    await expect(node.dispose()).rejects.toEqual(
      expect.objectContaining({ errors: [failure], message: "ImageNode cleanup failed" }),
    );

    window.removeEventListener("error", onError);
  });
});

describe("ImageNode 90-degree rotation", () => {
  it("turns the selected images by an angle only, leaving the picture files alone, and undoes", async () => {
    // 20x10 原图，scale=5 -> 显示为 100x50
    const decode = vi.fn(async () => ({ width: 20, height: 10, close: vi.fn() }) as unknown as ImageBitmap);
    vi.stubGlobal("createImageBitmap", decode);
    const stored = new Blob(["image"], { type: "image/png" });

    const project = {
      closing: false,
      projectState: 0,
      emit: vi.fn(),
      attachments: new Map<string, Blob>([["att-orig", stored]]),
      addAttachment: vi.fn(),
      stage: [] as unknown[],
      stageManager: {
        getSelectedEntities: () =>
          project.stage.filter((obj): obj is ImageNode => obj instanceof ImageNode && obj.isSelected),
        getAssociations: () => project.stage.filter((obj): obj is LineEdge => obj instanceof LineEdge),
        updateReferences: () => {
          // 反序列化后修正连线两端指向当前 stage 中的节点实例
          const byId = new Map(
            project.stage.filter((obj): obj is ImageNode => obj instanceof ImageNode).map((node) => [node.uuid, node]),
          );
          for (const edge of project.stage.filter((obj): obj is LineEdge => obj instanceof LineEdge)) {
            edge.associationList = edge.associationList.map((end) => byId.get(end.uuid) ?? end);
          }
        },
      },
      historyManager: null as unknown as HistoryManager,
    };

    const readyA = new Promise<void>((resolve) => {
      const node = new ImageNode(
        project as never,
        {
          uuid: "img-a",
          attachmentId: "att-orig",
          scale: 5,
          collisionBox: new CollisionBox([new Rectangle(new Vector(100, 50), new Vector(100, 50))]),
        },
        false,
        resolve,
      );
      node.isSelected = true;
      project.stage.push(node);
    });
    const readyB = new Promise<void>((resolve) => {
      const shared = new ImageNode(
        project as never,
        {
          uuid: "img-b",
          attachmentId: "att-orig",
          scale: 5,
          collisionBox: new CollisionBox([new Rectangle(new Vector(400, 50), new Vector(100, 50))]),
        },
        false,
        resolve,
      );
      project.stage.push(shared);
    });
    await Promise.all([readyA, readyB]);

    const [nodeA, nodeB] = project.stage as [ImageNode, ImageNode];
    // 连线从 nodeB 连到 nodeA 内部 (0.6, 0.3)
    const edge = new LineEdge(project as never, {
      uuid: "edge-1",
      associationList: [nodeB, nodeA],
      targetRectangleRate: new Vector(0.6, 0.3),
    });
    project.stage.push(edge);
    project.historyManager = new HistoryManager(project as never);

    expect(nodeA.rectangle.size).toEqual(new Vector(100, 50));
    const centerBefore = nodeA.geometryCenter.clone();

    // 向右转 90°：中心不动，宽高从 100x50 变成 50x100，scale 仍为 5；用同一张图的 nodeB 不受影响
    rotateSelectedImageNodes(project as never, "cw");
    expect(nodeA.rotation).toBe(90);
    expect(nodeA.geometryCenter).toEqual(centerBefore);
    expect(nodeA.rectangle.size).toEqual(new Vector(50, 100));
    expect(nodeA.scale).toBe(5);
    expect(nodeB.rotation).toBe(0);
    expect(nodeB.rectangle.size).toEqual(new Vector(100, 50));
    expect(edge.targetRectangleRate).toEqual(new Vector(0.7, 0.6));
    // 图片文件没动：还是那一张，没有多出来的，也没有重新解码
    expect(nodeA.attachmentId).toBe("att-orig");
    expect(project.attachments.get("att-orig")).toBe(stored);
    expect(project.addAttachment).not.toHaveBeenCalled();
    expect(decode).toHaveBeenCalledTimes(2);

    // 转过以后再缩放，宽高比是转好以后的
    nodeA.scaleUpdate(1);
    expect(nodeA.rectangle.size).toEqual(new Vector(60, 120));
    nodeA.resizeHandle(new Vector(-10, 0));
    expect(nodeA.rectangle.size).toEqual(new Vector(50, 100));

    // 存盘再开：图片解码出来以后还是转好的大小和位置
    const reopened = deserialize(structuredClone(serialize(project.stage)), project) as [
      ImageNode,
      ImageNode,
      LineEdge,
    ];
    await vi.waitFor(() => expect(reopened[0].state).toBe("success"));
    expect(reopened[0].rotation).toBe(90);
    expect(reopened[0].rectangle.size).toEqual(new Vector(50, 100));
    expect(reopened[0].geometryCenter).toEqual(centerBefore);
    expect(reopened[2].targetRectangleRate).toEqual(new Vector(0.7, 0.6));

    // 再连转 3 次（共 4 次）：角度、尺寸、位置、连线比例全部回到原样
    for (let turn = 0; turn < 3; turn++) rotateSelectedImageNodes(project as never, "cw");
    expect(nodeA.rotation).toBe(0);
    expect(nodeA.rectangle.size).toEqual(new Vector(100, 50));
    expect(nodeA.rectangle.location).toEqual(new Vector(100, 50));
    expect(edge.targetRectangleRate.x).toBeCloseTo(0.6, 12);
    expect(edge.targetRectangleRate.y).toBeCloseTo(0.3, 12);

    // 撤销全部 4 次旋转
    for (let turn = 0; turn < 4; turn++) project.historyManager.undo();
    const [restoredA, , restoredEdge] = project.stage as [ImageNode, ImageNode, LineEdge];
    expect(restoredA.rotation).toBe(0);
    expect(restoredA.rectangle.location).toEqual(new Vector(100, 50));
    expect(restoredA.rectangle.size).toEqual(new Vector(100, 50));
    expect(restoredEdge.targetRectangleRate).toEqual(new Vector(0.6, 0.3));
  });

  it("opens a file written before the angle existed as not turned", async () => {
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => ({ width: 20, height: 10, close: vi.fn() })),
    );
    const project = { addAttachment: vi.fn(), attachments: new Map([["image", new Blob(["image"])]]) };
    const [{ rotation, ...before }] = serialize([new ImageNode(project as never, { attachmentId: "image" })]);
    expect(rotation).toBe(0);
    const [node] = deserialize([before], project) as [ImageNode];
    await vi.waitFor(() => expect(node.state).toBe("success"));
    expect(node.rotation).toBe(0);
    expect(node.rectangle.size).toEqual(new Vector(20, 10));
  });
});
