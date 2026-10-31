import type { AIMessageMetadata } from "@/core/service/dataManageService/aiEngine/AIEngine";
import type { AIChatSessionMemory } from "@/core/service/dataManageService/aiEngine/AIChatSessionMemory";
import { isResearchShell } from "@/core/research/ResearchShell";
import { isActivatedSkillSnapshot } from "./AISkillSession";
import type { ActivatedSkillSnapshot } from "./AISkills";
import { LazyStore } from "@tauri-apps/plugin-store";
import type { UIMessage } from "ai";

export type AIChatSessionSummary = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
};

export type AIChatSessionIndex = {
  version: 1;
  activeSessionId: string;
  sessions: AIChatSessionSummary[];
};

export type StoredAIChatSession = {
  version: 1;
  id: string;
  title: string;
  titleManuallyEdited: boolean;
  messages: UIMessage<AIMessageMetadata>[];
  memory?: AIChatSessionMemory;
  activatedSkills?: ActivatedSkillSnapshot[];
  createdAt: number;
  updatedAt: number;
};

export type AIChatSessionProjectState = {
  index: AIChatSessionIndex;
  activeSession: StoredAIChatSession;
};

const DEFAULT_SESSION_TITLE = "新会话";
const store = new LazyStore("ai-chat-sessions.json");
let initPromise: Promise<void> | undefined;
let writeQueue: Promise<void> = Promise.resolve();

async function getStore(): Promise<LazyStore> {
  initPromise ??= store.init();
  await initPromise;
  return store;
}

