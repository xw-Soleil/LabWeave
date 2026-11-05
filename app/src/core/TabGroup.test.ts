import { describe, expect, it } from "vitest";
import {
  clampSidePanelWidth,
  createTabGroup,
  findFixedSideChild,
  findTabGroup,
  findTabGroupByTabId,
  FIXED_SIDE_GROUP_IDS,
  getTabGroups,
  insertTabIntoGroup,
  parseSidePanelWidth,
  removeTabFromGroups,
  SIDE_PANEL_WIDTH,
  splitTabGroup,
  updateTabSplitSizes,
  WELCOME_GROUP_ID,
  welcomeLayout,
} from "./TabGroup";

describe("TabGroup", () => {
  it("splits groups on either side", () => {
    const first = createTabGroup(["a"], "first");
    const second = createTabGroup(["b"], "second");
    const root = splitTabGroup(first, first.id, second, "left", "split");

    expect(root).toMatchObject({
      id: "split",
      type: "split",
      direction: "horizontal",
      children: [{ id: "second" }, { id: "first" }],
      sizes: [20, 80],
    });
  });

  it("defaults right side splits to one fifth for the new group", () => {
    const first = createTabGroup(["a"], "first");
    const second = createTabGroup(["b"], "second");
    const root = splitTabGroup(first, "first", second, "right", "split");

    expect(root).toMatchObject({
      direction: "horizontal",
      children: [{ id: "first" }, { id: "second" }],
      sizes: [80, 20],
    });
  });

  it("can create stable left/right side groups for reuse", () => {
    const center = createTabGroup(["project"], "center");
    const left = createTabGroup(["find"], FIXED_SIDE_GROUP_IDS.left);
    const withLeft = splitTabGroup(center, "center", left, "left");
    expect(findTabGroup(withLeft, FIXED_SIDE_GROUP_IDS.left)?.tabIds).toEqual(["find"]);

    const stacked = insertTabIntoGroup(withLeft, FIXED_SIDE_GROUP_IDS.left, "tags");
    expect(findTabGroup(stacked, FIXED_SIDE_GROUP_IDS.left)?.tabIds).toEqual(["find", "tags"]);

    const right = createTabGroup(["ai"], FIXED_SIDE_GROUP_IDS.right);
    const withRight = splitTabGroup(stacked, "center", right, "right");
    expect(findTabGroup(withRight, FIXED_SIDE_GROUP_IDS.left)?.tabIds).toEqual(["find", "tags"]);
    expect(findTabGroup(withRight, FIXED_SIDE_GROUP_IDS.right)?.tabIds).toEqual(["ai"]);
  });

  it("moves and reorders tabs without duplicates", () => {
    const root = createTabGroup(["a", "b", "c"], "group");
    const reordered = insertTabIntoGroup(root, "group", "a", 2);

    expect(getTabGroups(reordered)[0].tabIds).toEqual(["b", "c", "a"]);
  });

  it("collapses an empty source group", () => {
    const first = createTabGroup(["a"], "first");
    const second = createTabGroup(["b"], "second");
    const root = splitTabGroup(first, "first", second, "right", "split");
    const result = removeTabFromGroups(root, "a");

    expect(result.root).toEqual(second);
    expect(findTabGroupByTabId(result.root, "b")?.id).toBe("second");
  });

  it("selects a neighboring tab when removing the active tab", () => {
    const group = createTabGroup(["a", "b", "c"], "group");
    group.activeTabId = "b";
    const result = removeTabFromGroups(group, "b");

    expect(result.nextActiveTabId).toBe("c");
    expect(getTabGroups(result.root)[0]).toMatchObject({ tabIds: ["a", "c"], activeTabId: "c" });
  });

  it("updates nested split sizes", () => {
    const first = createTabGroup(["a"], "first");
    const second = createTabGroup(["b"], "second");
    const root = splitTabGroup(first, "first", second, "bottom", "split");
    const updated = updateTabSplitSizes(root, "split", [30, 70]);

    expect(updated).toMatchObject({ direction: "vertical", sizes: [30, 70] });
  });
});

