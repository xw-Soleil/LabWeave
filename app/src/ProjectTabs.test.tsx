// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { URI } from "vscode-uri";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  aiPanelTab: undefined as unknown,
  toastWarning: vi.fn(),
  outsideRoot: "/elsewhere/",
}));

vi.mock("./core/research/ResearchSession", () => ({ findResearchPanelTab: () => mocks.aiPanelTab }));
vi.mock("./core/research/TemporaryWorkspace", () => ({
  isTemporaryWorkspace: (project: { uri: URI }) => project.uri.path.startsWith(mocks.outsideRoot),
}));
vi.mock("./core/service/Settings", () => ({ Settings: { protectingPrivacy: false, watch: () => () => {} } }));
vi.mock("./core/service/feedbackService/SoundService", () => ({
  SoundService: { play: new Proxy({}, { get: () => () => {} }) },
}));
vi.mock("./core/TabWorkspace", () => ({
  TabWorkspace: {
    getDropTarget: vi.fn(),
    clearDropPreview: vi.fn(),
    moveTab: vi.fn(),
    float: vi.fn(),
    previewDrop: vi.fn(),
  },
}));
vi.mock("./components/tab-context-menu", () => ({
  default: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("./utils/font", () => ({ replaceTextWhenProtect: (text: string) => text }));
vi.mock("./state", async () => {
  const { atom, getDefaultStore } = await import("jotai");
  return { activeResourceTabAtom: atom<unknown>(undefined), store: getDefaultStore() };
});
vi.mock("sonner", () => ({ toast: { warning: mocks.toastWarning } }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { n?: string }) => (options?.n !== undefined ? `${key}:${options.n}` : key),
  }),
}));
vi.mock("./core/Tab", () => {
  class Tab {
    readonly id = crypto.randomUUID();
    closable = true;
    get title() {
      return "";
    }
    get icon(): React.ComponentType | null {
      return null;
    }
  }
  class ComponentTab extends Tab {
    readonly contextTarget: string | undefined;
    private readonly tabTitle: string;
    constructor(options: { title?: string; contextTarget?: string; closable?: boolean }) {
      super();
      this.tabTitle = options.title ?? "";
      this.contextTarget = options.contextTarget;
      this.closable = options.closable ?? true;
    }
    override get title() {
      return this.tabTitle;
    }
  }
  return { Tab, ComponentTab };
});
vi.mock("./core/Project", async () => {
  const { Tab } = await import("./core/Tab");
  enum ProjectState {
    Saved,
    Stashed,
    Unsaved,
  }
  class Project extends (Tab as unknown as new () => { id: string; closable: boolean }) {
    projectState = ProjectState.Saved;
    isSaving = false;
    save = vi.fn();
    constructor(readonly uri: URI) {
      super();
    }
    get isDraft() {
      return this.uri.scheme === "draft";
    }
    get title() {
      return this.uri.scheme === "file" ? this.uri.path.split("/").pop()! : `临时草稿 (${this.uri.path})`;
    }
  }
  return { Project, ProjectState };
});

import { Project, ProjectState } from "./core/Project";
import { ComponentTab, type Tab } from "./core/Tab";
import { ProjectTabs } from "./ProjectTabs";
import { activeResourceTabAtom, store } from "./state";

const newProject = (uri: URI) => new (Project as unknown as new (uri: URI) => Project)(uri);
const newComponentTab = (options: { title?: string; contextTarget?: string; closable?: boolean }) =>
  new (ComponentTab as unknown as new (options: object) => ComponentTab)(options);

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  mocks.aiPanelTab = undefined;
  mocks.toastWarning.mockClear();
  store.set(activeResourceTabAtom, undefined);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function render(tabs: Tab[], activeTab: Tab | undefined = tabs[0]) {
  const onTabClick = vi.fn();
  const onTabClose = vi.fn();
  act(() =>
    root.render(
      <ProjectTabs
        groupId="group"
        tabs={tabs}
        activeTab={activeTab}
        onTabClick={onTabClick}
        onTabClose={onTabClose}
        isClassroomMode={false}
      />,
    ),
  );
  return { onTabClick, onTabClose };
}

const tabElement = (tab: Tab) => container.querySelector<HTMLElement>(`[data-pg-docked-tab-id="${tab.id}"]`)!;
const closeButton = (tab: Tab) => tabElement(tab).querySelector<HTMLButtonElement>('button[aria-label="tabs.close"]')!;
const mouse = (type: string, button = 0) => new MouseEvent(type, { bubbles: true, button });

