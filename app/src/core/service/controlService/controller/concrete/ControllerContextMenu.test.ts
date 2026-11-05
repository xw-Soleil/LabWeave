import { describe, expect, it, vi } from "vitest";
import { Vector } from "@graphif/data-structures";
vi.mock("@/core/service/Settings", () => ({ Settings: { enableRightClickConnect: false } }));
vi.mock("@/core/stage/stageObject/abstract/StageEntity", () => ({ Entity: class {} }));
import { Entity } from "@/core/stage/stageObject/abstract/StageEntity";
import { ControllerContextMenuClass } from "./ControllerContextMenu";

function setup() {
  const selected = Object.assign(Object.create(Entity.prototype), { isSelected: true });
  const clicked = Object.assign(Object.create(Entity.prototype), { isSelected: false });
  const project = {
    stageManager: {
      getConnectableEntity: () => [selected, clicked],
      findConnectableEntityByLocation: () => clicked,
      getStageObjects: () => [selected, clicked],
    },
    renderer: { transformView2World: (point: Vector) => point },
    canvas: { viewToClient: (point: Vector) => point },
    controllerUtils: { getClickedStageObject: () => clicked },
    sectionMethods: { getOutermostLockedAncestorSection: () => null },
    emit: vi.fn(),
  };
  const event = (x: number, button = 2) => ({ button, clientX: x, clientY: 0 }) as MouseEvent;
  return { selected, clicked, project, event, controller: new ControllerContextMenuClass(project as never) };
}

describe("canvas context menu gesture", () => {
  it("selects the right-clicked object so its edit actions operate on that object", () => {
    const { controller, selected, clicked, project, event } = setup();
    controller.mousedown(event(10));
    controller.mouseup(event(10));
    expect(clicked.isSelected).toBe(true);
    expect(selected.isSelected).toBe(false);
    expect(project.emit).toHaveBeenCalledWith("contextmenu", new Vector(10, 0));
  });
  it("preserves multiple selection when opening the alignment menu on a selected card", () => {
    const { controller, selected, clicked, event } = setup();
    clicked.isSelected = true;
    controller.mousedown(event(10));
    controller.mouseup(event(10));
    expect(selected.isSelected && clicked.isSelected).toBe(true);
  });
  it("does not open the menu after a cutting gesture returns to its starting point", () => {
    const { controller, project, event } = setup();
    controller.mousedown(event(10));
    controller.mousemove(event(100));
    controller.mouseup(event(10));
    expect(project.emit).not.toHaveBeenCalled();
  });
  it("does not open the menu after a forced cancellation or an unmatched release", () => {
    const { controller, project, event } = setup();
    controller.mouseup(event(10));
    controller.mousedown(event(10));
    controller.mouseMoveOutWindowForcedShutdown();
    controller.mouseup(event(10));
    expect(project.emit).not.toHaveBeenCalled();
  });
});
