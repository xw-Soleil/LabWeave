import { describe, expect, it } from "vitest";
import { researchContextMenu, RESEARCH_CONTEXT_ACTIONS } from "./ResearchContextMenu";

describe("research context menu", () => {
  it("restores labeled edit and alignment actions even with an old hidden icon menu", () => {
    const menu = researchContextMenu([
      {
        id: "old-grid",
        type: "group",
        visible: false,
        children: [
          { id: "alignLeft", type: "item", visible: false },
          { id: "deleteSelectedStageObjects", type: "item", visible: false },
        ],
      },
      { id: "custom-command", type: "item", visible: true },
    ]);
    const flatten = (items: typeof menu): typeof menu =>
      items.flatMap((item) => [item, ...flatten(item.children ?? [])]);
    const commands = flatten(menu);
    for (const id of RESEARCH_CONTEXT_ACTIONS) {
      expect(commands.filter((item) => item.id === id)).toEqual([{ id, type: "item", visible: true }]);
    }
    expect(menu.some((item) => item.id === "custom-command")).toBe(true);
    expect(menu.some((item) => item.id === "old-grid")).toBe(false);
    expect(researchContextMenu(menu)).toEqual(menu);
  });
});
