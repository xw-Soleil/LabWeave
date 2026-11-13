import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import YAML from "yaml";
import { settingKeysOf, settingsPages } from "./settings";

vi.mock("@/components/ui/field", () => ({
  SettingField: () => null,
  SettingRow: () => null,
  researchSettingText: () => ({ title: "", description: "" }),
}));
vi.mock("@/core/service/Settings", () => ({ Settings: {}, settingsSchema: { shape: {} } }));
vi.mock("./themes", () => ({ default: () => null }));
vi.mock("./customization/effects", () => ({ default: () => null }));
vi.mock("./customization/sounds", () => ({ default: () => null }));

const shownKeys = settingsPages.flatMap(settingKeysOf);

describe("settings pages", () => {
  it("groups translation, library location and the existing theme page under reading", () => {
    const reading = settingsPages.find((page) => page.id === "reading")!;
    expect(reading.sections.flatMap((section) => section.items)).toEqual([
      "translateService",
      "translateOnSelect",
      "translateProxy",
      "translateProxyUrl",
      "literatureLibraryPath",
      { subPage: "readingTheme" },
    ]);
    expect(settingKeysOf(settingsPages.find((page) => page.id === "folder")!)).not.toContain("literatureLibraryPath");
    expect(settingKeysOf(settingsPages.find((page) => page.id === "ai")!)).not.toContain("translateService");
  });
  it("lists every setting on exactly one page", () => {
    const duplicated = shownKeys.filter((key, index) => shownKeys.indexOf(key) !== index);
    expect(duplicated).toEqual([]);
    expect(new Set(settingsPages.map((page) => page.id)).size).toBe(settingsPages.length);
    for (const page of settingsPages) {
      expect(page.sections.length, page.id).toBeGreaterThan(0);
      for (const section of page.sections) expect(section.items.length, `${page.id}.${section.id}`).toBeGreaterThan(0);
    }
  });

  it("does not show settings that are forced off or do nothing", () => {
    for (const key of [
      "telemetry",
      "allowGlobalHotKeys",
      "isClassroomMode",
      "autoImportTxtFileWhenOpenPrg",
      "aiAutoApproveMcpTools",
      "researchSession",
      "mouseWheelMode",
      "mouseSideWheelMode",
      "macTrackpadAndMouseWheelDifference",
      "windowBackgroundAlpha",
      "showQuickSettingsToolbar",
      "isEnableEntityCollision",
      "mouseLeftMode",
      "compatibilityMode",
      "nodeDetailsPanel",
    ]) {
      expect(shownKeys).not.toContain(key);
    }
  });

  // 设置名、页名、小标题和子页面的文字缺了，界面上会直接露出 key
  it.each(["zh_CN.yml", "en.yml"])("has setting, page, section and sub-page titles in %s", (name) => {
    const locale = YAML.parse(readFileSync(new URL(`../../locales/${name}`, import.meta.url), "utf8"));
    for (const key of shownKeys) {
      expect(locale.settings[key]?.title, `${name}: settings.${key}.title`).toBeTypeOf("string");
    }
    const texts = locale.research.settings;
    for (const page of settingsPages) {
      expect(texts.pages[page.id]?.title, `${name}: pages.${page.id}.title`).toBeTypeOf("string");
      if (page.sections.length < 2) continue;
      for (const section of page.sections) {
        expect(texts.pages[page.id][section.id], `${name}: pages.${page.id}.${section.id}`).toBeTypeOf("string");
      }
    }
    const subPages = settingsPages.flatMap((page) =>
      page.sections.flatMap((section) => section.items.filter((item) => typeof item !== "string")),
    );
    expect(subPages.length).toBeGreaterThan(0);
    for (const { subPage } of subPages) {
      for (const field of ["title", "description", "button"]) {
        expect(texts.subPages[subPage]?.[field], `${name}: subPages.${subPage}.${field}`).toBeTypeOf("string");
      }
    }
  });
});
