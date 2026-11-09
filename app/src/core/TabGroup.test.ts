import { describe, expect, it } from "vitest";
import {
  clampSidePanelWidth,
  createTabGroup,
  findTabGroup,
  findTabGroupByTabId,
  FIXED_SIDE_GROUP_IDS,
  getTabGroups,
  insertTabIntoGroup,
  parseSidePanelWidth,
  removeTabFromGroups,
  separateFixedSideGroups,
  SIDE_PANEL_WIDTH,
  splitTabGroup,
  updateTabSplitSizes,
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
});

describe("floating side panels", () => {
  const files = () => createTabGroup(["files"], FIXED_SIDE_GROUP_IDS.left);
  const ai = () => createTabGroup(["ai", "outline"], FIXED_SIDE_GROUP_IDS.right);

  it("takes both side groups out and leaves the editor splits as they were", () => {
    const main = createTabGroup(["a"], "a");
    const editors = splitTabGroup(main, "a", createTabGroup(["b"], "b"), "right", "editors");
    const withFiles = splitTabGroup(editors, "a", files(), "left", "outer");
    const root = splitTabGroup(withFiles, "b", ai(), "right", "inner");

    const { main: rest, sides } = separateFixedSideGroups(root);

    expect(getTabGroups(rest).map((group) => group.id)).toEqual(["a", "b"]);
    expect(rest).toMatchObject({ id: "editors", type: "split", direction: "horizontal" });
    expect(sides.left?.tabIds).toEqual(["files"]);
    expect(sides.right?.tabIds).toEqual(["ai", "outline"]);
    // 显示用的结果不改原来的树
    expect(getTabGroups(root).map((group) => group.id)).toEqual([
      FIXED_SIDE_GROUP_IDS.left,
      "a",
      "b",
      FIXED_SIDE_GROUP_IDS.right,
    ]);
  });

  it("has no editor area when only side panels are open", () => {
    const root = splitTabGroup(files(), FIXED_SIDE_GROUP_IDS.left, ai(), "right", "outer");
    const { main, sides } = separateFixedSideGroups(root);
    expect(main).toBeNull();
    expect(Object.keys(sides).sort()).toEqual(["left", "right"]);
  });

  it("returns the tree untouched when there are no side panels", () => {
    const root = splitTabGroup(createTabGroup(["a"], "a"), "a", createTabGroup(["b"], "b"), "bottom", "split");
    expect(separateFixedSideGroups(root)).toEqual({ main: root, sides: {} });
    expect(separateFixedSideGroups(null)).toEqual({ main: null, sides: {} });
  });
});
