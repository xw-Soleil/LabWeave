import { describe, expect, it, vi } from "vitest";

vi.mock("@/core/service/Settings", () => ({ Settings: { defaultFontFamily: "sans-serif" } }));
vi.mock("@/core/service/ProjectToolSettingsSchema", () => ({
  DEFAULT_FONT_FAMILY: "sans-serif",
  MAC_DEFAULT_FONT_FAMILY: "sans-serif",
}));
vi.hoisted(() => {
  vi.stubGlobal("document", { createElement: () => ({ getContext: () => null }) });
});

import {
  clampTextLines,
  ELLIPSIS,
  ellipsizeEnd,
  ellipsizeMiddle,
  isBundledCanvasFont,
  type MeasureText,
  resolveFont,
  setCanvasFont,
  wrapTextByWords,
} from "./font";

/** 每个字宽 1；省略号可以单独指定宽度，验证截短时真的量了省略号 */
function fakeMeasure(ellipsisWidth = 1): MeasureText {
  return (text) =>
    Array.from(text).reduce((width, character) => width + (character === ELLIPSIS ? ellipsisWidth : 1), 0);
}

function context() {
  let actual = "10px sans-serif";
  const assign = vi.fn((font: string) => {
    actual = font.replace(/^normal /, "");
  });
  return {
    ctx: {
      get font() {
        return actual;
      },
      set font(value: string) {
        assign(value);
      },
    } as CanvasRenderingContext2D,
    assign,
    restore: (font: string) => {
      actual = font;
    },
  };
}

describe("setCanvasFont", () => {
  it("avoids assigning the same font after Canvas normalizes its representation", () => {
    const { ctx, assign } = context();
    for (let i = 0; i < 600; i++) setCanvasFont(ctx, "normal 24px sans-serif");
    expect(ctx.font).toBe("24px sans-serif");
    expect(assign).toHaveBeenCalledTimes(1);
  });

  it("applies changes in size, family and weight", () => {
    const { ctx, assign } = context();
    for (const font of ["normal 24px sans-serif", "normal 25px sans-serif", "normal 25px serif", "bold 25px serif"]) {
      setCanvasFont(ctx, font);
    }
    expect(assign).toHaveBeenCalledTimes(4);
    expect(ctx.font).toBe("bold 25px serif");
  });

  it("detects external assignments and canvas restore or resize", () => {
    const { ctx, assign, restore } = context();
    setCanvasFont(ctx, "normal 24px sans-serif");
    ctx.font = "bold 16px serif";
    setCanvasFont(ctx, "normal 24px sans-serif");
    restore("10px sans-serif");
    setCanvasFont(ctx, "normal 24px sans-serif");
    expect(ctx.font).toBe("24px sans-serif");
    expect(assign).toHaveBeenCalledTimes(4);
  });

  it("keeps independent state for each canvas", () => {
    const a = context();
    const b = context();
    setCanvasFont(a.ctx, "normal 24px sans-serif");
    setCanvasFont(b.ctx, "normal 24px sans-serif");
    expect(a.assign).toHaveBeenCalledTimes(1);
    expect(b.assign).toHaveBeenCalledTimes(1);
  });
});

it("keeps the configured system font on desktop instead of swapping in the MSDF font", () => {
  vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
  try {
    expect(isBundledCanvasFont()).toBe(false);
    expect(resolveFont(32)).toBe("normal 32px sans-serif");
  } finally {
    vi.unstubAllGlobals();
  }
});

