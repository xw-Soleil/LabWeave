import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";

/*
 * 把一份汇报草稿导出成报告（Markdown）和 PPT（.pptx，不加库，自己拼）。
 * 出自同伴 cleverfool-rnh 的 PR（xw-Soleil/LabWeave 第 1 号），这里改了三处：
 * 报告开头加属性；每节后面的出处写成能点回原处的链接；素材文件夹的名字由调用方给。
 */

export interface ReportEvidence {
  /** S1、S2…… AI 引用时用的编号 */
  id: string;
  /** 这条材料在项目里的位置，写进「来源.json」 */
  path: string;
  label: string;
  text: string;
  /** 点了回到原处：卡片、批注是 rwb://，笔记是相对报告的路径。没有地方可回的不给 */
  link?: string;
}

export interface ReportImage {
  id: string;
  filename: string;
  bytes: Uint8Array;
  width: number;
  height: number;
  sourceId: string;
}

export interface ReportDraft {
  title: string;
  summary: string;
  sections: {
    heading: string;
    paragraphs: string[];
    sourceIds: string[];
    imageIds: string[];
  }[];
}

/** 这份汇报是哪个节点的 */
export interface ReportMeta {
  /** 节点的名字，也是汇报文件夹的名字：2026-11-21 组会 */
  title: string;
  /** 类型写给人看的名字：组会、周报、自己复盘 */
  type: string;
  project: string;
  /** 范围，带时区的时间。项目里第一次做小结时没有开头 */
  since?: string;
  until: string;
  /** 定格时拍的节点快照 */
  snapshot?: string;
}

export interface ReportDocument {
  draft: ReportDraft;
  evidence: ReportEvidence[];
  images: ReportImage[];
  meta: ReportMeta;
  warnings: string[];
}

const day = (time: string) => time.slice(0, 10);
const rangeOf = ({ since, until }: ReportMeta) => (since ? `${day(since)} ~ ${day(until)}` : `到 ${day(until)}`);

const xml = (text: string) =>
  Array.from(text)
    .filter((character) => character.charCodeAt(0) >= 32 || "\t\n\r".includes(character))
    .join("")
    .replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]!);
const declaration = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const a = "http://schemas.openxmlformats.org/drawingml/2006/main";
const p = "http://schemas.openxmlformats.org/presentationml/2006/main";
const r = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const emu = (inches: number) => Math.round(inches * 914400);

/** Count East Asian glyphs at full width so paragraphs paginate instead of shrinking to illegibility. */
export function wrapReportText(text: string, columns = 38): string[] {
  const result: string[] = [];
  for (const paragraph of text.replace(/\r\n?/g, "\n").split("\n")) {
    let line = "";
    let width = 0;
    for (const character of Array.from(paragraph)) {
      const size = character.codePointAt(0)! <= 255 ? 0.55 : 1;
      if (width + size > columns && line) {
        result.push(line);
        line = "";
        width = 0;
      }
      line += character;
      width += size;
    }
    result.push(line);
  }
  return result;
}

const limit = (text: string, length: number) =>
  Array.from(text).length > length
    ? Array.from(text)
        .slice(0, length - 1)
        .join("") + "…"
    : text;

