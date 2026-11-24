import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  root: "/research/课题",
  library: "/papers",
  projects: ["/research/课题", "/research/另一个项目"],
  files: new Set<string>(),
  openBoard: vi.fn(),
  openDocument: vi.fn(),
  oldLinks: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
}));
vi.mock("@/core/service/Settings", () => ({
  Settings: {
    get literatureLibraryPath() {
      return mocks.library;
    },
  },
}));
vi.mock("@tauri-apps/plugin-fs", () => ({ exists: async (path: string) => mocks.files.has(path) }));
vi.mock("i18next", () => ({ default: { t: (key: string) => key } }));
vi.mock("sonner", () => ({ toast: { warning: mocks.warning, error: mocks.error } }));
vi.mock("./ResearchFolder", () => {
  const resolve = (path: string) => {
    const parts: string[] = [];
    for (const part of path.split("/")) {
      if (part === "..") parts.pop();
      else if (part && part !== ".") parts.push(part);
    }
    return `/${parts.join("/")}`;
  };
  return {
    ResearchFolder: {
      getRoot: () => mocks.root,
      toAbsolute: (path: string, base: string = mocks.root) => resolve(path.startsWith("/") ? path : `${base}/${path}`),
      isInside: (path: string, base: string) => !!base && path.startsWith(`${base}/`),
    },
  };
});
vi.mock("./ResearchWorkspace", () => ({
  loadResearchWorkspace: async () => ({}),
  activeResearchWorkspace: () => ({ projects: mocks.projects.map((path) => ({ path })) }),
}));
vi.mock("./DocumentTab", () => ({ openDocumentFile: mocks.openDocument }));
vi.mock("@/core/service/GlobalMenu", () => ({ onOpenFile: mocks.openBoard }));
vi.mock("@/core/service/dataFileService/DeepLinkHandler", () => ({ handleDeepLink: mocks.oldLinks }));

import { recordLink } from "./ReportTools";
import { followReportLink, openReportLink, parseReportLink, resolveReportLink } from "./ReportLinks";

function board(cards: string[]) {
  const camera = {
    location: "视野中心",
    currentScale: 2,
    resetByRectangle: vi.fn(),
    applySavedView: vi.fn(),
  };
  return {
    camera,
    // 画布的宽高；白板标签页不在前面时是 0
    renderer: { w: 1200, h: 800 },
    stageManager: {
      getEntities: () => cards.map((uuid) => ({ uuid, collisionBox: { getRectangle: () => `${uuid} 的位置` } })),
    },
  };
}

beforeEach(() => {
  mocks.root = "/research/课题";
  mocks.library = "/papers";
  mocks.files = new Set([
    "/research/课题/白板.prg",
    "/research/课题/论文/main (v2).pdf",
    "/research/课题/笔记/想法.md",
    "/research/另一个项目/别的白板.prg",
    "/papers/作者2024/paper.pdf",
    "/research/我的进展/2026-11-15 阶段小结.md",
    "/etc/secret.pdf",
  ]);
  vi.clearAllMocks();
});

describe("parseReportLink", () => {
  it("拆得开 recordLink 写出来的四种链接", () => {
    expect(parseReportLink(recordLink(mocks.root, { board: "白板.prg", card: "c1" })!)).toEqual({
      project: "课题",
      library: false,
      path: "白板.prg",
      target: "c1",
    });
    expect(parseReportLink(recordLink(mocks.root, { file: "论文/main (v2).pdf", page: 3, annotation: "A1" })!)).toEqual(
      { project: "课题", library: false, path: "论文/main (v2).pdf", page: 3, annotation: "A1" },
    );
    expect(parseReportLink(recordLink(mocks.root, { library: "作者2024/paper.pdf", page: 5 })!)).toEqual({
      library: true,
      path: "作者2024/paper.pdf",
      page: 5,
    });
    expect(parseReportLink(recordLink(mocks.root, { file: "笔记/想法.md" })!)).toEqual({
      project: "课题",
      library: false,
      path: "笔记/想法.md",
    });
    // Markdown 渲染时会把中文转成 %XX，照样认
    expect(parseReportLink("rwb://open?project=%E8%AF%BE%E9%A2%98&path=%E7%99%BD%E6%9D%BF.prg&target=c1")).toEqual({
      project: "课题",
      library: false,
      path: "白板.prg",
      target: "c1",
    });
  });

  it("老写法的白板链接和别的网址不归这里管", () => {
    expect(parseReportLink("rwb://open?path=/research/课题/白板.prg&target=c1")).toBeUndefined();
    expect(parseReportLink("rwb://open")).toBeUndefined();
    expect(parseReportLink("https://example.com/a.pdf")).toBeUndefined();
    // 只带 path 的笔记和 PDF 老写法打不开，归这里
    expect(parseReportLink("rwb://open?path=/research/我的进展/2026-11-15 阶段小结.md")).toMatchObject({
      path: "/research/我的进展/2026-11-15 阶段小结.md",
    });
  });
});

