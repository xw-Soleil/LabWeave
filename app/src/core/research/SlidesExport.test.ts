import { Uint8ArrayReader, Uint8ArrayWriter, ZipReader } from "@zip.js/zip.js";
import { describe, expect, it } from "vitest";
import { buildPptx } from "./SlidesExport";

async function unpack(content: Uint8Array): Promise<Map<string, Uint8Array>> {
  const reader = new ZipReader(new Uint8ArrayReader(content));
  const files = new Map<string, Uint8Array>();
  for (const entry of await reader.getEntries()) {
    if (!entry.directory) files.set(entry.filename, await entry.getData!(new Uint8ArrayWriter()));
  }
  await reader.close();
  return files;
}
const text = (bytes: Uint8Array | undefined) => new TextDecoder().decode(bytes);

/** 第一个没配上对的标签；都配上了给 undefined */
function unbalancedTag(xml: string): string | undefined {
  const open: string[] = [];
  for (const [, closing, name, selfClosing] of xml.matchAll(/<(\/?)([\w:]+)(?:\s[^<>]*?)?(\/?)>/g)) {
    if (selfClosing) continue;
    if (!closing) open.push(name);
    else if (open.pop() !== name) return name;
  }
  return open.at(-1);
}

/** 一张 4×2 的 PNG：只有文件头和尺寸那一段是真的，够认出大小 */
const png = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 4, 0, 0, 0, 2, 8, 6, 0,
  0, 0,
]);

describe("buildPptx", () => {
  it("每页一个文件，清单、关系、页数都对得上", async () => {
    const files = await unpack(
      await buildPptx([
        { title: "2026-11-28 阶段小结", bullets: ["范围：11-21 ~ 11-28", "项目：Research"] },
        { title: "做了什么", bullets: ["读了 main.pdf", "摘了 3 段"], image: png },
        { title: "下一步", bullets: [] },
      ]),
    );
    expect([...files.keys()]).toEqual([
      "[Content_Types].xml",
      "_rels/.rels",
      "ppt/presentation.xml",
      "ppt/_rels/presentation.xml.rels",
      "ppt/slideMasters/slideMaster1.xml",
      "ppt/slideMasters/_rels/slideMaster1.xml.rels",
      "ppt/slideLayouts/slideLayout1.xml",
      "ppt/slideLayouts/_rels/slideLayout1.xml.rels",
      "ppt/theme/theme1.xml",
      "ppt/slides/slide1.xml",
      "ppt/slides/_rels/slide1.xml.rels",
      "ppt/media/image1.png",
      "ppt/slides/slide2.xml",
      "ppt/slides/_rels/slide2.xml.rels",
      "ppt/slides/slide3.xml",
      "ppt/slides/_rels/slide3.xml.rels",
    ]);
    // 每份 XML 的标签都一开一合对得上
    for (const [name, bytes] of files) {
      if (/\.(xml|rels)$/.test(name)) expect(unbalancedTag(text(bytes)), name).toBeUndefined();
    }
    const types = text(files.get("[Content_Types].xml"));
    for (const number of [1, 2, 3]) expect(types).toContain(`PartName="/ppt/slides/slide${number}.xml"`);
    expect(text(files.get("ppt/presentation.xml")).match(/<p:sldId /g)).toHaveLength(3);
    expect(text(files.get("ppt/_rels/presentation.xml.rels")).match(/slides\/slide\d\.xml/g)).toHaveLength(3);
    expect(text(files.get("ppt/slides/slide1.xml"))).toContain("<a:t>2026-11-28 阶段小结</a:t>");
    expect(text(files.get("ppt/slides/slide1.xml"))).not.toContain("<p:pic>");
    // 有配图的那一页：图片照原比例（2:1）放在右边，关系里指到图片文件
    const second = text(files.get("ppt/slides/slide2.xml"));
    const [, cx, cy] = /<p:pic>.*?<a:ext cx="(\d+)" cy="(\d+)"\/>/.exec(second)!;
    expect(Number(cx) / Number(cy)).toBeCloseTo(2, 2);
    expect(text(files.get("ppt/slides/_rels/slide2.xml.rels"))).toContain('Target="../media/image1.png"');
    expect(files.get("ppt/media/image1.png")).toEqual(png);
    // 没有要点的页也得有一个空段落，否则文件不合规
    expect(text(files.get("ppt/slides/slide3.xml"))).toContain("<a:endParaRPr");
  });

  it("要点里的特殊字符转掉，换行和控制字符不进文件", async () => {
    const files = await unpack(
      await buildPptx([{ title: 'A < B & "C"', bullets: ["第一行\n第二行\u0007", "x > y"], image: new Uint8Array(4) }]),
    );
    const slide = text(files.get("ppt/slides/slide1.xml"));
    expect(slide).toContain("<a:t>A &lt; B &amp; &quot;C&quot;</a:t>");
    expect(slide).toContain("<a:t>第一行 第二行</a:t>");
    expect(slide).toContain("<a:t>x &gt; y</a:t>");
    // 认不出是 PNG 的配图不放
    expect(slide).not.toContain("<p:pic>");
    expect([...files.keys()].some((name) => name.startsWith("ppt/media/"))).toBe(false);
  });

  it("一页都没有时不出文件", async () => {
    await expect(buildPptx([])).rejects.toThrow("slides.empty");
  });
});
