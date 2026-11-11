import { z } from "zod";

export interface ReadingTheme {
  preset: "default" | "obsidian" | "notion";
  fontBody?: string;
  fontHeading?: string;
  fontCode?: string;
  fontSize?: number;
  lineHeight?: number;
  lineWidth?: number;
  headingScale?: [number, number, number, number, number, number];
}

const scale = z.number().positive();
export const readingThemeSchema = z.object({
  preset: z.enum(["default", "obsidian", "notion"]),
  fontBody: z.string().optional(),
  fontHeading: z.string().optional(),
  fontCode: z.string().optional(),
  fontSize: scale.optional(),
  lineHeight: scale.optional(),
  lineWidth: scale.optional(),
  headingScale: z.tuple([scale, scale, scale, scale, scale, scale]).optional(),
});

/**
 * 默认就是用户 Obsidian 的样子（Minimal 设置：16px、50rem；blog-style：行高 1.8；headings 片段的标题阶梯），
 * 字体留空时用 reading.css 里的 Inter + 苹方、JetBrains Mono。
 * 「照我的 Obsidian」再把标题换成抖音美好体：程序不带这个字体，电脑上装了才有，没装就和默认一样。
 */
const presets: Record<ReadingTheme["preset"], Required<ReadingTheme>> = {
  default: {
    preset: "default",
    fontBody: "",
    fontHeading: "",
    fontCode: "",
    fontSize: 16,
    lineHeight: 1.8,
    lineWidth: 50,
    headingScale: [1.6, 1.4, 1.25, 1.15, 1.08, 1.02],
  },
  obsidian: {
    preset: "obsidian",
    fontBody: "",
    fontHeading: '"DOUYINSANSBOLD-GB", "Douyin Sans"',
    fontCode: "",
    fontSize: 16,
    lineHeight: 1.8,
    lineWidth: 50,
    headingScale: [1.6, 1.4, 1.25, 1.15, 1.08, 1.02],
  },
  notion: {
    preset: "notion",
    fontBody: "",
    fontHeading: "",
    fontCode: "",
    fontSize: 16,
    lineHeight: 1.5,
    lineWidth: 44,
    headingScale: [1.875, 1.5, 1.25, 1.1, 1, 1],
  },
};

export function resolveReadingTheme(theme: ReadingTheme): Required<ReadingTheme> {
  const preset = presets[theme.preset];
  return {
    preset: theme.preset,
    fontBody: theme.fontBody?.trim() || preset.fontBody,
    fontHeading: theme.fontHeading?.trim() || preset.fontHeading,
    fontCode: theme.fontCode?.trim() || preset.fontCode,
    fontSize: theme.fontSize ?? preset.fontSize,
    lineHeight: theme.lineHeight ?? preset.lineHeight,
    lineWidth: theme.lineWidth ?? preset.lineWidth,
    headingScale: [...(theme.headingScale ?? preset.headingScale)],
  };
}

export function readingThemeVars(resolved: Required<ReadingTheme>): Record<`--reading-${string}`, string> {
  const vars: Record<`--reading-${string}`, string> = {
    "--reading-font-size": `${resolved.fontSize}px`,
    "--reading-line-height": String(resolved.lineHeight),
    "--reading-line-width": `${resolved.lineWidth}rem`,
    // 用户的 Obsidian 里表格默认居中；Notion 风贴左
    "--reading-table-margin": resolved.preset === "notion" ? "0" : "auto",
  };
  if (resolved.fontBody) vars["--reading-font-body"] = resolved.fontBody;
  if (resolved.fontHeading) vars["--reading-font-heading"] = resolved.fontHeading;
  if (resolved.fontCode) vars["--reading-font-code"] = resolved.fontCode;
  resolved.headingScale.forEach((value, index) => {
    vars[`--reading-h${index + 1}`] = String(value);
  });
  return vars;
}
