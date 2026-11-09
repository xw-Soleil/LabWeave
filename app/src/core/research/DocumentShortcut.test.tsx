// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/core/Project", () => ({ Project: class {} }));
vi.mock("@/core/service/controlService/shortcutKeysEngine/shortcutKeysRegister", () => ({ allKeyBinds: [] }));
vi.mock("@/core/service/Settings", () => ({ Settings: {} }));
vi.mock("@/core/service/Telemetry", () => ({ Telemetry: {} }));
vi.mock("@/utils/platform", () => ({ isMac: true }));
vi.mock("@/utils/store", () => ({ createStore: vi.fn() }));
vi.mock("@/core/research/ResearchFolder", () => ({
  ResearchFolder: { ensureRootRegistered: vi.fn() },
  notifyResearchFilesChanged: vi.fn(),
}));
vi.mock("@/components/ui/dialog", () => ({ Dialog: {} }));
import { KeyBindsUI } from "@/core/service/controlService/shortcutKeysEngine/KeyBindsUI";
import { activeResourceTabAtom, activeTabAtom, store, tabsAtom } from "@/state";
import { activeDocumentTab, DocumentTab } from "./DocumentTab";

beforeEach(() => {
  KeyBindsUI.uiStartListen();
});
afterEach(() => {
  KeyBindsUI.uiStopListen();
  KeyBindsUI.unregisterOneUIKeyBind("saveFile");
  document.body.replaceChildren();
});

describe("Markdown save through shell keyboard routing", () => {
  it.each(["textarea", "input"])("routes Cmd+S in %s to the active document with no board", async (tag) => {
    const tab = new DocumentTab("/r/a.md", "markdown");
    const save = vi.spyOn(tab, "save").mockResolvedValue(true);
    store.set(tabsAtom, [tab]);
    store.set(activeTabAtom, tab);
    store.set(activeResourceTabAtom, tab);
    KeyBindsUI.registerOneUIKeyBind(
      "saveFile",
      "M-s",
      true,
      () => void activeDocumentTab()!.save(),
      undefined,
      false,
      () => activeDocumentTab()?.kind === "markdown",
    );
    const field = document.createElement(tag);
    document.body.append(field);
    field.focus();
    const event = new KeyboardEvent("keydown", { key: "s", metaKey: true, bubbles: true, cancelable: true });
    field.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "s", bubbles: true, cancelable: true }));
    expect(save).toHaveBeenCalledOnce();
  });
});