function enqueueWrite<T>(operation: (initializedStore: LazyStore) => Promise<T>): Promise<T> {
  const result = writeQueue.then(
    async () => operation(await getStore()),
    async () => operation(await getStore()),
  );
  writeQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

const draftChatKeys = new WeakMap<object, string>();

function readWorkbenchId(metadata: unknown): string | undefined {
  if (!metadata || typeof metadata !== "object") return undefined;
  const workbench = (metadata as { workbench?: unknown }).workbench;
  if (!workbench || typeof workbench !== "object") return undefined;
  const id = (workbench as { id?: unknown }).id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

type AIChatKeyProject = { uri: { scheme: string; toString(): string }; metadata?: unknown };

type ResolvedChatKey = {
  key: string;
  /** 换键时记录跟着搬过去就不变；面板用它决定要不要重新载入 */
  viewKey: string;
  /** 和另一个已打开的工作区撞了 id，固定用 URI，之后也不再换 */
  pinned: boolean;
};

const resolvedChatKeys = new WeakMap<object, ResolvedChatKey>();
const workbenchKeyOwners = new Map<string, WeakRef<object>>();
let isChatProjectOpen: (project: object) => boolean = () => true;

/** 由界面层告诉这里哪些工程还开着，用来判断工作区 id 是否和别的已打开工程重复 */
export function setAIChatProjectOpenCheck(check: (project: object) => boolean) {
  isChatProjectOpen = check;
}

function getFallbackChatKey(project: AIChatKeyProject): string {
  if (project.uri.scheme !== "draft") return project.uri.toString();
  let key = draftChatKeys.get(project);
  if (!key) {
    key = `draft-session:${crypto.randomUUID()}`;
    draftChatKeys.set(project, key);
  }
  return key;
}

function isWorkbenchKeyHeldByOther(project: object, workbenchKey: string): boolean {
  const owner = workbenchKeyOwners.get(workbenchKey)?.deref();
  return (
    owner !== undefined &&
    owner !== project &&
    resolvedChatKeys.get(owner)?.key === workbenchKey &&
    isChatProjectOpen(owner)
  );
}

function resolveChatKey(project: AIChatKeyProject): ResolvedChatKey {
  const previous = resolvedChatKeys.get(project);
  if (previous?.pinned) return previous;
  const workbenchId = readWorkbenchId(project.metadata);
  if (!workbenchId) return previous ?? { key: getFallbackChatKey(project), viewKey: "", pinned: false };
  const workbenchKey = `workbench:${workbenchId}`;
  if (previous?.key === workbenchKey) return previous;
  if (isWorkbenchKeyHeldByOther(project, workbenchKey)) {
    // 复制出来的 .prg 带着原文件的 id；两个都开着时后打开的那个改按 URI 存，免得两份对话混在一起
    const key = previous?.key ?? getFallbackChatKey(project);
    return { key, viewKey: previous?.viewKey ?? key, pinned: true };
  }
  workbenchKeyOwners.set(workbenchKey, new WeakRef(project));
  if (previous && !previous.key.startsWith("workbench:")) {
    // 草稿或旧文件第一次拿到 id：把已有对话搬到新键下，面板不用重新载入
    migrateChatKey(previous.key, workbenchKey);
    return { key: workbenchKey, viewKey: previous.viewKey, pinned: false };
  }
  // id 换了（另存为副本）：副本从新的对话开始，原文件的记录留在原来的键下
  return { key: workbenchKey, viewKey: workbenchKey, pinned: false };
}

function resolveAndRemember(project: AIChatKeyProject): ResolvedChatKey {
  const resolved = resolveChatKey(project);
  const complete = resolved.viewKey ? resolved : { ...resolved, viewKey: resolved.key };
  resolvedChatKeys.set(project, complete);
  return complete;
}

/**
 * 聊天记录按什么存。科研模式下优先用工作区 id（存在 .prg 元数据里，改名、移动、草稿存盘都不变）；
 * 草稿的 URI 每次启动都从 draft:1 重新数，不能拿来当键，改用这个草稿对象自己的随机 id。
 */
export function getAIChatProjectKey(project: AIChatKeyProject) {
  if (!isResearchShell()) return project.uri.toString();
  return resolveAndRemember(project).key;
}

/** 面板的 React key：对话跟着换了存储键时不变，避免正在进行的对话被卸载 */
export function getAIChatViewKey(project: AIChatKeyProject) {
  if (!isResearchShell()) return project.uri.toString();
  return resolveAndRemember(project).viewKey;
}

function migrateChatKey(fromKey: string, toKey: string) {
  void enqueueWrite(async (initializedStore) => {
    const index = await readIndex(initializedStore, fromKey);
    if (!index) return;
    if ((await initializedStore.get<unknown>(getIndexKey(toKey))) != null) return;
    for (const summary of index.sessions) {
      const session = await initializedStore.get<unknown>(getSessionKey(fromKey, summary.id));
      if (session !== undefined) await initializedStore.set(getSessionKey(toKey, summary.id), session);
    }
    await initializedStore.set(getIndexKey(toKey), index);
    for (const summary of index.sessions) await initializedStore.delete(getSessionKey(fromKey, summary.id));
    await initializedStore.delete(getIndexKey(fromKey));
    await initializedStore.save();
  }).catch((error) => {
    window.dispatchEvent(new ErrorEvent("error", { error }));
  });
}

function getIndexKey(projectUri: string): string {
  return `project:${projectUri}:session-index`;
}

function getSessionKey(projectUri: string, sessionId: string): string {
  return `project:${projectUri}:session:${sessionId}`;
}

function isSessionSummary(value: unknown): value is AIChatSessionSummary {
  if (!value || typeof value !== "object") return false;
  const summary = value as Partial<AIChatSessionSummary>;
  return (
    typeof summary.id === "string" &&
    summary.id.length > 0 &&
    typeof summary.title === "string" &&
    typeof summary.createdAt === "number" &&
    typeof summary.updatedAt === "number" &&
    typeof summary.messageCount === "number" &&
    Number.isInteger(summary.messageCount) &&
    summary.messageCount >= 0
  );
}

function isSessionIndex(value: unknown): value is AIChatSessionIndex {
  if (!value || typeof value !== "object") return false;
  const index = value as Partial<AIChatSessionIndex>;
  return (
    index.version === 1 &&
    typeof index.activeSessionId === "string" &&
    index.activeSessionId.length > 0 &&
    Array.isArray(index.sessions) &&
    index.sessions.length > 0 &&
    index.sessions.every(isSessionSummary) &&
    index.sessions.some((session) => session.id === index.activeSessionId)
  );
}

function isStoredSession(value: unknown): value is StoredAIChatSession {
  if (!value || typeof value !== "object") return false;
  const session = value as Partial<StoredAIChatSession>;
  return (
    session.version === 1 &&
    typeof session.id === "string" &&
    session.id.length > 0 &&
    typeof session.title === "string" &&
    typeof session.titleManuallyEdited === "boolean" &&
    Array.isArray(session.messages) &&
    (session.memory === undefined || isSessionMemory(session.memory)) &&
    (session.activatedSkills === undefined ||
      (Array.isArray(session.activatedSkills) && session.activatedSkills.every(isActivatedSkillSnapshot))) &&
    typeof session.createdAt === "number" &&
    typeof session.updatedAt === "number"
  );
}

function isSessionMemory(value: unknown): value is AIChatSessionMemory {
  if (!value || typeof value !== "object") return false;
  const memory = value as Partial<AIChatSessionMemory>;
  return (
    typeof memory.summary === "string" &&
    memory.summary.trim().length > 0 &&
    typeof memory.coveredMessageCount === "number" &&
    Number.isInteger(memory.coveredMessageCount) &&
    memory.coveredMessageCount > 0
  );
}

function createEmptySession(): StoredAIChatSession {
  const now = Date.now();
  return {
    version: 1,
    id: crypto.randomUUID(),
    title: DEFAULT_SESSION_TITLE,
    titleManuallyEdited: false,
    messages: [],
    createdAt: now,
    updatedAt: now,
  };
}

function toSummary(session: StoredAIChatSession): AIChatSessionSummary {
  return {
    id: session.id,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messageCount: session.messages.length,
  };
}

function replaceSummary(index: AIChatSessionIndex, session: StoredAIChatSession): AIChatSessionIndex {
  return {
    ...index,
    sessions: index.sessions
      .map((summary) => (summary.id === session.id ? toSummary(session) : summary))
      .sort((left, right) => right.updatedAt - left.updatedAt),
  };
}

function extractText(message: UIMessage<AIMessageMetadata>): string {
  return message.parts
    .filter((part): part is Extract<(typeof message.parts)[number], { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join(" ");
}

function createAutomaticTitle(messages: UIMessage<AIMessageMetadata>[]): string | undefined {
  const firstUserMessage = messages.find((message) => message.role === "user");
  if (!firstUserMessage) return undefined;
  const title = extractText(firstUserMessage)
    .replace(/^\[selected:\s+(?:[ne]\d+\s*)+\]\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!title) return undefined;
  return title.length > 36 ? `${title.slice(0, 36)}…` : title;
}

async function readIndex(initializedStore: LazyStore, projectUri: string): Promise<AIChatSessionIndex | null> {
  const value = await initializedStore.get<unknown>(getIndexKey(projectUri));
  if (value === undefined || value === null) return null;
  if (!isSessionIndex(value)) throw new Error("保存的 AI 会话索引格式无效");
  return value;
}

async function readRequiredSession(
  initializedStore: LazyStore,
  projectUri: string,
  sessionId: string,
): Promise<StoredAIChatSession> {
  const value = await initializedStore.get<unknown>(getSessionKey(projectUri, sessionId));
  if (!isStoredSession(value) || value.id !== sessionId) throw new Error("保存的 AI 会话格式无效");
  return value;
}

export namespace AIChatSessionStore {
  export async function initializeProject(projectUri: string): Promise<AIChatSessionProjectState> {
    return enqueueWrite(async (initializedStore) => {
      const existingIndex = await readIndex(initializedStore, projectUri);
      if (existingIndex) {
        return {
          index: existingIndex,
          activeSession: await readRequiredSession(initializedStore, projectUri, existingIndex.activeSessionId),
        };
      }

      const activeSession = createEmptySession();
      const index: AIChatSessionIndex = {
        version: 1,
        activeSessionId: activeSession.id,
        sessions: [toSummary(activeSession)],
      };
      await initializedStore.set(getSessionKey(projectUri, activeSession.id), activeSession);
      await initializedStore.set(getIndexKey(projectUri), index);
      await initializedStore.save();
      return { index, activeSession };
    });
  }

  export async function loadSession(projectUri: string, sessionId: string): Promise<StoredAIChatSession> {
    // 排在写入队列里读：换键搬记录时要等搬完
    return enqueueWrite((initializedStore) => readRequiredSession(initializedStore, projectUri, sessionId));
  }

  export async function getSessionMemory(
    projectUri: string,
    sessionId: string,
  ): Promise<AIChatSessionMemory | undefined> {
    return (await loadSession(projectUri, sessionId)).memory;
  }

  export async function getActivatedSkills(projectUri: string, sessionId: string): Promise<ActivatedSkillSnapshot[]> {
    const snapshots = (await loadSession(projectUri, sessionId)).activatedSkills ?? [];
    return snapshots.map((snapshot) => ({ ...snapshot, resources: [...snapshot.resources] }));
  }

  export async function activateSkill(
    projectUri: string,
    sessionId: string,
    snapshot: ActivatedSkillSnapshot,
  ): Promise<void> {
    if (!isActivatedSkillSnapshot(snapshot)) throw new Error("AI Skill 会话快照格式无效");
    await enqueueWrite(async (initializedStore) => {
      const index = await readIndex(initializedStore, projectUri);
      if (!index || !index.sessions.some((session) => session.id === sessionId)) {
        throw new Error("指定的 AI 会话不存在");
      }
      const current = await readRequiredSession(initializedStore, projectUri, sessionId);
      if (current.activatedSkills?.some((activeSkill) => activeSkill.name === snapshot.name)) return;
      const savedSession: StoredAIChatSession = {
        ...current,
        activatedSkills: [...(current.activatedSkills ?? []), { ...snapshot, resources: [...snapshot.resources] }],
        updatedAt: Date.now(),
      };
      await initializedStore.set(getSessionKey(projectUri, sessionId), savedSession);
      await initializedStore.set(getIndexKey(projectUri), replaceSummary(index, savedSession));
      await initializedStore.save();
    });
  }

  export async function setSessionMemory(
    projectUri: string,
    sessionId: string,
    memory: AIChatSessionMemory,
  ): Promise<void> {
    if (!isSessionMemory(memory)) throw new Error("AI 会话记忆格式无效");
    await enqueueWrite(async (initializedStore) => {
      const index = await readIndex(initializedStore, projectUri);
      if (!index || !index.sessions.some((session) => session.id === sessionId)) {
        throw new Error("指定的 AI 会话不存在");
      }
      const current = await readRequiredSession(initializedStore, projectUri, sessionId);
      const savedSession: StoredAIChatSession = {
        ...current,
        memory,
        updatedAt: Date.now(),
      };
      await initializedStore.set(getSessionKey(projectUri, sessionId), savedSession);
      await initializedStore.set(getIndexKey(projectUri), replaceSummary(index, savedSession));
      await initializedStore.save();
    });
  }

  export async function createSession(projectUri: string): Promise<AIChatSessionProjectState> {
    return enqueueWrite(async (initializedStore) => {
      const index = await readIndex(initializedStore, projectUri);
      if (!index) throw new Error("AI 会话索引尚未初始化");
      const activeSession = createEmptySession();
      const nextIndex: AIChatSessionIndex = {
        ...index,
        activeSessionId: activeSession.id,
        sessions: [toSummary(activeSession), ...index.sessions],
      };
      await initializedStore.set(getSessionKey(projectUri, activeSession.id), activeSession);
      await initializedStore.set(getIndexKey(projectUri), nextIndex);
      await initializedStore.save();
      return { index: nextIndex, activeSession };
    });
  }

  export async function saveSession(
    projectUri: string,
    sessionId: string,
    messages: UIMessage<AIMessageMetadata>[],
  ): Promise<AIChatSessionProjectState> {
    return enqueueWrite(async (initializedStore) => {
      const index = await readIndex(initializedStore, projectUri);
      if (!index) throw new Error("AI 会话索引尚未初始化");
      if (!index.sessions.some((summary) => summary.id === sessionId)) throw new Error("指定的 AI 会话不存在");
      const current = await readRequiredSession(initializedStore, projectUri, sessionId);
      const automaticTitle = current.titleManuallyEdited ? undefined : createAutomaticTitle(messages);
      const savedSession: StoredAIChatSession = {
        ...current,
        title: automaticTitle ?? current.title,
        messages,
        updatedAt: Date.now(),
      };
      const nextIndex = replaceSummary(index, savedSession);
      await initializedStore.set(getSessionKey(projectUri, sessionId), savedSession);
      await initializedStore.set(getIndexKey(projectUri), nextIndex);
      await initializedStore.save();
      const activeSession =
        nextIndex.activeSessionId === sessionId
          ? savedSession
          : await readRequiredSession(initializedStore, projectUri, nextIndex.activeSessionId);
      return { index: nextIndex, activeSession };
    });
  }

  export async function setActiveSession(projectUri: string, sessionId: string): Promise<AIChatSessionProjectState> {
    return enqueueWrite(async (initializedStore) => {
      const index = await readIndex(initializedStore, projectUri);
      if (!index || !index.sessions.some((session) => session.id === sessionId)) {
        throw new Error("指定的 AI 会话不存在");
      }
      const activeSession = await readRequiredSession(initializedStore, projectUri, sessionId);
      const nextIndex = { ...index, activeSessionId: sessionId };
      await initializedStore.set(getIndexKey(projectUri), nextIndex);
      await initializedStore.save();
      return { index: nextIndex, activeSession };
    });
  }

  export async function renameSession(
    projectUri: string,
    sessionId: string,
    title: string,
  ): Promise<AIChatSessionProjectState> {
    const normalizedTitle = title.replace(/\s+/g, " ").trim();
    if (!normalizedTitle) throw new Error("会话标题不能为空");
    return enqueueWrite(async (initializedStore) => {
      const index = await readIndex(initializedStore, projectUri);
      if (!index) throw new Error("AI 会话索引尚未初始化");
      const current = await readRequiredSession(initializedStore, projectUri, sessionId);
      const renamedSession: StoredAIChatSession = {
        ...current,
        title: normalizedTitle,
        titleManuallyEdited: true,
        updatedAt: Date.now(),
      };
      const nextIndex = replaceSummary(index, renamedSession);
      await initializedStore.set(getSessionKey(projectUri, sessionId), renamedSession);
      await initializedStore.set(getIndexKey(projectUri), nextIndex);
      await initializedStore.save();
      return {
        index: nextIndex,
        activeSession:
          nextIndex.activeSessionId === sessionId
            ? renamedSession
            : await readRequiredSession(initializedStore, projectUri, nextIndex.activeSessionId),
      };
    });
  }

  export async function deleteSession(projectUri: string, sessionId: string): Promise<AIChatSessionProjectState> {
    return enqueueWrite(async (initializedStore) => {
      const index = await readIndex(initializedStore, projectUri);
      if (!index || !index.sessions.some((session) => session.id === sessionId)) {
        throw new Error("指定的 AI 会话不存在");
      }

      const remaining = index.sessions.filter((session) => session.id !== sessionId);
      let activeSession: StoredAIChatSession;
      if (remaining.length === 0) {
        activeSession = createEmptySession();
        remaining.push(toSummary(activeSession));
        await initializedStore.set(getSessionKey(projectUri, activeSession.id), activeSession);
      } else if (index.activeSessionId === sessionId) {
        activeSession = await readRequiredSession(initializedStore, projectUri, remaining[0].id);
      } else {
        activeSession = await readRequiredSession(initializedStore, projectUri, index.activeSessionId);
      }

      const nextIndex: AIChatSessionIndex = {
        ...index,
        activeSessionId: activeSession.id,
        sessions: remaining,
      };
      await initializedStore.delete(getSessionKey(projectUri, sessionId));
      await initializedStore.set(getIndexKey(projectUri), nextIndex);
      await initializedStore.save();
      return { index: nextIndex, activeSession };
    });
  }
}
