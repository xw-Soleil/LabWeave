import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { editorText, MarkdownDocument, type MarkdownFileIO } from "./DocumentFile";

const samples = process.env.LABWEAVE_SAMPLE_NOTES;
const temporary = process.env.LABWEAVE_TEST_TMP;

describe.skipIf(!samples || !temporary)("real research note fidelity (copies only)", () => {
  it("preserves every sample byte on no-op save and changes only one character on edited save", async () => {
    const dir = await mkdtemp(path.join(temporary!, "markdown-fidelity-"));
    try {
      const names = (await readdir(samples!)).filter((name) => name.endsWith(".md"));
      expect(names.length).toBeGreaterThan(0);
      const io: MarkdownFileIO = {
        read: async (file) => ({ text: await readFile(file, "utf8"), mtime: (await stat(file)).mtimeMs }),
        write: (file, text) => writeFile(file, text, "utf8"),
      };
      for (const name of names) {
        const bytes = await readFile(path.join(samples!, name));
        const copy = path.join(dir, name);
        await writeFile(copy, bytes);
        const baseline = await io.read(copy);
        const document = new MarkdownDocument(copy, baseline, io);
        await document.save();
        expect(await readFile(copy), name).toEqual(bytes);
        expect((await stat(copy)).mtimeMs, name).toBe(baseline.mtime);
        const replacement = baseline.text.replace(/[\u4e00-\u9fff]/, "测");
        document.edit(editorText(replacement));
        await document.save();
        expect(await readFile(copy, "utf8"), name).toBe(replacement);
        expect(document.dirty, name).toBe(false);
        console.info(
          `Fidelity ${name}: ${bytes.length} bytes; unchanged save = 0 byte / 0 mtime differences; edited save = first Chinese character → 测 only`,
        );
      }
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});