describe("ProjectTabs", () => {
  it("shows workspace names without .prg, the full path as tooltip, and drafts as untitled", () => {
    const file = newProject(URI.file("/research/垃圾分类模型对比.prg"));
    const draft = newProject(URI.parse("draft:3"));
    render([file, draft]);

    expect(tabElement(file).textContent).toBe("垃圾分类模型对比");
    expect(tabElement(file).querySelector("[title]")!.getAttribute("title")).toBe("/research/垃圾分类模型对比.prg");
    expect(tabElement(draft).textContent).toBe("tabs.untitled:3");
    expect(tabElement(file).getAttribute("aria-selected")).toBe("true");
    expect(tabElement(draft).getAttribute("aria-selected")).toBe("false");
  });

  it("marks boards outside the research folder with an icon, italics and an explaining tooltip", () => {
    const outside = newProject(URI.file("/elsewhere/借来的.prg"));
    const inside = newProject(URI.file("/research/综述.prg"));
    render([outside, inside]);

    const outsideName = tabElement(outside).querySelector("[title]")!;
    expect(tabElement(outside).textContent).toBe("借来的");
    expect(tabElement(outside).querySelector(".lucide-folder-output")).not.toBeNull();
    expect(outsideName.className).toContain("italic");
    expect(outsideName.getAttribute("title")).toBe("tabs.outsideFolder");
    const insideName = tabElement(inside).querySelector("[title]")!;
    expect(tabElement(inside).querySelector(".lucide-folder-output")).toBeNull();
    expect(insideName.className).not.toContain("italic");
    expect(insideName.getAttribute("title")).toBe("/research/综述.prg");
  });

  it("labels the AI panel tab as AI chat instead of the workspace it points to", () => {
    const workspace = newProject(URI.file("/research/综述.prg"));
    store.set(activeResourceTabAtom, workspace as never);
    const ai = newComponentTab({ title: "", contextTarget: "activeResourceTab", closable: false });
    const outline = newComponentTab({ title: "大纲", contextTarget: "activeResourceTab" });
    mocks.aiPanelTab = ai;
    render([ai, outline]);

    expect(tabElement(ai).textContent).toBe("tabs.aiChat");
    expect(tabElement(outline).textContent).toBe("大纲·综述");
  });

  it("marks unsaved tabs with a dot and the × closes instead of saving", () => {
    const file = newProject(URI.file("/research/a.prg"));
    file.projectState = ProjectState.Unsaved;
    const saved = newProject(URI.file("/research/b.prg"));
    const { onTabClose, onTabClick } = render([file, saved], saved);

    expect(tabElement(file).querySelector('[aria-label="tabs.unsaved"]')).not.toBeNull();
    expect(tabElement(saved).querySelector('[aria-label="tabs.unsaved"]')).toBeNull();

    act(() => {
      closeButton(file).dispatchEvent(mouse("mousedown"));
      closeButton(file).dispatchEvent(mouse("click"));
    });
    expect(onTabClick).not.toHaveBeenCalled();
    expect(onTabClose).toHaveBeenCalledWith(file);
    expect(file.save).not.toHaveBeenCalled();
  });

  it("refuses to close a tab that is still saving", () => {
    const file = newProject(URI.file("/research/a.prg"));
    file.isSaving = true;
    const { onTabClose } = render([file]);

    act(() => closeButton(file).dispatchEvent(mouse("click")));
    expect(onTabClose).not.toHaveBeenCalled();
    expect(mocks.toastWarning).toHaveBeenCalledWith("tabs.savingWait");
  });

  it("keeps middle-click close and left-click activation on the tab", () => {
    const first = newProject(URI.file("/research/a.prg"));
    const second = newProject(URI.file("/research/b.prg"));
    const { onTabClose, onTabClick } = render([first, second]);

    act(() => tabElement(second).dispatchEvent(mouse("mousedown", 0)));
    expect(onTabClick).toHaveBeenCalledWith(second);
    act(() => window.dispatchEvent(mouse("mouseup")));

    act(() => tabElement(first).dispatchEvent(mouse("mousedown", 1)));
    expect(onTabClose).toHaveBeenCalledWith(first);
  });

  it("does not offer a close button on tabs that cannot be closed", () => {
    const panel = newComponentTab({ title: "文件", closable: false });
    render([panel]);
    expect(closeButton(panel)).toBeNull();
  });
});