describe("resolveReportLink", () => {
  const resolve = (url: string) => resolveReportLink(parseReportLink(url)!);

  it("按项目名、文献库找到这台电脑上的文件", async () => {
    expect(await resolve("rwb://open?project=课题&path=白板.prg")).toBe("/research/课题/白板.prg");
    expect(await resolve("rwb://open?library=1&path=作者2024/paper.pdf")).toBe("/papers/作者2024/paper.pdf");
    // 别的项目：按文件夹名在项目列表里找
    expect(await resolve("rwb://open?project=另一个项目&path=别的白板.prg")).toBe("/research/另一个项目/别的白板.prg");
    // 「我的进展」里的报告记的是完整路径
    expect(await resolve("rwb://open?path=/research/我的进展/2026-11-15 阶段小结.md")).toBe(
      "/research/我的进展/2026-11-15 阶段小结.md",
    );
  });

  it("找不到、跑到外面去的都拒绝，并说清是哪种", async () => {
    await expect(resolve("rwb://open?project=没有这个项目&path=a.prg")).rejects.toThrow("reportLink.noProject");
    await expect(resolve("rwb://open?project=课题&path=已经删了.md")).rejects.toThrow("reportLink.missing");
    await expect(resolve("rwb://open?project=课题&path=../../etc/secret.pdf")).rejects.toThrow("reportLink.outside");
    await expect(resolve("rwb://open?path=/etc/secret.pdf")).rejects.toThrow("reportLink.outside");
    mocks.library = "";
    await expect(resolve("rwb://open?library=1&path=作者2024/paper.pdf")).rejects.toThrow("reportLink.noLibrary");
  });
});

describe("openReportLink", () => {
  it("卡片：打开白板，把镜头对过去并定住", async () => {
    const project = board(["c1"]);
    mocks.openBoard.mockResolvedValue(project);
    expect(await openReportLink("rwb://open?project=课题&path=白板.prg&target=c1")).toBe(true);
    expect(mocks.openBoard.mock.calls[0][0].path).toBe("/research/课题/白板.prg");
    expect(project.camera.resetByRectangle).toHaveBeenCalledWith("c1 的位置");
    expect(project.camera.applySavedView).toHaveBeenCalledWith("视野中心", 2);
  });

  it("白板标签页刚切到前面、画布还没排好时，等它排好再对镜头（不然会算出 NaN）", async () => {
    vi.useFakeTimers();
    try {
      const project = board(["c1"]);
      project.renderer = { w: 0, h: 0 };
      mocks.openBoard.mockResolvedValue(project);
      const opened = openReportLink("rwb://open?project=课题&path=白板.prg&target=c1");
      await vi.advanceTimersByTimeAsync(400);
      expect(project.camera.resetByRectangle).not.toHaveBeenCalled();
      project.renderer = { w: 1200, h: 800 };
      await vi.advanceTimersByTimeAsync(100);
      expect(await opened).toBe(true);
      expect(project.camera.resetByRectangle).toHaveBeenCalledWith("c1 的位置");

      // 一直没排好（比如窗口最小化着）就不动镜头，也不报错
      const hidden = board(["c1"]);
      hidden.renderer = { w: 0, h: 0 };
      mocks.openBoard.mockResolvedValue(hidden);
      const never = openReportLink("rwb://open?project=课题&path=白板.prg&target=c1");
      await vi.advanceTimersByTimeAsync(5000);
      expect(await never).toBe(true);
      expect(hidden.camera.resetByRectangle).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("卡片已经删掉：白板照样打开，提示一句，不报错", async () => {
    const project = board([]);
    mocks.openBoard.mockResolvedValue(project);
    expect(await openReportLink("rwb://open?project=课题&path=白板.prg&target=c1")).toBe(true);
    expect(mocks.warning).toHaveBeenCalledWith("reportLink.cardGone");
    expect(project.camera.resetByRectangle).not.toHaveBeenCalled();
  });

  it("批注：打开 PDF 翻到那一页、指到那条批注；笔记直接打开", async () => {
    await openReportLink(recordLink(mocks.root, { file: "论文/main (v2).pdf", page: 3, annotation: "A1" })!);
    expect(mocks.openDocument).toHaveBeenLastCalledWith("/research/课题/论文/main (v2).pdf", {
      pdf: { page: 3, annotationId: "A1" },
    });
    await openReportLink(recordLink(mocks.root, { library: "作者2024/paper.pdf", page: 5, annotation: "B7" })!);
    expect(mocks.openDocument).toHaveBeenLastCalledWith("/papers/作者2024/paper.pdf", {
      pdf: { page: 5, annotationId: "B7" },
    });
    await openReportLink(recordLink(mocks.root, { file: "笔记/想法.md" })!);
    expect(mocks.openDocument).toHaveBeenLastCalledWith("/research/课题/笔记/想法.md", undefined);
  });

  it("不是这里管的链接不动", async () => {
    expect(await openReportLink("https://example.com")).toBe(false);
    expect(mocks.openBoard).not.toHaveBeenCalled();
    expect(mocks.openDocument).not.toHaveBeenCalled();
  });
});

describe("followReportLink", () => {
  it("同一个链接可以反复点", async () => {
    const url = recordLink(mocks.root, { file: "笔记/想法.md" })!;
    expect(await followReportLink(url)).toBe(true);
    expect(await followReportLink(url)).toBe(true);
    expect(mocks.openDocument).toHaveBeenCalledTimes(2);
  });

  it("打不开时提示一句；老写法的白板链接转给原来的处理；别的网址不管", async () => {
    expect(await followReportLink("rwb://open?project=课题&path=已经删了.md")).toBe(true);
    expect(mocks.error).toHaveBeenCalledWith("reportLink.missing");
    expect(await followReportLink("rwb://open?path=/research/课题/白板.prg")).toBe(true);
    expect(mocks.oldLinks).toHaveBeenCalledWith(["rwb://open?path=/research/课题/白板.prg"]);
    expect(await followReportLink("https://example.com")).toBe(false);
    expect(await followReportLink("笔记/想法.md")).toBe(false);
  });
});
