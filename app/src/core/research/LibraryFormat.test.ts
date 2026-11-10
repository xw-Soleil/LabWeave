import { describe, expect, it } from "vitest";
import {
  createLibraryNote,
  libraryExtra,
  libraryMetadata,
  makeLibraryKey,
  parseLibraryYaml,
  splitLibraryNote,
  updateLibraryNote,
} from "./LibraryFormat";

const encode = (text: string) => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array) => new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
const template = "\n# 研究笔记\n\n## 研究问题\n\n\n## 方法\n\n\n## 结论与启发\n\n";

describe("plugin-compatible literature frontmatter", () => {
  const unknown =
    "custom: &custom { quoted: 'keep me', count: 007 } # exact comment\r\n" +
    "alias: *custom\r\n" +
    "multiline: |-\r\n  literal: text\r\n  --- not a delimiter\r\n" +
    'customList: [one, "two"]\r\n';
  const header =
    "\uFEFF---\r\ntype: 文献\r\nitemType: 会议论文\r\ntitle: 'Original title'\r\n" +
    "authors:\r\n  - Jiahe Huang\r\n  - 'A; B'\r\nyear: 2024\r\nvenue: NeurIPS\r\n" +
    "status: 阅读中\r\ncollections:\r\n  - AI\r\n  - AI/PDE\r\ntags: [one, two]\r\n" +
    unknown +
    "---\r\n";
  const body = "\r\n# 原笔记\n\n> [!note]- 标题  \r\n> [[文献#节|链接]]\r\n\n```yaml\n---\n```\n\0";
  const original = encode(header + body);

  it("changes just one field, retaining every other byte, BOM, mixed newlines and unknown YAML", () => {
    const updated = updateLibraryNote(original, { title: "Edited title" });
    expect(decode(updated)).toBe((header + body).replace("title: 'Original title'\r\n", 'title: "Edited title"\r\n'));
    expect(splitLibraryNote(updated).body).toEqual(encode(body));
    const values = parseLibraryYaml(splitLibraryNote(updated).yaml).values;
    expect(libraryExtra(values)).toEqual({
      custom: { quoted: "keep me", count: 7 },
      alias: { quoted: "keep me", count: 7 },
      multiline: "literal: text\n--- not a delimiter",
      customList: ["one", "two"],
    });
    expect(splitLibraryNote(updated).yaml).toContain(unknown);
  });

  it("never decodes or changes non-UTF-8 bytes in the body", () => {
    const start = encode(header);
    const binaryBody = Uint8Array.of(0xff, 0xfe, 0, 13, 10, 0x80);
    const bytes = new Uint8Array(start.length + binaryBody.length);
    bytes.set(start);
    bytes.set(binaryBody, start.length);
    expect(splitLibraryNote(updateLibraryNote(bytes, { status: "read" })).body).toEqual(binaryBody);
  });

  it("does no rewriting when a plugin-style item is saved without changes", () => {
    const meta = libraryMetadata(parseLibraryYaml(splitLibraryNote(original).yaml).values, "Huang2024DiffusionPDE");
    expect(updateLibraryNote(original, meta)).toEqual(original);
    expect(updateLibraryNote(original, {})).toEqual(original);
  });

  it.each(["unread", "toRead", "reading", "read"] as const)("roundtrips the Chinese status for %s", (status) => {
    const bytes = updateLibraryNote(original, { status });
    const values = parseLibraryYaml(splitLibraryNote(bytes).yaml).values;
    expect(libraryMetadata(values, "key").status).toBe(status);
    expect(["未读", "待读", "阅读中", "已读"]).toContain(values.status);
  });

  it("trashes with deleted: true and restores by removing the field", () => {
    const trashed = updateLibraryNote(original, { trashed: true });
    expect(decode(trashed)).toContain("deleted: true\r\n---");
    expect(libraryMetadata(parseLibraryYaml(splitLibraryNote(trashed).yaml).values, "key").trashed).toBe(true);
    expect(updateLibraryNote(trashed, { trashed: false })).toEqual(original);
    const blank = encode("---\ntype: 文献\ndeleted:\n---\nbody");
    expect(decode(updateLibraryNote(blank, { trashed: false }))).not.toContain("deleted:");
  });

  it("preserves unfamiliar fields between edits, including comments and block scalars", () => {
    const raw =
      "---\ntype: 文献\ntitle: old # title comment\n# custom comment\nx: >-\n  text\n\nstatus: 未读\n# end\n---\nbody";
    const updated = decode(updateLibraryNote(encode(raw), { title: "new", status: "read" }));
    expect(updated).toContain("# custom comment\nx: >-\n  text\n\n");
    expect(updated).toContain("# end\n---\nbody");
  });

  it("inserts missing fields in plugin order and uses quoted block lists", () => {
    const raw = encode("---\ntype: 文献\ntitle: old\nabstract:\n---\n");
    const result = decode(
      updateLibraryNote(raw, { added: "2026-11-10", tags: [], year: "2024", authors: ["A: B", 'C "D"'], venue: "V" }),
    );
    expect(result).toBe(
      '---\ntype: 文献\ntitle: old\nauthors:\n  - "A: B"\n  - "C \\"D\\""\nyear: 2024\nvenue: "V"\ntags: []\nadded: "2026-11-10"\nabstract:\n---\n'.replace(
        /\\\\"/g,
        '\\"',
      ),
    );
  });

  it("keeps unknown fields and their comments after an edited block list", () => {
    const raw =
      "---\ntype: 文献\nauthors:\n  - old # old author\n\n# custom comment\ncustom: 'keep: exactly' # keep too\n---\nbody";
    const updated = decode(updateLibraryNote(encode(raw), { authors: ["new"] }));
    expect(updated).toBe(raw.replace("authors:\n  - old # old author\n", 'authors:\n  - "new"\n'));
  });

  it.each([
    "type: 文献\ntitle: [broken",
    "type: 文献\ntitle: one\ntitle: two",
    "type: other\ntitle: one",
    "type: 文献\nx: *unknown",
    "- 文献",
  ])("rejects damaged or unsafe YAML without producing replacement bytes: %s", (yaml) => {
    expect(() => updateLibraryNote(encode(`---\n${yaml}\n---\nbody`), { title: "new" })).toThrow(
      "library.invalidFrontmatter",
    );
  });

  it("rejects changing an anchor used by an unknown field instead of breaking it", () => {
    const bytes = encode("---\ntype: 文献\ntitle: &title old\nx: *title\n---\nbody");
    expect(() => updateLibraryNote(bytes, { title: "new" })).toThrow("library.invalidFrontmatter");
  });

  it("rejects oversized new metadata before it could publish a note the loader cannot edit", () => {
    const abstract = "字".repeat(400000);
    expect(() => updateLibraryNote(original, { abstract })).toThrow("library.invalidFrontmatter");
    expect(() => createLibraryNote({ title: "Large", abstract }, "", template)).toThrow("library.invalidFrontmatter");
  });

  it("reads the plugin's string-list fallbacks and deleted string", () => {
    expect(
      libraryMetadata(
        {
          title: " T ",
          authors: "A; B；C",
          tags: "#one, two 三",
          collections: "AI/PDE",
          status: "unknown",
          deleted: "true",
          year: 2024,
        },
        "Key",
      ),
    ).toMatchObject({
      title: "T",
      authors: ["A", "B", "C"],
      tags: ["one", "two", "三"],
      collections: ["AI/PDE"],
      status: "unread",
      trashed: true,
      year: "2024",
    });
  });

  it("creates the exact plugin field order, quotes, empty lists, PDF name and note template", () => {
    const bytes = createLibraryNote(
      { title: "A title", authors: ["A B"], year: "2024", added: "2026-11-10" },
      "B2024Title.pdf",
      template,
    );
    expect(decode(bytes)).toBe(
      '---\ntype: "文献"\nitemType: "其他"\ntitle: "A title"\nauthors:\n  - "A B"\nyear: 2024\nvenue:\nvolume:\nissue:\npages:\ndoi:\narxiv:\nurl:\nstatus: "未读"\ncollections: []\ntags: []\nadded: "2026-11-10"\npdf: "B2024Title.pdf"\nabstract:\n---\n' +
        template,
    );
    const fields = libraryMetadata(parseLibraryYaml(splitLibraryNote(bytes).yaml).values, "B2024Title");
    expect(updateLibraryNote(bytes, fields)).toEqual(bytes);
  });

  it.each([
    [
      { title: "DiffusionPDE: Generative PDE-Solving", authors: ["Jiahe Huang"], year: "2024" },
      "Huang2024DiffusionPDE",
    ],
    [{ title: "The physics of motion", authors: ["Jonas Bastek"], year: "2024" }, "Bastek2024Physics"],
    [{ title: "Towards a study", authors: [], year: "" }, "AnonStudy"],
    [{ title: "一二三四五六七八九十", authors: ["王"] }, "王一二三四五六七八"],
  ])("creates plugin citation key %s", (fields, key) => {
    expect(makeLibraryKey(fields)).toBe(key);
  });
});
