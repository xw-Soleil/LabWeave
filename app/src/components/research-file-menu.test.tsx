// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  rename: vi.fn(),
  trash: vi.fn(),
  write: vi.fn(),
  open: vi.fn(),
  duplicate: vi.fn(),
  reveal: vi.fn(),
}));
vi.mock("@/core/research/ResearchRename", () => ({ moveResearchFile: vi.fn() }));
vi.mock("@/core/research/DocumentTab", () => ({ documentError: String, openDocumentFile: vi.fn() }));
vi.mock("@/core/research/ResearchFolder", () => ({
  ResearchFolder: { duplicateFile: mocks.duplicate, listFolders: vi.fn(), toRelative: (path: string) => path },
}));
vi.mock("@/core/TabWorkspace", () => ({ TabWorkspace: { moveTab: vi.fn() } }));
vi.mock("@/core/TabGroup", () => ({ findTabGroupByTabId: vi.fn() }));
vi.mock("@/state", () => ({ store: { get: vi.fn() }, tabGroupRootAtom: {} }));
vi.mock("@/sub/FileManagerWindow", () => ({ default: { reveal: mocks.reveal } }));
vi.mock("@/core/research/ResearchTrash", () => ({ promptTrashResearchFile: mocks.trash }));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: mocks.write }));
vi.mock("@tauri-apps/plugin-shell", () => ({ open: mocks.open }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
import ResearchFileMenu from "./research-file-menu";

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks();
  for (const action of Object.values(mocks)) action.mockResolvedValue(undefined);
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
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function openMenu(beforeModify?: () => Promise<boolean>) {
  const onOpen = vi.fn();
  await act(async () =>
    root.render(
      <ResearchFileMenu
        entry={{ name: "a.pdf", absPath: "/research/papers/a.pdf", relPath: "papers/a.pdf", kind: "pdf" }}
        onOpen={onOpen}
        onRename={mocks.rename}
        beforeModify={beforeModify}
      >
        <button>paper</button>
      </ResearchFileMenu>,
    ),
  );
  await act(async () =>
    container
      .querySelector("button")!
      .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, button: 2, clientX: 30, clientY: 30 })),
  );
  return onOpen;
}
async function select(label: string) {
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) =>
    item.textContent?.includes(label),
  );
  expect(item, label).toBeDefined();
  await act(async () => item!.click());
}
describe("file list context menu", () => {
  it("does not delete when switching to the containing project is cancelled", async () => {
    const switchProject = vi.fn(async () => false);
    await openMenu(switchProject);
    await select("fileMenu.delete");
    expect(switchProject).toHaveBeenCalledOnce();
    expect(mocks.trash).not.toHaveBeenCalled();
  });
  it("shows all labeled file actions on an unselected row", async () => {
    await openMenu();
    const labels = [...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent);
    expect(labels).toEqual([
      "fileMenu.open",
      "fileMenu.openRight",
      "fileMenu.duplicate",
      "fileMenu.moveTo",
      "fileMenu.copyPathMenu",
      "document.openSystem",
      "fileMenu.reveal",
      "rename.title F2",
      "fileMenu.delete",
    ]);
  });
  it("makes a copy next to the file and shows it in the file panel", async () => {
    mocks.duplicate.mockResolvedValue("/research/papers/a 1.pdf");
    await openMenu();
    await select("fileMenu.duplicate");
    expect(mocks.duplicate).toHaveBeenCalledWith("/research/papers/a.pdf");
    await vi.waitFor(() => expect(mocks.reveal).toHaveBeenCalledWith("/research/papers/a 1.pdf"));
  });
  it("copies a wikilink from the copy-path submenu", async () => {
    await openMenu();
    await select("fileMenu.copyPathMenu");
    await select("fileMenu.copyWikilink");
    expect(mocks.write).toHaveBeenCalledWith("[[a.pdf]]");
  });
  it("opens the clicked row", async () => {
    const open = await openMenu();
    await select("fileMenu.open");
    expect(open).toHaveBeenCalledOnce();
  });
  it("routes delete to the clicked file's confirmation and recoverable deletion", async () => {
    await openMenu();
    await select("fileMenu.delete");
    expect(mocks.trash).toHaveBeenCalledWith("/research/papers/a.pdf");
  });
  it("copies the exact relative path", async () => {
    await openMenu();
    await select("fileMenu.copyPathMenu");
    await select("fileMenu.copyRelative");
    expect(mocks.write).toHaveBeenCalledWith("papers/a.pdf");
  });
  it("copies the absolute path", async () => {
    await openMenu();
    await select("fileMenu.copyPathMenu");
    await select("fileMenu.copyAbsolute");
    expect(mocks.write).toHaveBeenCalledWith("/research/papers/a.pdf");
  });
  it("hands rename to the file panel only after the menu has closed, without giving focus back to the row", async () => {
    await openMenu();
    const row = container.querySelector("button")!;
    const focus = vi.spyOn(row, "focus");
    await select("rename.title");
    // 菜单收起来以后才开始改名；焦点不还给那一行，不然刚出来的输入框会立刻失焦
    await vi.waitFor(() => expect(mocks.rename).toHaveBeenCalledOnce());
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(focus).not.toHaveBeenCalled();
  });
  it("opens the containing folder", async () => {
    await openMenu();
    await select("fileMenu.reveal");
    expect(mocks.open).toHaveBeenCalledWith("/research/papers");
  });
  it("explicitly opens the source with the system app", async () => {
    await openMenu();
    await select("document.openSystem");
    expect(mocks.open).toHaveBeenCalledWith("/research/papers/a.pdf");
  });
});
