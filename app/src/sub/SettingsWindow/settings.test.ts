import { describe, expect, it, vi } from "vitest";
import { categories, categoryIcons, getVisibleCategories, researchCommonSections } from "./settings";

vi.mock("@/components/ui/field", () => ({
  SettingField: () => null,
  SettingRow: () => null,
  researchSettingText: () => ({ title: "", description: "" }),
}));
vi.mock("@/core/service/feedbackService/SoundService", () => ({ SoundService: { play: {} } }));
vi.mock("@/core/service/Settings", () => ({ Settings: {}, settingsSchema: { shape: {} } }));

const icons = categoryIcons as Record<string, Record<string, unknown>>;

function expectIcons(tree: Record<string, Record<string, unknown>>) {
  for (const [category, groups] of Object.entries(tree)) {
    expect(icons[category]?.icon, category).toBeDefined();
    for (const group of Object.keys(groups)) {
      expect(icons[category][group], `${category}.${group}`).toBeDefined();
    }
  }
}

// 设置页按 categoryIcons 取大类和分组的图标，缺一个整页就会报错
describe("settings categories", () => {
  it("has an icon for every category and group of the visible navigation", () => {
    expectIcons(getVisibleCategories());
    expectIcons({ common: Object.fromEntries(researchCommonSections.map((section) => [section.id, section.items])) });
  });

  it("has an icon for every category and group in the full category list", () => {
    expectIcons(categories);
  });

  it("hides settings that do nothing", () => {
    const visible = Object.values(getVisibleCategories()).flatMap((groups) => Object.values(groups).flat());
    for (const key of [
      "windowBackgroundAlpha",
      "windowBackgroundOpacityAfterOpenClickThrough",
      "windowBackgroundOpacityAfterCloseClickThrough",
      "showQuickSettingsToolbar",
      "isEnableEntityCollision",
      "mouseLeftMode",
    ]) {
      expect(visible).not.toContain(key);
    }
    expect(visible).toContain("researchShowFullMenu");
  });

  it("drops groups and categories left empty after hiding", () => {
    for (const groups of Object.values(getVisibleCategories())) {
      expect(Object.keys(groups).length).toBeGreaterThan(0);
      for (const keys of Object.values(groups)) expect(keys.length).toBeGreaterThan(0);
    }
  });
});
