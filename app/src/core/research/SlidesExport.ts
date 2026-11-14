import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";

/*
 * 把一页一页的提纲转成 .pptx。
 *
 * 没有用现成的库：.pptx 就是一个压缩包，里面是几份固定格式的 XML，压缩用程序里已有的 zip.js。
 * 版式只有一种：上面标题，下面几条要点，有配图时图放右边。能在 PowerPoint、Keynote 里打开、接着改就行。
 */

export interface Slide {
  title: string;
  bullets: string[];
  /** 配图，只认 PNG */
  image?: Uint8Array;
}

// 长度单位是 EMU，一英寸 914400；页面 16:9，13.333 × 7.5 英寸
const INCH = 914400;
const PAGE = { w: 12192000, h: 6858000 };
const MARGIN = Math.round(0.6 * INCH);
const TITLE = { x: MARGIN, y: Math.round(0.45 * INCH), w: PAGE.w - 2 * MARGIN, h: Math.round(1.05 * INCH) };
const BODY_TOP = Math.round(1.7 * INCH);
const BODY = { x: MARGIN, y: BODY_TOP, w: PAGE.w - 2 * MARGIN, h: PAGE.h - BODY_TOP - Math.round(0.5 * INCH) };
const GAP = Math.round(0.4 * INCH);
// 有配图时正文占左边一半多一点，图占右边
const BODY_BESIDE_IMAGE = { ...BODY, w: Math.round(BODY.w * 0.54) };
const IMAGE = {
  x: BODY.x + BODY_BESIDE_IMAGE.w + GAP,
  y: BODY.y,
  w: BODY.w - BODY_BESIDE_IMAGE.w - GAP,
  h: BODY.h,
};

type Box = { x: number; y: number; w: number; h: number };

const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const NS =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const TYPE = "application/vnd.openxmlformats-officedocument";

function escapeXml(text: string): string {
  let out = "";
  for (const char of text) {
    const code = char.codePointAt(0)!;
    // XML 里不许出现的控制字符丢掉；换行在一条要点里没有意义，换成空格
    if (code === 0x0a || code === 0x0d || code === 0x09) out += " ";
    else if (code < 0x20) continue;
    else out += char === "&" ? "&amp;" : char === "<" ? "&lt;" : char === ">" ? "&gt;" : char === '"' ? "&quot;" : char;
  }
  return out;
}

function pngSize(bytes: Uint8Array): { w: number; h: number } | undefined {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24 || signature.some((byte, index) => bytes[index] !== byte)) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const size = { w: view.getUint32(16), h: view.getUint32(20) };
  return size.w > 0 && size.h > 0 ? size : undefined;
}

/** 按原比例放进框里，居中 */
function fit(size: { w: number; h: number }, box: Box): Box {
  const scale = Math.min(box.w / size.w, box.h / size.h);
  const w = Math.round(size.w * scale);
  const h = Math.round(size.h * scale);
  return { x: box.x + Math.round((box.w - w) / 2), y: box.y + Math.round((box.h - h) / 2), w, h };
}

const relationships = (items: [id: string, type: string, target: string][]) =>
  `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items
    .map(([id, type, target]) => `<Relationship Id="${id}" Type="${REL}/${type}" Target="${target}"/>`)
    .join("")}</Relationships>`;

const xfrm = (box: Box) => `<a:xfrm><a:off x="${box.x}" y="${box.y}"/><a:ext cx="${box.w}" cy="${box.h}"/></a:xfrm>`;

// 每个形状树开头都要有这一段
const TREE_START =
  '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
  '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';

