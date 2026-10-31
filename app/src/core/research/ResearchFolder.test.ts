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
});
