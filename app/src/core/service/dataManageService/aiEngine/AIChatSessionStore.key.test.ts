import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: class {
    async init() {}
  },
}));

import { getAIChatProjectKey } from "./AIChatSessionStore";

function project(uri: string, metadata?: unknown) {
  const [scheme] = uri.split(":");
  return { uri: { scheme, toString: () => uri }, metadata };
}

describe("getAIChatProjectKey", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("keys chats by the workspace id in research mode", () => {
    const workspace = project("file:///root/a.prg", { version: "2.0.0", workbench: { id: "w-1" } });
    expect(getAIChatProjectKey(workspace)).toBe("workbench:w-1");
  });

  it("falls back to the URI for files without a workspace id", () => {
    expect(getAIChatProjectKey(project("file:///root/a.prg", { version: "2.0.0" }))).toBe("file:///root/a.prg");
    expect(getAIChatProjectKey(project("file:///root/a.prg", { workbench: { id: 3 } }))).toBe("file:///root/a.prg");
  });

  it("gives each draft its own stable key so drafts from earlier launches do not collide", () => {
    const first = project("draft:1");
    const second = project("draft:1");
    expect(getAIChatProjectKey(first)).toMatch(/^draft-session:/);
    expect(getAIChatProjectKey(first)).toBe(getAIChatProjectKey(first));
    expect(getAIChatProjectKey(second)).not.toBe(getAIChatProjectKey(first));
  });

  it("keeps the upstream URI key when the research shell is off", () => {
    vi.stubEnv("LR_RESEARCH_SHELL", "false");
    expect(getAIChatProjectKey(project("draft:1"))).toBe("draft:1");
    expect(getAIChatProjectKey(project("file:///root/a.prg", { workbench: { id: "w-1" } }))).toBe("file:///root/a.prg");
  });
});
