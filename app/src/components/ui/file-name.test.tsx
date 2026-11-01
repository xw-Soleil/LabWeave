import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { displayWorkspaceName, FileName, fileNameParts, splitFileName } from "./file-name";

describe("splitFileName", () => {
  it.each([
    ["main.pdf", "main", ".pdf"],
    ["README", "README", ""],
    [".gitignore", ".gitignore", ""],
    [".env.local", ".env", ".local"],
    ["a.tar.gz", "a.tar", ".gz"],
    ["垃圾分类模型对比.prg", "垃圾分类模型对比", ".prg"],
    ["垃圾分类模型对比", "垃圾分类模型对比", ""],
    ["论文.中文", "论文", ".中文"],
    ["trailing.", "trailing.", ""],
    ["v1.2 最终版", "v1.2 最终版", ""],
    ["notes.averyveryverylongsuffix", "notes.averyveryverylongsuffix", ""],
  ])("%s → %s + %s", (name, stem, ext) => {
    expect(splitFileName(name)).toEqual({ stem, ext });
  });
});

describe("fileNameParts", () => {
  it("keeps the extension outside the truncatable part", () => {
    expect(fileNameParts("very-long-paper-name.pdf")).toEqual({ head: "very-long-paper-name", tail: ".pdf" });
  });

  it("keeps extra tail characters to tell similar names apart", () => {
    expect(fileNameParts("model_v7_final2.prg", { tailChars: 2 })).toEqual({
      head: "model_v7_fina",
      tail: "l2.prg",
    });
  });

  it("counts tail characters by code point, not UTF-16 unit", () => {
    expect(fileNameParts("对比😀图.png", { tailChars: 2 })).toEqual({ head: "对比", tail: "😀图.png" });
  });

  it("does not keep extra tail when the stem is too short to leave anything truncatable", () => {
    expect(fileNameParts("ab.pdf", { tailChars: 2 })).toEqual({ head: "ab", tail: ".pdf" });
  });

  it("truncates the whole name when keepExtension is false", () => {
    expect(fileNameParts("a.tar.gz", { keepExtension: false })).toEqual({ head: "a.tar.gz", tail: "" });
  });
});

describe("FileName", () => {
  it("renders stem and extension in separate spans with a full-name tooltip", () => {
    const html = renderToStaticMarkup(<FileName name="main.pdf" />);
    expect(html).toBe(
      '<span class="flex min-w-0" title="main.pdf"><span class="min-w-0 truncate">main</span><span class="shrink-0 whitespace-pre">.pdf</span></span>',
    );
  });

  it("uses the given title (e.g. full path) and omits the tail span without extension", () => {
    const html = renderToStaticMarkup(<FileName name="README" title="/a/b/README" className="text-[13px]" />);
    expect(html).toBe(
      '<span class="flex min-w-0 text-[13px]" title="/a/b/README"><span class="min-w-0 truncate">README</span></span>',
    );
  });
});

describe("displayWorkspaceName", () => {
  it.each([
    ["文献综述.prg", "文献综述"],
    ["Review.PRG", "Review"],
    ["a.prg.prg", "a.prg"],
    ["main.pdf", "main.pdf"],
    ["无后缀", "无后缀"],
  ])("%s → %s", (input, output) => {
    expect(displayWorkspaceName(input)).toBe(output);
  });
});
