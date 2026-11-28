import type { Settings } from "@/core/service/Settings";

type MenuItem = Settings["contextMenuConfig"][number];

const editActions = ["cut", "copy", "paste", "deleteSelectedStageObjects"];
const historyActions = ["undo", "redo", "selectAll"];
export const RESEARCH_ALIGNMENT_ACTIONS = [
  "alignLeft",
  "alignCenterVertical",
  "alignRight",
  "alignTop",
  "alignCenterHorizontal",
  "alignBottom",
  "alignHorizontalSpaceBetween",
  "alignVerticalSpaceBetween",
];
export const RESEARCH_CONTEXT_ACTIONS = new Set([
  ...editActions,
  ...historyActions,
  ...RESEARCH_ALIGNMENT_ACTIONS,
  "straightenSelectedEdges",
]);

/** 这两项现在在文字那一段的「字号」一行里（字号框加两个按钮），自定义清单里留着的不再重复列一遍 */
const inFontSizeRow = new Set(["increaseFontSize", "decreaseFontSize"]);

/** Old saved icon grids must not hide the common labeled commands. Keep other custom items. */
export function researchContextMenu(config: MenuItem[]): MenuItem[] {
  const stripCommon = (items: MenuItem[]): MenuItem[] =>
    items.flatMap((item) => {
      if (RESEARCH_CONTEXT_ACTIONS.has(item.id) || inFontSizeRow.has(item.id) || item.id.startsWith("research-common-"))
        return [];
      if (!item.children) return [item];
      const children = stripCommon(item.children);
      return children.some((child) => child.type !== "separator") ? [{ ...item, children }] : [];
    });
  const commands = (ids: string[]): MenuItem[] => ids.map((id) => ({ type: "item", id, visible: true }));
  const separator = (id: string): MenuItem => ({ type: "separator", id, visible: true });
  return [
    ...commands(editActions),
    separator("research-common-edit"),
    ...commands(historyActions),
    separator("research-common-history"),
    {
      type: "sub",
      id: "research-common-align",
      icon: "AlignCenterHorizontal",
      visible: true,
      children: commands(RESEARCH_ALIGNMENT_ACTIONS),
    },
    ...commands(["straightenSelectedEdges"]),
    separator("research-common-extra"),
    ...stripCommon(config),
  ];
}
