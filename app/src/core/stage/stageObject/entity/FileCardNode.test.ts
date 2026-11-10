import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/core/Project", () => ({ Project: class Project {} }));
vi.mock("@/core/service/Settings", () => ({ Settings: {} }));
vi.mock("@/core/stage/stageObject/tools/entityDetailsManager", () => ({ DetailsManager: class DetailsManager {} }));

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

    expect(restored).toMatchObject({ attachmentId: "", excerpt: "", pageCount: 0, caption: "", details: [] });
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
