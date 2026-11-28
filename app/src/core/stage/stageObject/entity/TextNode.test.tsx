// @vitest-environment jsdom
import { Color, Vector } from "@graphif/data-structures";
import { deserialize, serialize } from "@graphif/serializer";
import { Rectangle } from "@graphif/shapes";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/core/Project", () => ({
  Project: class Project {},
  ProjectState: { Saved: 0, Stashed: 1, Unsaved: 2 },
  service: () => () => undefined,
}));
vi.mock("@/core/render/canvas2d/renderer", () => ({
  Renderer: { FONT_SIZE: 32, NODE_PADDING: 14, NODE_ROUNDED_RADIUS: 8 },
}));
vi.mock("@/core/service/feedbackService/SoundService", () => ({ SoundService: { play: {} } }));
vi.mock("@/core/stage/stageObject/tools/entityDetailsManager", () => ({ DetailsManager: class DetailsManager {} }));
vi.mock("@/core/research/LegacyMathCards", async () => ({
  deserializeStageObjects: (await import("@graphif/serializer")).deserialize,
}));
vi.mock("@/core/render/canvas2d/basicRenderer/msdfTextAtlas", () => ({
  MsdfTextAtlasRenderer: class {
    drawLine() {
      return false;
    }
  },
}));
vi.mock("@/utils/font", () => ({
  getTextSize: (text: string, size: number) => new Vector(Array.from(text).length * (size * 0.5), size),
  getMultiLineTextSize: (text: string, size: number, lineHeight = 1.5) => {
    const lines = text.split("\n");
    const width = Math.max(...lines.map((line) => Array.from(line).length * (size * 0.5)), 0);
    return new Vector(width, lines.length * size * lineHeight);
  },
  textToTextArray: (text: string) => text.split("\n"),
  clampTextLines: (text: string) => text.split("\n"),
  ellipsizeEnd: (text: string) => text,
  ellipsizeMiddle: () => "",
  getFontIdentity: (family?: string, weight?: string) => `${weight || "normal"}:${family || "sans-serif"}`,
  isBundledCanvasFont: () => false,
  replaceTextWhenProtect: (text: string) => text,
  resolveFont: (size: number, family?: string, weight?: string) =>
    `${weight || "normal"} ${size}px ${family || "sans-serif"}`,
  setCanvasFont: (ctx: { font: string }, font: string) => {
    ctx.font = font;
  },
}));
vi.mock("@/core/service/Settings", () => ({
  Settings: {
    defaultFontFamily: "sans-serif",
    protectingPrivacy: false,
    textIntegerLocationAndSizeRender: false,
    ignoreTextNodeTextRenderLessThanFontSize: 0,
    forceHideTextNodeBorder: false,
    enableTagTextNodesBigDisplay: false,
    textNodeContentLineBreak: "shiftEnter",
    textNodeExitEditMode: "enter",
    textNodeExitEditModeOnWheel: false,
    textNodeAutoFormatTreeWhenInput: false,
    historyRecordMode: "timeEfficient",
    historySize: 20,
    showDebug: false,
    viewerMode: false,
    watch: (_key: string, callback: (value: string) => void) => {
      callback("timeEfficient");
      return vi.fn();
    },
  },
}));

import { TextRenderer } from "@/core/render/canvas2d/basicRenderer/textRenderer";
import { TextNodeRenderer } from "@/core/render/canvas2d/entityRenderer/textNode/TextNodeRenderer";
import { SvgUtils } from "@/core/render/svg/SvgUtils";
import { ControllerUtils } from "@/core/service/controlService/controller/concrete/utilsControl";
import { TextNodeSmartTools } from "@/core/service/dataManageService/textNodeSmartTools";
import { HistoryManager } from "@/core/stage/stageManager/StageHistoryManager";
import { CollisionBox } from "@/core/stage/stageObject/collisionBox/collisionBox";
import { TextNode } from "./TextNode";

