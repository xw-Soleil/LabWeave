// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDefaultStore, atom } from "jotai";
import { URI } from "vscode-uri";

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  authorize: vi.fn(),
  switchProject: vi.fn(),
  openDocument: vi.fn(),
  scan: vi.fn(),
  exists: vi.fn(),
  toast: vi.fn(),
  drop: vi.fn(),
  update: vi.fn(),
  confirm: vi.fn(),
  load: vi.fn(),
}));
vi.mock("@/state", () => ({ store: getDefaultStore(), tabsAtom: atom([]), activeResourceTabAtom: atom(undefined) }));
vi.mock("@/core/service/Settings", () => ({ Settings: { use: () => ["/current"] } }));
vi.mock("@/core/Project", () => ({ Project: class Project {} }));
vi.mock("@/core/research/DocumentTab", () => ({
  DocumentTab: class DocumentTab {
    uri = URI.file("/other/a.md");
  },
  openDocumentFile: mocks.openDocument,
}));
vi.mock("@/core/research/ResearchFolder", () => ({
  RESEARCH_FILES_CHANGED_EVENT: "research:files-changed",
  ResearchFolder: {
    getRoot: () => "/current",
    scan: mocks.scan,
    isInside: (path: string) => path.startsWith("/current"),
    toRelative: (path: string) => path.replace(/^\/current\/?/, ""),
  },
}));
vi.mock("@/core/research/ResearchWorkspace", () => ({
  researchWorkspaceAtom: atom({
    workspaces: [{ name: "My workspace", projects: [{ path: "/current" }, { path: "/other" }] }],
  }),
  activeResearchWorkspace: (data: { workspaces: unknown[] }) => data.workspaces[0],
  loadResearchWorkspace: mocks.load,
  authorizeResearchProject: mocks.authorize,
  readResearchDirectory: mocks.read,
  requestResearchProject: mocks.switchProject,
  updateResearchWorkspace: mocks.update,
  projectPathKey: (path: string) => path.toLowerCase(),
  projectName: (path: string) => path.split("/").at(-1),
  researchWorkspaceError: String,
}));
vi.mock("@/core/research/ResearchRename", () => ({ promptResearchRename: vi.fn() }));
vi.mock("@/core/research/ResearchTrash", () => ({
  restoreLastResearchFile: vi.fn(),
  promptTrashResearchFile: vi.fn(),
}));
vi.mock("@/core/research/ResearchDrop", () => ({ dropFilesAtClientPoint: mocks.drop }));
vi.mock("@/core/research/SidePanels", () => ({ hidePeekForDrag: vi.fn() }));
vi.mock("@/core/subWindowOpen", () => ({ createSubWindow: vi.fn() }));
vi.mock("@/core/TabWorkspace", () => ({ TabWorkspace: {} }));
vi.mock("@/components/ui/dialog", () => ({ Dialog: { confirm: mocks.confirm, input: vi.fn() } }));
vi.mock("@tauri-apps/plugin-fs", () => ({ exists: mocks.exists }));
vi.mock("@tauri-apps/plugin-shell", () => ({ open: vi.fn() }));
vi.mock("sonner", () => ({ toast: { error: mocks.toast } }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string, args?: { name: string }) => (args?.name ? `${key}:${args.name}` : key) }),
}));
import { store, tabsAtom } from "@/state";
import { DocumentTab } from "@/core/research/DocumentTab";
import FileManagerWindow from "./FileManagerWindow";

let root: Root;
let container: HTMLDivElement;
beforeEach(async () => {
  vi.clearAllMocks();
  mocks.load.mockResolvedValue(undefined);
  mocks.exists.mockResolvedValue(true);
  mocks.authorize.mockResolvedValue(undefined);
  mocks.switchProject.mockResolvedValue(true);
  mocks.openDocument.mockResolvedValue(undefined);
  mocks.drop.mockResolvedValue(undefined);
  mocks.update.mockResolvedValue(undefined);
  mocks.scan.mockResolvedValue({
    entries: [{ absPath: "/current/match.md", relPath: "match.md", name: "match.md", kind: "markdown" }],
    truncated: false,
    unreadableDirs: [],
  });
  mocks.read.mockImplementation(async (_root: string, path: string) =>
    path === "/other"
      ? [
          { absPath: "/other/sub", relPath: "sub", name: "sub", directory: true, kind: "other" },
          ...["a.md", "a.pdf", "a.prg", "a.docx"].map((name) => ({
            absPath: `/other/${name}`,
            relPath: name,
            name,
            directory: false,
            kind: name.endsWith("prg")
              ? "workspace"
              : name.endsWith("pdf")
                ? "pdf"
                : name.endsWith("md")
                  ? "markdown"
                  : "other",
          })),
        ]
      : [],
  );
  store.set(tabsAtom, []);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<FileManagerWindow />));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
const button = (label: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
const row = (name: string) =>
  [...container.querySelectorAll<HTMLElement>('[role="button"]')].find((row) =>
    row.title.startsWith(`/other/${name}\n`),
  )!;
async function expandOther() {
  await act(async () => button("projectTree.expand:other").click());
}

async function removeFromMenu(name: string) {
  await act(async () =>
    button(`projectTree.actions:${name}`).dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
  );
  const remove = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (item) => item.textContent === "projectTree.remove",
  )!;
  expect(remove).toBeDefined();
  await act(async () => remove.click());
}

