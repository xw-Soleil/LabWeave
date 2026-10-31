import { afterEach, describe, expect, it, vi } from "vitest";
import { URI } from "vscode-uri";

vi.mock("@/core/service/Settings", () => ({ Settings: { researchFolderPath: "/Users/me/Research" } }));

import {
  isRecentFileVisible,
  keyBindI18nKey,
  RESEARCH_COMMAND_IDS,
  RESEARCH_DISABLED_KEYBIND_IDS,
  RESEARCH_GLOBAL_MENU,
  RESEARCH_KEYBIND_IDS,
  RESEARCH_SHELL_SCOPE_KEYBIND_IDS,
} from "./ResearchMenu";

afterEach(() => {
  vi.unstubAllEnvs();
});

function menuItemIds(nodes: typeof RESEARCH_GLOBAL_MENU): string[] {
  return nodes.flatMap((node) => [
    ...(node.type === "item" ? [node.id] : []),
    ...menuItemIds((node.children ?? []) as typeof RESEARCH_GLOBAL_MENU),
  ]);
}

describe("research menu", () => {
  it("keeps the four top menus that the native macOS menu knows", () => {
    expect(RESEARCH_GLOBAL_MENU.map((node) => node.id)).toEqual(["file", "view", "settings", "about"]);
  });

  it("offers every new research command in the menu and the command palette", () => {
    const items = menuItemIds(RESEARCH_GLOBAL_MENU);
    for (const id of RESEARCH_KEYBIND_IDS) {
      expect(items).toContain(id);
      expect(RESEARCH_COMMAND_IDS.has(id)).toBe(true);
      expect(RESEARCH_SHELL_SCOPE_KEYBIND_IDS.has(id)).toBe(true);
    }
    expect(items).toContain("openAboutWindow");
  });

  it("never disables a command it shows", () => {
    for (const id of [...menuItemIds(RESEARCH_GLOBAL_MENU), ...RESEARCH_COMMAND_IDS]) {
      expect(RESEARCH_DISABLED_KEYBIND_IDS.has(id)).toBe(false);
    }
  });

  it("looks up research keybind labels in the research namespace", () => {
    expect(keyBindI18nKey("researchToggleAIChat")).toBe("research:menu.items.researchToggleAIChat");
    expect(keyBindI18nKey("saveFile")).toBe("saveFile");
  });
});

describe("recent files", () => {
  it("only lists files inside the research folder in the research shell", () => {
    expect(isRecentFileVisible(URI.file("/Users/me/Research/topic/a.prg"))).toBe(true);
    expect(isRecentFileVisible(URI.file("/Users/me/Other/b.prg"))).toBe(false);
    expect(isRecentFileVisible(URI.parse("draft:1"))).toBe(false);
  });

  it("lists every file when the research shell is off", () => {
    vi.stubEnv("LR_RESEARCH_SHELL", "false");
    expect(isRecentFileVisible(URI.file("/Users/me/Other/b.prg"))).toBe(true);
  });
});
