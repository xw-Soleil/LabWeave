import { describe, expect, it } from "vitest";
import { getKatexFontFace, katexEmbeddedCss, katexFontFaces, katexStyleCss } from "./katexEmbeddedCss";

describe("embedded KaTeX fonts", () => {
  it("embeds every font face without external font URLs", () => {
    const faces = katexEmbeddedCss.match(/@font-face\{[^}]+\}/g) ?? [];
    expect(faces).toHaveLength(20);
    for (const face of faces) {
      expect(face).toMatch(/src:url\("data:font\/woff2;base64,[A-Za-z0-9+/=]+"\) format\("woff2"\)/);
    }
    expect(katexEmbeddedCss).not.toMatch(/url\((?!"data:)/);
    expect(katexEmbeddedCss).toContain("KaTeX_Math");
    expect(katexEmbeddedCss).toContain("KaTeX_Size4");
  });

  it("separates font faces from the unchanged layout stylesheet", () => {
    expect(katexFontFaces).toHaveLength(20);
    expect(katexStyleCss).not.toContain("@font-face");
    expect(katexStyleCss).not.toContain("data:font");
    expect(katexEmbeddedCss).toBe(katexFontFaces.map((face) => face.css).join("") + katexStyleCss);
  });

  it("selects the family, weight and style instead of embedding every variant", () => {
    const regular = getKatexFontFace('"KaTeX_Main", serif', "400", "normal")!;
    const italic = getKatexFontFace("KaTeX_Main", "normal", "italic")!;
    const boldItalic = getKatexFontFace("KaTeX_Main", "700", "italic")!;
    expect(regular).toMatchObject({ family: "KaTeX_Main", weight: "400", style: "normal" });
    expect(italic.css).not.toBe(regular.css);
    expect(boldItalic).toMatchObject({ family: "KaTeX_Main", weight: "700", style: "italic" });
    expect(getKatexFontFace("serif", "400", "normal")).toBeUndefined();
    expect(getKatexFontFace("KaTeX_Size1", "bold", "italic")).toMatchObject({ weight: "400", style: "normal" });
  });
});
