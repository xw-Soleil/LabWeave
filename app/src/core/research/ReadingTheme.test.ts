import { describe, expect, it, vi } from "vitest";
import { readingThemeSchema, readingThemeVars, resolveReadingTheme, type ReadingTheme } from "./ReadingTheme";

const saved = vi.hoisted(() => new Map<string, unknown>());
vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: class {
    async init() {}
    async entries() {
      return [...saved.entries()];
    }
    async set(key: string, value: unknown) {
      saved.set(key, structuredClone(value));
    }
    async save() {}
  },
}));
vi.mock("@/components/ui/dialog", () => ({ Dialog: { confirm: vi.fn() } }));
vi.mock("@/utils/platform", () => ({ isMac: false }));

describe("reading themes", () => {
  it("persists readingTheme through the existing settings system and reloads it", async () => {
    const { Settings, settingsSchema } = await import("@/core/service/Settings");
    expect(settingsSchema.pick({ readingTheme: true }).parse({})).toEqual({ readingTheme: { preset: "default" } });
    const changed = vi.fn();
    const unwatch = Settings.watch("readingTheme", changed);
    const theme: ReadingTheme = { preset: "notion", fontSize: 18, fontBody: "Georgia" };
    Settings.readingTheme = theme;
    expect(saved.get("readingTheme")).toEqual(theme);
    expect(changed).toHaveBeenLastCalledWith(theme);
    unwatch();
    vi.resetModules();
    const reloaded = await import("@/core/service/Settings");
    expect(reloaded.Settings.readingTheme).toEqual(theme);
    expect(resolveReadingTheme(reloaded.Settings.readingTheme).lineWidth).toBe(44);
  });
  it.each([
    ["default", 15, 1.6, 46, [1.5, 1.3, 1.15, 1.05, 1, 1]],
    ["obsidian", 16, 1.5, 50, [1.6, 1.4, 1.25, 1.15, 1.08, 1.02]],
    ["notion", 16, 1.5, 44, [1.875, 1.5, 1.25, 1.1, 1, 1]],
  ] as const)("resolves the %s preset", (preset, fontSize, lineHeight, lineWidth, headingScale) => {
    expect(resolveReadingTheme({ preset })).toMatchObject({ fontSize, lineHeight, lineWidth, headingScale });
  });

  it("keeps only explicit overrides, with empty fonts falling back to the preset", () => {
    const theme: ReadingTheme = {
      preset: "obsidian",
      fontSize: 17.5,
      lineHeight: 1.75,
      lineWidth: 60,
      fontBody: "",
      fontCode: undefined,
      fontHeading: "Georgia, serif",
      headingScale: [2, 1.8, 1.6, 1.4, 1.2, 1],
    };
    const saved = JSON.stringify(theme);
    const resolved = resolveReadingTheme(readingThemeSchema.parse(JSON.parse(saved)));
    expect(resolved).toEqual({ ...theme, fontBody: '"Inter", system-ui', fontCode: '"JetBrains Mono", ui-monospace' });
    resolved.headingScale[0] = 8;
    expect(JSON.stringify(theme)).toBe(saved);
    expect(resolveReadingTheme({ preset: "obsidian" }).headingScale[0]).toBe(1.6);
  });

  it("uses exactly the CSS variable names and units consumed by reading.css", () => {
    expect(readingThemeVars(resolveReadingTheme({ preset: "obsidian" }))).toEqual({
      "--reading-font-body": '"Inter", system-ui',
      "--reading-font-code": '"JetBrains Mono", ui-monospace',
      "--reading-font-size": "16px",
      "--reading-line-height": "1.5",
      "--reading-line-width": "50rem",
      "--reading-h1": "1.6",
      "--reading-h2": "1.4",
      "--reading-h3": "1.25",
      "--reading-h4": "1.15",
      "--reading-h5": "1.08",
      "--reading-h6": "1.02",
      "--reading-table-margin": "auto",
    });
    for (const preset of ["default", "notion"] as const) {
      const vars = readingThemeVars(resolveReadingTheme({ preset }));
      expect(vars["--reading-table-margin"]).toBe("0");
      for (const font of ["body", "heading", "code"]) expect(vars).not.toHaveProperty(`--reading-font-${font}`);
    }
    expect(
      readingThemeVars(resolveReadingTheme({ preset: "default", fontHeading: "Georgia" }))["--reading-font-heading"],
    ).toBe("Georgia");
  });

  it.each([
    { preset: "missing" },
    { preset: "default", fontSize: -1 },
    { preset: "default", lineHeight: Infinity },
    { preset: "default", lineWidth: "50" },
    { preset: "default", headingScale: [1, 2] },
  ])("rejects malformed saved values: %j", (value) => {
    expect(readingThemeSchema.safeParse(value).success).toBe(false);
  });
});
