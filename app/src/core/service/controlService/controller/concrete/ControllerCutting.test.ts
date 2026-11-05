// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { Color, Vector } from "@graphif/data-structures";
import { Line } from "@graphif/shapes";

vi.mock("@/core/Project", () => ({
  Project: class {},
  ProjectState: { Unsaved: "unsaved" },
  service: () => (value: unknown) => value,
}));
vi.mock("@/core/service/Settings", () => ({
  Settings: {
    mouseRightDragBackground: "cut",
    historySize: 100,
    watch: (_key: string, callback: (value: string) => void) => {
      callback("memoryEfficient");
      return vi.fn();
    },
  },
}));
vi.mock("@/utils/platform", () => ({ isMac: false }));
vi.mock("@/core/render/canvas2d/renderer", () => ({ Renderer: {} }));
vi.mock("@/utils/font", () => ({ getMultiLineTextSize: () => new Vector(20, 20) }));
vi.mock("@/core/service/feedbackService/SoundService", () => ({
  SoundService: { play: { cuttingLineStart: vi.fn(), cuttingLineRelease: vi.fn() } },
}));
vi.mock("@/core/stage/stageObject/tools/entityDetailsManager", () => ({ DetailsManager: class {} }));

import { ControllerCuttingClass } from "./ControllerCutting";
import { HistoryManager } from "@/core/stage/stageManager/StageHistoryManager";

function setup() {
  const intersect = (line: Line) => line.start.x <= 50 && line.end.x >= 50;
  const card = {
    uuid: "file-card",
    sourcePath: "keep.pdf",
    collisionBox: {
      isIntersectsWithLine: intersect,
      getRectangle: () => ({ getCollidePointsWithLine: () => [] }),
    },
  };
  const edge = { uuid: "edge", isPhysical: true, collisionBox: { isIntersectsWithLine: intersect } };
  const removed: string[] = [];
  const project = {
    stage: [] as unknown[],
    emit: vi.fn(),
    projectState: "saved",
    camera: { currentScale: 1 },
    controller: { setCursorName: vi.fn(), penStrokeControl: { isAdjusting: false } },
    renderer: { transformView2World: (point: Vector) => point },
    sectionMethods: { isObjectBeLockedBySection: () => false },
    effects: { addEffect: vi.fn() },
    stageStyleManager: { currentStyle: { effects: { warningShadow: Color.Transparent } } },
    stageManager: {
      findEntityByLocation: () => undefined,
      isEntityOnLocation: () => false,
      isAssociationOnLocation: () => false,
      getEntities: () => [card],
      getSections: () => [],
      getAssociations: () => [edge],
      updateReferences: vi.fn(),
      deleteAssociation: (item: { uuid: string }) => {
        removed.push(item.uuid);
        project.stage.push(item.uuid);
        history.recordStep();
      },
      deleteEntities: (items: { uuid: string }[]) => {
        for (const item of items) {
          removed.push(item.uuid);
          project.stage.push(item.uuid);
          history.recordStep();
        }
      },
    },
    historyManager: undefined as unknown as HistoryManager,
  };
  const history = new HistoryManager(project as never);
  project.historyManager = history;
  return { project, removed, card, control: new ControllerCuttingClass(project as never), history };
}

describe("right drag cutting", () => {
  it("uses the release point even without a final move event and batches the whole deletion", () => {
    const { control, removed, project, card, history } = setup();
    control.mousedown({ button: 2, clientX: 0, clientY: 0 } as MouseEvent);
    control.mouseup({ button: 2, clientX: 100, clientY: 0 } as MouseEvent);
    expect(removed).toEqual(["edge", "file-card"]);
    expect(card.sourcePath).toBe("keep.pdf");
    expect(project.emit).toHaveBeenCalledTimes(1);
    history.undo();
    expect(project.stage).toEqual([]);
    control.dispose();
    history.dispose();
  });
  it("Escape cancels the preview and release does not delete", () => {
    const { control, removed, history } = setup();
    control.mousedown({ button: 2, clientX: 0, clientY: 0 } as MouseEvent);
    control.mousemove({ clientX: 100, clientY: 0 } as MouseEvent);
    expect(control.warningEntity).toHaveLength(1);
    control.keydown(new KeyboardEvent("keydown", { key: "Escape" }));
    control.mouseup({ button: 2, clientX: 100, clientY: 0 } as MouseEvent);
    expect(removed).toEqual([]);
    expect(control.warningAssociations).toEqual([]);
    control.dispose();
    history.dispose();
  });
  it("a right click without dragging never deletes", () => {
    const { control, removed, history } = setup();
    control.mousedown({ button: 2, clientX: 49, clientY: 0 } as MouseEvent);
    control.mouseup({ button: 2, clientX: 51, clientY: 0 } as MouseEvent);
    expect(removed).toEqual([]);
    control.dispose();
    history.dispose();
  });
});