describe("wrapTextByWords", () => {
  const measure = fakeMeasure();

  it("breaks Latin text between words instead of inside them", () => {
    expect(wrapTextByWords("the quick brown fox", 10, measure).lines).toEqual(["the quick", "brown fox"]);
  });

  it("may break after underscores and hyphens", () => {
    expect(wrapTextByWords("deep_learning-survey_v2", 12, measure).lines).toEqual(["deep_", "learning-", "survey_v2"]);
  });

  it("breaks a single over-long word per character and keeps filling the line afterwards", () => {
    expect(wrapTextByWords("supercalifragilistic is long", 8, measure).lines).toEqual([
      "supercal",
      "ifragili",
      "stic is",
      "long",
    ]);
  });

  it("breaks CJK text between any two characters and keeps closing punctuation off the line start", () => {
    expect(wrapTextByWords("研究白板的文字排版", 4, measure).lines).toEqual(["研究白板", "的文字排", "版"]);
    expect(wrapTextByWords("用 PyTorch 训练", 8, measure).lines).toEqual(["用", "PyTorch", "训练"]);
    expect(wrapTextByWords("你好，世界", 2, measure).lines).toEqual(["你", "好，", "世界"]);
  });

  it("keeps paragraphs and blank lines", () => {
    expect(wrapTextByWords("a\n\nb", 10, measure).lines).toEqual(["a", "", "b"]);
  });

  it("stops at maxLines and reports whether anything was left out", () => {
    expect(wrapTextByWords("one two three four", 7, measure, 2)).toEqual({
      lines: ["one two", "three"],
      truncated: true,
    });
    expect(wrapTextByWords("one two", 7, measure, 1)).toEqual({ lines: ["one two"], truncated: false });
  });
});

describe("ellipsizeEnd", () => {
  it("leaves text that fits alone unless an ellipsis is forced", () => {
    expect(ellipsizeEnd("abc", 10, fakeMeasure())).toBe("abc");
    expect(ellipsizeEnd("abc", 10, fakeMeasure(), true)).toBe("abc…");
  });

  it("shortens the text so that text plus ellipsis fits the width", () => {
    expect(ellipsizeEnd("abcdefghij", 5, fakeMeasure())).toBe("abcd…");
    // 一行刚好排满时也要先让出省略号的位置
    expect(ellipsizeEnd("abcde", 5, fakeMeasure(), true)).toBe("abcd…");
  });

  it("measures the ellipsis itself instead of assuming its width", () => {
    const measure = fakeMeasure(3);
    const result = ellipsizeEnd("abcdefgh", 6, measure);
    expect(result).toBe("abc…");
    expect(measure(result)).toBeLessThanOrEqual(6);
  });

  it("does not leave a space before the ellipsis and gives up when not even the ellipsis fits", () => {
    expect(ellipsizeEnd("ab cdef", 4, fakeMeasure())).toBe("ab…");
    expect(ellipsizeEnd("abc", 0.5, fakeMeasure())).toBe("");
  });
});

describe("clampTextLines", () => {
  it("ellipsizes the last allowed line so that it still fits", () => {
    const measure = fakeMeasure(2);
    const lines = clampTextLines("aaaa bbbb cccc dddd eeee", 9, 2, measure);
    expect(lines).toEqual(["aaaa bbbb", "cccc dd…"]);
    for (const line of lines) expect(measure(line)).toBeLessThanOrEqual(9);
  });

  it("adds no ellipsis when everything fits and renders nothing for zero lines", () => {
    expect(clampTextLines("short title", 20, 2, fakeMeasure())).toEqual(["short title"]);
    expect(clampTextLines("anything", 20, 0, fakeMeasure())).toEqual([]);
  });
});

describe("ellipsizeMiddle", () => {
  const measure = fakeMeasure();

  it("keeps the extension and both ends of the name", () => {
    expect(ellipsizeMiddle({ body: "a", tail: ".pdf" }, 16, measure)).toBe("a.pdf");
    const result = ellipsizeMiddle({ body: "2024_garbage_classification_final", tail: ".pdf" }, 16, measure);
    expect(result).toBe("2024_g…final.pdf");
    expect(measure(result)).toBeLessThanOrEqual(16);
  });

  it("keeps the text around the name intact", () => {
    expect(ellipsizeMiddle({ head: "> ", body: "verylongfilename", tail: ".md · 双击打开" }, 17, measure)).toBe(
      "> ve…me.md · 双击打开",
    );
  });

  it("falls back to cutting the end when the kept parts alone do not fit", () => {
    const result = ellipsizeMiddle({ body: "abc", tail: ".longext" }, 5, measure);
    expect(result).toBe("abc.…");
    expect(measure(result)).toBeLessThanOrEqual(5);
  });
});