function textBox(
  id: number,
  name: string,
  lines: string[],
  x: number,
  y: number,
  w: number,
  h: number,
  size = 22,
  color = "243047",
  bold = false,
) {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${xml(name)}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${emu(x)}" y="${emu(y)}"/><a:ext cx="${emu(w)}" cy="${emu(h)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></p:spPr><p:txBody><a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0"/><a:lstStyle/>${lines.map((line) => `<a:p><a:pPr><a:lnSpc><a:spcPct val="125000"/></a:lnSpc><a:spcAft><a:spcPts val="800"/></a:spcAft></a:pPr><a:r><a:rPr lang="zh-CN" sz="${size * 100}" b="${bold ? 1 : 0}"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:latin typeface="Aptos"/><a:ea typeface="Microsoft YaHei"/></a:rPr><a:t xml:space="preserve">${xml(line)}</a:t></a:r><a:endParaRPr lang="zh-CN" sz="${size * 100}"/></a:p>`).join("")}</p:txBody></p:sp>`;
}

const group =
  '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';
const relations = (items: { id: string; type: string; target: string }[]) =>
  `${declaration}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items.map((item) => `<Relationship Id="${item.id}" Type="${r}/${item.type}" Target="${xml(item.target)}"/>`).join("")}</Relationships>`;

interface Slide {
  title: string;
  lines: string[];
  source: string;
  image?: ReportImage;
}

function citedEvidence(document: ReportDocument): ReportEvidence[] {
  const ids = new Set(document.draft.sections.flatMap((section) => section.sourceIds));
  return document.evidence.filter((source) => ids.has(source.id));
}

function slidesOf(document: ReportDocument): Slide[] {
  const slides: Slide[] = [];
  const paginate = (title: string, lines: string[], source: string) => {
    for (let offset = 0; offset < Math.max(1, lines.length); offset += 7) {
      slides.push({ title: offset ? `${title}（续）` : title, lines: lines.slice(offset, offset + 7), source });
    }
  };
  const { meta } = document;
  paginate(
    document.draft.title,
    wrapReportText(document.draft.summary),
    `${meta.title} · ${meta.project} · ${rangeOf(meta)}`,
  );
  for (const section of document.draft.sections) {
    const sources = section.sourceIds
      .map((id) => document.evidence.find((item) => item.id === id))
      .filter((item): item is ReportEvidence => !!item);
    const source = sources.map((item) => `[${item.id}] ${item.label}`).join("；");
    paginate(
      section.heading,
      section.paragraphs.flatMap((paragraph) => wrapReportText(paragraph)),
      source,
    );
    for (const imageId of section.imageIds) {
      const image = document.images.find((item) => item.id === imageId);
      if (image) slides.push({ title: section.heading, lines: [], source, image });
    }
  }
  const references = citedEvidence(document)
    .map((item) => `[${item.id}] ${item.label}`)
    .flatMap((line) => wrapReportText(line));
  paginate("材料来源", references, meta.snapshot ? `节点快照 ${meta.snapshot}` : meta.title);
  if (document.warnings.length)
    paginate(
      "材料范围与待核对项",
      document.warnings.flatMap((line) => wrapReportText(line)),
      "仅基于本次纳入的材料生成",
    );
  return slides;
}

export async function createReportPptx(document: ReportDocument): Promise<Uint8Array> {
  const slides = slidesOf(document);
  const writer = new ZipWriter(new Uint8ArrayWriter());
  const add = (path: string, value: string | Uint8Array) =>
    writer.add(path, new Uint8ArrayReader(typeof value === "string" ? new TextEncoder().encode(value) : value), {
      level: 0,
    });
  const usedImages = [
    ...new Map(slides.filter((slide) => slide.image).map((slide) => [slide.image!.id, slide.image!])).values(),
  ];
  await add(
    "[Content_Types].xml",
    `${declaration}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpg" ContentType="image/jpeg"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>${slides.map((_, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join("")}</Types>`,
  );
  await add("_rels/.rels", relations([{ id: "rId1", type: "officeDocument", target: "ppt/presentation.xml" }]));
  await add(
    "ppt/presentation.xml",
    `${declaration}<p:presentation xmlns:a="${a}" xmlns:r="${r}" xmlns:p="${p}"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rIdMaster"/></p:sldMasterIdLst><p:sldIdLst>${slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`).join("")}</p:sldIdLst><p:sldSz cx="12192000" cy="6858000" type="screen16x9"/><p:notesSz cx="6858000" cy="9144000"/><p:defaultTextStyle/></p:presentation>`,
  );
  await add(
    "ppt/_rels/presentation.xml.rels",
    relations([
      { id: "rIdMaster", type: "slideMaster", target: "slideMasters/slideMaster1.xml" },
      ...slides.map((_, i) => ({ id: `rId${i + 1}`, type: "slide", target: `slides/slide${i + 1}.xml` })),
    ]),
  );
  const colorMap =
    '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>';
  await add(
    "ppt/slideMasters/slideMaster1.xml",
    `${declaration}<p:sldMaster xmlns:a="${a}" xmlns:r="${r}" xmlns:p="${p}"><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:effectLst/></p:bgPr></p:bg><p:spTree>${group}</p:spTree></p:cSld>${colorMap}<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rIdLayout"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles></p:sldMaster>`,
  );
  await add(
    "ppt/slideMasters/_rels/slideMaster1.xml.rels",
    relations([
      { id: "rIdLayout", type: "slideLayout", target: "../slideLayouts/slideLayout1.xml" },
      { id: "rIdTheme", type: "theme", target: "../theme/theme1.xml" },
    ]),
  );
  await add(
    "ppt/slideLayouts/slideLayout1.xml",
    `${declaration}<p:sldLayout xmlns:a="${a}" xmlns:r="${r}" xmlns:p="${p}" type="blank" preserve="1"><p:cSld name="Blank"><p:spTree>${group}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`,
  );
  await add(
    "ppt/slideLayouts/_rels/slideLayout1.xml.rels",
    relations([{ id: "rIdMaster", type: "slideMaster", target: "../slideMasters/slideMaster1.xml" }]),
  );
  const colors = {
    dk1: "243047",
    lt1: "FFFFFF",
    dk2: "475569",
    lt2: "F1F5F9",
    accent1: "357B78",
    accent2: "64748B",
    accent3: "A7C4BC",
    accent4: "C89B61",
    accent5: "8D83B5",
    accent6: "83B4C9",
    hlink: "2563EB",
    folHlink: "7C3AED",
  };
  const fill = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>';
  await add(
    "ppt/theme/theme1.xml",
    `${declaration}<a:theme xmlns:a="${a}" name="LabWeave"><a:themeElements><a:clrScheme name="LabWeave">${Object.entries(
      colors,
    )
      .map(([name, color]) => `<a:${name}><a:srgbClr val="${color}"/></a:${name}>`)
      .join(
        "",
      )}</a:clrScheme><a:fontScheme name="LabWeave"><a:majorFont><a:latin typeface="Aptos Display"/><a:ea typeface="Microsoft YaHei"/><a:cs typeface="Arial"/></a:majorFont><a:minorFont><a:latin typeface="Aptos"/><a:ea typeface="Microsoft YaHei"/><a:cs typeface="Arial"/></a:minorFont></a:fontScheme><a:fmtScheme name="LabWeave"><a:fillStyleLst>${fill.repeat(3)}</a:fillStyleLst><a:lnStyleLst>${[9525, 25400, 38100].map((w) => `<a:ln w="${w}">${fill}<a:prstDash val="solid"/></a:ln>`).join("")}</a:lnStyleLst><a:effectStyleLst>${"<a:effectStyle><a:effectLst/></a:effectStyle>".repeat(3)}</a:effectStyleLst><a:bgFillStyleLst>${fill.repeat(3)}</a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`,
  );
  for (const image of usedImages) await add(`ppt/media/${image.filename}`, image.bytes);
  for (const [index, slide] of slides.entries()) {
    let shapes = textBox(
      2,
      "Title",
      wrapReportText(slide.title, 30).slice(0, 2),
      0.65,
      0.42,
      12,
      1.2,
      28,
      "243047",
      true,
    );
    if (slide.image) {
      const scale = Math.min(11.7 / slide.image.width, 4.8 / slide.image.height);
      const width = slide.image.width * scale;
      const height = slide.image.height * scale;
      shapes += `<p:pic><p:nvPicPr><p:cNvPr id="3" name="${xml(slide.image.filename)}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rIdImage"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="${emu((13.333 - width) / 2)}" y="${emu(1.7 + (4.8 - height) / 2)}"/><a:ext cx="${emu(width)}" cy="${emu(height)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`;
    } else shapes += textBox(3, "Content", slide.lines, 0.7, 1.65, 11.9, 4.85, 22);
    shapes += textBox(4, "Source", [limit(slide.source, 80)], 0.7, 6.87, 11.1, 0.27, 9, "64748B");
    shapes += textBox(5, "Page", [`${index + 1} / ${slides.length}`], 11.9, 6.87, 0.8, 0.27, 9, "64748B");
    await add(
      `ppt/slides/slide${index + 1}.xml`,
      `${declaration}<p:sld xmlns:a="${a}" xmlns:r="${r}" xmlns:p="${p}"><p:cSld><p:spTree>${group}${shapes}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`,
    );
    await add(
      `ppt/slides/_rels/slide${index + 1}.xml.rels`,
      relations([
        { id: "rIdLayout", type: "slideLayout", target: "../slideLayouts/slideLayout1.xml" },
        ...(slide.image ? [{ id: "rIdImage", type: "image", target: `../media/${slide.image.filename}` }] : []),
      ]),
    );
  }
  return writer.close();
}