function textBox(id: number, name: string, box: Box, anchor: "t" | "ctr", paragraphs: string): string {
  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>` +
    `<p:spPr>${xfrm(box)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>` +
    `<p:txBody><a:bodyPr wrap="square" rtlCol="0" anchor="${anchor}"><a:normAutofit/></a:bodyPr><a:lstStyle/>` +
    `${paragraphs}</p:txBody></p:sp>`
  );
}

const run = (text: string, size: number, bold = false) =>
  `<a:r><a:rPr lang="zh-CN" altLang="en-US" sz="${size * 100}"${bold ? ' b="1"' : ""} dirty="0"/><a:t>${escapeXml(text)}</a:t></a:r>`;

function slideXml(slide: Slide, picture?: Box): string {
  const bullets =
    slide.bullets.length > 0
      ? slide.bullets
          .map(
            (bullet) =>
              '<a:p><a:pPr marL="285750" indent="-285750"><a:spcBef><a:spcPts val="900"/></a:spcBef>' +
              `<a:buFont typeface="Arial"/><a:buChar char="&#8226;"/></a:pPr>${run(bullet, 20)}</a:p>`,
          )
          .join("")
      : '<a:p><a:endParaRPr lang="zh-CN" altLang="en-US" dirty="0"/></a:p>';
  return (
    `${HEAD}<p:sld ${NS}><p:cSld><p:spTree>${TREE_START}` +
    textBox(2, "Title", TITLE, "ctr", `<a:p>${run(slide.title, 32, true)}</a:p>`) +
    textBox(3, "Content", picture ? BODY_BESIDE_IMAGE : BODY, "t", bullets) +
    (picture
      ? '<p:pic><p:nvPicPr><p:cNvPr id="4" name="Picture"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>' +
        '<p:blipFill><a:blip r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>' +
        `<p:spPr>${xfrm(picture)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`
      : "") +
    "</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>"
  );
}

const textStyle = (size: number, font: "mj" | "mn") =>
  `<a:lvl1pPr marL="0" indent="0" algn="l"><a:defRPr sz="${size * 100}" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill>` +
  `<a:latin typeface="+${font}-lt"/><a:ea typeface="+${font}-ea"/><a:cs typeface="+${font}-cs"/></a:defRPr></a:lvl1pPr>`;

const MASTER =
  `${HEAD}<p:sldMaster ${NS}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg>` +
  `<p:spTree>${TREE_START}</p:spTree></p:cSld>` +
  '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" ' +
  'accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>' +
  '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>' +
  `<p:txStyles><p:titleStyle>${textStyle(32, "mj")}</p:titleStyle><p:bodyStyle>${textStyle(20, "mn")}</p:bodyStyle>` +
  `<p:otherStyle>${textStyle(18, "mn")}</p:otherStyle></p:txStyles></p:sldMaster>`;

const LAYOUT =
  `${HEAD}<p:sldLayout ${NS} type="blank" preserve="1"><p:cSld name="Blank"><p:spTree>${TREE_START}</p:spTree></p:cSld>` +
  "<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>";

const color = (name: string, value: string) => `<a:${name}><a:srgbClr val="${value}"/></a:${name}>`;
const fonts = (name: string, latin: string) =>
  `<a:${name}><a:latin typeface="${latin}"/><a:ea typeface=""/><a:cs typeface=""/></a:${name}>`;
const three = (item: string) => item.repeat(3);
const PLACEHOLDER_FILL = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>';

// 主题必须齐全（十二种颜色、两套字体、四组各三个样式），缺一样 PowerPoint 就说文件要修复
const THEME =
  `${HEAD}<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office Theme"><a:themeElements>` +
  '<a:clrScheme name="Office"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>' +
  '<a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>' +
  color("dk2", "44546A") +
  color("lt2", "E7E6E6") +
  color("accent1", "4472C4") +
  color("accent2", "ED7D31") +
  color("accent3", "A5A5A5") +
  color("accent4", "FFC000") +
  color("accent5", "5B9BD5") +
  color("accent6", "70AD47") +
  color("hlink", "0563C1") +
  color("folHlink", "954F72") +
  "</a:clrScheme>" +
  `<a:fontScheme name="Office">${fonts("majorFont", "Calibri Light")}${fonts("minorFont", "Calibri")}</a:fontScheme>` +
  '<a:fmtScheme name="Office">' +
  `<a:fillStyleLst>${three(PLACEHOLDER_FILL)}</a:fillStyleLst>` +
  `<a:lnStyleLst>${three(
    `<a:ln w="6350" cap="flat" cmpd="sng" algn="ctr">${PLACEHOLDER_FILL}<a:prstDash val="solid"/><a:miter lim="800000"/></a:ln>`,
  )}</a:lnStyleLst>` +
  `<a:effectStyleLst>${three("<a:effectStyle><a:effectLst/></a:effectStyle>")}</a:effectStyleLst>` +
  `<a:bgFillStyleLst>${three(PLACEHOLDER_FILL)}</a:bgFillStyleLst>` +
  "</a:fmtScheme></a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>";

/** 提纲转成 .pptx 文件的内容。一页都没有时抛 slides.empty */
export async function buildPptx(slides: readonly Slide[]): Promise<Uint8Array> {
  if (slides.length === 0) throw new Error("slides.empty");
  const files: [name: string, content: string | Uint8Array][] = [];
  const overrides: [part: string, type: string][] = [
    ["/ppt/presentation.xml", "presentationml.presentation.main+xml"],
    ["/ppt/slideMasters/slideMaster1.xml", "presentationml.slideMaster+xml"],
    ["/ppt/slideLayouts/slideLayout1.xml", "presentationml.slideLayout+xml"],
    ["/ppt/theme/theme1.xml", "theme+xml"],
  ];
  let images = 0;
  slides.forEach((slide, index) => {
    const number = index + 1;
    const size = slide.image && pngSize(slide.image);
    const links: [string, string, string][] = [["rId1", "slideLayout", "../slideLayouts/slideLayout1.xml"]];
    if (slide.image && size) {
      images++;
      files.push([`ppt/media/image${images}.png`, slide.image]);
      links.push(["rId2", "image", `../media/image${images}.png`]);
    }
    files.push([`ppt/slides/slide${number}.xml`, slideXml(slide, size ? fit(size, IMAGE) : undefined)]);
    files.push([`ppt/slides/_rels/slide${number}.xml.rels`, relationships(links)]);
    overrides.push([`/ppt/slides/slide${number}.xml`, "presentationml.slide+xml"]);
  });

  const contentTypes =
    `${HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Default Extension="png" ContentType="image/png"/>' +
    overrides.map(([part, type]) => `<Override PartName="${part}" ContentType="${TYPE}.${type}"/>`).join("") +
    "</Types>";
  const presentation =
    `${HEAD}<p:presentation ${NS} saveSubsetFonts="1">` +
    '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>' +
    `<p:sldIdLst>${slides.map((_, index) => `<p:sldId id="${256 + index}" r:id="rId${index + 3}"/>`).join("")}</p:sldIdLst>` +
    `<p:sldSz cx="${PAGE.w}" cy="${PAGE.h}"/><p:notesSz cx="${PAGE.h}" cy="${PAGE.w}"/></p:presentation>`;

  const all: [string, string | Uint8Array][] = [
    ["[Content_Types].xml", contentTypes],
    ["_rels/.rels", relationships([["rId1", "officeDocument", "ppt/presentation.xml"]])],
    ["ppt/presentation.xml", presentation],
    [
      "ppt/_rels/presentation.xml.rels",
      relationships([
        ["rId1", "slideMaster", "slideMasters/slideMaster1.xml"],
        ["rId2", "theme", "theme/theme1.xml"],
        ...slides.map((_, index): [string, string, string] => [
          `rId${index + 3}`,
          "slide",
          `slides/slide${index + 1}.xml`,
        ]),
      ]),
    ],
    ["ppt/slideMasters/slideMaster1.xml", MASTER],
    [
      "ppt/slideMasters/_rels/slideMaster1.xml.rels",
      relationships([
        ["rId1", "slideLayout", "../slideLayouts/slideLayout1.xml"],
        ["rId2", "theme", "../theme/theme1.xml"],
      ]),
    ],
    ["ppt/slideLayouts/slideLayout1.xml", LAYOUT],
    [
      "ppt/slideLayouts/_rels/slideLayout1.xml.rels",
      relationships([["rId1", "slideMaster", "../slideMasters/slideMaster1.xml"]]),
    ],
    ["ppt/theme/theme1.xml", THEME],
    ...files,
  ];

  const output = new Uint8ArrayWriter();
  // 不压缩、不带附加字段：Office 对压缩包的写法也挑剔，用最朴素的那种
  const writer = new ZipWriter(output, { level: 0, extendedTimestamp: false, dataDescriptor: false });
  const encoder = new TextEncoder();
  for (const [name, content] of all) {
    await writer.add(name, new Uint8ArrayReader(typeof content === "string" ? encoder.encode(content) : content));
  }
  await writer.close();
  return output.getData();
}