describe("fixed side panel width", () => {
  it("clamps to 220–480px and never takes more than half of its split", () => {
    expect(clampSidePanelWidth(100)).toBe(220);
    expect(clampSidePanelWidth(300.4)).toBe(300);
    expect(clampSidePanelWidth(900)).toBe(480);
    expect(clampSidePanelWidth(400, 600)).toBe(300);
    // 窗口窄到一半都不够 220 时仍保留最小宽度
    expect(clampSidePanelWidth(400, 300)).toBe(220);
  });

  it("falls back to the default width when nothing usable is stored", () => {
    expect(parseSidePanelWidth(null, "left")).toBe(SIDE_PANEL_WIDTH.default.left);
    expect(parseSidePanelWidth("", "right")).toBe(SIDE_PANEL_WIDTH.default.right);
    expect(parseSidePanelWidth("wide", "left")).toBe(SIDE_PANEL_WIDTH.default.left);
    expect(parseSidePanelWidth("260", "left")).toBe(260);
    expect(parseSidePanelWidth("2000", "right")).toBe(480);
  });

  it("finds the side group hanging directly off a left/right split", () => {
    const main = createTabGroup(["project"], "main");
    const left = createTabGroup(["files"], FIXED_SIDE_GROUP_IDS.left);
    const right = createTabGroup(["ai"], FIXED_SIDE_GROUP_IDS.right);
    const withLeft = splitTabGroup(main, "main", left, "left", "outer");
    const both = splitTabGroup(withLeft, "main", right, "right", "inner");
    if (both?.type !== "split") throw new Error("expected a split");

    expect(findFixedSideChild(both)).toEqual({ index: 0, edge: "left" });
    if (both.children[1].type !== "split") throw new Error("expected a nested split");
    expect(findFixedSideChild(both.children[1])).toEqual({ index: 1, edge: "right" });

    const vertical = splitTabGroup(left, left.id, createTabGroup(["x"], "x"), "bottom", "vertical");
    if (vertical?.type !== "split") throw new Error("expected a split");
    expect(findFixedSideChild(vertical)).toBeUndefined();
  });
});

describe("welcome layout (no workspace open)", () => {
  const files = () => createTabGroup(["files"], FIXED_SIDE_GROUP_IDS.left);
  const ai = () => createTabGroup(["ai"], FIXED_SIDE_GROUP_IDS.right);

  it("is only the welcome page when no panel is open", () => {
    expect(welcomeLayout(null)).toMatchObject({ type: "group", id: WELCOME_GROUP_ID, tabIds: [] });
  });

  it("puts the welcome page right of the files panel, which keeps its fixed width", () => {
    const layout = welcomeLayout(files());
    if (layout.type !== "split") throw new Error("expected a split");
    expect(layout.children.map((child) => child.id)).toEqual([FIXED_SIDE_GROUP_IDS.left, WELCOME_GROUP_ID]);
    expect(findFixedSideChild(layout)).toEqual({ index: 0, edge: "left" });
  });

  it("hides the AI chat and keeps the rest of the layout", () => {
    const root = splitTabGroup(files(), FIXED_SIDE_GROUP_IDS.left, ai(), "right", "outer");
    const layout = welcomeLayout(root, ["ai"]);
    expect(getTabGroups(layout).map((group) => group.id)).toEqual([FIXED_SIDE_GROUP_IDS.left, WELCOME_GROUP_ID]);
    // 显示用的布局不改原来的树
    expect(getTabGroups(root).map((group) => group.id)).toEqual([
      FIXED_SIDE_GROUP_IDS.left,
      FIXED_SIDE_GROUP_IDS.right,
    ]);
  });

  it("keeps other panels docked on the right, with the welcome page in between", () => {
    const right = createTabGroup(["ai", "outline"], FIXED_SIDE_GROUP_IDS.right);
    const root = splitTabGroup(files(), FIXED_SIDE_GROUP_IDS.left, right, "right", "outer");
    const layout = welcomeLayout(root, ["ai"]);
    expect(getTabGroups(layout).map((group) => group.id)).toEqual([
      FIXED_SIDE_GROUP_IDS.left,
      WELCOME_GROUP_ID,
      FIXED_SIDE_GROUP_IDS.right,
    ]);
    expect(findTabGroup(layout, FIXED_SIDE_GROUP_IDS.right)?.tabIds).toEqual(["outline"]);
  });

  it("puts the welcome page left of a right-docked files panel", () => {
    const layout = welcomeLayout(createTabGroup(["files"], FIXED_SIDE_GROUP_IDS.right));
    if (layout.type !== "split") throw new Error("expected a split");
    expect(layout.children.map((child) => child.id)).toEqual([WELCOME_GROUP_ID, FIXED_SIDE_GROUP_IDS.right]);
    expect(findFixedSideChild(layout)).toEqual({ index: 1, edge: "right" });
  });
});