const mdText = (value: string) =>
  Array.from(value)
    .map((character) => ("\\`*_{}[]<>".includes(character) ? "\\" + character : character))
    .join("");

// 属性里的值带 YAML 认的符号时加引号，免得读错
const yamlValue = (value: string) => (/[,[\]{}:#"'&*!|>%@`]/.test(value) ? JSON.stringify(value) : value);

/** 一条出处：能点的写成链接，文字是「编号 标签」 */
function sourceLink(source: ReportEvidence, labelLength: number): string {
  const text = mdText(`${source.id} ${limit(source.label.replace(/\s+/g, " "), labelLength)}`);
  return source.link ? `[${text}](${source.link})` : text;
}

/**
 * 报告的 Markdown。assets 是放图的文件夹名（和报告在同一个文件夹里）。
 * 开头是属性，正文每节后面跟着这一节的出处，最后列全部用到的材料和待核对项。
 */
export function createReportMarkdown(document: ReportDocument, assets = "素材"): string {
  const { meta } = document;
  const lines = [
    "---",
    `类型: ${yamlValue(meta.type)}`,
    `日期: ${day(meta.until)}`,
    `范围: ${rangeOf(meta)}`,
    `项目: [${yamlValue(meta.project)}]`,
    ...(meta.snapshot ? [`快照: ${meta.snapshot}`] : []),
    "---",
    "",
    `# ${mdText(document.draft.title)}`,
    "",
    document.draft.summary,
    "",
  ];
  for (const section of document.draft.sections) {
    lines.push(`## ${mdText(section.heading)}`, "", ...section.paragraphs.flatMap((paragraph) => [paragraph, ""]));
    for (const id of section.imageIds) {
      const image = document.images.find((item) => item.id === id);
      if (image) lines.push(`![${mdText(section.heading)}](${assets}/${image.filename})`, "");
    }
    const sources = section.sourceIds
      .map((id) => document.evidence.find((item) => item.id === id))
      .filter((item): item is ReportEvidence => !!item);
    lines.push(`出处：${sources.map((source) => sourceLink(source, 24)).join(" · ")}`, "");
  }
  lines.push("## 材料来源", "");
  for (const source of citedEvidence(document)) lines.push(`- ${sourceLink(source, 80)}`);
  if (document.warnings.length)
    lines.push("", "## 材料范围与待核对项", "", ...document.warnings.map((warning) => `- ${mdText(warning)}`));
  return lines.join("\n") + "\n";
}
