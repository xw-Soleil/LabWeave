import { describe, expect, it } from "vitest";
import { decode, encode } from "@msgpack/msgpack";
import { Uint8ArrayReader, Uint8ArrayWriter, ZipReader, ZipWriter } from "@zip.js/zip.js";
import { createDefaultMetadata } from "@/types/metadata";
import { rewriteProjectFile } from "./ProjectFile";

describe("closed workspace rename", () => {
  it("preserves workspace identity, attachments and unknown entries while updating references", async () => {
    const output = new Uint8ArrayWriter();
    const writer = new ZipWriter(output);
    const metadata = {
      ...createDefaultMetadata(),
      workbench: { id: "stable-chat-id", createdAt: 123, workspacePath: "old.prg" },
    };
    await writer.add("stage.msgpack", new Uint8ArrayReader(encode([{ _: "FileCardNode", sourcePath: "old.pdf" }])));
    await writer.add("metadata.msgpack", new Uint8ArrayReader(encode(metadata)));
    await writer.add("attachments/photo.bin", new Uint8ArrayReader(new Uint8Array([0, 255, 17])));
    await writer.add("future-format.bin", new Uint8ArrayReader(new Uint8Array([18, 19])));
    await writer.close();
    const original = await output.getData();
    const updated = await rewriteProjectFile(
      original,
      (stage) => {
        (stage as { sourcePath: string }[])[0].sourcePath = "renamed.pdf";
      },
      "renamed.prg",
    );
    const reader = new ZipReader(new Uint8ArrayReader(updated.content));
    const files = new Map<string, Uint8Array>();
    for (const entry of await reader.getEntries()) {
      if (!entry.directory) files.set(entry.filename, await entry.getData!(new Uint8ArrayWriter()));
    }
    await reader.close();
    expect(decode(files.get("metadata.msgpack")!)).toEqual({
      ...metadata,
      workbench: { ...metadata.workbench, workspacePath: "renamed.prg" },
    });
    expect(decode(files.get("stage.msgpack")!)).toEqual([{ _: "FileCardNode", sourcePath: "renamed.pdf" }]);
    expect(files.get("attachments/photo.bin")).toEqual(new Uint8Array([0, 255, 17]));
    expect(files.get("future-format.bin")).toEqual(new Uint8Array([18, 19]));
    const unchanged = await rewriteProjectFile(original, () => {});
    expect(unchanged.changed).toBe(false);
    expect(unchanged.content).toBe(original);
  });
});
