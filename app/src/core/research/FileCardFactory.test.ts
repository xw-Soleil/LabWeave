import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  exists: vi.fn(),
  toastWarning: vi.fn(),
  toastError: vi.fn(),
  toastLoading: vi.fn(() => "loading-toast"),
  toastDismiss: vi.fn(),
  settings: { researchFolderPath: "/Users/me/Research", aiPdfTextPages: 3 },
}));

vi.mock("@/core/Project", () => ({ Project: class Project {} }));
vi.mock("@/core/service/Settings", () => ({ Settings: mocks.settings }));
vi.mock("@/core/stage/stageObject/tools/entityDetailsManager", () => ({ DetailsManager: class DetailsManager {} }));
vi.mock("@/utils/platform", () => ({ family: () => "unix" }));
vi.mock("@tauri-apps/plugin-fs", () => ({ readFile: mocks.readFile, exists: mocks.exists }));
vi.mock("sonner", () => ({
  toast: {
    warning: mocks.toastWarning,
    error: mocks.toastError,
    loading: mocks.toastLoading,
    dismiss: mocks.toastDismiss,
  },
}));

import { FileCardNode } from "@/core/stage/stageObject/entity/FileCardNode";
import { Vector } from "@graphif/data-structures";
import { URI } from "vscode-uri";
import {
  createFileCards,
  refreshFileCardMissing,
  resolveFileCardPath,
  resolveSourcePath,
  toStoredSourcePath,
} from "./FileCardFactory";

function makeProject(uri: URI) {
  return {
    uri,
    attachments: new Map<string, Blob>(),
    addAttachment: vi.fn(),
    stage: [] as unknown[],
    stageManager: {
      add: vi.fn(),
      updateReferences: vi.fn(),
      goInSection: vi.fn(),
    },
    sectionMethods: { getSectionsByInnerLocation: vi.fn(() => []) },
    historyManager: { recordStep: vi.fn() },
  };
}

const savedProject = () => makeProject(URI.file("/Users/me/Research/topic/workspace.prg"));
const draftProject = () => makeProject(URI.from({ scheme: "draft", path: "1" }));

describe("file card paths", () => {
  it("stores paths relative to the .prg folder once the project is saved", () => {
    const project = savedProject();
    expect(toStoredSourcePath(project as never, "/Users/me/Research/topic/papers/a.pdf")).toBe("papers/a.pdf");
    expect(toStoredSourcePath(project as never, "/Users/me/Research/notes/b.md")).toBe("../notes/b.md");
    expect(resolveSourcePath(project as never, "../notes/b.md")).toBe("/Users/me/Research/notes/b.md");
  });

  it("stores absolute paths while the project is a draft", () => {
    const project = draftProject();
    expect(toStoredSourcePath(project as never, "/Users/me/Research/papers/a.pdf")).toBe(
      "/Users/me/Research/papers/a.pdf",
    );
    expect(resolveSourcePath(project as never, "/Users/me/Research/papers/a.pdf")).toBe(
      "/Users/me/Research/papers/a.pdf",
    );
  });

  it("marks a card as missing when its file is gone", async () => {
    const project = savedProject();
    const card = new FileCardNode(project as never, { sourcePath: "papers/a.pdf" });
    mocks.exists.mockResolvedValueOnce(false);
    await expect(refreshFileCardMissing(project as never, card)).resolves.toBe(true);
    expect(mocks.exists).toHaveBeenCalledWith("/Users/me/Research/topic/papers/a.pdf");
    expect(card.missing).toBe(true);
    expect(resolveFileCardPath(project as never, card)).toBe("/Users/me/Research/topic/papers/a.pdf");
  });
});

describe("createFileCards", () => {
  beforeEach(() => {
    mocks.readFile.mockReset();
    mocks.toastWarning.mockReset();
    mocks.toastError.mockReset();
  });

  it("lays cards out in a grid and records exactly one history step", async () => {
    const project = savedProject();
    mocks.readFile.mockImplementation(async (path: string) => new TextEncoder().encode(`# ${path.split("/").pop()}`));
    const paths = ["a.md", "b.md", "c.md"].map((name) => `/Users/me/Research/topic/notes/${name}`);

    const cards = await createFileCards(project as never, paths, new Vector(100, 50));

    expect(cards.map((card) => card.title)).toEqual(["a.md", "b.md", "c.md"]);
    expect(cards.map((card) => card.sourcePath)).toEqual(["notes/a.md", "notes/b.md", "notes/c.md"]);
    expect(cards.every((card) => card.fileKind === "markdown")).toBe(true);
    expect(cards[0].rectangle.location).toEqual(new Vector(100, 50));
    expect(cards[1].rectangle.location.y).toBe(50);
    expect(cards[1].rectangle.location.x).toBeGreaterThan(100 + FileCardNode.width);
    expect(cards[2].rectangle.location.x).toBe(100);
    expect(cards[2].rectangle.location.y).toBeGreaterThan(50 + FileCardNode.height);
    expect(project.stageManager.add).toHaveBeenCalledTimes(3);
    expect(project.stageManager.add).toHaveBeenCalledWith(cards[0], true);
    expect(project.stageManager.updateReferences).toHaveBeenCalledOnce();
    expect(project.historyManager.recordStep).toHaveBeenCalledOnce();
  });

  it("shows a loading toast for slow batches and always dismisses it", async () => {
    const project = savedProject();
    mocks.readFile.mockRejectedValue(new Error("disk unplugged"));

    await createFileCards(project as never, ["/Users/me/Research/topic/paper.pdf"], Vector.getZero());

    expect(mocks.toastLoading).toHaveBeenCalledOnce();
    expect(mocks.toastDismiss).toHaveBeenCalledWith("loading-toast");
    expect(mocks.toastError).toHaveBeenCalledOnce();
  });

  it("skips unsupported and unreadable files and tells the user", async () => {
    const project = savedProject();
    mocks.readFile.mockImplementation(async (path: string) => {
      if (path.endsWith("broken.md")) throw new Error("permission denied");
      return new TextEncoder().encode("正文");
    });

    const cards = await createFileCards(
      project as never,
      ["/Users/me/Research/topic/a.docx", "/Users/me/Research/topic/broken.md", "/Users/me/Research/topic/ok.md"],
      Vector.getZero(),
    );

    expect(cards.map((card) => card.title)).toEqual(["ok"]);
    expect(mocks.toastWarning).toHaveBeenCalledOnce();
    expect(mocks.toastError).toHaveBeenCalledOnce();
    expect(project.historyManager.recordStep).toHaveBeenCalledOnce();
  });

  it("does not touch history when no card was created", async () => {
    const project = savedProject();
    await expect(createFileCards(project as never, ["/Users/me/Research/a.docx"], Vector.getZero())).resolves.toEqual(
      [],
    );
    expect(project.stageManager.updateReferences).not.toHaveBeenCalled();
    expect(project.historyManager.recordStep).not.toHaveBeenCalled();
  });
});
