import {
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/components/ui/context-menu";
import { Project } from "@/core/Project";
import { ACTIVITY_MARKS, noteCardMarks } from "@/core/research/ActivityLog";
import { promptImageCaption, refreshFileCard, resolveFileCardPath } from "@/core/research/FileCardFactory";
import { open } from "@tauri-apps/plugin-shell";
import { toast } from "sonner";
import { researchContextMenu, RESEARCH_CONTEXT_ACTIONS } from "@/core/research/ResearchContextMenu";
import { KeyBindsUI } from "@/core/service/controlService/shortcutKeysEngine/KeyBindsUI";
import { allKeyBinds } from "@/core/service/controlService/shortcutKeysEngine/shortcutKeysRegister";
import { ColorManager } from "@/core/service/feedbackService/ColorManager";
import { TextNodeSmartTools } from "@/core/service/dataManageService/textNodeSmartTools";
import { Settings } from "@/core/service/Settings";
import { FileCardNode } from "@/core/stage/stageObject/entity/FileCardNode";
import { ImageNode, rotateSelectedImageNodes } from "@/core/stage/stageObject/entity/ImageNode";
import { TextNode, type TextNodeAlign } from "@/core/stage/stageObject/entity/TextNode";
import { activeResourceTabAtom } from "@/state";
import { cn } from "@/utils/cn";
import ColorPaletteWindow from "@/sub/ColorPaletteWindow";
import ColorWindow from "@/sub/ColorWindow";
import { Color } from "@graphif/data-structures";
import { useAtom } from "jotai";
import type { LucideProps } from "lucide-react";
import * as LucideIcons from "lucide-react";
import type { ComponentType, ReactNode } from "react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import KeyTooltip from "./key-tooltip";
import { Button } from "./ui/button";

// 简化色盘：红绿各有低饱和度行 + 高饱和度行，其余色系各4个 + 黑白灰
// 排列：grid-cols-4，每行4个色块
const SIMPLE_PALETTE: (Color | null)[] = [
  // 红（低饱和度，亮→暗）
  new Color(235, 205, 205),
  new Color(200, 145, 145),
  new Color(155, 85, 85),
  new Color(100, 45, 45),
  // 红（高饱和度，亮→暗）
  new Color(240, 160, 155),
  new Color(210, 80, 75),
  new Color(150, 35, 30),
  new Color(47, 14, 15),
  // 橙
  new Color(235, 215, 195),
  new Color(210, 170, 130),
  new Color(165, 120, 80),
  new Color(110, 75, 45),
  // 黄
  new Color(235, 230, 190),
  new Color(210, 200, 120),
  new Color(165, 150, 60),
  new Color(110, 95, 30),
  // 绿（低饱和度，亮→暗）
  new Color(200, 225, 200),
  new Color(135, 185, 135),
  new Color(80, 140, 80),
  new Color(40, 85, 40),
  // 绿（高饱和度，亮→暗）
  new Color(155, 220, 140),
  new Color(90, 165, 75),
  new Color(65, 101, 57),
  new Color(30, 55, 25),
  // 青
  new Color(195, 225, 225),
  new Color(120, 180, 180),
  new Color(65, 130, 130),
  new Color(30, 80, 80),
  // 蓝
  new Color(200, 210, 235),
  new Color(130, 150, 200),
  new Color(70, 95, 160),
  new Color(35, 50, 105),
  // 紫
  new Color(220, 205, 235),
  new Color(170, 140, 205),
  new Color(115, 80, 160),
  new Color(65, 40, 105),
  // 消色
  new Color(255, 255, 255),
  new Color(180, 180, 180),
  new Color(90, 90, 90),
  new Color(0, 0, 0),
];

const Content = ContextMenuContent;
const Item = ContextMenuItem;
const CheckboxItem = ContextMenuCheckboxItem;
const Group = ContextMenuGroup;
const Sub = ContextMenuSub;
const SubTrigger = ContextMenuSubTrigger;
const SubContent = ContextMenuSubContent;

/**
 * 字号这一行（照 Word）：一个显示当前字号的框，能直接填数字，点箭头展开常用字号；旁边两个按钮一档一档调。
 * 它不是菜单项，点了不关菜单，可以看着白板连着调。选中的几个节点字号不一样时框里留空。
 */
function FontSizeRow({ project, nodes }: { project: Project; nodes: TextNode[] }) {
  const { t } = useTranslation("contextMenu");
  const [, redraw] = useState(0);
  const [listOpen, setListOpen] = useState(false);
  const [draft, setDraft] = useState<string>();
  const sizes = new Set(nodes.map((node) => node.getFontSize()));
  const shared = sizes.size === 1 ? [...sizes][0] : undefined;
  const apply = (change: () => void) => {
    project.controller.resetCountdownTimer();
    change();
    setDraft(undefined);
    redraw((count) => count + 1);
  };
  const commit = () => {
    const size = Number(draft);
    // 半截数字（想填 48 才敲了个 4）不当真
    if (draft !== undefined && Number.isFinite(size) && size >= 6 && size <= 512) {
      apply(() => TextNodeSmartTools.setSelectedTextNodesFontSize(project, size));
    } else setDraft(undefined);
  };
  return (
    // 菜单会把字母、数字键当成「跳到某一项」，方向键当成换项；这一行里的键盘输入不往上传
    <div className="px-2 py-1" onKeyDown={(event) => event.stopPropagation()}>
      {/* 左边留的空和图标、文字的位置，同上下几项带勾的菜单项对齐 */}
      <div className="flex items-center gap-2 pl-6 [&>svg]:size-4 [&>svg]:shrink-0">
        <LucideIcons.ALargeSmall />
        <span className="flex-1 text-sm">{t("fontSize")}</span>
        <div className="border-input focus-within:border-ring flex h-7 items-center rounded-md border">
          <input
            aria-label={t("fontSize")}
            inputMode="numeric"
            className="w-9 bg-transparent pl-1.5 text-center text-sm tabular-nums outline-none"
            value={draft ?? shared ?? ""}
            placeholder="—"
            onChange={(event) => setDraft(event.target.value.replace(/[^\d.]/g, ""))}
            onFocus={(event) => event.target.select()}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === "Enter") commit();
              else if (event.key === "Escape") setDraft(undefined);
            }}
          />
          <button
            type="button"
            aria-label={t("fontSizeList")}
            title={t("fontSizeList")}
            aria-expanded={listOpen}
            className="text-muted-foreground hover:text-foreground flex h-full cursor-pointer items-center px-1"
            onClick={() => setListOpen((open) => !open)}
          >
            <LucideIcons.ChevronDown className={cn("size-3.5 transition-transform", listOpen && "rotate-180")} />
          </button>
        </div>
        <KeyTooltip keyId="increaseFontSize">
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label={t("increaseFontSize")}
            onClick={() => apply(() => TextNodeSmartTools.stepSelectedTextNodesFontSize(project, "increase"))}
          >
            <LucideIcons.AArrowUp />
          </Button>
        </KeyTooltip>
        <KeyTooltip keyId="decreaseFontSize">
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label={t("decreaseFontSize")}
            onClick={() => apply(() => TextNodeSmartTools.stepSelectedTextNodesFontSize(project, "decrease"))}
          >
            <LucideIcons.AArrowDown />
          </Button>
        </KeyTooltip>
      </div>
      {listOpen && (
        <div className="mt-1 grid grid-cols-6 gap-0.5">
          {TextNode.FONT_SIZES.map((size) => (
            <button
              key={size}
              type="button"
              aria-pressed={size === shared}
              className={cn(
                "hover:bg-accent cursor-pointer rounded px-1 py-1 text-xs tabular-nums",
                size === shared && "bg-accent font-medium",
              )}
              onClick={() => apply(() => TextNodeSmartTools.setSelectedTextNodesFontSize(project, size))}
            >
              {size}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * 右键菜单
 * @returns
 */
export default function MyContextMenuContent() {
  const [tab] = useAtom(activeResourceTabAtom);
  const p = tab instanceof Project ? tab : undefined;
  const { t } = useTranslation("contextMenu");
  const { t: tKeyBind } = useTranslation("keyBinds");
  const { t: tResearch } = useTranslation("research");
  const [config] = Settings.use("contextMenuConfig");
  const menuConfig = researchContextMenu(config);

  // 加载用户自定义颜色
  const [userColorList, setUserColorList] = useState<Color[]>([]);
  useEffect(() => {
    ColorManager.getUserEntityFillColors().then(setUserColorList);
    const unsub = ColorManager.subscribe(() => {
      ColorManager.getUserEntityFillColors().then(setUserColorList);
    });
    return unsub;
  }, []);

  if (!p) return <></>;

  type ContextMenuConfigItem = (typeof Settings)["contextMenuConfig"][number];

  const getIcon = (itemId?: string, iconName?: string) => {
    if (iconName) {
      const IconComp = (LucideIcons as unknown as Record<string, ComponentType<LucideProps>>)[iconName];
      if (IconComp) return <IconComp />;
    }
    if (itemId) {
      const kb = allKeyBinds.find((k) => k.id === itemId);
      if (kb?.icon) {
        const IconComp = kb.icon;
        return <IconComp />;
      }
    }
    return null;
  };

  const getItemTitle = (itemId: string, label?: string) =>
    itemId === "research-common-align"
      ? t("alignObjects")
      : label || tKeyBind(`${itemId}.title`, { defaultValue: t(itemId, { defaultValue: itemId }) });

  const checkVisible = (itemId: string) => {
    const kb = allKeyBinds.find((k) => k.id === itemId);
    if (kb && kb.when(p) === false) return false;
    return true;
  };

  const isConfigVisible = (it: ContextMenuConfigItem): boolean => {
    if (RESEARCH_CONTEXT_ACTIONS.has(it.id)) return true;
    if (it.visible === false) return false;
    if (it.type === "separator") return true;
    if (it.type === "setColorForSelected") {
      return p.stageManager.getSelectedStageObjects().some((obj) => "color" in obj);
    }
    if (it.type === "group" || it.type === "sub") {
      return (it.children || []).some(isConfigVisible);
    }
    return checkVisible(it.id);
  };

  const renderButtonGroupChild = (it: ContextMenuConfigItem, isGrid: boolean = false) => {
    if (!isConfigVisible(it)) return null;
    if (it.type === "separator") return <div key={it.id} />;

    const uiKb = KeyBindsUI.getUIKeyBind(it.id);
    const keyBind = uiKb ?? allKeyBinds.find((k) => k.id === it.id);

    return (
      <KeyTooltip key={`tooltip-${it.id}`} keyId={it.id}>
        <Button
          variant="ghost"
          size="icon"
          className={isGrid ? "size-6" : ""}
          onClick={() => {
            keyBind?.onPress?.(p);
            if ((keyBind?.isContinuous || keyBind?.onRelease) && keyBind?.onRelease) {
              setTimeout(() => {
                keyBind.onRelease?.(p);
              }, 100);
            }
          }}
        >
          {getIcon(it.id, it.icon)}
        </Button>
      </KeyTooltip>
    );
  };

  const renderGridGroupContent = (groupConfig: ContextMenuConfigItem) => (
    <div
      key={groupConfig.id}
      className="grid gap-0"
      style={{
        gridTemplateColumns: `repeat(${groupConfig.cols || 3}, 1fr)`,
      }}
    >
      {groupConfig.children?.map((it: any) => renderButtonGroupChild(it, true))}
    </div>
  );

  const renderSetColorForSelected = (itemConfig: ContextMenuConfigItem) => {
    const hasColorableSelectedObject = p.stageManager.getSelectedStageObjects().some((it) => "color" in it);
    if (!hasColorableSelectedObject) return null;

    return (
      <Sub key={itemConfig.id}>
        <SubTrigger>
          {getIcon(itemConfig.id, itemConfig.icon)}
          {getItemTitle(itemConfig.id, itemConfig.label)}
        </SubTrigger>
        <SubContent>
          <Item onClick={() => p.stageObjectColorManager.setSelectedStageObjectColor(Color.Transparent)}>
            {getIcon("resetSelectedStageObjectColor", "Slash")}
            {t("resetColor")}
          </Item>

          <Item className="grid w-fit grid-cols-4 gap-0 bg-transparent!">
            {SIMPLE_PALETTE.map((color, index) =>
              color ? (
                <div
                  key={index}
                  className="hover:outline-accent-foreground size-4 -outline-offset-2 hover:outline-2"
                  style={{ backgroundColor: color.toString() }}
                  onMouseEnter={() => {
                    if (!Settings.colorPanelMouseEnterPreview) return;
                    p.controller.resetCountdownTimer();
                    p.stageObjectColorManager.setSelectedStageObjectColor(color, true);
                  }}
                  onClick={() => {
                    p.controller.resetCountdownTimer();
                    p.stageObjectColorManager.setSelectedStageObjectColor(color, false);
                  }}
                />
              ) : (
                <div key={index} className="size-4" />
              ),
            )}
          </Item>
          <Item onClick={() => p.stageObjectColorManager.setSelectedStageObjectColor(new Color(11, 45, 14, 0))}>
            改为强制特殊透明色
          </Item>
          <Item onClick={() => ColorWindow.open()}>打开调色板</Item>
          <Item onClick={() => ColorPaletteWindow.open()}>打开舞台颜色分布表</Item>
        </SubContent>
      </Sub>
    );
  };

  const renderSetPenStrokeColor = (itemConfig: ContextMenuConfigItem) => {
    return (
      <Sub key={itemConfig.id}>
        <SubTrigger>
          {getIcon(itemConfig.id, itemConfig.icon)}
          {getItemTitle(itemConfig.id, itemConfig.label)}
        </SubTrigger>
        <SubContent>
          <Item onClick={() => (Settings.autoFillPenStrokeColor = Color.Transparent.toArray())}>
            {getIcon("resetPenStrokeColor", "Slash")}
            {t("resetColor")}
          </Item>
          <Item className="grid w-fit grid-cols-4 gap-0 bg-transparent!">
            {SIMPLE_PALETTE.map((color, index) =>
              color ? (
                <div
                  key={index}
                  className="hover:outline-accent-foreground size-4 -outline-offset-2 hover:outline-2"
                  style={{ backgroundColor: color.toString() }}
                  onMouseEnter={() => {
                    if (!Settings.colorPanelMouseEnterPreview) return;
                    p.controller.resetCountdownTimer();
                    Settings.autoFillPenStrokeColor = color.toArray();
                  }}
                  onClick={() => {
                    p.controller.resetCountdownTimer();
                    Settings.autoFillPenStrokeColor = color.toArray();
                  }}
                />
              ) : (
                <div key={index} className="size-4" />
              ),
            )}
          </Item>
          <Item onClick={() => ColorWindow.open()}>打开调色板</Item>
        </SubContent>
      </Sub>
    );
  };

  const renderItem = (itemConfig: ContextMenuConfigItem): ReactNode => {
    if (!isConfigVisible(itemConfig)) return null;

    if (itemConfig.type === "separator") {
      return <div key={itemConfig.id} className="bg-border my-1 h-px" />;
    }

    if (itemConfig.type === "group" && itemConfig.layout === "row") {
      return (
        <Item key={itemConfig.id} className="gap-0 bg-transparent! p-0">
          {itemConfig.children?.map((it: any) => renderButtonGroupChild(it))}
        </Item>
      );
    }

    if (itemConfig.type === "group" && itemConfig.layout === "grid") {
      return (
        <Item key={itemConfig.id} className="gap-0 bg-transparent! p-0">
          {renderGridGroupContent(itemConfig)}
        </Item>
      );
    }

    if (itemConfig.type === "setColorForSelected") {
      return renderSetColorForSelected(itemConfig);
    }

    if (itemConfig.type === "setPenStrokeColor") {
      return renderSetPenStrokeColor(itemConfig);
    }

    if (itemConfig.type === "sub") {
      return (
        <Sub key={itemConfig.id}>
          <SubTrigger>
            {getIcon(itemConfig.id, itemConfig.icon)}
            {getItemTitle(itemConfig.id, itemConfig.label)}
          </SubTrigger>
          <SubContent>
            {itemConfig.id === "research-common-align" && p.stageManager.getSelectedEntities().length < 2 && (
              <ContextMenuLabel>{t("alignSelectionHint")}</ContextMenuLabel>
            )}
            {renderItems(itemConfig.children || [])}
          </SubContent>
        </Sub>
      );
    }

    // Standard item
    const enabled = checkVisible(itemConfig.id);
    if (!enabled && !RESEARCH_CONTEXT_ACTIONS.has(itemConfig.id)) return null;
    const uiKb = KeyBindsUI.getUIKeyBind(itemConfig.id);
    const keyBind = uiKb ?? allKeyBinds.find((k) => k.id === itemConfig.id);
    const action = keyBind?.onPress;
    const release = keyBind?.onRelease;
    const isContinuous = keyBind?.isContinuous;
    const shortcut = uiKb?.key;

    const handleClick = () => {
      action?.(p);
      if ((isContinuous || release) && release) {
        setTimeout(() => {
          release?.(p);
        }, 100);
      }
    };

    return (
      <Item
        key={itemConfig.id}
        onSelect={handleClick}
        disabled={!action || !enabled}
        variant={itemConfig.id === "deleteSelectedStageObjects" ? "destructive" : "default"}
      >
        {getIcon(itemConfig.id, itemConfig.icon)}
        {getItemTitle(itemConfig.id, itemConfig.label)}
        {shortcut && <ContextMenuShortcut>{shortcut}</ContextMenuShortcut>}
      </Item>
    );
  };

  const renderItems = (items: ContextMenuConfigItem[]) => {
    const rendered: ReactNode[] = [];

    const renderUserColorBar = () => {
      const hasColorableSelectedObject = p.stageManager.getSelectedStageObjects().some((it) => "color" in it);
      if (!hasColorableSelectedObject || userColorList.length === 0) return;

      rendered.push(
        <Item key="user-color-bar" className="bg-transparent! p-0">
          <div
            className="flex w-54 flex-row gap-0 overflow-x-hidden whitespace-nowrap"
            onWheelCapture={(e) => {
              e.stopPropagation();
              e.currentTarget.scrollLeft += e.deltaY;
            }}
          >
            {userColorList.map((color) => (
              <div
                key={color.toString()}
                className="hover:outline-accent-foreground size-3 shrink-0 -outline-offset-1 hover:outline-2"
                style={{ backgroundColor: `rgba(${color.r},${color.g},${color.b},${color.a})` }}
                onMouseEnter={() => {
                  if (!Settings.colorPanelMouseEnterPreview) return;
                  p.controller.resetCountdownTimer();
                  p.stageObjectColorManager.setSelectedStageObjectColor(color, true);
                }}
                onClick={() => {
                  p.controller.resetCountdownTimer();
                  p.stageObjectColorManager.setSelectedStageObjectColor(color, false);
                }}
              />
            ))}
          </div>
        </Item>,
      );
    };

    for (let index = 0; index < items.length; index++) {
      const item = items[index];
      if (!isConfigVisible(item)) continue;

      if (item.type === "group" && item.layout === "grid") {
        const gridGroups = [item];
        while (
          index + 1 < items.length &&
          isConfigVisible(items[index + 1]) &&
          items[index + 1].type === "group" &&
          items[index + 1].layout === "grid"
        ) {
          gridGroups.push(items[index + 1]);
          index++;
        }

        rendered.push(
          <Item key={gridGroups.map((group) => group.id).join("-")} className="gap-0 bg-transparent! p-0">
            {gridGroups.map((group) => renderGridGroupContent(group))}
          </Item>,
        );
        continue;
      }

      if (item.type === "setColorForSelected") {
        renderUserColorBar();
      }
      rendered.push(renderItem(item));
    }

    return rendered;
  };

  // 只选中一张图片卡片时，最上面多一项「图片标题…」：图片卡片不显示文件名，想要标题就在这里填
  const selected = p.stageManager.getSelectedEntities();
  const textNodes = selected.filter((entity): entity is TextNode => entity instanceof TextNode);
  const sharedTextAlign: TextNodeAlign | undefined =
    textNodes.length > 0 && textNodes.every((node) => node.textAlign === textNodes[0].textAlign)
      ? textNodes[0].textAlign
      : undefined;
  const allBold = textNodes.length > 0 && textNodes.every((node) => node.isBold());
  const imageNodes = selected.filter((entity): entity is ImageNode => entity instanceof ImageNode);
  const canRotateImages = imageNodes.some((node) => node.canRotate());
  const fileCard = selected.length === 1 && selected[0] instanceof FileCardNode ? selected[0] : undefined;
  // PDF 里框下来的图也算图片卡片，可以改标题
  const imageCard =
    fileCard && (fileCard.fileKind === "image" || (fileCard.pdfPage > 0 && fileCard.attachmentId))
      ? fileCard
      : undefined;

  return (
    <Content>
      {fileCard && (
        <Item onClick={() => void open(resolveFileCardPath(p, fileCard)).catch((error) => toast.error(String(error)))}>
          <LucideIcons.ExternalLink />
          {tResearch("document.openSystem")}
        </Item>
      )}
      {fileCard?.fileKind === "pdf" && !fileCard.pdfPage && (
        <Item onClick={() => void refreshFileCard(p, fileCard)}>
          <LucideIcons.RefreshCw />
          {tResearch("card.refresh")}
        </Item>
      )}
      {imageCard && (
        <>
          <Item onClick={() => void promptImageCaption(p, imageCard)}>
            <LucideIcons.Captions />
            {tResearch(imageCard.caption ? "card.caption.editMenu" : "card.caption.menu")}
          </Item>
          <div className="bg-border my-1 h-px" />
        </>
      )}
      {/* 给选中的卡片记一笔：做阶段小结时，标过的会优先写进去。只记在活动记录里，卡片本身不变 */}
      {selected.length > 0 && (
        <>
          <Sub>
            <SubTrigger>
              <LucideIcons.Flag />
              {tResearch("activityLog.mark.menu")}
            </SubTrigger>
            <SubContent>
              {ACTIVITY_MARKS.map((mark) => (
                <Item
                  key={mark}
                  onClick={() => {
                    if (noteCardMarks(p, selected, mark)) {
                      toast.success(
                        tResearch("activityLog.mark.done", {
                          mark: tResearch(`activityLog.mark.${mark}`),
                          count: selected.length,
                        }),
                      );
                    } else toast.warning(tResearch("activityLog.mark.outside"));
                  }}
                >
                  {tResearch(`activityLog.mark.${mark}`)}
                </Item>
              ))}
            </SubContent>
          </Sub>
          <div className="bg-border my-1 h-px" />
        </>
      )}
      {textNodes.length > 0 && (
        <>
          <Group>
            <CheckboxItem
              checked={sharedTextAlign === "left"}
              onSelect={() => TextNodeSmartTools.setSelectedTextNodesAlign(p, "left")}
            >
              <LucideIcons.AlignLeft />
              {t("textAlignLeft")}
            </CheckboxItem>
            <CheckboxItem
              checked={sharedTextAlign === "center"}
              onSelect={() => TextNodeSmartTools.setSelectedTextNodesAlign(p, "center")}
            >
              <LucideIcons.AlignCenter />
              {t("textAlignCenter")}
            </CheckboxItem>
            <CheckboxItem
              checked={sharedTextAlign === "right"}
              onSelect={() => TextNodeSmartTools.setSelectedTextNodesAlign(p, "right")}
            >
              <LucideIcons.AlignRight />
              {t("textAlignRight")}
            </CheckboxItem>
            <FontSizeRow project={p} nodes={textNodes} />
            <CheckboxItem checked={allBold} onSelect={() => TextNodeSmartTools.toggleSelectedTextNodesBold(p)}>
              <LucideIcons.Bold />
              {t("toggleBold")}
            </CheckboxItem>
          </Group>
          <div className="bg-border my-1 h-px" />
        </>
      )}
      {imageNodes.length > 0 && (
        <>
          <Group>
            <Item disabled={!canRotateImages} onSelect={() => rotateSelectedImageNodes(p, "cw")}>
              <LucideIcons.RotateCw />
              {t("rotateClockwise90")}
            </Item>
            <Item disabled={!canRotateImages} onSelect={() => rotateSelectedImageNodes(p, "ccw")}>
              <LucideIcons.RotateCcw />
              {t("rotateCounterClockwise90")}
            </Item>
          </Group>
          <div className="bg-border my-1 h-px" />
        </>
      )}
      {renderItems(menuConfig)}
    </Content>
  );
}
