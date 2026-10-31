import { describe, expect, it, vi } from "vitest";

vi.mock("@/core/Project", () => ({ Project: class Project {} }));
vi.mock("@/core/service/Settings", () => ({ Settings: {} }));
vi.mock("@/core/stage/stageObject/tools/entityDetailsManager", () => ({ DetailsManager: class DetailsManager {} }));

import { CollisionBox } from "@/core/stage/stageObject/collisionBox/collisionBox";
import { Color, Vector } from "@graphif/data-structures";
import { deserialize, serialize } from "@graphif/serializer";
import { Rectangle } from "@graphif/shapes";
import { FileCardNode } from "./FileCardNode";

const project = { attachments: new Map<string, Blob>() };

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

    expect(restored).toMatchObject({ attachmentId: "", excerpt: "", pageCount: 0, details: [] });
    expect(restored.color).toEqual(Color.Transparent);
  });

  it("keeps at most 4000 characters of excerpt", () => {
    const card = new FileCardNode(project as never, { excerpt: "字".repeat(5000) });
    expect(card.excerpt).toHaveLength(FileCardNode.maxExcerptLength);
  });
});
