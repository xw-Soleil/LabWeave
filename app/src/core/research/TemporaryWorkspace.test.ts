import { beforeEach, describe, expect, it, vi } from "vitest";
import { URI } from "vscode-uri";

const settings = vi.hoisted(() => ({ researchFolderPath: "/research" }));
vi.mock("@/core/service/Settings", () => ({ Settings: settings }));

import { canOpenWorkspace, isTemporaryWorkspace } from "./TemporaryWorkspace";

beforeEach(() => {
  settings.researchFolderPath = "/research";
});

describe("temporary workspace", () => {
  it("uses the live URI and folder, and never treats a draft as temporary", () => {
    const project = { uri: URI.file("/outside/a.prg") };
    expect(isTemporaryWorkspace(project)).toBe(true);
    project.uri = URI.file("/research/a.prg");
    expect(isTemporaryWorkspace(project)).toBe(false);
    settings.researchFolderPath = "/elsewhere";
    expect(isTemporaryWorkspace(project)).toBe(true);
    settings.researchFolderPath = "";
    expect(isTemporaryWorkspace(project)).toBe(false);
    settings.researchFolderPath = "/research";
    expect(isTemporaryWorkspace({ uri: URI.parse("draft:1") })).toBe(false);
  });

  it.each([
    ["C:\\Research", "c:\\research\\a.prg", false],
    ["C:\\Research", "C:\\Research-other\\a.prg", true],
    ["C:\\Research", "D:\\Research\\a.prg", true],
    ["C:\\Research", "C:\\Research\\..\\outside\\a.prg", true],
    ["\\\\server\\share\\Research", "\\\\server\\share\\Research\\a.prg", false],
    ["\\\\server\\share\\Research", "\\\\server\\other\\a.prg", true],
  ])("checks Windows paths: %s / %s", (root, path, expected) => {
    settings.researchFolderPath = root;
    expect(isTemporaryWorkspace({ uri: URI.file(path.replaceAll("\\", "/")) })).toBe(expected);
  });

  it("allows only explicit user origins outside the folder", () => {
    const uri = URI.file("/outside/a.prg");
    expect(canOpenWorkspace(uri)).toBe(false);
    for (const origin of ["file-dialog", "file-drop", "file-paste", "os-file"] as const)
      expect(canOpenWorkspace(uri, origin)).toBe(true);
    expect(canOpenWorkspace(URI.file("/research/a.prg"))).toBe(true);
  });
});
