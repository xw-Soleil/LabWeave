// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/core/Project", () => ({
  Project: class Project {},
  ProjectState: { Saved: 0, Stashed: 1, Unsaved: 2 },
  service: () => () => undefined,
}));
vi.mock("@/core/render/canvas2d/renderer", () => ({ Renderer: { FONT_SIZE: 24 } }));
vi.mock("@/core/service/feedbackService/SoundService", () => ({ SoundService: { play: {} } }));
vi.mock("@/core/research/LegacyMathCards", async () => ({
  deserializeStageObjects: (await import("@graphif/serializer")).deserialize,
}));
vi.mock("@/utils/font", () => ({
  getTextSize: () => new Vector(20, 20),
  getMultiLineTextSize: () => new Vector(20, 20),
}));
vi.mock("@/core/service/Settings", () => ({
  Settings: {
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
vi.mock("@/core/stage/stageObject/tools/entityDetailsManager", () => ({ DetailsManager: class DetailsManager {} }));

import { buildAiSidecar } from "@/core/research/AiSidecarBuilder";
import { diffItems, sidecarItems } from "@/core/research/ProjectRecord";
import { ControllerEntityResizeClass } from "@/core/service/controlService/controller/concrete/ControllerEntityResize";
import { HistoryManager } from "@/core/stage/stageManager/StageHistoryManager";
import { CollisionBox } from "@/core/stage/stageObject/collisionBox/collisionBox";
import { Color, Vector } from "@graphif/data-structures";
import { deserialize, serialize } from "@graphif/serializer";
import { Rectangle } from "@graphif/shapes";
import { FileCardNode } from "./FileCardNode";

const project = { attachments: new Map<string, Blob>() };

afterEach(() => vi.unstubAllGlobals());

it("releases a thumbnail that finishes decoding after the card was disposed", async () => {
  let finish!: (bitmap: unknown) => void;
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    ),
  );
  const target = { attachments: new Map([["cover", new Blob(["pdf cover"])]]) };
  const card = new FileCardNode(target as never, { attachmentId: "cover" });
  card.ensureThumbnail();
  card.dispose();
  const bitmap = { width: 100, height: 200, close: vi.fn() };
  finish(bitmap);
  await Promise.resolve();
  expect(bitmap.close).toHaveBeenCalledOnce();
  expect(card.bitmap).toBeUndefined();
});

describe("FileCardNode serialization", () => {
  it("round-trips every stored field and leaves runtime state behind", () => {
    const card = new FileCardNode(project as never, {
      uuid: "card-1",
      title: "注意力机制综述",
      details: [{ type: "p", children: [{ text: "第三节要细读" }] }],
      sourcePath: "papers/attention.pdf",
      fileKind: "pdf",
      attachmentId: "thumb-1",
      excerpt: "Abstract\n本文回顾了……",
      pageCount: 12,
      collisionBox: new CollisionBox([new Rectangle(new Vector(10, 20), new Vector(280, 200))]),
      color: new Color(10, 20, 30, 0.5),
    });
    card.missing = true;

    const serialized = serialize([card]);
    expect(serialized[0]._).toBe("FileCardNode");
    expect(serialized[0]).not.toHaveProperty("missing");
    expect(serialized[0]).not.toHaveProperty("bitmap");

    const [restored] = deserialize(structuredClone(serialized), project) as FileCardNode[];
    expect(restored).toBeInstanceOf(FileCardNode);
    expect(restored).toMatchObject({
      uuid: "card-1",
      title: "注意力机制综述",
      details: [{ type: "p", children: [{ text: "第三节要细读" }] }],
      sourcePath: "papers/attention.pdf",
      fileKind: "pdf",
      attachmentId: "thumb-1",
      excerpt: "Abstract\n本文回顾了……",
      pageCount: 12,
      missing: false,
    });
    expect(restored.color).toEqual(new Color(10, 20, 30, 0.5));
    expect(restored.rectangle.location).toEqual(new Vector(10, 20));
    expect(restored.rectangle.size).toEqual(new Vector(280, 200));
  });

  it("fills defaults for fields an older file does not have", () => {
    const collisionBox = serialize(new CollisionBox([new Rectangle(Vector.getZero(), new Vector(280, 200))]));
    const [restored] = deserialize(
      [
        {
          _: "FileCardNode",
          uuid: "card-2",
          title: "笔记",
          sourcePath: "notes/a.md",
          fileKind: "markdown",
          collisionBox,
        },
      ],
      project,
    ) as FileCardNode[];

    expect(restored).toMatchObject({
      attachmentId: "",
      excerpt: "",
      pageCount: 0,
      caption: "",
      pdfPage: 0,
      pdfAnnotation: "",
      details: [],
    });
    expect(restored.color).toEqual(Color.Transparent);
  });

  it("keeps at most 4000 characters of excerpt", () => {
    const card = new FileCardNode(project as never, { excerpt: "字".repeat(5000) });
    expect(card.excerpt).toHaveLength(FileCardNode.maxExcerptLength);
  });

  it("round-trips an image caption", () => {
    const card = new FileCardNode(project as never, { fileKind: "image", caption: "B 模型准确率" });
    const [restored] = deserialize(structuredClone(serialize([card])), project) as FileCardNode[];
    expect(restored.caption).toBe("B 模型准确率");
  });

  it("round-trips where a PDF excerpt came from", () => {
    const card = new FileCardNode(project as never, { pdfPage: 5, pdfAnnotation: "ABCD1234", excerpt: "原文一段" });
    const [restored] = deserialize(structuredClone(serialize([card])), project) as FileCardNode[];
    expect(restored).toMatchObject({ pdfPage: 5, pdfAnnotation: "ABCD1234", excerpt: "原文一段" });
  });
});

describe("image card size", () => {
  it("follows the image's shape with a 300 long side", () => {
    expect(FileCardNode.imageCardSize(1600, 900)).toEqual(new Vector(300, 169));
    expect(FileCardNode.imageCardSize(900, 1600)).toEqual(new Vector(169, 300));
    expect(FileCardNode.imageCardSize(500, 500)).toEqual(new Vector(300, 300));
  });

  it("keeps very thin images at least 60 across", () => {
    expect(FileCardNode.imageCardSize(3000, 100)).toEqual(new Vector(300, 60));
  });

  it("falls back to the normal card size when the image size is unknown", () => {
    expect(FileCardNode.imageCardSize(0, 0)).toEqual(new Vector(FileCardNode.width, FileCardNode.height));
  });

  it("shrinks an old 280×200 card around the image, centred, never growing", () => {
    const box = new Rectangle(new Vector(100, 100), new Vector(280, 200));
    const wide = FileCardNode.fitImageInBox(box, 1600, 900);
    expect(wide.size).toEqual(new Vector(280, 158));
    expect(wide.center).toEqual(box.center);
    const tall = FileCardNode.fitImageInBox(box, 900, 1600);
    expect(tall.size).toEqual(new Vector(113, 200));
    expect(tall.center).toEqual(box.center);
  });
});

describe("PDF boxed-region card resize", () => {
  it("only resizes PDF excerpt cards with an image attachment, preserving aspect ratio and min size", () => {
    const region = new FileCardNode(project as never, {
      fileKind: "pdf",
      pdfPage: 3,
      pdfAnnotation: "BOX1",
      attachmentId: "box-img",
      collisionBox: new CollisionBox([new Rectangle(new Vector(40, 50), new Vector(300, 200))]),
    });
    expect(region.canResize).toBe(true);

    region.resizeHandle(new Vector(150, 80));
    expect(region.rectangle.location).toEqual(new Vector(40, 50));
    expect(region.rectangle.size.x).toBeCloseTo(450);
    expect(region.rectangle.size.y).toBeCloseTo(300);

    // 往左上缩过头时，短边停在 imageMinSide（60），长宽比不变
    region.resizeHandle(new Vector(-1000, -1000));
    expect(region.rectangle.size.x).toBeCloseTo(90);
    expect(region.rectangle.size.y).toBeCloseTo(FileCardNode.imageMinSide);

    const quote = new FileCardNode(project as never, {
      fileKind: "pdf",
      pdfPage: 3,
      pdfAnnotation: "Q1",
      attachmentId: "",
      excerpt: "摘录文字",
      collisionBox: new CollisionBox([new Rectangle(Vector.getZero(), new Vector(320, 120))]),
    });
    const ordinaryPdf = new FileCardNode(project as never, {
      fileKind: "pdf",
      pdfPage: 0,
      attachmentId: "cover",
      collisionBox: new CollisionBox([new Rectangle(Vector.getZero(), new Vector(240, 340))]),
    });
    const ordinaryImage = new FileCardNode(project as never, {
      fileKind: "image",
      pdfPage: 0,
      attachmentId: "img-thumb",
      collisionBox: new CollisionBox([new Rectangle(Vector.getZero(), new Vector(300, 169))]),
    });

    for (const fixed of [quote, ordinaryPdf, ordinaryImage]) {
      const before = fixed.rectangle.size.clone();
      expect(fixed.canResize).toBe(false);
      fixed.resizeHandle(new Vector(100, 100));
      expect(fixed.rectangle.size).toEqual(before);
    }
  });

  it("persists resized dimensions, supports undo via resize controller, and does not change content fingerprint", () => {
    const board = {
      attachments: new Map<string, Blob>(),
      stage: [] as FileCardNode[],
      projectState: 0,
      emit: vi.fn(),
      renderer: { transformView2World: (v: Vector) => v },
      stageManager: {
        getSelectedEntities: () => board.stage.filter((item) => item.isSelected),
        updateReferences: vi.fn(),
      },
      historyManager: null as unknown as HistoryManager,
    };
    const region = new FileCardNode(board as never, {
      uuid: "region-1",
      title: "Fluid Net",
      caption: "Fluid Net · p. 6",
      sourcePath: "papers/fluid.pdf",
      fileKind: "pdf",
      pdfPage: 6,
      pdfAnnotation: "FIG2",
      attachmentId: "fig-2",
      collisionBox: new CollisionBox([new Rectangle(new Vector(100, 100), new Vector(300, 150))]),
    });
    region.isSelected = true;
    board.stage = [region];
    board.historyManager = new HistoryManager(board as never);

    const beforeSidecar = buildAiSidecar({ serializedStage: serialize(board.stage), workspaceFile: "/r/board.prg" });

    const controller = new ControllerEntityResizeClass(board as never);
    const handleCenter = region.getResizeHandleRect().center;
    controller.mousedown({ button: 0, clientX: handleCenter.x, clientY: handleCenter.y } as MouseEvent);
    controller.mousemove({ clientX: handleCenter.x + 100, clientY: handleCenter.y + 40 } as MouseEvent);
    controller.mouseup({ button: 0 } as MouseEvent);

    expect(region.rectangle.size.x).toBeCloseTo(400);
    expect(region.rectangle.size.y).toBeCloseTo(200);
    expect(board.projectState).toBe(2);

    // 存盘再开保持调完后的大小；调大小不算内容改动
    const [reopened] = deserialize(structuredClone(serialize(board.stage)), board) as FileCardNode[];
    expect(reopened.rectangle.size.x).toBeCloseTo(400);
    expect(reopened.rectangle.size.y).toBeCloseTo(200);

    const afterSidecar = buildAiSidecar({ serializedStage: serialize(board.stage), workspaceFile: "/r/board.prg" });
    expect(diffItems(sidecarItems(beforeSidecar.json), sidecarItems(afterSidecar.json))).toEqual({
      added: [],
      edited: [],
      removed: [],
    });

    // 撤销恢复回原来的尺寸
    board.historyManager.undo();
    expect(board.stage[0].rectangle.size).toEqual(new Vector(300, 150));
  });
});
