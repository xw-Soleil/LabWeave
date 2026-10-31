// @vitest-environment jsdom

import {
  activeDockedTabAtom,
  activeGroupIdAtom,
  activeResourceTabAtom,
  activeTabAtom,
  store,
  tabGroupRootAtom,
  tabsAtom,
} from "@/state";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./service/Settings", () => ({ Settings: { maxFps: 60, maxFpsUnfocused: 60 } }));
vi.mock("./service/Telemetry", () => ({ Telemetry: { event: vi.fn() } }));
vi.mock("@/components/ui/dialog", () => ({ Dialog: { buttons: vi.fn() } }));

import { URI } from "vscode-uri";
import { Tab } from "./Tab";
import { createTabGroup, findTabGroupByTabId, FIXED_SIDE_GROUP_IDS, getTabGroups, splitTabGroup } from "./TabGroup";
import { TabWorkspace } from "./TabWorkspace";

class TestTab extends Tab {
  getComponent() {
    return () => null;
  }
}

class TestResourceTab extends TestTab {
  readonly uri = URI.parse("draft:test");
}

function openTestTab() {
  const tab = new TestTab({});
  const group = createTabGroup([tab.id], "test-group");
  store.set(tabsAtom, [tab]);
  store.set(activeTabAtom, tab);
  store.set(activeDockedTabAtom, tab);
  store.set(tabGroupRootAtom, group);
  store.set(activeGroupIdAtom, group.id);
  return tab;
}

describe("TabWorkspace close lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    store.set(tabsAtom, []);
    store.set(activeTabAtom, undefined);
    store.set(activeDockedTabAtom, undefined);
    store.set(activeResourceTabAtom, undefined);
    store.set(tabGroupRootAtom, null);
    store.set(activeGroupIdAtom, undefined);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("waits for disposal after removing the closing tab", async () => {
    const tab = openTestTab();
    let finishDisposal!: () => void;
    const dispose = vi.spyOn(tab, "dispose").mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishDisposal = resolve;
        }),
    );
    let closed = false;

    const closePromise = TabWorkspace.close(tab.id).then(() => {
      closed = true;
    });
    await Promise.resolve();

    expect(closed).toBe(false);
    await vi.advanceTimersByTimeAsync(449);
    expect(dispose).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(dispose).toHaveBeenCalledOnce();
    expect(store.get(tabsAtom)).toContain(tab);

    await vi.advanceTimersByTimeAsync(50);
    expect(store.get(tabsAtom)).not.toContain(tab);
    expect(closed).toBe(false);

    finishDisposal();
    await closePromise;
    expect(closed).toBe(true);
  });

  it("waits for tab removal when disposal finishes first", async () => {
    const tab = openTestTab();
    const dispose = vi.spyOn(tab, "dispose").mockResolvedValue();
    let closed = false;

    const closePromise = TabWorkspace.close(tab.id).then(() => {
      closed = true;
    });
    await vi.advanceTimersByTimeAsync(450);

    expect(dispose).toHaveBeenCalledOnce();
    expect(closed).toBe(false);
    expect(store.get(tabsAtom)).toContain(tab);

    await vi.advanceTimersByTimeAsync(50);
    await closePromise;
    expect(closed).toBe(true);
    expect(store.get(tabsAtom)).not.toContain(tab);
  });

  it("returns the in-flight close task when the tab is already closing", async () => {
    const tab = openTestTab();
    let finishDisposal!: () => void;
    vi.spyOn(tab, "dispose").mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishDisposal = resolve;
        }),
    );
    let duplicateClosed = false;

    const firstClose = TabWorkspace.close(tab.id);
    const duplicateClose = TabWorkspace.close(tab.id).then(() => {
      duplicateClosed = true;
    });
    await vi.advanceTimersByTimeAsync(500);

    expect(duplicateClosed).toBe(false);
    finishDisposal();
    await Promise.all([firstClose, duplicateClose]);
    expect(duplicateClosed).toBe(true);
  });

  it("removes the tab before reporting a disposal failure", async () => {
    const tab = openTestTab();
    const cleanupError = new Error("cleanup failed");
    vi.spyOn(tab, "dispose").mockRejectedValue(cleanupError);

    const closeResult = TabWorkspace.close(tab.id).then(
      () => undefined,
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(500);

    await expect(closeResult).resolves.toBe(cleanupError);
    expect(store.get(tabsAtom)).not.toContain(tab);
  });
});

describe("TabWorkspace opening resource tabs next to side panels", () => {
  beforeEach(() => {
    store.set(tabsAtom, []);
    store.set(activeTabAtom, undefined);
    store.set(activeDockedTabAtom, undefined);
    store.set(activeResourceTabAtom, undefined);
    store.set(tabGroupRootAtom, null);
    store.set(activeGroupIdAtom, undefined);
  });

  function openSidePanel(mainTab?: Tab) {
    const panel = new TestTab({});
    const side = createTabGroup([panel.id], FIXED_SIDE_GROUP_IDS.left);
    if (mainTab) {
      const main = createTabGroup([mainTab.id], "main-group");
      store.set(tabsAtom, [mainTab, panel]);
      store.set(tabGroupRootAtom, splitTabGroup(main, main.id, side, "left"));
    } else {
      store.set(tabsAtom, [panel]);
      store.set(tabGroupRootAtom, side);
    }
    store.set(activeGroupIdAtom, side.id);
    return panel;
  }

  it("puts a project into the main group when a fixed side group is active", () => {
    const existing = new TestResourceTab({});
    openSidePanel(existing);

    const project = TabWorkspace.open(new TestResourceTab({}));

    expect(findTabGroupByTabId(store.get(tabGroupRootAtom), project.id)?.id).toBe("main-group");
    expect(store.get(activeGroupIdAtom)).toBe("main-group");
  });

  it("creates a main group beside the side panel when no main group exists", () => {
    openSidePanel();

    const project = TabWorkspace.open(new TestResourceTab({}));

    const root = store.get(tabGroupRootAtom);
    const group = findTabGroupByTabId(root, project.id);
    expect(group?.id).not.toBe(FIXED_SIDE_GROUP_IDS.left);
    expect(getTabGroups(root).map((candidate) => candidate.id)).toEqual([FIXED_SIDE_GROUP_IDS.left, group?.id]);
    expect(root?.type === "split" && root.sizes[1]).toBeGreaterThan(50);
  });

  it("still stacks component tabs into the active side group", () => {
    openSidePanel(new TestResourceTab({}));

    const component = TabWorkspace.open(new TestTab({}));

    expect(findTabGroupByTabId(store.get(tabGroupRootAtom), component.id)?.id).toBe(FIXED_SIDE_GROUP_IDS.left);
  });

  it("synchronizes a missing project into the main group", () => {
    openSidePanel(new TestResourceTab({}));
    const project = new TestResourceTab({});
    store.set(tabsAtom, [...store.get(tabsAtom), project]);

    TabWorkspace.synchronizeGroups();

    expect(findTabGroupByTabId(store.get(tabGroupRootAtom), project.id)?.id).toBe("main-group");
  });
});
