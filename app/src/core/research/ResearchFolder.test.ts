import { describe, expect, it, vi } from "vitest";

vi.mock("@/core/service/Settings", () => ({ Settings: { researchFolderPath: "/Users/me/Research/" } }));

import { ResearchFolder } from "./ResearchFolder";

describe("ResearchFolder path helpers", () => {
  it("reads the root from Settings", () => {
    expect(ResearchFolder.getRoot()).toBe("/Users/me/Research/");
  });

  it("checks containment case-insensitively and in NFC", () => {
    expect(ResearchFolder.isInside("/Users/me/Research/papers/a.pdf")).toBe(true);
    expect(ResearchFolder.isInside("/users/ME/research")).toBe(true);
    expect(ResearchFolder.isInside("/Users/me/Research2/a.pdf")).toBe(false);
    expect(ResearchFolder.isInside("/Users/me/Research/../secret.pdf")).toBe(false);
    expect(ResearchFolder.isInside("papers/a.pdf")).toBe(false);
    // Finder \u53ef\u80fd\u7ed9\u51fa NFD \u5f62\u5f0f\u7684\u6587\u4ef6\u540d
    expect(ResearchFolder.toRelative("/Users/me/Cafe\u0301/a.pdf", "/Users/me/Caf\u00e9")).toBe("a.pdf");
  });

  it("makes POSIX relative paths, with ../ when needed", () => {
    expect(ResearchFolder.toRelative("/Users/me/Research/papers/a.pdf")).toBe("papers/a.pdf");
    expect(ResearchFolder.toRelative("/Users/me/Research/papers/a.pdf", "/Users/me/Research/notes")).toBe(
      "../papers/a.pdf",
    );
    expect(ResearchFolder.toRelative("C:\\Research\\papers\\a.pdf", "C:\\Research")).toBe("papers/a.pdf");
    expect(ResearchFolder.toRelative("D:\\other\\a.pdf", "C:\\Research")).toBe("D:/other/a.pdf");
  });

  it("resolves relative paths against the base folder", () => {
    expect(ResearchFolder.toAbsolute("papers/a.pdf")).toBe("/Users/me/Research/papers/a.pdf");
    expect(ResearchFolder.toAbsolute("../papers/./a.pdf", "/Users/me/Research/notes")).toBe(
      "/Users/me/Research/papers/a.pdf",
    );
    expect(ResearchFolder.toAbsolute("/elsewhere/a.pdf")).toBe("/elsewhere/a.pdf");
    expect(ResearchFolder.toAbsolute("papers\\a.pdf", "C:\\Research")).toBe("C:/Research/papers/a.pdf");
  });

  describe("Windows UNC paths (network shares, mapped drives)", () => {
    const uncRoot = "\\\\nas\\share\\Research";

    it("keeps the \\\\server\\share prefix when resolving", () => {
      expect(ResearchFolder.toAbsolute("导入", uncRoot)).toBe("//nas/share/Research/导入");
      expect(ResearchFolder.toAbsolute("papers/a.pdf", "//nas/share/Research/topic")).toBe(
        "//nas/share/Research/topic/papers/a.pdf",
      );
      expect(ResearchFolder.toAbsolute("\\\\nas\\share\\Research/a.pdf")).toBe("//nas/share/Research/a.pdf");
      // 退不到共享根外面
      expect(ResearchFolder.toAbsolute("../../../a.pdf", "//nas/share/R")).toBe("//nas/share/a.pdf");
    });

    it("makes relative paths only within the same share", () => {
      expect(ResearchFolder.toRelative("\\\\nas\\share\\Research\\papers\\a.pdf", uncRoot)).toBe("papers/a.pdf");
      expect(ResearchFolder.toRelative("//NAS/share/Research/notes/b.md", "//nas/share/Research/topic")).toBe(
        "../notes/b.md",
      );
      expect(ResearchFolder.toRelative("\\\\other\\share\\a.pdf", uncRoot)).toBe("//other/share/a.pdf");
      expect(ResearchFolder.toRelative("C:\\local\\a.pdf", uncRoot)).toBe("C:/local/a.pdf");
      expect(ResearchFolder.toRelative("\\\\nas\\share\\a.pdf", "C:\\Research")).toBe("//nas/share/a.pdf");
    });

    it("checks containment against a UNC root", async () => {
      const { Settings } = await import("@/core/service/Settings");
      const saved = Settings.researchFolderPath;
      Settings.researchFolderPath = uncRoot;
      try {
        expect(ResearchFolder.isInside("\\\\nas\\share\\Research\\papers\\a.pdf")).toBe(true);
        expect(ResearchFolder.isInside("//nas/share/Research")).toBe(true);
        expect(ResearchFolder.isInside("/nas/share/Research/a.pdf")).toBe(false);
        expect(ResearchFolder.isInside("\\\\nas\\other\\Research\\a.pdf")).toBe(false);
        expect(ResearchFolder.toAbsolute("papers/a.pdf")).toBe("//nas/share/Research/papers/a.pdf");
      } finally {
        Settings.researchFolderPath = saved;
      }
    });
  });
});