describe("TextNode horizontal alignment and typography", () => {
  it("defaults to left alignment on legacy files and round-trips left / center / right", () => {
    const project = {};
    const legacyBox = serialize(new CollisionBox([new Rectangle(new Vector(20, 30), new Vector(180, 96))]));
    const [legacy] = deserialize(
      [{ _: "TextNode", uuid: "legacy-1", text: "第一行\n短", collisionBox: legacyBox }],
      project,
    ) as TextNode[];
    expect(legacy.textAlign).toBe("left");

    const centered = new TextNode(project as never, {
      uuid: "centered-1",
      text: "居中标题\n副标题",
      textAlign: "center",
      fontWeight: "bold",
      fontScaleLevel: 2,
      collisionBox: new CollisionBox([new Rectangle(new Vector(10, 20), new Vector(0, 0))]),
    });
    const [restored] = deserialize(structuredClone(serialize([centered])), project) as TextNode[];
    expect(restored.textAlign).toBe("center");
    expect(restored.isBold()).toBe(true);
    expect(restored.fontScaleLevel).toBe(2);
  });

  it("aligns multi-line text consistently on Canvas, DOM textarea editor, and SVG export", () => {
    const translates: number[] = [];
    const ctx = {
      textBaseline: "middle",
      textAlign: "left",
      fillStyle: "",
      font: "",
      save: vi.fn(),
      restore: vi.fn(),
      translate: vi.fn((x: number) => translates.push(x)),
      scale: vi.fn(),
      fillText: vi.fn(),
    };
    const capturedStyles: Partial<CSSStyleDeclaration>[] = [];
    const project = {
      canvas: {
        ctx,
        viewToClientScale: () => new Vector(1, 1),
        viewToClient: (v: Vector) => v,
      },
      camera: { currentScale: 1, isDefaultZoom: () => false, stopImmediately: vi.fn() },
      controller: { isCameraLocked: false },
      entityMoveManager: { stopImmediately: vi.fn() },
      stageManager: { clearSelectAll: vi.fn() },
      renderer: { w: 1200, h: 800, transformWorld2View: (value: unknown) => value },
      stageStyleManager: {
        currentStyle: {
          Background: Color.White,
          StageObjectBorder: Color.Black,
          CollideBoxSelected: Color.Blue,
          effects: { successShadow: Color.Green },
        },
      },
      shapeRenderer: { renderRect: vi.fn(), renderDashedRect: vi.fn() },
      collisionBoxRenderer: { render: vi.fn() },
      autoComputeUtils: { isNameIsLogicNode: () => false },
      keyboardOnlyEngine: { isOpenning: () => false },
      syncAssociationManager: { syncFrom: vi.fn(), getSyncSiblings: () => [] },
      inputElement: {
        textarea: vi.fn((_text: string, _onChange: unknown, style: Partial<CSSStyleDeclaration>) => {
          capturedStyles.push(style);
          return new Promise<string>(() => {});
        }),
      },
      textRenderer: null as unknown as TextRenderer,
      textNodeRenderer: null as unknown as TextNodeRenderer,
    };
    project.textRenderer = new TextRenderer(project as never);
    project.textNodeRenderer = new TextNodeRenderer(project as never);

    // 第一行宽 6 * 16 = 96，第二行宽 2 * 16 = 32；padding = 14，框总宽 96 + 28 = 124（x: 100..224）
    const node = new TextNode(project as never, {
      text: "ABCDEF\nGH",
      collisionBox: new CollisionBox([new Rectangle(new Vector(100, 50), new Vector(0, 0))]),
    });
    expect(node.rectangle.size.x).toBe(124);

    // 1. 靠左：两行都从 100 + 14 = 114 开始
    translates.length = 0;
    project.textNodeRenderer.renderTextNode(node);
    expect(translates).toEqual([114, 114]);

    // 2. 居中：第二行偏移 (96 - 32) / 2 = 32 -> 114 + 32 = 146
    node.setTextAlign("center");
    node.setBold(true);
    translates.length = 0;
    project.textNodeRenderer.renderTextNode(node);
    expect(translates).toEqual([114, 146]);

    // DOM 编辑输入框同步拿到 textAlign 与 fontWeight
    new ControllerUtils(project as never).editTextNode(node);
    expect(capturedStyles.at(-1)).toMatchObject({
      textAlign: "center",
      fontWeight: "bold",
    });
    node.isEditing = false;

    // SVG 导出在框中心 x = 100 + 124 / 2 = 162 处使用 text-anchor="middle"
    const centerSvg = renderToStaticMarkup(
      <svg>
        {SvgUtils.multiLineTextFromLeftTopWithWrap(
          node.text,
          node.rectangle.leftTop,
          node.getFontSize(),
          Color.Black,
          Infinity,
          1.5,
          {
            textAlign: node.textAlign,
            boxWidth: node.rectangle.size.x,
            padding: node.getPadding(),
            fontWeight: node.fontWeight,
          },
        )}
      </svg>,
    );
    expect(centerSvg).toContain('text-anchor="middle"');
    expect(centerSvg).toContain('x="162.0"');
    expect(centerSvg).toContain('font-weight="bold"');

    // 3. 靠右：第二行偏移 96 - 32 = 64 -> 114 + 64 = 178；SVG 导出在 x = 224 - 14 = 210 处使用 text-anchor="end"
    node.setTextAlign("right");
    translates.length = 0;
    project.textNodeRenderer.renderTextNode(node);
    expect(translates).toEqual([114, 178]);

    const rightSvg = renderToStaticMarkup(
      <svg>
        {SvgUtils.multiLineTextFromLeftTopWithWrap(
          node.text,
          node.rectangle.leftTop,
          node.getFontSize(),
          Color.Black,
          Infinity,
          1.5,
          { textAlign: node.textAlign, boxWidth: node.rectangle.size.x, padding: node.getPadding() },
        )}
      </svg>,
    );
    expect(rightSvg).toContain('text-anchor="end"');
    expect(rightSvg).toContain('x="210.0"');
  });

  it("applies alignment, font size steps, and bold toggle across multiple selected TextNodes with undo", () => {
    const project = {
      stage: [] as TextNode[],
      projectState: 0,
      emit: vi.fn(),
      graphMethods: { edgeParentArray: () => [] },
      stageManager: {
        getSelectedEntities: () => project.stage.filter((node) => node.isSelected),
        updateReferences: vi.fn(),
      },
      historyManager: null as unknown as HistoryManager,
    };
    const first = new TextNode(project as never, {
      uuid: "n1",
      text: "卡片一",
      collisionBox: new CollisionBox([new Rectangle(new Vector(0, 0), new Vector(0, 0))]),
    });
    const second = new TextNode(project as never, {
      uuid: "n2",
      text: "卡片二",
      collisionBox: new CollisionBox([new Rectangle(new Vector(200, 0), new Vector(0, 0))]),
    });
    first.isSelected = true;
    second.isSelected = true;
    project.stage = [first, second];
    project.historyManager = new HistoryManager(project as never);

    TextNodeSmartTools.setSelectedTextNodesAlign(project as never, "right");
    expect(project.stage.map((n) => n.textAlign)).toEqual(["right", "right"]);

    TextNodeSmartTools.stepSelectedTextNodesFontSize(project as never, "increase");
    expect(project.stage.map((n) => n.getFontSize())).toEqual([36, 36]);

    TextNodeSmartTools.toggleSelectedTextNodesBold(project as never);
    expect(project.stage.map((n) => n.isBold())).toEqual([true, true]);

    // 依次撤销：加粗 -> 字号 -> 对齐
    project.historyManager.undo();
    expect(project.stage.map((n) => n.isBold())).toEqual([false, false]);
    expect(project.stage.map((n) => n.getFontSize())).toEqual([36, 36]);

    project.historyManager.undo();
    expect(project.stage.map((n) => n.getFontSize())).toEqual([32, 32]);
    expect(project.stage.map((n) => n.textAlign)).toEqual(["right", "right"]);

    project.historyManager.undo();
    expect(project.stage.map((n) => n.textAlign)).toEqual(["left", "left"]);
  });

  it("takes any font size, steps through the common sizes, and still reads the half-step levels in old files", () => {
    const project = {
      stage: [] as TextNode[],
      projectState: 0,
      emit: vi.fn(),
      graphMethods: { edgeParentArray: () => [] },
      stageManager: {
        getSelectedEntities: () => project.stage.filter((node) => node.isSelected),
        updateReferences: vi.fn(),
      },
      historyManager: null as unknown as HistoryManager,
    };
    const make = (uuid: string, fontScaleLevel = 0) =>
      new TextNode(project as never, {
        uuid,
        text: "卡片",
        fontScaleLevel,
        collisionBox: new CollisionBox([new Rectangle(new Vector(0, 0), new Vector(0, 0))]),
      });
    const node = make("n1");
    expect(node.getFontSize()).toBe(32);
    // 存的是由字号反推出来的级别，算回去不能差一号
    for (const size of TextNode.FONT_SIZES) {
      node.setFontSize(size);
      expect(node.getFontSize()).toBe(size);
    }
    node.setFontSize(28);
    node.increaseFontSize();
    expect(node.getFontSize()).toBe(32);
    node.decreaseFontSize();
    node.decreaseFontSize();
    expect(node.getFontSize()).toBe(24);
    // 填的字号不在常用的那几个里：往最近的一档走
    node.setFontSize(30);
    node.increaseFontSize();
    expect(node.getFontSize()).toBe(32);
    // 到头就不动
    node.setFontSize(256);
    node.increaseFontSize();
    expect(node.getFontSize()).toBe(256);
    node.setFontSize(8);
    node.decreaseFontSize();
    expect(node.getFontSize()).toBe(8);

    // 旧文件里的一级是 32 × √2，显示成 45
    const old = make("n2", 1);
    expect(old.getFontSize()).toBe(45);
    old.increaseFontSize();
    expect(old.getFontSize()).toBe(48);
    old.setFontScaleLevel(1);
    old.decreaseFontSize();
    expect(old.getFontSize()).toBe(36);

    node.isSelected = true;
    old.isSelected = true;
    project.stage = [node, old];
    project.historyManager = new HistoryManager(project as never);
    TextNodeSmartTools.setSelectedTextNodesFontSize(project as never, 20);
    expect(project.stage.map((n) => n.getFontSize())).toEqual([20, 20]);
    project.historyManager.undo();
    expect(project.stage.map((n) => n.getFontSize())).toEqual([8, 36]);
  });
});
