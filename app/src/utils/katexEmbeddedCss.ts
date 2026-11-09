import css from "katex/dist/katex.min.css?raw";
import AMSRegular from "katex/dist/fonts/KaTeX_AMS-Regular.woff2?inline";
import CaligraphicBold from "katex/dist/fonts/KaTeX_Caligraphic-Bold.woff2?inline";
import CaligraphicRegular from "katex/dist/fonts/KaTeX_Caligraphic-Regular.woff2?inline";
import FrakturBold from "katex/dist/fonts/KaTeX_Fraktur-Bold.woff2?inline";
import FrakturRegular from "katex/dist/fonts/KaTeX_Fraktur-Regular.woff2?inline";
import MainBold from "katex/dist/fonts/KaTeX_Main-Bold.woff2?inline";
import MainBoldItalic from "katex/dist/fonts/KaTeX_Main-BoldItalic.woff2?inline";
import MainItalic from "katex/dist/fonts/KaTeX_Main-Italic.woff2?inline";
import MainRegular from "katex/dist/fonts/KaTeX_Main-Regular.woff2?inline";
import MathBoldItalic from "katex/dist/fonts/KaTeX_Math-BoldItalic.woff2?inline";
import MathItalic from "katex/dist/fonts/KaTeX_Math-Italic.woff2?inline";
import SansSerifBold from "katex/dist/fonts/KaTeX_SansSerif-Bold.woff2?inline";
import SansSerifItalic from "katex/dist/fonts/KaTeX_SansSerif-Italic.woff2?inline";
import SansSerifRegular from "katex/dist/fonts/KaTeX_SansSerif-Regular.woff2?inline";
import ScriptRegular from "katex/dist/fonts/KaTeX_Script-Regular.woff2?inline";
import Size1Regular from "katex/dist/fonts/KaTeX_Size1-Regular.woff2?inline";
import Size2Regular from "katex/dist/fonts/KaTeX_Size2-Regular.woff2?inline";
import Size3Regular from "katex/dist/fonts/KaTeX_Size3-Regular.woff2?inline";
import Size4Regular from "katex/dist/fonts/KaTeX_Size4-Regular.woff2?inline";
import TypewriterRegular from "katex/dist/fonts/KaTeX_Typewriter-Regular.woff2?inline";

const fonts: Record<string, string> = {
  AMSRegular,
  CaligraphicBold,
  CaligraphicRegular,
  FrakturBold,
  FrakturRegular,
  MainBold,
  MainBoldItalic,
  MainItalic,
  MainRegular,
  MathBoldItalic,
  MathItalic,
  SansSerifBold,
  SansSerifItalic,
  SansSerifRegular,
  ScriptRegular,
  Size1Regular,
  Size2Regular,
  Size3Regular,
  Size4Regular,
  TypewriterRegular,
};

export interface KatexFontFace {
  family: string;
  weight: string;
  style: string;
  source: string;
  css: string;
}

const normalizeFamily = (family: string) => family.trim().replaceAll(/["']/g, "");
const normalizeWeight = (weight: string) => (weight === "bold" || Number(weight) >= 600 ? "700" : "400");

export const katexFontFaces: KatexFontFace[] = Array.from(css.matchAll(/@font-face\s*\{[^}]+\}/g), ([face]) => {
  const property = (name: string) => new RegExp(`${name}:\\s*([^;}]+)`).exec(face)?.[1].trim() ?? "normal";
  const name = property("src")
    .match(/KaTeX_([\w-]+)\.woff2/)?.[1]
    .replaceAll("-", "");
  const font = name && fonts[name];
  if (!font) throw new Error(`Missing embedded KaTeX font: ${name}`);
  const source = `url("${font}") format("woff2")`;
  return {
    family: normalizeFamily(property("font-family")),
    weight: normalizeWeight(property("font-weight")),
    style: property("font-style"),
    source,
    css: face.replace(/src:[^;}]+/, `src:${source}`),
  };
});

export const katexStyleCss = css.replace(/@font-face\s*\{[^}]+\}/g, "");

export function getKatexFontFace(fontFamily: string, fontWeight: string, fontStyle: string): KatexFontFace | undefined {
  for (const family of fontFamily.split(",").map(normalizeFamily)) {
    const faces = katexFontFaces.filter((face) => face.family === family);
    if (!faces.length) continue;
    const weight = normalizeWeight(fontWeight);
    const style = fontStyle === "oblique" ? "italic" : fontStyle;
    return (
      faces.find((face) => face.weight === weight && face.style === style) ??
      faces.find((face) => face.style === style) ??
      faces.find((face) => face.weight === weight) ??
      faces[0]
    );
  }
}
