import { afterEach, describe, expect, it, vi } from "vitest";

const memory = vi.hoisted(() => new Map<string, unknown>());

vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: class {
    async init() {}
    async get(key: string) {
      return memory.get(key);
    }
    async set(key: string, value: unknown) {
      memory.set(key, structuredClone(value));
    }
    async delete(key: string) {
      memory.delete(key);
    }
    async save() {}
  },
}));

import {
  AIChatSessionStore,
  getAIChatProjectKey,
  getAIChatViewKey,
  setAIChatProjectOpenCheck,
} from "./AIChatSessionStore";

function project(uri: string, metadata?: unknown) {
  const [scheme] = uri.split(":");
  return { uri: { scheme, toString: () => uri }, metadata };
}

describe("getAIChatProjectKey", () => {
  afterEach(() => {
    setAIChatProjectOpenCheck(() => true);
  });

  it("keys chats by the workspace id", () => {
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

  it("moves the chats to the workspace id key when a draft gets its id, keeping the view key", async () => {
    const draft = project("draft:1") as { uri: { scheme: string; toString(): string }; metadata?: unknown };
    const draftKey = getAIChatProjectKey(draft);
    const viewKey = getAIChatViewKey(draft);
    const initial = await AIChatSessionStore.initializeProject(draftKey);

    draft.metadata = { workbench: { id: "w-migrate" } };
    draft.uri = { scheme: "file", toString: () => "file:///root/new.prg" };

    expect(getAIChatProjectKey(draft)).toBe("workbench:w-migrate");
    expect(getAIChatViewKey(draft)).toBe(viewKey);
    const migrated = await AIChatSessionStore.initializeProject("workbench:w-migrate");
    expect(migrated.activeSession.id).toBe(initial.activeSession.id);
    await expect(AIChatSessionStore.loadSession(draftKey, initial.activeSession.id)).rejects.toThrow();
  });

  it("uses the URI for a second open project that carries the same workspace id", () => {
    const original = project("file:///root/a.prg", { workbench: { id: "w-copy" } });
    const copy = project("file:///root/a copy.prg", { workbench: { id: "w-copy" } });
    expect(getAIChatProjectKey(original)).toBe("workbench:w-copy");
    expect(getAIChatProjectKey(copy)).toBe("file:///root/a copy.prg");
    expect(getAIChatProjectKey(copy)).toBe("file:///root/a copy.prg");
    expect(getAIChatProjectKey(original)).toBe("workbench:w-copy");
  });

  it("lets a later project use the id once the earlier one is closed", () => {
    const closed = project("file:///root/b.prg", { workbench: { id: "w-closed" } });
    expect(getAIChatProjectKey(closed)).toBe("workbench:w-closed");
    setAIChatProjectOpenCheck((candidate) => candidate !== closed);
    const reopened = project("file:///root/b.prg", { workbench: { id: "w-closed" } });
    expect(getAIChatProjectKey(reopened)).toBe("workbench:w-closed");
  });

  it.each(["file:///research/renamed.prg", "file:///C:/Research/renamed.prg"])(
    "按白板 ID 恢复时，改名/换项目路径仍保留原 ACP 绑定：%s",
    async (uri) => {
      const id = crypto.randomUUID();
      const original = project("file:///research/original.prg", { workbench: { id } });
      const key = getAIChatProjectKey(original);
      const { activeSession } = await AIChatSessionStore.initializeProject(key);
      const binding = { agentId: "claude", sessionId: "original-acp-id" };
      await AIChatSessionStore.setLocalAgentSession(key, activeSession.id, binding);
      setAIChatProjectOpenCheck(() => false);
      const reopened = project(uri, { workbench: { id } });
      const restored = await AIChatSessionStore.initializeProject(getAIChatProjectKey(reopened));
      expect(restored.activeSession.id).toBe(activeSession.id);
      expect(restored.activeSession.localAgent).toEqual(binding);
    },
  );
});
