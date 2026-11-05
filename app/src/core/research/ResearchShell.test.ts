// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { emitResearchEvent, fileKindOf, onResearchEvent } from "./ResearchShell";

describe("fileKindOf", () => {
  it("classifies by extension, case-insensitively", () => {
    expect(fileKindOf("/papers/Attention.PDF")).toBe("pdf");
    expect(fileKindOf("C:\\images\\fig.JPeg")).toBe("image");
    expect(fileKindOf("notes/idea.markdown")).toBe("markdown");
    expect(fileKindOf("notes/idea.md")).toBe("markdown");
  });

  it("returns null for other files, dot files and names without an extension", () => {
    expect(fileKindOf("/a/workspace.prg")).toBeNull();
    expect(fileKindOf("/a/.md")).toBeNull();
    expect(fileKindOf("/a.pdf/README")).toBeNull();
  });
});

describe("research events", () => {
  it("delivers the detail and stops after unsubscribe", () => {
    const handler = vi.fn();
    const unsubscribe = onResearchEvent("toggleFiles", handler);
    emitResearchEvent("toggleFiles", { source: "rail" });
    emitResearchEvent("toggleAI");
    unsubscribe();
    emitResearchEvent("toggleFiles");
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ source: "rail" });
  });
});
