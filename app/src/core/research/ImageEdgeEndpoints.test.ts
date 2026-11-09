import { Vector } from "@graphif/data-structures";
import { Rectangle } from "@graphif/shapes";
import { beforeEach, describe, expect, it, vi } from "vitest";

const settings = vi.hoisted(() => ({
  viewerMode: false,
  enableAutoEdgeWidth: false,
  watch: (_key: string, callback: (value: string) => void) => callback("straight"),
}));
vi.mock("@/core/Project", () => ({ Project: class {} }));
vi.mock("@/core/render/canvas2d/renderer", () => ({ Renderer: { FONT_SIZE: 24 } }));
vi.mock("@/core/service/Settings", () => ({ Settings: settings }));
vi.mock("@/utils/font", () => ({ getMultiLineTextSize: () => new Vector(20, 20) }));
vi.mock("@/core/stage/stageObject/abstract/ConnectableEntity", () => ({ ConnectableEntity: class {} }));
vi.mock("@/core/stage/stageObject/entity/ConnectPoint", () => ({ ConnectPoint: class {} }));
vi.mock("@/core/stage/stageObject/entity/TextNode", () => ({ TextNode: class {} }));
vi.mock("@/core/stage/stageObject/entity/Section", () => ({ Section: class {} }));
vi.mock("@/core/stage/stageObject/entity/ImageNode", () => ({ ImageNode: class {} }));
vi.mock("@/core/stage/stageObject/entity/FileCardNode", () => ({ FileCardNode: class {} }));

import type { Project } from "@/core/Project";
import { LineEdge } from "@/core/stage/stageObject/association/LineEdge";
import { CollisionBox } from "@/core/stage/stageObject/collisionBox/collisionBox";
import { FileCardNode } from "@/core/stage/stageObject/entity/FileCardNode";
import { ImageNode } from "@/core/stage/stageObject/entity/ImageNode";
import { TextNode } from "@/core/stage/stageObject/entity/TextNode";
import {
  canAimInside,
  dragEndpointTo,
  findEndpointHandle,
  hasEndpointHandle,
  pointsInside,
  rateForDrag,
} from "./ImageEdgeEndpoints";

function entity<T extends object>(prototype: T, x: number, fields: Record<string, unknown> = {}) {
  return Object.assign(Object.create(prototype), {
    uuid: crypto.randomUUID(),
    collisionBox: new CollisionBox([new Rectangle(new Vector(x, 0), new Vector(200, 100))]),
    isHiddenBySectionCollapse: false,
    clipConnectionToBoundary: false,
    ...fields,
  });
}

/** 文字卡片在 (0,0)–(200,100)，图片在 (400,0)–(600,100)，连线从文字指向图片 */
function setup() {
  const text = entity(TextNode.prototype, 0, { clipConnectionToBoundary: true, getBorderWidth: () => 2 });
  const image = entity(ImageNode.prototype, 400, { isBackground: false });
  const edge = new LineEdge({} as never, { associationList: [text, image] });
  edge.isSelected = true;
  const project = {
    camera: { currentScale: 1 },
    stageManager: { getSelectedAssociations: () => (edge.isSelected ? [edge] : []) },
  } as unknown as Project;
  return { text, image, edge, project };
}

beforeEach(() => {
  settings.viewerMode = false;
});

describe("rateForDrag", () => {
  const rect = new Rectangle(new Vector(0, 0), new Vector(200, 100));
  const defaultLocation = new Vector(200, 50);

  it("goes back to the default when dropped near the default spot", () => {
    expect(rateForDrag(rect, defaultLocation, new Vector(192, 55), 1)).toEqual(Vector.same(0.5));
  });

  it("points at the spot inside the image", () => {
    expect(rateForDrag(rect, defaultLocation, new Vector(60, 40), 1)).toEqual(new Vector(0.3, 0.4));
  });

  it("sticks to a border it is dropped close to", () => {
    expect(rateForDrag(rect, defaultLocation, new Vector(60, 5), 1)).toEqual(new Vector(0.3, 0));
  });

  it("keeps the end on the image when dragged outside it", () => {
    expect(rateForDrag(rect, defaultLocation, new Vector(-50, 40), 1)).toEqual(new Vector(0, 0.4));
  });

  it("measures snapping in screen pixels", () => {
    expect(rateForDrag(rect, defaultLocation, new Vector(60, 6), 2)).toEqual(new Vector(0.3, 0.06));
  });

  it("does not mistake the exact centre for the default", () => {
    expect(rateForDrag(rect, defaultLocation, new Vector(100, 50), 1)).not.toEqual(Vector.same(0.5));
  });
});

describe("which ends can be dragged", () => {
  it("allows pasted images and image cards, not background images, PDFs or text", () => {
    expect(canAimInside(entity(ImageNode.prototype, 0, { isBackground: false }))).toBe(true);
    expect(canAimInside(entity(ImageNode.prototype, 0, { isBackground: true }))).toBe(false);
    expect(canAimInside(entity(FileCardNode.prototype, 0, { fileKind: "image" }))).toBe(true);
    expect(canAimInside(entity(FileCardNode.prototype, 0, { fileKind: "pdf" }))).toBe(false);
    expect(canAimInside(entity(TextNode.prototype, 0))).toBe(false);
  });

  it("gives only the image end a handle, and none in viewer mode", () => {
    const { edge } = setup();
    expect(hasEndpointHandle(edge, "source")).toBe(false);
    expect(hasEndpointHandle(edge, "target")).toBe(true);
    settings.viewerMode = true;
    expect(hasEndpointHandle(edge, "target")).toBe(false);
  });
});

describe("dragging an end on an image", () => {
  it("starts on the image border by default", () => {
    const { edge } = setup();
    expect(edge.bodyLine.end).toEqual(new Vector(400, 50));
    expect(pointsInside(edge, "target")).toBe(false);
  });

  it("finds the handle of a selected line only", () => {
    const { edge, project } = setup();
    expect(findEndpointHandle(project, new Vector(404, 53))).toEqual({ edge, end: "target" });
    expect(findEndpointHandle(project, new Vector(200, 50))).toBeNull();
    edge.isSelected = false;
    expect(findEndpointHandle(project, new Vector(404, 53))).toBeNull();
  });

  it("moves the arrow to the spot inside the image, then back to the border", () => {
    const { edge, project } = setup();
    const handle = { edge, end: "target" as const };
    dragEndpointTo(project, handle, new Vector(520, 30));
    expect(edge.targetRectangleRate).toEqual(new Vector(0.6, 0.3));
    expect(edge.bodyLine.end).toEqual(new Vector(520, 30));
    expect(pointsInside(edge, "target")).toBe(true);

    dragEndpointTo(project, handle, new Vector(405, 48));
    expect(edge.targetRectangleRate).toEqual(Vector.same(0.5));
    expect(edge.bodyLine.end).toEqual(new Vector(400, 50));
  });
});
