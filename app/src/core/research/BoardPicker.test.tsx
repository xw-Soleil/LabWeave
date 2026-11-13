// @vitest-environment jsdom
import { atom, getDefaultStore } from "jotai";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ main: vi.fn() }));
vi.mock("@/state", () => ({ store: getDefaultStore(), tabsAtom: atom<unknown[]>([]) }));
vi.mock("@/core/Project", () => ({
  Project: class Project {
    closing = false;
    isDraft = false;
    uri: { scheme: string; fsPath: string; path: string };
    constructor(
      public id: string,
      public title: string,
    ) {
      this.uri = { scheme: "file", fsPath: `/research/${title}`, path: `/research/${title}` };
    }
  },
}));
vi.mock("./ResearchSession", () => ({ findMainProject: mocks.main }));
vi.mock("./ResearchFolder", () => ({
  ResearchFolder: {
    isInside: (path: string) => path.startsWith("/research/"),
    toRelative: (path: string) => path.replace("/research/", ""),
  },
}));
vi.mock("i18next", () => ({
  default: { t: (key: string, options?: { n?: string }) => (options?.n ? `${key}:${options.n}` : key) },
}));

import RenderOverlays from "@/components/overlay-host";
import { Project } from "@/core/Project";
import { store, tabsAtom } from "@/state";
import { boardName, chooseBoard, openBoards } from "./BoardPicker";

const board = (id: string, title: string) =>
  new (Project as unknown as new (id: string, title: string) => Project)(id, title);
let root: Root;
let container: HTMLDivElement;
beforeEach(async () => {
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
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  mocks.main.mockReset();
  store.set(tabsAtom, []);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<RenderOverlays />));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const items = () => [...document.querySelectorAll<HTMLElement>("[cmdk-item]")];

describe("choosing a board to send to", () => {
  it("names a board the way its tab does", () => {
    expect(boardName(board("a", "读书笔记.prg"))).toBe("读书笔记");
    const draft = Object.assign(board("b", "x"), { isDraft: true, uri: { scheme: "draft", path: "2" } });
    expect(boardName(draft)).toBe("tabs.untitled:2");
  });

  it("answers at once without asking when no board or only one board is open", async () => {
    expect(await chooseBoard()).toBeUndefined();
    const only = board("a", "one.prg");
    const closing = board("b", "closing.prg");
    closing.closing = true;
    store.set(tabsAtom, [{ id: "pdf" }, only, closing] as never);
    expect(await chooseBoard()).toBe(only);
    expect(items()).toEqual([]);
  });

  it("lists the open boards with the one on screen first, and remembers the pick for next time", async () => {
    const first = board("a", "一.prg");
    const second = board("b", "二.prg");
    const third = board("c", "三.prg");
    store.set(tabsAtom, [first, second, third] as never);
    mocks.main.mockReturnValue(second);
    let picked: Promise<Project | undefined>;
    await act(async () => {
      picked = chooseBoard();
    });
    expect(items().map((item) => item.textContent)).toEqual(["二二.prg", "一一.prg", "三三.prg"]);
    await act(async () => items()[2].click());
    expect(await picked!).toBe(third);
    // 关闭动画放完，列表就从页面上拿掉
    await act(async () => vi.advanceTimersByTime(400));
    expect(items()).toEqual([]);
    // 接着再发，上次选的那块排在最前，按回车就是它
    expect(openBoards().map((item) => item.id)).toEqual(["c", "b", "a"]);
  });

  it("answers with nothing when the list is dismissed", async () => {
    store.set(tabsAtom, [board("a", "一.prg"), board("b", "二.prg")] as never);
    let picked: Promise<Project | undefined>;
    await act(async () => {
      picked = chooseBoard();
    });
    expect(items()).toHaveLength(2);
    await act(async () => {
      document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(await picked!).toBeUndefined();
    await act(async () => vi.advanceTimersByTime(400));
  });
});