describe("workspace file tree", () => {
  it("confirms removal, respects cancellation and only removes the project from the list", async () => {
    mocks.confirm.mockResolvedValueOnce(false).mockResolvedValue(true);
    await removeFromMenu("other");
    expect(mocks.update).not.toHaveBeenCalled();
    await removeFromMenu("other");
    expect(mocks.switchProject).toHaveBeenCalledExactlyOnceWith("", undefined, "/other");
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("does not remove the current project when closing unsaved tabs is cancelled", async () => {
    mocks.confirm.mockResolvedValue(true);
    mocks.switchProject.mockResolvedValueOnce(false);
    await removeFromMenu("current");
    expect(mocks.switchProject).toHaveBeenCalledWith("", undefined, "/current");
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("preserves pointer dragging to the canvas and routes dragged boards through project switching", async () => {
    await expandOther();
    const pointer = (type: string, x: number) => {
      const event = new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: 20 });
      Object.defineProperty(event, "pointerId", { value: 1 });
      return event;
    };
    for (const name of ["a.md", "a.prg"]) {
      const element = row(name);
      element.setPointerCapture = vi.fn();
      await act(async () => element.dispatchEvent(pointer("pointerdown", 1)));
      await act(async () => window.dispatchEvent(pointer("pointermove", 400)));
      await act(async () => window.dispatchEvent(pointer("pointerup", 400)));
    }
    expect(mocks.drop).toHaveBeenCalledExactlyOnceWith(["/other/a.md"], 400, 20);
    expect(mocks.switchProject).toHaveBeenCalledWith("/other", "/other/a.prg");
  });
  it("does not scan or read collapsed projects; expands one level and only reads a subfolder when requested", async () => {
    expect(mocks.read).not.toHaveBeenCalled();
    expect(mocks.scan).not.toHaveBeenCalled();
    await expandOther();
    expect(mocks.read).toHaveBeenCalledExactlyOnceWith("/other", "/other");
    expect(mocks.switchProject).not.toHaveBeenCalled();
    await act(async () => button("projectTree.expand:sub").click());
    expect(mocks.read).toHaveBeenLastCalledWith("/other", "/other/sub");
    await expandOther();
    expect(row("a.md")).toBeUndefined();
  });

  it("opens Markdown/PDF/other files without switching, switches before opening a board, and marks open documents", async () => {
    await act(async () => store.set(tabsAtom, [new DocumentTab("/other/a.md", "markdown")]));
    await expandOther();
    expect(row("a.md").querySelector('[title="files.opened"]')).not.toBeNull();
    await act(async () => row("a.prg").click());
    expect(mocks.switchProject).not.toHaveBeenCalled();
    for (const name of ["a.md", "a.pdf", "a.docx"])
      await act(async () => row(name).dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    expect(mocks.openDocument.mock.calls.map(([path]) => path)).toEqual([
      "/other/a.md",
      "/other/a.pdf",
      "/other/a.docx",
    ]);
    expect(mocks.switchProject).not.toHaveBeenCalled();
    await act(async () => row("a.prg").dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    expect(mocks.switchProject).toHaveBeenCalledExactlyOnceWith("/other", "/other/a.prg");
    await act(async () => container.querySelector<HTMLButtonElement>('button[title="/other"]')!.click());
    expect(mocks.switchProject).toHaveBeenLastCalledWith("/other");
  });

  it("reports unavailable folders in the row without repeated error toasts", async () => {
    mocks.read.mockRejectedValue(new Error("unplugged"));
    await expandOther();
    expect(container.querySelector('[role="status"]')?.textContent).toBe("projectTree.missing");
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(mocks.toast).not.toHaveBeenCalled();
    expect(button("projectTree.actions:other")).not.toBeNull();
  });

  it("renders a large directory in batches without rereading it or dropping the remaining files", async () => {
    mocks.read.mockResolvedValue(
      Array.from({ length: 450 }, (_, index) => ({
        absPath: `/other/${index}.md`,
        relPath: `${index}.md`,
        name: `${index}.md`,
        directory: false,
        kind: "markdown",
      })),
    );
    await expandOther();
    expect(container.querySelectorAll('[role="button"]')).toHaveLength(200);
    const more = () =>
      [...container.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent === "projectTree.showMore",
      )!;
    await act(async () => more().click());
    expect(container.querySelectorAll('[role="button"]')).toHaveLength(400);
    await act(async () => more().click());
    expect(container.querySelectorAll('[role="button"]')).toHaveLength(450);
    expect(mocks.read).toHaveBeenCalledOnce();
  });

  it("searches only the current project's existing scan and restores the tree when cleared", async () => {
    const input = container.querySelector("input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "match");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(mocks.scan).toHaveBeenCalledOnce();
    expect(mocks.read).not.toHaveBeenCalled();
    expect(container.textContent).toContain("match.md");
    await act(async () => button("files.clearSearch").click());
    expect(button("projectTree.expand:other")).not.toBeNull();
  });

  it("keeps a workspace load failure visible while the current-project search succeeds", async () => {
    mocks.load.mockRejectedValueOnce(new Error("workspaceCorrupt"));
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    const input = container.querySelector("input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "match");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(container.textContent).toContain("match.md");
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
  });
});
