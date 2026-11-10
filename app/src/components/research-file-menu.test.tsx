// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ rename: vi.fn(), trash: vi.fn(), write: vi.fn(), open: vi.fn() }));
vi.mock("@/core/research/ResearchRename", () => ({ promptResearchRename: mocks.rename }));
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
  it("does not rename or delete when switching to the containing project is cancelled", async () => {
    const switchProject = vi.fn(async () => false);
    await openMenu(switchProject);
    await select("rename.title");
    expect(switchProject).toHaveBeenCalledOnce();
    expect(mocks.rename).not.toHaveBeenCalled();
    await openMenu(switchProject);
    await select("fileMenu.delete");
    expect(mocks.trash).not.toHaveBeenCalled();
  });
  it("shows all labeled file actions on an unselected row", async () => {
    await openMenu();
    const labels = [...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent);
    expect(labels).toEqual([
      "fileMenu.open",
      "document.openSystem",
      "fileMenu.reveal",
      "fileMenu.copyPath",
      "fileMenu.copyRelativePath",
      "rename.title F2",
      "fileMenu.delete",
    ]);
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
    await select("fileMenu.copyRelativePath");
    expect(mocks.write).toHaveBeenCalledWith("papers/a.pdf");
  });
  it("copies the absolute path", async () => {
    await openMenu();
    await select("fileMenu.copyPath");
    expect(mocks.write).toHaveBeenCalledWith("/research/papers/a.pdf");
  });
  it("renames the clicked file", async () => {
    await openMenu();
    await select("rename.title");
    expect(mocks.rename).toHaveBeenCalledWith("/research/papers/a.pdf");
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
