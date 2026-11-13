// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LibraryItem, LibrarySnapshot } from "./Library";

const mocks = vi.hoisted(() => ({
  snapshot: undefined as unknown,
  update: vi.fn(),
  trash: vi.fn(),
  open: vi.fn(),
}));
vi.mock("@/core/service/Settings", () => ({
  Settings: { use: () => ["/lib", vi.fn()], literatureLibraryPath: "/lib" },
}));
vi.mock("@/components/ui/dialog", () => ({ Dialog: { input: vi.fn(), buttons: vi.fn() } }));
vi.mock("@tauri-apps/plugin-shell", () => ({ open: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("i18next", () => ({ default: { t: (key: string) => key } }));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), loading: vi.fn() }) }));
vi.mock("./DocumentTab", () => ({ documentError: String, openDocumentFile: mocks.open }));
vi.mock("./LibraryLookup", () => ({}));
vi.mock("./ZoteroSyncDialog", () => ({ default: () => null }));
vi.mock("./Library", () => ({
  useLibrary: () => ({
    snapshot: mocks.snapshot,
    loading: false,
    error: null,
    refresh: async () => {},
    reloadAll: async () => {},
  }),
  queryLibrary: (snapshot: LibrarySnapshot) => snapshot.items,
  countLibrary: (snapshot: LibrarySnapshot) => ({
    total: snapshot.items.length,
    unfiled: snapshot.items.length,
    trashed: 0,
    byStatus: { unread: snapshot.items.length, toRead: 0, reading: 0, read: 0 },
    byCollection: {},
    byTag: {},
  }),
  updateItem: mocks.update,
  trashItem: mocks.trash,
  restoreItem: vi.fn(),
  createItem: vi.fn(),
  createLibrary: vi.fn(),
  addCollection: vi.fn(),
  renameCollection: vi.fn(),
  removeCollection: vi.fn(),
}));
import LibraryView from "./LibraryView";

const paper = (index: number): LibraryItem => ({
  key: `Paper${index}`,
  dir: `/lib/条目/Paper${index}`,
  notePath: `/lib/条目/Paper${index}/Paper${index}.md`,
  translations: {},
  extra: {},
  title: `Paper ${index}`,
  authors: ["Ada Lovelace"],
  year: "2024",
  status: "unread",
  collections: [],
  tags: [],
  trashed: false,
});
const library = (count: number): LibrarySnapshot => ({
  root: "/lib",
  collections: [],
  items: Array.from({ length: count }, (_, index) => paper(index + 1)),
  errors: [],
});

let root: Root;
let container: HTMLDivElement;
const rows = () => [...container.querySelectorAll<HTMLElement>('[role="option"]')];
const menuItems = () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
async function show(count: number) {
  mocks.snapshot = library(count);
  await act(async () => root.render(<LibraryView />));
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const action of [mocks.update, mocks.trash, mocks.open]) action.mockResolvedValue(undefined);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Element.prototype.scrollIntoView = vi.fn();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("the literature list", () => {
  it("draws the first screen at once and the rest straight after", async () => {
    vi.useFakeTimers();
    mocks.snapshot = library(45);
    act(() => root.render(<LibraryView />));
    expect(rows()).toHaveLength(30);
    await act(async () => vi.runOnlyPendingTimers());
    expect(rows()).toHaveLength(45);
  });

  it("opens the status menu on the first press and changes the status without selecting the row", async () => {
    await show(3);
    const status = rows()[1].querySelector<HTMLElement>('[aria-label="library.fields.status"]')!;
    // 每行一开始只是一个普通按钮（下拉菜单的按钮会带 data-state），下拉菜单组件点了才装上
    expect(status.hasAttribute("data-state")).toBe(false);
    await act(async () => status.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 })));
    expect(menuItems().map((item) => item.textContent)).toEqual([
      "library.status.unread",
      "library.status.toRead",
      "library.status.reading",
      "library.status.read",
    ]);
    await act(async () => menuItems()[3].click());
    expect(mocks.update).toHaveBeenCalledWith("/lib", "Paper2", { status: "read" });
    expect(rows()[1].getAttribute("aria-selected")).toBe("false");
  });

  it("opens the status menu from the keyboard too", async () => {
    await show(2);
    const status = rows()[0].querySelector<HTMLElement>('[aria-label="library.fields.status"]')!;
    await act(async () => status.click());
    expect(menuItems()).toHaveLength(4);
  });

  it("shares one right-click menu between the rows and acts on the row that was clicked", async () => {
    await show(3);
    const press = (row: HTMLElement) =>
      act(async () =>
        row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, button: 2, clientX: 40, clientY: 60 })),
      );
    await press(rows()[2]);
    const labels = menuItems().map((item) => item.textContent);
    expect(labels).toContain("library.openNote");
    expect(labels).toContain("library.lookup.complete");
    await act(async () =>
      menuItems()
        .find((item) => item.textContent === "library.moveToTrash")!
        .click(),
    );
    expect(mocks.trash).toHaveBeenCalledWith("/lib", "Paper3");

    await press(rows()[0]);
    await act(async () =>
      menuItems()
        .find((item) => item.textContent === "library.openNote")!
        .click(),
    );
    expect(mocks.open).toHaveBeenCalledWith("/lib/条目/Paper1/Paper1.md");
  });
});
