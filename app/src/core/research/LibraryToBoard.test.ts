// @vitest-environment jsdom
import { Vector } from "@graphif/data-structures";
import { Rectangle } from "@graphif/shapes";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveBoard: vi.fn(),
  createFileCards: vi.fn(),
  trackActivityBoards: vi.fn(),
  focus: vi.fn(),
  warning: vi.fn(),
}));

vi.mock("@/core/service/Settings", () => ({ Settings: {} }));
vi.mock("@/core/Project", () => ({
  Project: class FakeProject {},
}));
vi.mock("@/core/stage/stageObject/entity/FileCardNode", () => ({
  FileCardNode: { pdfWidth: 240, pdfHeight: 340 },
}));
vi.mock("@/core/stage/stageObject/entity/ImageNode", () => ({
  ImageNode: class {},
}));
vi.mock("@/core/stage/stageObject/entity/PenStroke", () => ({
  PenStroke: class {},
}));
vi.mock("@/core/stage/stageObject/entity/Section", () => ({
  Section: class {},
}));
vi.mock("@/core/TabWorkspace", () => ({
  TabWorkspace: { focus: mocks.focus },
}));
vi.mock("sonner", () => ({
  toast: { warning: mocks.warning },
}));
vi.mock("./ActivityLog", () => ({
  trackActivityBoards: mocks.trackActivityBoards,
}));
vi.mock("./BoardPicker", () => ({
  resolveBoard: mocks.resolveBoard,
}));
vi.mock("./DocumentTab", () => ({
  documentText: (key: string) => key,
}));
vi.mock("./FileCardFactory", () => ({
  createFileCards: mocks.createFileCards,
}));

import { Project } from "@/core/Project";
import { activeTabAtom, store, tabsAtom } from "@/state";
import { sendLibraryPdfToBoard } from "./LibraryToBoard";

describe("sendLibraryPdfToBoard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    store.set(tabsAtom, []);
    store.set(activeTabAtom, undefined);
  });

  it("tracks activity before adding, centers the PDF card in the board viewport, nudges past existing cards, and switches to that board", async () => {
    const order: string[] = [];
    const existingEntities: { isHiddenBySectionCollapse: boolean; collisionBox: { getRectangle: () => Rectangle } }[] =
      [];
    const board = Object.assign(new (Project as unknown as new () => object)(), {
      id: "board-main",
      closing: false,
      camera: { location: new Vector(500, 400) },
      stageManager: { getEntities: () => existingEntities },
    });
    store.set(tabsAtom, [board as never]);
    mocks.resolveBoard.mockResolvedValue(board);
    mocks.trackActivityBoards.mockImplementation(() => order.push("track"));
    mocks.focus.mockImplementation(() => order.push("focus"));
    mocks.createFileCards.mockImplementation(async () => {
      order.push("create");
      return [{ uuid: "card-1" }];
    });

    const cards = await sendLibraryPdfToBoard("/r/library/paper.pdf", {
      key: "board-main",
      name: "主画布",
      folder: "",
      open: true,
    });

    expect(cards).toEqual([{ uuid: "card-1" }]);
    expect(order).toEqual(["track", "focus", "create"]);
    expect(mocks.trackActivityBoards).toHaveBeenCalledWith([board]);
    expect(mocks.focus).toHaveBeenCalledWith("board-main");
    // 240x340 的 PDF 卡片以 (500, 400) 为中心，左上角在 (380, 230)
    expect(mocks.createFileCards).toHaveBeenCalledWith(board, ["/r/library/paper.pdf"], new Vector(380, 230));

    // 正中心已有卡片时，新发的卡片自动避开不压在上面
    existingEntities.push({
      isHiddenBySectionCollapse: false,
      collisionBox: { getRectangle: () => new Rectangle(new Vector(380, 230), new Vector(240, 340)) },
    });
    await sendLibraryPdfToBoard("/r/library/paper2.pdf", {
      key: "board-main",
      name: "主画布",
      folder: "",
      open: true,
    });
    const secondPos = mocks.createFileCards.mock.calls[1][2] as Vector;
    expect(secondPos).not.toEqual(new Vector(380, 230));
  });
});
