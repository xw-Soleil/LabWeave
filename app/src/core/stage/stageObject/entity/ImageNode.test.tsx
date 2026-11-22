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
import {
  ImageNode,
  JPEG_ROTATE_QUALITY,
  rotateRate90,
  rotateRgba90,
  rotatedMimeType,
  rotateSelectedImageNodes,
} from "./ImageNode";

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
  it("rotates RGBA pixels and normalized edge rates losslessly, returning to identical bytes after 4 turns", () => {
    // 3x2 非对称像素图，每个像素带不同 RGBA 值
    const original = new Uint8ClampedArray([
      10, 20, 30, 255, 40, 50, 60, 255, 70, 80, 90, 255, 110, 120, 130, 200, 140, 150, 160, 180, 170, 180, 190, 160,
    ]);
    const cw1 = rotateRgba90(original, 3, 2, "cw");
    expect([cw1.width, cw1.height]).toEqual([2, 3]);
    // 左上角 (0,0)=[10,20,30,255] 顺时针转 90° 后落到右上角 (1,0)
    expect(Array.from(cw1.data.slice(4, 8))).toEqual([10, 20, 30, 255]);
    // 再逆时针转回，逐字节一致
    const back = rotateRgba90(cw1.data, cw1.width, cw1.height, "ccw");
    expect([back.width, back.height]).toEqual([3, 2]);
    expect(Array.from(back.data)).toEqual(Array.from(original));

    // 连续向右转 4 次，逐字节完全还原
    let step = { data: original, width: 3, height: 2 };
    for (let i = 0; i < 4; i++) {
      step = rotateRgba90(step.data, step.width, step.height, "cw");
    }
    expect([step.width, step.height]).toEqual([3, 2]);
    expect(Array.from(step.data)).toEqual(Array.from(original));

    // 连线端点比例：中心不动，框内点和边缘哨兵值随图片一起转
    expect(rotateRate90(new Vector(0.5, 0.5), "cw")).toEqual(new Vector(0.5, 0.5));
    expect(rotateRate90(new Vector(0.6, 0.3), "cw")).toEqual(new Vector(0.7, 0.6));
    expect(rotateRate90(new Vector(0.7, 0.6), "ccw")).toEqual(new Vector(0.6, 0.3));
    expect(rotateRate90(new Vector(0.5, 0.01), "cw")).toEqual(new Vector(0.99, 0.5));

    expect(rotatedMimeType("image/png")).toEqual({ type: "image/png" });
    expect(rotatedMimeType("image/jpeg")).toEqual({ type: "image/jpeg", quality: JPEG_ROTATE_QUALITY });
  });

  it("rotates selected images as new attachments, keeps center/scale/other cards, rotates edge endpoints, persists, and undoes", async () => {
    interface FakePayload {
      width: number;
      height: number;
      pixels: number[];
    }
    const encodeFakePng = (width: number, height: number, data: Uint8ClampedArray): Blob =>
      new Blob([JSON.stringify({ width, height, pixels: Array.from(data) } satisfies FakePayload)], {
        type: "image/png",
      });
    const decodeFakePng = async (blob: Blob): Promise<FakePayload> => JSON.parse(await blob.text()) as FakePayload;

    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async (blob: Blob) => {
        const parsed = await decodeFakePng(blob);
        return {
          width: parsed.width,
          height: parsed.height,
          pixels: new Uint8ClampedArray(parsed.pixels),
          close: vi.fn(),
        } as unknown as ImageBitmap;
      }),
    );

    const origCreateElement = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation(((tagName: string) => {
      if (tagName !== "canvas") return origCreateElement(tagName);
      const canvas = {
        width: 0,
        height: 0,
        buffer: new Uint8ClampedArray(0),
        getContext: () => ({
          drawImage: (source: { width: number; height: number; pixels: Uint8ClampedArray }) => {
            canvas.buffer = new Uint8ClampedArray(source.pixels);
          },
          getImageData: (_x: number, _y: number, w: number, h: number) => ({
            width: w,
            height: h,
            data: new Uint8ClampedArray(canvas.buffer),
          }),
          createImageData: (w: number, h: number) => ({
            width: w,
            height: h,
            data: new Uint8ClampedArray(w * h * 4),
          }),
          putImageData: (img: { data: Uint8ClampedArray }) => {
            canvas.buffer = new Uint8ClampedArray(img.data);
          },
        }),
        toBlob: (cb: (blob: Blob | null) => void, type = "image/png") => {
          cb(
            new Blob(
              [JSON.stringify({ width: canvas.width, height: canvas.height, pixels: Array.from(canvas.buffer) })],
              { type },
            ),
          );
        },
      };
      return canvas as unknown as HTMLCanvasElement;
    }) as typeof document.createElement);

    // 20x10 原图，scale=5 -> 显示为 100x50
    const initialPixels = new Uint8ClampedArray(20 * 10 * 4);
    for (let i = 0; i < initialPixels.length; i++) initialPixels[i] = (i * 17 + 5) & 0xff;
    const initialBlob = encodeFakePng(20, 10, initialPixels);
    const initialBytes = await initialBlob.text();

    let seq = 0;
    const project = {
      closing: false,
      projectState: 0,
      emit: vi.fn(),
      attachments: new Map<string, Blob>([["att-orig", initialBlob]]),
      addAttachment: vi.fn((blob: Blob) => {
        const id = `att-rot-${++seq}`;
        project.attachments.set(id, blob);
        return id;
      }),
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

    // 向右转 90°：中心不动，宽高从 100x50 变成 50x100，scale 仍为 5；共用原附件的 nodeB 不受影响
    await rotateSelectedImageNodes(project as never, "cw");
    expect(nodeA.geometryCenter).toEqual(centerBefore);
    expect(nodeA.rectangle.size).toEqual(new Vector(50, 100));
    expect(nodeA.scale).toBe(5);
    expect(nodeA.attachmentId).toBe("att-rot-1");
    expect(nodeB.attachmentId).toBe("att-orig");
    expect(nodeB.rectangle.size).toEqual(new Vector(100, 50));
    expect(edge.targetRectangleRate).toEqual(new Vector(0.7, 0.6));

    // 存盘再开保持转完后的附件、大小、中心与连线端点比例
    const reopened = deserialize(structuredClone(serialize(project.stage)), project) as [
      ImageNode,
      ImageNode,
      LineEdge,
    ];
    expect(reopened[0].attachmentId).toBe("att-rot-1");
    expect(reopened[0].rectangle.size).toEqual(new Vector(50, 100));
    expect(reopened[0].geometryCenter).toEqual(centerBefore);
    expect(reopened[2].targetRectangleRate).toEqual(new Vector(0.7, 0.6));

    // 再连转 3 次（共 4 次）：尺寸、位置、连线比例与 PNG 内容全部回到原样
    await rotateSelectedImageNodes(project as never, "cw");
    await rotateSelectedImageNodes(project as never, "cw");
    await rotateSelectedImageNodes(project as never, "cw");
    expect(nodeA.geometryCenter).toEqual(centerBefore);
    expect(nodeA.rectangle.size).toEqual(new Vector(100, 50));
    expect(nodeA.rectangle.location).toEqual(new Vector(100, 50));
    expect(edge.targetRectangleRate.x).toBeCloseTo(0.6, 12);
    expect(edge.targetRectangleRate.y).toBeCloseTo(0.3, 12);
    expect(await project.attachments.get(nodeA.attachmentId)!.text()).toBe(initialBytes);

    // 撤销全部 4 次旋转，回到最开始的附件和连线端点比例
    project.historyManager.undo();
    project.historyManager.undo();
    project.historyManager.undo();
    project.historyManager.undo();
    const [restoredA, , restoredEdge] = project.stage as [ImageNode, ImageNode, LineEdge];
    expect(restoredA.attachmentId).toBe("att-orig");
    expect(restoredA.rectangle.location).toEqual(new Vector(100, 50));
    expect(restoredA.rectangle.size).toEqual(new Vector(100, 50));
    expect(restoredEdge.targetRectangleRate).toEqual(new Vector(0.6, 0.3));
  });
});
