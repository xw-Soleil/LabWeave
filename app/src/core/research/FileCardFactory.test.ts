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
import { serialize } from "@graphif/serializer";
import { URI } from "vscode-uri";
import {
  createFileCards,
  hasPendingFileCards,
  markFileCardsPending,
  refreshFileCardMissing,
  resolveFileCardPath,
  resolveSourcePath,
  rewriteSerializedFileCardPaths,
  toStoredSourcePath,
} from "./FileCardFactory";

function makeProject(uri: URI) {
  return {
    uri,
    closing: false,
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

  it("stores absolute paths for linked files outside the research folder, so moving the folder doesn't break them", () => {
    const project = savedProject();
    expect(toStoredSourcePath(project as never, "/Users/me/Downloads/a.pdf")).toBe("/Users/me/Downloads/a.pdf");
    expect(resolveSourcePath(project as never, "/Users/me/Downloads/a.pdf")).toBe("/Users/me/Downloads/a.pdf");
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

  it("rewrites cards serialized inside a Section, not just top-level ones", () => {
    const source = savedProject();
    const card = new FileCardNode(source as never, { sourcePath: "papers/x.pdf" });
    // 复制 Section 时，卡片内联在 Section 的 children 里，顶层那一项只是 { $: "/0/0" } 引用
    const serialized = serialize([[card], card]);
    expect(serialized[1]).toEqual({ $: "/0/0" });

    rewriteSerializedFileCardPaths(serialized, (sourcePath) => resolveSourcePath(source as never, sourcePath));

    expect(serialized[0][0].sourcePath).toBe("/Users/me/Research/topic/papers/x.pdf");
    expect(serialized[1]).toEqual({ $: "/0/0" });
    const target = makeProject(URI.file("/Users/me/Research/b.prg"));
    expect(toStoredSourcePath(target as never, resolveSourcePath(target as never, serialized[0][0].sourcePath))).toBe(
      "topic/papers/x.pdf",
    );
  });
});

describe("pending file cards", () => {
  it("counts nested marks and releases each one only once", () => {
    const project = draftProject();
    const releaseA = markFileCardsPending(project as never);
    const releaseB = markFileCardsPending(project as never);
    releaseA();
    releaseA();
    expect(hasPendingFileCards(project as never)).toBe(true);
    releaseB();
    expect(hasPendingFileCards(project as never)).toBe(false);
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

  it("keeps the board marked as pending while files are parsed", async () => {
    const project = draftProject();
    let pendingDuringRead = false;
    mocks.readFile.mockImplementation(async () => {
      pendingDuringRead = hasPendingFileCards(project as never);
      return new TextEncoder().encode("正文");
    });
    await createFileCards(project as never, ["/Users/me/Research/a.md"], Vector.getZero());
    expect(pendingDuringRead).toBe(true);
    expect(hasPendingFileCards(project as never)).toBe(false);
    expect(project.stageManager.add).toHaveBeenCalledOnce();
  });

  it("puts the cards on the fallback board when the target was closed during parsing", async () => {
    const closed = draftProject();
    const fallback = savedProject();
    mocks.readFile.mockImplementation(async () => {
      closed.closing = true;
      return new TextEncoder().encode("正文");
    });

    const cards = await createFileCards(closed as never, ["/Users/me/Research/topic/a.md"], Vector.getZero(), {
      retarget: () => ({ project: fallback as never, worldPos: new Vector(7, 8) }),
    });

    expect(closed.stageManager.add).not.toHaveBeenCalled();
    expect(fallback.stageManager.add).toHaveBeenCalledWith(cards[0], true);
    expect(cards[0].sourcePath).toBe("a.md");
    expect(cards[0].rectangle.location).toEqual(new Vector(7, 8));
    expect(fallback.historyManager.recordStep).toHaveBeenCalledOnce();
  });

  it("warns instead of adding cards to a closed board when there is nowhere else to put them", async () => {
    const closed = draftProject();
    mocks.readFile.mockImplementation(async () => {
      closed.closing = true;
      return new TextEncoder().encode("正文");
    });

    await expect(createFileCards(closed as never, ["/Users/me/Research/a.md"], Vector.getZero())).resolves.toEqual([]);

    expect(closed.stageManager.add).not.toHaveBeenCalled();
    expect(closed.addAttachment).not.toHaveBeenCalled();
    expect(mocks.toastWarning).toHaveBeenCalledOnce();
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
