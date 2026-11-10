// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  windows: false,
  read: vi.fn(),
  add: vi.fn(),
  create: vi.fn(),
  exists: vi.fn(),
  done: vi.fn(),
}));
vi.mock("@/core/service/Settings", () => ({ Settings: {} }));
vi.mock("@/components/overlay-host", () => ({ OverlayHost: { open: vi.fn(), close: vi.fn() } }));
vi.mock("@/utils/platform", () => ({
  get isWindows() {
    return mocks.windows;
  },
}));
vi.mock("@tauri-apps/api/path", () => ({ homeDir: async () => "/home/user" }));
vi.mock("@tauri-apps/plugin-fs", () => ({ exists: mocks.exists }));
vi.mock("./ResearchWorkspace", () => ({
  readResearchDirectory: mocks.read,
  addResearchProject: mocks.add,
  createResearchProject: mocks.create,
  projectName: (path: string) => path.split("/").at(-1),
  loadResearchWorkspace: async () => ({ recentProjects: ["/recent/lab"] }),
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
import { folderBrowserLocations, ResearchFolderBrowser } from "./ResearchFolderBrowser";

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.windows = false;
  mocks.exists.mockImplementation(async (path: string) => ["/Volumes", "C:/", "D:/"].includes(path));
  mocks.read.mockImplementation(async (_root: string, path: string) =>
    path === "/home/user" ? [{ name: "papers", absPath: "/home/user/papers", directory: true }] : [],
  );
  mocks.add.mockImplementation(async (path) => path);
  mocks.create.mockImplementation(async (path, name) => `${path}/${name}`);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
const button = (text: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === text)!;

describe("in-app folder browser", () => {
  it("can retry when the starting locations fail to load", async () => {
    mocks.exists.mockRejectedValueOnce(new Error("disk unavailable"));
    await act(async () => root.render(<ResearchFolderBrowser create={false} onDone={mocks.done} />));
    expect(document.querySelector('[role="alert"]')).not.toBeNull();
    await act(async () => button("files.retry").click());
    expect(button("papers")).toBeDefined();
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(mocks.add).not.toHaveBeenCalled();
  });
  it("offers home, macOS volumes and recent projects, and enumerates Windows drive roots", async () => {
    expect(await folderBrowserLocations()).toEqual({
      home: "/home/user",
      drives: ["/Volumes"],
      recent: ["/recent/lab"],
    });
    mocks.windows = true;
    expect((await folderBrowserLocations()).drives).toEqual(["C:/", "D:/"]);
    expect(mocks.exists).toHaveBeenCalledWith("Z:/");
  });
  it("navigates folders without authorizing them and grants only the folder explicitly selected", async () => {
    await act(async () => root.render(<ResearchFolderBrowser create={false} onDone={mocks.done} />));
    expect(mocks.read).toHaveBeenCalledExactlyOnceWith("/home/user", "/home/user", true);
    await act(async () => button("papers").click());
    expect(mocks.read).toHaveBeenLastCalledWith("/home/user/papers", "/home/user/papers", true);
    expect(mocks.add).not.toHaveBeenCalled();
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="projectTree.parent"]')!.click());
    await act(async () => button("lab").click());
    await act(async () => button("projectTree.useFolder").click());
    expect(mocks.add).toHaveBeenCalledExactlyOnceWith("/recent/lab");
    expect(mocks.done).toHaveBeenCalledWith("/recent/lab");
  });
  it("creates at the browsed location and keeps creation errors in the dialog for correction", async () => {
    await act(async () => root.render(<ResearchFolderBrowser create onDone={mocks.done} />));
    const input = document.querySelector("input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "New");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    mocks.create.mockRejectedValueOnce(new Error("invalidProjectName"));
    await act(async () => button("projectTree.createHere").click());
    expect(document.querySelector('[role="alert"]')).not.toBeNull();
    expect(mocks.done).not.toHaveBeenCalled();
    await act(async () => button("projectTree.createHere").click());
    expect(mocks.create).toHaveBeenLastCalledWith("/home/user", "New");
    expect(mocks.done).toHaveBeenCalledWith("/home/user/New");
    expect(mocks.add).not.toHaveBeenCalled();
  });
  it("cancels without creating or authorizing a folder", async () => {
    await act(async () => root.render(<ResearchFolderBrowser create onDone={mocks.done} />));
    await act(async () => button("document.cancel").click());
    expect(mocks.done).toHaveBeenCalledWith(null);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.add).not.toHaveBeenCalled();
  });
});
