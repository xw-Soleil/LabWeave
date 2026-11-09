// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ readFile: vi.fn(), stat: vi.fn(), writeFile: vi.fn(), open: vi.fn() }));
vi.mock("@tauri-apps/plugin-fs", () => ({ readFile: mocks.readFile, stat: mocks.stat, writeFile: mocks.writeFile }));
vi.mock("@tauri-apps/plugin-shell", () => ({ open: mocks.open }));
vi.mock("@/core/research/ResearchFolder", () => ({
  ResearchFolder: { ensureRootRegistered: vi.fn() },
  notifyResearchFilesChanged: vi.fn(),
}));
vi.mock("@/core/service/Settings", () => ({ Settings: {} }));
vi.mock("@/core/service/Telemetry", () => ({ Telemetry: {} }));
vi.mock("@/components/ui/dialog", () => ({ Dialog: { buttons: vi.fn() } }));
vi.mock("i18next", () => ({ default: { t: (key: string) => key } }));
import { DocumentTab } from "./DocumentTab";
import DocumentView from "./DocumentView";

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  URL.createObjectURL = vi.fn(() => "blob:local-image");
  URL.revokeObjectURL = vi.fn();
  mocks.stat.mockResolvedValue({ mtime: new Date(1), size: 10 });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("Markdown document view", () => {
  it("renders inline/block math, tables and scoped relative images; disposes image URLs", async () => {
    mocks.readFile.mockImplementation(async (path: string) =>
      new TextEncoder().encode(
        path.endsWith(".md")
          ? "# Note\n$x^2$\n\n$$\ny=1\n$$\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n![figure](../fig/a.png)"
          : "png",
      ),
    );
    const tab = new DocumentTab("/research/notes/a.md", "markdown");
    await tab.loadMarkdown();
    await act(async () => root.render(<DocumentView tab={tab} />));
    expect(container.querySelectorAll(".katex")).toHaveLength(2);
    expect(container.querySelector("table")?.textContent).toContain("ab12");
    expect(mocks.readFile).toHaveBeenCalledWith("/research/fig/a.png");
    expect(container.querySelector("img")?.getAttribute("src")).toBe("blob:local-image");
    await act(async () => root.render(null));
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:local-image");
  });
  it("does not load remote image URLs from untrusted Markdown", async () => {
    mocks.readFile.mockResolvedValue(new TextEncoder().encode("![tracking](https://host/pixel.png)"));
    const tab = new DocumentTab("/r/a.md", "markdown");
    await tab.loadMarkdown();
    await act(async () => root.render(<DocumentView tab={tab} />));
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("document.errors.imageNotLocal");
    expect(mocks.readFile).toHaveBeenCalledOnce();
  });
});
