import { describe, expect, it } from "vitest";
import { noteStats, parseNoteProperties, setNoteProperty, splitFrontmatter } from "./NoteProperties";

const note = [
  "---",
  "type: 文献",
  'title: "Physics-Informed Diffusion Models"',
  "authors:",
  "  - Jan-Hendrik Bastek",
  "  - WaiChing Sun",
  "year: 2024",
  "# 自己写的注释",
  "status: 待读",
  "tags: []",
  "added: 2026-10-20",
  "url: https://arxiv.org/abs/2403.14404",
  "deleted: false",
  "---",
  "",
  "# 研究笔记",
  "",
].join("\n");

describe("note properties", () => {
  it("counts words and characters like Obsidian, without the frontmatter", () => {
    // 汉字一个字一个词；字母和数字连着的一串算一个；标点、空白不算词，但算字符
    expect(noteStats("---\na: 1\n---\n模型 EDM-2 用了 5,400 万参数。")).toEqual({ words: 9, characters: 22 });
    expect(noteStats("")).toEqual({ words: 0, characters: 0 });
  });

  it("splits the frontmatter off and keeps BOM, CRLF and an empty block intact", () => {
    const parts = splitFrontmatter(note)!;
    expect(parts.opening + parts.yaml + parts.closing + parts.body).toBe(note);
    expect(parts.body.startsWith("\n# 研究笔记")).toBe(true);
    const crlf = "﻿---\r\na: 1\r\n---\r\nbody";
    const split = splitFrontmatter(crlf)!;
    expect(split.yaml).toBe("a: 1\r\n");
    expect(split.opening + split.yaml + split.closing + split.body).toBe(crlf);
    expect(splitFrontmatter("---\n---\ntext")).toMatchObject({ yaml: "", body: "text" });
    expect(splitFrontmatter("# no properties\n---\n")).toBeNull();
  });

  it("infers the kind of each value like Obsidian", () => {
    const kinds = Object.fromEntries(
      parseNoteProperties(splitFrontmatter(note)!.yaml)!.map((property) => [property.key, property.kind]),
    );
    expect(kinds).toEqual({
      type: "text",
      title: "text",
      authors: "list",
      year: "number",
      status: "text",
      tags: "tags",
      added: "date",
      url: "link",
      deleted: "checkbox",
    });
    expect(parseNoteProperties("a: [unclosed")).toBeNull();
  });

  it("rewrites only the changed entry and keeps every other line as written", () => {
    const yaml = splitFrontmatter(note)!.yaml;
    const changed = setNoteProperty(yaml, "status", "已读");
    expect(changed).toBe(yaml.replace("status: 待读", "status: 已读"));
    const authors = setNoteProperty(yaml, "authors", ["Jan-Hendrik Bastek"]);
    expect(authors).toBe(yaml.replace("  - WaiChing Sun\n", ""));
    expect(setNoteProperty(yaml, "tags", ["pde", "diffusion"])).toContain("tags:\n  - pde\n  - diffusion\nadded:");
    expect(setNoteProperty(yaml, "year", undefined)).toBe(yaml.replace("year: 2024\n", ""));
    expect(setNoteProperty(yaml, "venue", null)).toBe(`${yaml}venue:\n`);
    expect(setNoteProperty("a: 1\r\nb: 2\r\n", "a", "x: y")).toBe('a: "x: y"\r\nb: 2\r\n');
    expect(setNoteProperty("", "title", "新笔记")).toBe("title: 新笔记\n");
  });
});
