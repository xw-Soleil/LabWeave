// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/core/Project", () => ({ Project: class {}, service: () => (target: unknown) => target }));
vi.mock("@/core/service/Settings", () => ({ Settings: { antialiasing: "disabled" } }));
vi.mock("@/state", () => ({ activeTabAtom: {}, store: { get: () => undefined } }));

import { Canvas } from "./Canvas";

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as never);
});

describe("a board's canvas", () => {
  it("stops listening to the window once the board is closed, so the board can be freed", () => {
    const pressingKeySet = new Set(["a"]);
    const canvas = new Canvas({ controller: { pressingKeySet }, loop: () => {}, isRunning: true } as never);
    window.dispatchEvent(new Event("blur"));
    expect(pressingKeySet.size).toBe(0);

    canvas.dispose();
    pressingKeySet.add("a");
    window.dispatchEvent(new Event("blur"));
    window.dispatchEvent(new KeyboardEvent("keyup", { key: "a" }));
    expect(pressingKeySet.size).toBe(1);
    const find = new KeyboardEvent("keydown", { key: "f", ctrlKey: true, cancelable: true });
    window.dispatchEvent(find);
    expect(find.defaultPrevented).toBe(false);
  });
});
