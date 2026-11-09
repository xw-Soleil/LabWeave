import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Project } from "@/core/Project";
import { isTabVisibleInWorkspace, markResearchPanelTab } from "@/core/research/ResearchSession";
import {
  AIChatSessionStore,
  getAIChatProjectKey,
  getAIChatViewKey,
  setAIChatProjectOpenCheck,
  type AIChatSessionProjectState,
  type AIChatSessionSummary,
  type StoredAIChatSession,
} from "@/core/service/dataManageService/aiEngine/AIChatSessionStore";
import type { AIConversation, AIMessageMetadata } from "@/core/service/dataManageService/aiEngine/AIEngine";
import {
  getAIConfigProblems,
  getEffectiveAIBaseUrl,
  type AIConfigProblem,
} from "@/core/service/dataManageService/aiEngine/AIProvider";
import {
  resolveAIModelContextWindow,
  type AIModelContextWindow,
} from "@/core/service/dataManageService/aiEngine/AIModelContextWindow";
import { AIObjectReferenceRegistry } from "@/core/service/dataManageService/aiEngine/AIObjectReferenceRegistry";
import { AIProjectReferenceStore } from "@/core/service/dataManageService/aiEngine/AIProjectReferenceStore";
import { getAIToolPartName, isAIToolPart } from "@/core/service/dataManageService/aiEngine/AIToolUIPart";
import { Settings } from "@/core/service/Settings";
import { ConnectableEntity } from "@/core/stage/stageObject/abstract/ConnectableEntity";
import { CollisionBox } from "@/core/stage/stageObject/collisionBox/collisionBox";
import { Section } from "@/core/stage/stageObject/entity/Section";
import { TextNode } from "@/core/stage/stageObject/entity/TextNode";
import { createSubWindow } from "@/core/subWindowOpen";
import { TabWorkspace } from "@/core/TabWorkspace";
import { activeResourceTabAtom, store, tabsAtom } from "@/state";
import { cn } from "@/utils/cn";
import { AIRequestTraceView } from "@/sub/AIRequestTraceView";
import SettingsWindow from "@/sub/SettingsWindow";
import { setSettingsInitialPage } from "@/sub/SettingsWindow/settings";
import { useLocalAgentCatalog } from "@/sub/SettingsWindow/LocalAgentsPage";
import {
  AISourceMenu,
  composerMenuTriggerClass,
  isLocalAgentReady,
  LocalAgentModeMenu,
  LocalAgentModelMenu,
  LocalAgentNotice,
  LocalAgentPermissionCard,
  useLocalAgentControls,
  useLocalAgentPermission,
  useLocalAgentStatus,
} from "@/sub/AIWindowLocalAgent";
import { displayWorkspaceName } from "@/components/ui/file-name";
import {
  isLocalAgentCommand,
  type LocalAgentCommand,
  type LocalAgentInfo,
} from "@/core/service/dataManageService/aiEngine/LocalAgent";
import { useChat } from "@ai-sdk/react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Color, Vector } from "@graphif/data-structures";
import { Rectangle } from "@graphif/shapes";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@radix-ui/react-collapsible";
import { code } from "@streamdown/code";
import { lastAssistantMessageIsCompleteWithApprovalResponses, type UIMessage } from "ai";
import { useAtom } from "jotai";
import {
  ArrowUp,
  Bot,
  Check,
  ChevronRight,
  Copy,
  FolderOpen,
  History,
  LayoutDashboard,
  MoreHorizontal,
  MousePointerClick,
  Pencil,
  Plus,
  Settings2,
  Sparkles,
  Square,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Streamdown } from "streamdown";
import "streamdown/styles.css";
import { getOriginalNameOf } from "virtual:original-class-name";

let pendingInitialText: string | null = null;
let pendingInitialPrompt: string | null = null;
// AI 面板是单例，已经打开的面板也要能收到新的预填文字
const pendingInitialTextListeners = new Set<() => void>();

export function setAIWindowInitialText(text: string, prompt?: string) {
  pendingInitialText = text;
  pendingInitialPrompt = prompt || null;
  pendingInitialTextListeners.forEach((listener) => listener());
}

function takePendingInitialInput(): string | null {
  if (!pendingInitialText) return null;
  const text = pendingInitialText;
  const prompt = pendingInitialPrompt;
  pendingInitialText = null;
  pendingInitialPrompt = null;
  return prompt ? `${prompt}\n\n---\n\n${text}` : text;
}

export default function AIWindow({ tabId }: { tabId: string }) {
  const [tab] = useAtom(activeResourceTabAtom);
  const project = tab instanceof Project ? tab : undefined;
  const { t } = useTranslation("research");

  if (!project) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
        <FolderOpen className="text-muted-foreground size-10" />
        <div className="font-medium">{t("ai.noWorkspace")}</div>
        <div className="text-muted-foreground max-w-64 text-sm">{t("ai.noWorkspaceHint")}</div>
      </div>
    );
  }

  return <AIChatWorkspace key={getAIChatViewKey(project)} project={project} tabId={tabId} />;
}

// 判断两个工作区是否撞了 id 时，只和还开着的工程比
setAIChatProjectOpenCheck((project) => store.get(tabsAtom).some((tab) => tab === project && !tab.closing));

function AIConfigNotice({ problems }: { problems: AIConfigProblem[] }) {
  const { t } = useTranslation("research");
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      <Settings2 className="text-muted-foreground size-10" />
      <div className="text-foreground font-medium">{t("ai.setupTitle")}</div>
      <div className="text-muted-foreground max-w-72 text-sm">
        {t("ai.setupDescription", {
          missing: problems.map((problem) => t(`ai.setupMissing.${problem}`)).join(t("ai.setupMissingSeparator")),
        })}
      </div>
      <Button
        size="sm"
        onClick={() => {
          setSettingsInitialPage("ai");
          SettingsWindow.open("settings");
        }}
      >
        {t("ai.openSettings")}
      </Button>
    </div>
  );
}

// 模型回答里的远程图片不自动加载：笔记或文件名里的提示注入可以借图片地址把内容带出去
function SafeMarkdownImage({ src, alt }: { src?: string; alt?: string }) {
  if (typeof src === "string" && /^(data:|blob:)/i.test(src)) return <img src={src} alt={alt ?? ""} />;
  return <span className="text-muted-foreground">[{alt || "image"}]</span>;
}

function getContrastTextColor(bg: Color): string {
  const luminance = (0.299 * bg.r + 0.587 * bg.g + 0.114 * bg.b) / 255;
  return luminance > 0.6 ? "#000" : "#fff";
}

function isEntity(
  obj: unknown,
): obj is { isSelected: boolean; collisionBox: { getRectangle(): Rectangle }; color?: Color } {
  return typeof obj === "object" && obj !== null && "isSelected" in obj && "collisionBox" in obj;
}

type ContextWindowState =
  | { status: "loading" }
  | { status: "ready"; info: AIModelContextWindow }
  | { status: "unknown" }
  | { status: "error"; message: string };

function createAnswerNode(message: UIMessage, project: Project) {
  const answerText = (Array.isArray(message.parts) ? message.parts : [])
    .filter((p: any) => p.type === "text")
    .map((p: any) => p.text ?? "")
    .join("\n")
    .trim();
  if (!answerText) {
    toast.error("该消息没有可落盘的文本");
    return;
  }
  const selected = project.stageManager.getSelectedEntities();
  const source = selected.find((e) => e instanceof Section) ?? selected.find((e) => e instanceof ConnectableEntity);
  if (!source) {
    toast.error("请先选中要指向的分组框或节点");
    return;
  }
  const sourceRect = source.collisionBox.getRectangle();
  const node = new TextNode(project, {
    text: answerText,
    color: new Color(0, 0, 0, 0),
    collisionBox: new CollisionBox([
      new Rectangle(
        new Vector(sourceRect.location.x + sourceRect.size.x + 100, sourceRect.location.y),
        new Vector(100, 50),
      ),
    ]),
    sizeAdjust: "auto",
  });
  project.stageManager.add(node);
  project.nodeConnector.connectConnectableEntity(source, node);
  project.historyManager.recordStep();
  project.camera.bombMove(node.geometryCenter);
}

/** 输入法正在组字（拼音、假名选词）时按的回车、Esc 是给输入法的；WKWebView 里这时 keyCode 是 229 */
function isImeComposing(event: React.KeyboardEvent) {
  const native = event.nativeEvent as unknown as { isComposing?: boolean; keyCode?: number };
  return native.isComposing === true || native.keyCode === 229;
}

type ActiveChatController = {
  save: () => Promise<void>;
};

function formatSessionUpdatedAt(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(timestamp);
}

function AIChatWorkspace({ project, tabId }: { project: Project; tabId: string }) {
  const projectUri = getAIChatProjectKey(project);
  // 存储键换了但记录跟着搬过去时（草稿第一次存盘）viewKey 不变，不必重新载入
  const viewKey = getAIChatViewKey(project);
  const [model] = Settings.use("aiModel");
  const [sessionState, setSessionState] = useState<AIChatSessionProjectState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const [operationInProgress, setOperationInProgress] = useState(false);
  const operationInProgressRef = useRef(false);
  const [renamingSessionId, setRenamingSessionId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [deletingSession, setDeletingSession] = useState<AIChatSessionSummary | null>(null);
  const activeChatController = useRef<ActiveChatController | null>(null);
  const references = useMemo(() => project.aiEngine.getProjectReferences(project), [project]);
  const [backend] = Settings.use("aiBackend");
  const [agentId] = Settings.use("aiLocalAgent");
  const [agentPaths] = Settings.use("aiLocalAgentPaths");
  const agentPath = agentPaths[agentId];
  const [catalog, refreshCatalog] = useLocalAgentCatalog();
  const contextWindowTokenLimitRef = useRef<number | undefined>(undefined);
  const conversationCount = useRef(0);
  const [conversation, setConversation] = useState<{ id: number; value: AIConversation } | null>(null);

  // 本机 AI 程序的进程跟着对话对象走：切换会话时沿用，换来源、换程序或关面板时结束。
  // 在 effect 里建而不是 useMemo，严格模式下重跑 effect 也不会拿到已经结束的那个
  useEffect(() => {
    const value = project.aiEngine.createConversation(project, references, () => contextWindowTokenLimitRef.current);
    setConversation({ id: ++conversationCount.current, value });
    return () => {
      void value.localAgent?.dispose();
    };
  }, [project, references, backend, agentId, agentPath]);

  useEffect(
    () =>
      references.subscribe((snapshot) => {
        void AIProjectReferenceStore.save(project, snapshot).catch((saveError) => {
          toast.error(`AI 项目引用保存失败: ${saveError instanceof Error ? saveError.message : String(saveError)}`);
        });
      }),
    [project, references],
  );

  useEffect(() => {
    let cancelled = false;
    setSessionState(null);
    setLoadError(null);
    Promise.all([
      project.aiEngine.prepareProjectReferences(project),
      AIChatSessionStore.initializeProject(getAIChatProjectKey(project)),
    ])
      .then(([, initialSessionState]) => {
        if (cancelled) return;
        setSessionState(initialSessionState);
      })
      .catch((error) => {
        if (cancelled) return;
        setLoadError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [project, viewKey]);

  async function saveCurrentSession() {
    await activeChatController.current?.save();
  }

  async function runSessionOperation(operation: () => Promise<void>) {
    if (requesting || operationInProgressRef.current) return;
    operationInProgressRef.current = true;
    setOperationInProgress(true);
    try {
      await operation();
    } catch (error) {
      toast.error(`AI 会话操作失败: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      operationInProgressRef.current = false;
      setOperationInProgress(false);
    }
  }

  function handleCreateSession() {
    void runSessionOperation(async () => {
      await saveCurrentSession();
      const nextState = await AIChatSessionStore.createSession(projectUri);
      setSessionState(nextState);
      setHistoryOpen(false);
    });
  }

  function handleSwitchSession(sessionId: string) {
    if (!sessionState || sessionState.index.activeSessionId === sessionId) {
      setHistoryOpen(false);
      return;
    }
    void runSessionOperation(async () => {
      await saveCurrentSession();
      const nextState = await AIChatSessionStore.setActiveSession(projectUri, sessionId);
      setSessionState(nextState);
      setHistoryOpen(false);
    });
  }

  function startRenaming(session: AIChatSessionSummary) {
    setRenamingSessionId(session.id);
    setRenameDraft(session.title);
  }

  function handleRenameSession() {
    const sessionId = renamingSessionId;
    if (!sessionId || !renameDraft.trim()) return;
    void runSessionOperation(async () => {
      const nextState = await AIChatSessionStore.renameSession(projectUri, sessionId, renameDraft);
      setSessionState(nextState);
      setRenamingSessionId(null);
      setRenameDraft("");
    });
  }

  function handleDeleteRequest(session: AIChatSessionSummary) {
    if (session.messageCount > 0) {
      setDeletingSession(session);
      return;
    }
    deleteSession(session.id);
  }

  function deleteSession(sessionId: string) {
    void runSessionOperation(async () => {
      if (sessionState?.index.activeSessionId === sessionId) await saveCurrentSession();
      const nextState = await AIChatSessionStore.deleteSession(projectUri, sessionId);
      setSessionState(nextState);
      setDeletingSession(null);
      setRenamingSessionId(null);
    });
  }

  function handleClose() {
    void runSessionOperation(async () => {
      await saveCurrentSession();
      TabWorkspace.close(tabId);
    });
  }

  const handleCloseRef = useRef(handleClose);
  handleCloseRef.current = handleClose;
  useEffect(() => {
    aiWindowCloseHandlers.set(tabId, () => handleCloseRef.current());
    return () => {
      aiWindowCloseHandlers.delete(tabId);
    };
  }, [tabId]);

  const actionsDisabled = requesting || operationInProgress || !sessionState;

  return (
    <div className="from-background via-background to-muted/30 flex h-full flex-col bg-gradient-to-b">
      <div data-pg-drag-region className="border-border/70 flex items-center gap-2 border-b px-3 py-2">
        <div className="bg-primary/10 text-primary flex size-8 items-center justify-center rounded-xl">
          <Sparkles className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">
            {sessionState?.activeSession.title ?? "Project Graph AI"}
          </div>
          <AISourceMenu catalog={catalog} onOpen={refreshCatalog} model={model} disabled={actionsDisabled} />
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label="会话历史"
              disabled={!sessionState}
              onClick={() => setHistoryOpen(true)}
            >
              <History />
            </Button>
          </TooltipTrigger>
          <TooltipContent>会话历史</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label="新建会话"
              disabled={actionsDisabled}
              onClick={handleCreateSession}
            >
              <Plus />
            </Button>
          </TooltipTrigger>
          <TooltipContent>新建会话</TooltipContent>
        </Tooltip>
        <Button
          variant="ghost"
          size="icon"
          aria-label="关闭 AI 窗口"
          disabled={requesting || operationInProgress}
          onClick={handleClose}
        >
          <X />
        </Button>
      </div>

      {loadError ? (
        <div className="text-destructive flex flex-1 items-center justify-center p-6 text-center text-sm">
          AI 会话加载失败：{loadError}
        </div>
      ) : !sessionState || !conversation ? (
        <div className="text-muted-foreground flex flex-1 items-center justify-center text-sm">正在加载 AI 记忆…</div>
      ) : (
        <AIChatPanel
          key={`${sessionState.activeSession.id}:${conversation.id}`}
          project={project}
          session={sessionState.activeSession}
          references={references}
          conversation={conversation.value}
          contextWindowTokenLimitRef={contextWindowTokenLimitRef}
          catalog={catalog}
          onControllerChange={(controller) => {
            activeChatController.current = controller;
          }}
          onRequestingChange={setRequesting}
          onSessionSaved={setSessionState}
        />
      )}

      <Sheet open={historyOpen} onOpenChange={setHistoryOpen}>
        <SheetContent side="left" className="w-72 sm:max-w-72">
          <SheetHeader>
            <SheetTitle>会话历史</SheetTitle>
            <SheetDescription>每个会话保留独立的聊天上下文，共享当前项目的节点引用。</SheetDescription>
          </SheetHeader>
          <ScrollArea className="min-h-0 flex-1 px-3 pb-4">
            <div className="flex flex-col gap-1">
              {sessionState?.index.sessions.map((session) => {
                const isActive = session.id === sessionState.index.activeSessionId;
                const isRenaming = renamingSessionId === session.id;
                return (
                  <div
                    key={session.id}
                    className={cn("flex items-center rounded-md", isActive && "bg-accent text-accent-foreground")}
                  >
                    {isRenaming ? (
                      <div className="flex min-w-0 flex-1 items-center gap-1 p-1">
                        <Input
                          autoFocus
                          aria-label="会话标题"
                          value={renameDraft}
                          disabled={operationInProgress}
                          onChange={(event) => setRenameDraft(event.target.value)}
                          onKeyDown={(event) => {
                            if (isImeComposing(event)) return;
                            if (event.key === "Enter") handleRenameSession();
                            if (event.key === "Escape") setRenamingSessionId(null);
                          }}
                        />
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label="保存标题"
                          disabled={!renameDraft.trim() || operationInProgress}
                          onClick={handleRenameSession}
                        >
                          <Check />
                        </Button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        className="flex min-w-0 flex-1 cursor-pointer flex-col items-start gap-0.5 rounded-md px-2 py-2 text-left disabled:cursor-not-allowed disabled:opacity-50"
                        disabled={actionsDisabled}
                        onClick={() => handleSwitchSession(session.id)}
                      >
                        <span className="w-full truncate text-sm font-medium">{session.title}</span>
                        <span className="text-muted-foreground text-xs">
                          {formatSessionUpdatedAt(session.updatedAt)} · {session.messageCount} 条消息
                        </span>
                      </button>
                    )}
                    {!isRenaming && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={`${session.title} 的操作`}
                            disabled={actionsDisabled}
                          >
                            <MoreHorizontal />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuGroup>
                            <DropdownMenuItem onSelect={() => startRenaming(session)}>
                              <Pencil />
                              重命名
                            </DropdownMenuItem>
                            <DropdownMenuItem variant="destructive" onSelect={() => handleDeleteRequest(session)}>
                              <Trash2 />
                              删除
                            </DropdownMenuItem>
                          </DropdownMenuGroup>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </div>
                );
              })}
            </div>
          </ScrollArea>
        </SheetContent>
      </Sheet>

      <AlertDialog open={!!deletingSession} onOpenChange={(open) => !open && setDeletingSession(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除会话？</AlertDialogTitle>
            <AlertDialogDescription>
              “{deletingSession?.title}”中的聊天记录会从本地删除，但该会话已经修改的画布内容不会撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              disabled={operationInProgress}
              onClick={() => deletingSession && deleteSession(deletingSession.id)}
            >
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function AIChatPanel({
  project,
  session,
  references,
  conversation,
  contextWindowTokenLimitRef,
  catalog,
  onControllerChange,
  onRequestingChange,
  onSessionSaved,
}: {
  project: Project;
  session: StoredAIChatSession;
  references: AIObjectReferenceRegistry;
  conversation: AIConversation;
  contextWindowTokenLimitRef: React.RefObject<number | undefined>;
  catalog: LocalAgentInfo[] | null;
  onControllerChange: (controller: ActiveChatController | null) => void;
  onRequestingChange: (requesting: boolean) => void;
  onSessionSaved: (state: AIChatSessionProjectState) => void;
}) {
  const [inputValue, setInputValue] = useState("");
  const messagesElRef = useRef<HTMLDivElement>(null);
  const [showTokenCount] = Settings.use("aiShowTokenCount");
  const [showDebug] = Settings.use("showDebug");
  const [apiBaseUrl] = Settings.use("aiApiBaseUrl");
  const [apiKey] = Settings.use("aiApiKey");
  const [model] = Settings.use("aiModel");
  const [manualContextWindow] = Settings.use("aiContextWindow");
  const [apiFormat] = Settings.use("aiApiFormat");
  const { t } = useTranslation("research");
  const localAgent = conversation.localAgent;
  const agentStatus = useLocalAgentStatus(localAgent);
  const permission = useLocalAgentPermission(localAgent);
  const agentControls = useLocalAgentControls(localAgent);
  const [agentId] = Settings.use("aiLocalAgent");
  const [agentPaths] = Settings.use("aiLocalAgentPaths");
  const agentInfo = catalog?.find((agent) => agent.id === agentId);
  // 本机程序不用设置里的接口，接口没填也照常能用
  const configProblems = localAgent
    ? []
    : getAIConfigProblems({
        aiApiFormat: apiFormat,
        aiApiBaseUrl: apiBaseUrl,
        aiApiKey: apiKey,
        aiModel: model,
      });
  const [selection, setSelection] = useState({ count: 0, entityCount: 0, key: "" });
  // 点了「已选」小标签上的 ×，这一组选中就不随消息发；换了选中内容自动恢复
  const [excludedSelectionKey, setExcludedSelectionKey] = useState<string | null>(null);
  const includeSelection = selection.count > 0 && selection.key !== excludedSelectionKey;
  const [sessionLoaded, setSessionLoaded] = useState(false);
  const [contextWindowState, setContextWindowState] = useState<ContextWindowState>({ status: "loading" });
  const projectUri = getAIChatProjectKey(project);
  const messagesRef = useRef<UIMessage<AIMessageMetadata>[]>(session.messages);
  const lastSavedMessagesRef = useRef<UIMessage<AIMessageMetadata>[]>(session.messages);

  const persistMessages = useCallback(
    async (nextMessages: UIMessage<AIMessageMetadata>[]) => {
      await AIProjectReferenceStore.save(project, references.exportSnapshot());
      const nextState = await AIChatSessionStore.saveSession(projectUri, session.id, nextMessages);
      lastSavedMessagesRef.current = nextMessages;
      onSessionSaved(nextState);
    },
    [onSessionSaved, project, projectUri, references, session.id],
  );

  const { messages, setMessages, sendMessage, regenerate, stop, status, addToolApprovalResponse } = useChat<
    UIMessage<AIMessageMetadata>
  >({
    id: session.id,
    transport: conversation.transport,
    experimental_throttle: 50,
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
    onError: (err) => {
      // 本机程序的错误由输入框上方的提示说明，不再弹一遍
      if (localAgent && err.message.startsWith("local-agent:")) return;
      toast.error(`AI 请求失败: ${err.message || err.toString() || JSON.stringify(err)}`);
    },
  });
  const requesting = status === "submitted" || status === "streaming";
  const tokenUsage = useMemo(() => getTokenUsage(messages), [messages]);
  const contextUsage = useMemo(() => getCurrentContextUsage(messages), [messages]);
  const agentUsage = useMemo(() => getLocalAgentUsage(messages), [messages]);

  // 斜杠命令菜单：输入框里只有「/开头的一个词」时弹出，或点底栏的 / 按钮打开
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const commandListRef = useRef<HTMLDivElement>(null);
  const [commandPickerOpen, setCommandPickerOpen] = useState(false);
  const [commandMenuDismissed, setCommandMenuDismissed] = useState(false);
  const [commandIndex, setCommandIndex] = useState(0);
  const slashQuery = localAgent ? /^\/(\S*)$/.exec(inputValue)?.[1] : undefined;
  const commandQuery = slashQuery ?? (commandPickerOpen ? "" : undefined);
  const commandMatches = useMemo(
    () => (commandQuery === undefined ? [] : matchCommands(agentControls.commands, commandQuery)),
    [agentControls.commands, commandQuery],
  );
  const commandMenuOpen = commandMatches.length > 0 && !commandMenuDismissed;
  useEffect(() => {
    setCommandIndex(0);
    setCommandMenuDismissed(false);
  }, [commandQuery]);
  useEffect(() => {
    commandListRef.current?.querySelector(`[data-index="${commandIndex}"]`)?.scrollIntoView({ block: "nearest" });
  }, [commandIndex]);

  function pickCommand(command: LocalAgentCommand) {
    // 从按钮打开时输入框里可能已经有字，命令放到最前面，后面的字当作命令参数
    const rest = slashQuery === undefined ? inputValue.trimStart() : "";
    setInputValue(`/${command.name} ${rest}`);
    setCommandPickerOpen(false);
    textareaRef.current?.focus();
  }

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    messagesElRef.current?.scrollTo({ top: messagesElRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    let cancelled = false;
    contextWindowTokenLimitRef.current = undefined;
    if (localAgent) return;
    setContextWindowState({ status: "loading" });
    resolveAIModelContextWindow({
      apiBaseUrl: getEffectiveAIBaseUrl({ aiApiFormat: apiFormat, aiApiBaseUrl: apiBaseUrl }),
      apiKey,
      model,
      manualTokenLimit: manualContextWindow,
    })
      .then((info) => {
        if (cancelled) return;
        contextWindowTokenLimitRef.current = info?.tokenLimit;
        setContextWindowState(info ? { status: "ready", info } : { status: "unknown" });
      })
      .catch((contextWindowError) => {
        if (cancelled) return;
        contextWindowTokenLimitRef.current = undefined;
        setContextWindowState({
          status: "error",
          message: contextWindowError instanceof Error ? contextWindowError.message : String(contextWindowError),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [apiBaseUrl, apiFormat, apiKey, contextWindowTokenLimitRef, localAgent, manualContextWindow, model]);

  useEffect(() => {
    // 引用快照找不回来时，新发的 n/e 引用不能和这段旧对话里出现过的重号
    references.reserveRefsMentionedIn(JSON.stringify(session.messages));
    setMessages(session.messages);
    messagesRef.current = session.messages;
    lastSavedMessagesRef.current = session.messages;
    setSessionLoaded(true);
  }, [session.id, setMessages]);

  useEffect(() => {
    onRequestingChange(requesting);
    return () => onRequestingChange(false);
  }, [onRequestingChange, requesting]);

  useEffect(() => {
    onControllerChange({
      save: async () => {
        await persistMessages(messagesRef.current);
      },
    });
    return () => onControllerChange(null);
  }, [onControllerChange, persistMessages]);

  useEffect(() => {
    if (!sessionLoaded || requesting || messages === lastSavedMessagesRef.current) return;
    const timeout = window.setTimeout(() => {
      void persistMessages(messages).catch((saveError) => {
        toast.error(`AI 会话保存失败: ${saveError instanceof Error ? saveError.message : String(saveError)}`);
      });
    }, 250);
    return () => window.clearTimeout(timeout);
  }, [messages, persistMessages, requesting, sessionLoaded]);

  useEffect(() => {
    const interval = setInterval(() => {
      const entities = project.stageManager.getSelectedEntities();
      const associations = project.stageManager.getSelectedAssociations();
      const key = selectionKey(project);
      setSelection((previous) =>
        previous.key === key
          ? previous
          : { count: entities.length + associations.length, entityCount: entities.length, key },
      );
    }, 300);
    return () => clearInterval(interval);
  }, [project]);

  // 打开面板或换会话时就启动本机程序，底栏的模型、模式下拉不必等发了第一条消息才出现
  useEffect(() => {
    if (!localAgent || !sessionLoaded) return;
    // 启动失败会经状态显示在输入框上方的提示里，这里不再重复弹
    localAgent.prepareSession(session.id).catch(() => undefined);
  }, [localAgent, session.id, sessionLoaded]);

  function switchAgentControl(kind: "mode" | "model", id: string) {
    if (!localAgent) return;
    (kind === "mode" ? localAgent.setMode(id) : localAgent.setModel(id)).catch((error) =>
      toast.error(
        t("ai.composer.switchFailed", {
          detail: error instanceof Error ? error.message : String(error),
          interpolation: { escapeValue: false },
        }),
      ),
    );
  }

  useEffect(() => {
    const consume = () => {
      const initialInput = takePendingInitialInput();
      if (initialInput) setInputValue(initialInput);
    };
    consume();
    pendingInitialTextListeners.add(consume);
    return () => {
      pendingInitialTextListeners.delete(consume);
    };
  }, []);

  function handleUserSend() {
    if (sendText(inputValue)) setInputValue("");
  }

  function sendText(rawText: string): boolean {
    const text = rawText.trim();
    if (!text || requesting || !sessionLoaded || configProblems.length > 0) return false;
    // 斜杠命令必须在提示词最前面程序才认，不加选中内容的前缀
    const isCommand = localAgent !== undefined && isLocalAgentCommand(text);
    const selectedObjects =
      isCommand || selectionKey(project) === excludedSelectionKey
        ? []
        : [...project.stageManager.getSelectedEntities(), ...project.stageManager.getSelectedAssociations()];
    const selectedRefs = selectedObjects.map((object) => references.getOrCreateRef(object));
    const prefix = selectedRefs.length > 0 ? `[selected: ${selectedRefs.join(" ")}]\n` : "";
    const messageText = prefix + text;
    project.aiEngine.getRequestTraceBuffer().capturePendingInput(session.id, messageText);
    sendMessage({ text: messageText });
    return true;
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (commandMenuOpen && !isImeComposing(e)) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const step = e.key === "ArrowDown" ? 1 : -1;
        setCommandIndex((index) => (index + step + commandMatches.length) % commandMatches.length);
        return;
      }
      if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        pickCommand(commandMatches[Math.min(commandIndex, commandMatches.length - 1)]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setCommandMenuDismissed(true);
        setCommandPickerOpen(false);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      // 输入法选词时按的回车不算发送
      if (isImeComposing(e)) {
        e.stopPropagation();
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      handleUserSend();
    }
  }

  const ObjectRefCode = useCallback(
    ({ children, ...props }: any) => {
      const text = typeof children === "string" ? children : String(children ?? "");
      const stageObject = references.tryResolve(text);
      if (!stageObject || !isEntity(stageObject)) {
        return <code {...props}>{children}</code>;
      }

      const hasColor = "color" in stageObject && stageObject.color instanceof Color;
      const bgColor = hasColor ? (stageObject.color as Color).toHexStringWithoutAlpha() : undefined;
      const textColor = hasColor ? getContrastTextColor(stageObject.color as Color) : undefined;

      const hasText = "text" in stageObject && typeof stageObject.text === "string";
      const textPreview = hasText
        ? `${(stageObject.text as string).split("\n")[0]} `
        : `${getOriginalNameOf(stageObject.constructor)} ${text}`;

      const handleClick = () => {
        project.stageManager.clearSelectAll();
        stageObject.isSelected = true;
        const center = stageObject.collisionBox.getRectangle().center;
        project.camera.bombMove(center);
      };

      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              className="hover:ring-primary/50 inline-flex cursor-pointer items-center rounded px-1.5 py-0.5 text-xs transition-all hover:ring-2"
              style={bgColor ? { backgroundColor: bgColor, color: textColor } : undefined}
              onClick={handleClick}
            >
              {textPreview}
            </span>
          </TooltipTrigger>
          <TooltipContent>{text}</TooltipContent>
        </Tooltip>
      );
    },
    [project, references],
  );

  const markdownComponents = useMemo<Record<string, React.ComponentType<any>>>(
    () => ({ inlineCode: ObjectRefCode, img: SafeMarkdownImage }),
    [ObjectRefCode],
  );

  if (configProblems.length > 0) {
    return <AIConfigNotice problems={configProblems} />;
  }

  const quickPrompts = [t("ai.quickPrompts.lineOfThought"), t("ai.quickPrompts.whatIsMissing")];
  const boardName = project.uri.scheme === "file" ? displayWorkspaceName(project.title) : project.title;
  const statusText = !sessionLoaded
    ? t("ai.composer.loadingMemory")
    : agentStatus?.kind === "starting"
      ? t("ai.localAgent.starting", { name: agentInfo?.name ?? agentId })
      : requesting
        ? t("ai.composer.thinking")
        : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={messagesElRef} className="flex-1 overflow-y-auto px-3 py-4">
        {messages.length === 0 ? (
          <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-3 text-center">
            <Bot className="size-10" />
            <div className="text-foreground font-medium">{t("ai.emptyTitle")}</div>
            <div className="max-w-72 text-sm">
              {localAgent
                ? t("ai.emptyDescriptionLocal", { name: agentInfo?.name ?? agentId })
                : t("ai.emptyDescription")}
            </div>
            <div className="flex flex-wrap justify-center gap-2">
              {quickPrompts.map((prompt) => (
                <Button
                  key={prompt}
                  size="sm"
                  variant="outline"
                  disabled={requesting || !sessionLoaded}
                  onClick={() => sendText(prompt)}
                >
                  {prompt}
                </Button>
              ))}
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {messages.map((message, index) => (
              <MessageBubble
                key={message.id}
                message={message as any}
                components={markdownComponents}
                project={project}
                selectedCount={selection.entityCount}
                isLast={index === messages.length - 1}
                requesting={requesting}
                onToolApproval={async (id, approved) => {
                  await addToolApprovalResponse({ id, approved });
                }}
              />
            ))}
            {localAgent && permission && (
              <LocalAgentPermissionCard
                request={permission}
                agentName={agentInfo?.name ?? permission.agentId}
                onRespond={(optionId) => localAgent.respondPermission(permission.requestId, optionId)}
              />
            )}
          </div>
        )}
      </div>

      <div className="px-3 pt-1 pb-3">
        {localAgent && !requesting && (
          <LocalAgentNotice
            status={agentStatus}
            agent={agentInfo}
            agentId={agentId}
            missing={catalog !== null && !isLocalAgentReady(agentInfo, agentPaths[agentId])}
            onRetry={() => void regenerate()}
          />
        )}
        {/* 输入框照两个 VS Code 插件的样子：一个圆角框，从上到下是上下文小标签、打字区、底栏 */}
        <div className="bg-background border-border focus-within:border-ring/60 relative flex flex-col rounded-xl border shadow-xs transition-colors">
          {commandMenuOpen && (
            <div
              ref={commandListRef}
              role="listbox"
              aria-label={t("ai.composer.commands")}
              className="bg-popover text-popover-foreground absolute right-0 bottom-full left-0 z-20 mb-1 max-h-64 overflow-y-auto rounded-lg border p-1 shadow-md"
            >
              {commandMatches.map((command, index) => (
                <button
                  key={command.name}
                  type="button"
                  role="option"
                  aria-selected={index === commandIndex}
                  data-index={index}
                  className={cn(
                    "flex w-full cursor-pointer flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-left",
                    index === commandIndex && "bg-accent text-accent-foreground",
                  )}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setCommandIndex(index)}
                  onClick={() => pickCommand(command)}
                >
                  <span className="flex w-full min-w-0 items-baseline gap-1.5 text-sm">
                    <span className="shrink-0 font-mono">/{command.name}</span>
                    {command.hint && <span className="text-muted-foreground truncate text-xs">{command.hint}</span>}
                  </span>
                  {command.description && (
                    <span className="text-muted-foreground line-clamp-1 text-xs">{command.description}</span>
                  )}
                </button>
              ))}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-1 px-2 pt-2">
            <ContextChip
              icon={<LayoutDashboard />}
              label={boardName}
              title={t("ai.composer.board", { name: boardName, interpolation: { escapeValue: false } })}
            />
            {includeSelection && (
              <ContextChip
                icon={<MousePointerClick />}
                label={t("ai.composer.selected", { count: selection.count })}
                title={t("ai.composer.selectedHint")}
                removeLabel={t("ai.composer.removeSelected")}
                onRemove={() => setExcludedSelectionKey(selection.key)}
              />
            )}
          </div>
          <Textarea
            ref={textareaRef}
            placeholder={
              localAgent && agentControls.commands.length > 0
                ? t("ai.inputPlaceholderCommands")
                : t("ai.inputPlaceholder")
            }
            className="max-h-40 min-h-14 resize-none border-0 bg-transparent px-3 py-1.5 shadow-none focus-visible:ring-0 dark:bg-transparent"
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={handleKeyDown}
            onFocus={() => setCommandMenuDismissed(false)}
            onBlur={() => {
              setCommandMenuDismissed(true);
              setCommandPickerOpen(false);
            }}
            value={inputValue}
            disabled={requesting || !sessionLoaded}
          />
          <div className="flex min-w-0 items-center gap-0.5 px-1.5 pb-1.5">
            {localAgent && agentControls.commands.length > 0 && (
              <button
                type="button"
                className={cn(composerMenuTriggerClass, "px-2 font-mono")}
                title={t("ai.composer.commands")}
                aria-label={t("ai.composer.commands")}
                disabled={requesting || !sessionLoaded}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  textareaRef.current?.focus();
                  setCommandMenuDismissed(false);
                  if (inputValue.trim()) setCommandPickerOpen(true);
                  else setInputValue("/");
                }}
              >
                /
              </button>
            )}
            {localAgent && (
              <>
                <LocalAgentModeMenu
                  controls={agentControls}
                  disabled={requesting || !sessionLoaded}
                  onSelect={(id) => switchAgentControl("mode", id)}
                />
                <LocalAgentModelMenu
                  controls={agentControls}
                  disabled={requesting || !sessionLoaded}
                  onSelect={(id) => switchAgentControl("model", id)}
                />
              </>
            )}
            <div className="min-w-0 flex-1" />
            {statusText && <span className="text-muted-foreground shrink-0 truncate px-1 text-xs">{statusText}</span>}
            {localAgent ? (
              <LocalAgentContextUsage usage={agentUsage} agentName={agentInfo?.name ?? agentId} />
            ) : (
              <ContextWindowUsage
                usage={contextUsage}
                state={contextWindowState}
                sessionTotalTokens={tokenUsage.totalTokens}
                showTokenCount={showTokenCount}
                inputTokens={tokenUsage.inputTokens}
                outputTokens={tokenUsage.outputTokens}
              />
            )}
            {requesting ? (
              <Button
                size="icon"
                variant="secondary"
                className="size-7 shrink-0 cursor-pointer rounded-full"
                aria-label={t("ai.composer.stop")}
                title={t("ai.composer.stop")}
                onClick={stop}
              >
                <Square className="size-3 fill-current" />
              </Button>
            ) : (
              <Button
                size="icon"
                className="size-7 shrink-0 cursor-pointer rounded-full"
                aria-label={t("ai.composer.send")}
                title={t("ai.composer.send")}
                onClick={handleUserSend}
                disabled={!sessionLoaded || !inputValue.trim()}
              >
                <ArrowUp className="size-4" />
              </Button>
            )}
          </div>
        </div>
        {showDebug && (
          <AIRequestTraceView buffer={project.aiEngine.getRequestTraceBuffer()} activeSessionId={session.id} />
        )}
      </div>
    </div>
  );
}

// 名字以输入开头的排前面，名字里含输入的排后面；程序报什么就列什么
function matchCommands(commands: LocalAgentCommand[], query: string) {
  const q = query.toLowerCase();
  const name = (command: LocalAgentCommand) => command.name.toLowerCase();
  return [
    ...commands.filter((command) => name(command).startsWith(q)),
    ...commands.filter((command) => !name(command).startsWith(q) && name(command).includes(q)),
  ];
}

function ContextChip({
  icon,
  label,
  title,
  removeLabel,
  onRemove,
}: {
  icon: React.ReactNode;
  label: string;
  title: string;
  removeLabel?: string;
  onRemove?: () => void;
}) {
  return (
    <span
      title={title}
      className="bg-muted text-muted-foreground inline-flex h-6 max-w-48 min-w-0 items-center gap-1 rounded-md px-1.5 text-xs [&>svg]:size-3.5 [&>svg]:shrink-0"
    >
      {icon}
      <span className="truncate">{label}</span>
      {onRemove && (
        <button
          type="button"
          aria-label={removeLabel}
          title={removeLabel}
          className="hover:text-foreground -mr-0.5 cursor-pointer rounded-sm p-0.5"
          onClick={onRemove}
        >
          <X className="size-3" />
        </button>
      )}
    </span>
  );
}

function selectionKey(project: Project) {
  return [...project.stageManager.getSelectedEntities(), ...project.stageManager.getSelectedAssociations()]
    .map((object) => object.uuid)
    .join(",");
}

function getTokenUsage(messages: UIMessage<AIMessageMetadata>[]) {
  return messages.reduce(
    (usage, message) => {
      usage.inputTokens += message.metadata?.inputTokens ?? 0;
      usage.outputTokens += message.metadata?.outputTokens ?? 0;
      usage.totalTokens += message.metadata?.totalTokens ?? 0;
      return usage;
    },
    { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  );
}

function formatTokenCount(value: number) {
  return value.toLocaleString();
}

type CurrentContextUsage = {
  inputTokens: number;
  outputTokens: number;
  usedTokens: number;
};

function getCurrentContextUsage(messages: UIMessage<AIMessageMetadata>[]): CurrentContextUsage | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const metadata = messages[index].metadata;
    if (typeof metadata?.lastStepInputTokens !== "number") continue;
    const outputTokens = metadata.lastStepOutputTokens ?? 0;
    return {
      inputTokens: metadata.lastStepInputTokens,
      outputTokens,
      usedTokens: metadata.lastStepInputTokens + outputTokens,
    };
  }
  return null;
}

// 本机程序每轮报一次 usage_update（已用多少、上限多少），存在消息的 metadata 里，取最新的一条
function getLocalAgentUsage(messages: UIMessage<AIMessageMetadata>[]): { used: number; size: number } | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const usage = (messages[index].metadata as { localAgentUsage?: { used?: unknown; size?: unknown } } | undefined)
      ?.localAgentUsage;
    if (typeof usage?.used === "number" && typeof usage.size === "number" && usage.size > 0)
      return { used: usage.used, size: usage.size };
  }
  return null;
}

function formatCompactTokenCount(value: number) {
  return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function UsageRing({ percentage }: { percentage: number }) {
  const ringClass = percentage >= 90 ? "stroke-destructive" : percentage >= 70 ? "stroke-amber-500" : "stroke-primary";
  const circumference = 2 * Math.PI * 6;
  return (
    <svg viewBox="0 0 16 16" className="size-4 -rotate-90" aria-hidden>
      <circle cx="8" cy="8" r="6" className="stroke-border fill-none" strokeWidth="2" />
      <circle
        cx="8"
        cy="8"
        r="6"
        className={cn("fill-none", ringClass)}
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray={`${(percentage / 100) * circumference} ${circumference}`}
      />
    </svg>
  );
}

/** 本机程序的上下文用量：数字是程序自己每轮报上来的已用量和上限 */
function LocalAgentContextUsage({
  usage,
  agentName,
}: {
  usage: { used: number; size: number } | null;
  agentName: string;
}) {
  const { t } = useTranslation("research");
  const percentage = usage ? Math.min(100, (usage.used / usage.size) * 100) : 0;
  const summary = usage
    ? t("ai.composer.contextUsed", {
        used: formatCompactTokenCount(usage.used),
        size: formatCompactTokenCount(usage.size),
        percent: `${percentage.toFixed(1)}%`,
      })
    : t("ai.composer.contextEmpty");
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          className="text-muted-foreground flex h-7 shrink-0 items-center rounded-md px-1 outline-none focus-visible:ring-2"
          tabIndex={0}
          role="status"
          aria-label={summary}
        >
          <UsageRing percentage={percentage} />
        </div>
      </TooltipTrigger>
      <TooltipContent>
        <div className="flex flex-col gap-1">
          <div>{summary}</div>
          {usage && <div>{t("ai.composer.contextFrom", { name: agentName })}</div>}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

/** 底栏右边的上下文用量小圆圈，细节放在悬停提示里 */
function ContextWindowUsage({
  usage,
  state,
  sessionTotalTokens,
  showTokenCount,
  inputTokens,
  outputTokens,
}: {
  usage: CurrentContextUsage | null;
  state: ContextWindowState;
  sessionTotalTokens: number;
  showTokenCount: boolean;
  inputTokens: number;
  outputTokens: number;
}) {
  const tokenLimit = state.status === "ready" ? state.info.tokenLimit : undefined;
  const percentage = tokenLimit && usage ? Math.min(100, (usage.usedTokens / tokenLimit) * 100) : 0;
  const usedText = usage ? formatCompactTokenCount(usage.usedTokens) : "--";
  const summary =
    state.status === "loading"
      ? `${usedText} / 正在获取上限`
      : state.status === "ready"
        ? `${usedText} / ${formatCompactTokenCount(state.info.tokenLimit)} · ${usage ? `${((usage.usedTokens / state.info.tokenLimit) * 100).toFixed(1)}%` : "--"}`
        : state.status === "error"
          ? `${usedText} / 获取失败`
          : `${usedText} / 上限未知`;
  const source = state.status === "ready" ? (state.info.source === "openrouter" ? "OpenRouter" : "手动设置") : "未知";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          className="text-muted-foreground flex h-7 shrink-0 items-center gap-1 rounded-md px-1 text-xs outline-none focus-visible:ring-2"
          tabIndex={0}
          role="status"
          aria-label={`上下文窗口 ${summary}`}
        >
          {showTokenCount && (
            <span>
              ↑{formatCompactTokenCount(inputTokens)} ↓{formatCompactTokenCount(outputTokens)}
            </span>
          )}
          <UsageRing percentage={percentage} />
        </div>
      </TooltipTrigger>
      <TooltipContent>
        <div className="flex min-w-56 flex-col gap-1">
          <div>上下文：{summary}</div>
          <div>占用量按最后一步模型输入与输出计算</div>
          <div>最后输入：{usage ? formatTokenCount(usage.inputTokens) : "暂无"}</div>
          <div>最后输出：{usage ? formatTokenCount(usage.outputTokens) : "暂无"}</div>
          <div>会话累计计费：{formatTokenCount(sessionTotalTokens)}</div>
          <div>上下文上限来源：{source}</div>
          {state.status === "error" && <div>错误：{state.message}</div>}
          {state.status === "unknown" && <div>可在 AI 设置中手动填写上下文窗口大小</div>}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

function MessageBubble({
  message,
  components,
  project,
  selectedCount,
  isLast,
  requesting,
  onToolApproval,
}: {
  message: any;
  components?: Record<string, React.ComponentType<any>>;
  project: Project;
  selectedCount: number;
  isLast: boolean;
  requesting: boolean;
  onToolApproval: (id: string, approved: boolean) => Promise<void>;
}) {
  const isUser = message.role === "user";
  const parts = (Array.isArray(message.parts) ? message.parts : []).filter((part: any) => part.type !== "step-start");
  const finished = !isUser && (!isLast || !requesting);
  const hasText = parts.some((part: any) => part.type === "text");
  const copyText = finished ? replyText(message, parts) : "";

  // 照插件的样子：你的消息是浅底圆角块，AI 的回答不套气泡，直接排文字，工具调用折成一行。
  // 全局样式给每个元素都设了不可选中，只给外框设 select-text 管不到里面的段落，要连子元素一起放开。
  return (
    <div
      className={cn(
        "group flex min-w-0 cursor-text flex-col gap-2 text-sm select-text [&_*]:select-text",
        isUser && "bg-muted/70 text-foreground rounded-lg px-3 py-2",
      )}
    >
      {parts.length > 0 ? (
        parts.map((part: any, index: number) => (
          <MessagePart
            key={part.toolCallId ?? `${part.type}-${index}`}
            part={part}
            components={components}
            isAnimating={!isUser && requesting}
            showCaret={!isUser && isLast}
            onToolApproval={onToolApproval}
          />
        ))
      ) : (
        <Streamdown
          className="pg-ai-markdown"
          plugins={{ code }}
          components={components}
          animated={!isUser}
          isAnimating={!isUser && requesting}
          caret={!isUser && isLast ? "circle" : undefined}
        >
          {String(message.content ?? "")}
        </Streamdown>
      )}
      {finished && (copyText || (selectedCount === 1 && hasText)) && (
        <div className="flex items-center justify-end gap-2">
          {copyText && <CopyReplyButton text={copyText} />}
          {selectedCount === 1 && hasText && (
            <button
              className="text-muted-foreground hover:text-foreground flex cursor-pointer items-center"
              onClick={() => createAnswerNode(message, project)}
            >
              <Plus className="size-3.5" />
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function replyText(message: any, parts: any[]): string {
  const texts = parts.filter((part) => part.type === "text").map((part) => String(part.text ?? ""));
  return (texts.length > 0 ? texts.join("\n\n") : String(message.content ?? "")).trim();
}

function CopyReplyButton({ text }: { text: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <button
      className={cn(
        "text-muted-foreground hover:text-foreground flex cursor-pointer items-center transition-opacity focus-visible:opacity-100",
        copied ? "opacity-100" : "opacity-0 group-hover:opacity-100",
      )}
      title={t(copied ? "ai.composer.copied" : "ai.composer.copy")}
      aria-label={t("ai.composer.copy")}
      onClick={async () => {
        await writeText(text);
        setCopied(true);
      }}
    >
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
    </button>
  );
}

function MessagePart({
  part,
  components,
  isAnimating,
  showCaret,
  onToolApproval,
}: {
  part: any;
  components?: Record<string, React.ComponentType<any>>;
  isAnimating?: boolean;
  showCaret?: boolean;
  onToolApproval: (id: string, approved: boolean) => Promise<void>;
}) {
  if (part.type === "text") {
    return (
      <Streamdown
        className="pg-ai-markdown"
        plugins={{ code }}
        components={components}
        animated={isAnimating}
        isAnimating={isAnimating}
        caret={showCaret ? "circle" : undefined}
      >
        {part.text ?? ""}
      </Streamdown>
    );
  }
  if (part.type === "reasoning") {
    return <ReasoningPart part={part} />;
  }
  if (isAIToolPart(part)) {
    return <ToolPart part={part} onToolApproval={onToolApproval} />;
  }
  return (
    <pre className="text-muted-foreground overflow-auto text-xs">unknown part: {JSON.stringify(part, null, 2)}</pre>
  );
}

function ReasoningPart({ part }: { part: any }) {
  const streaming = part.state === "streaming";
  const [open, setOpen] = useState(streaming);
  const userToggled = useRef(false);
  const wasStreaming = useRef(streaming);

  useEffect(() => {
    // 只在流式结束后自动收起一次，用户手动展开过就不再干预
    if (wasStreaming.current && !streaming && !userToggled.current) setOpen(false);
    wasStreaming.current = streaming;
  }, [streaming]);

  return (
    <Collapsible
      open={open}
      onOpenChange={(next) => {
        userToggled.current = true;
        setOpen(next);
      }}
      className="group/reasoning min-w-0 self-stretch"
    >
      <CollapsibleTrigger className="text-muted-foreground hover:text-foreground flex cursor-pointer items-center gap-1.5 text-xs">
        <ChevronRight className="size-3 shrink-0 transition-transform group-data-[state=open]/reasoning:rotate-90" />
        <span>{streaming ? "思考中" : "思考过程"}</span>
      </CollapsibleTrigger>
      <CollapsibleContent className="animate-none!">
        <div className="text-muted-foreground mt-1.5 border-l-2 pl-2 text-xs leading-relaxed wrap-anywhere whitespace-pre-wrap">
          {part.text ?? part.reasoning ?? ""}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function ToolPart({
  part,
  onToolApproval,
}: {
  part: any;
  onToolApproval: (id: string, approved: boolean) => Promise<void>;
}) {
  const name = getAIToolPartName(part);
  const done = part.state === "output-available";
  const failed = part.state === "output-error";

  if (part.state === "approval-requested") {
    return <ToolApprovalPart name={name} part={part} onToolApproval={onToolApproval} />;
  }

  // 一行小字：状态圆点、工具名，跑着或失败时再带一句状态；点开看参数和结果
  return (
    <Collapsible className="group/collapsible min-w-0">
      <CollapsibleTrigger className="text-muted-foreground hover:text-foreground flex max-w-full cursor-pointer items-center gap-1.5 text-xs">
        <span
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            done ? "bg-muted-foreground/50" : failed ? "bg-destructive" : "bg-primary animate-pulse",
          )}
        />
        <span className="truncate font-medium">{name}</span>
        {!done && <span className={cn("shrink-0", failed && "text-destructive")}>{toolStateText(part.state)}</span>}
        <ChevronRight className="size-3 shrink-0 transition-transform group-data-[state=open]/collapsible:rotate-90" />
      </CollapsibleTrigger>
      <CollapsibleContent className="bg-muted/60 mt-1.5 animate-none! rounded-md px-2.5 py-2">
        <Streamdown className="pg-ai-markdown" plugins={{ code }}>
          {`\`\`\`json\n${JSON.stringify({ input: part.input, output: part.output, error: part.errorText }, null, 2)}\n\`\`\``}
        </Streamdown>
      </CollapsibleContent>
    </Collapsible>
  );
}

function ToolApprovalPart({
  name,
  part,
  onToolApproval,
}: {
  name: string;
  part: any;
  onToolApproval: (id: string, approved: boolean) => Promise<void>;
}) {
  const [submitting, setSubmitting] = useState(false);
  const respond = async (approved: boolean) => {
    if (submitting) return;
    setSubmitting(true);
    try {
      await onToolApproval(part.approval.id, approved);
    } catch (error) {
      toast.error(`提交工具审批失败：${error instanceof Error ? error.message : String(error)}`);
      setSubmitting(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="text-muted-foreground text-xs">
        <span className="font-mono">{name}</span> 请求执行
      </div>
      <pre className="bg-muted max-h-48 overflow-auto rounded-md p-2 font-mono text-xs select-text">
        {JSON.stringify(part.input, null, 2)}
      </pre>
      <div className="flex justify-end gap-2">
        <Button
          size="sm"
          className="h-7 px-2"
          variant="outline"
          disabled={submitting}
          onClick={() => void respond(false)}
        >
          拒绝
        </Button>
        <Button size="sm" className="h-7 px-2" disabled={submitting} onClick={() => void respond(true)}>
          允许本次调用
        </Button>
      </div>
    </div>
  );
}

function toolStateText(state: string | undefined) {
  switch (state) {
    case "input-streaming":
      return "准备参数";
    case "input-available":
      return "执行中";
    case "approval-requested":
      return "等待批准";
    case "approval-responded":
      return "已处理批准";
    case "output-available":
      return "完成";
    case "output-error":
      return "失败";
    default:
      return state ?? "";
  }
}

const aiWindowTabIds = new Set<string>();
// 关面板前要先把聊天记录存掉，由打开着的面板自己登记
const aiWindowCloseHandlers = new Map<string, () => void>();

function findOpenAIWindowTab() {
  return store.get(tabsAtom).find((tab) => !tab.closing && aiWindowTabIds.has(tab.id));
}

AIWindow.open = () => {
  // 只留一个 AI 面板，其他入口（右键菜单、快捷键）打开时也切到这一个
  const existing = findOpenAIWindowTab();
  if (existing) {
    TabWorkspace.focus(existing.id);
    return existing;
  }
  const tab = createSubWindow("AIWindow", {
    title: "",
    contextTarget: "activeResourceTab",
    closable: false,
    titleBarOverlay: true,
    closeOnEscape: false,
    children: (tab) => <AIWindow tabId={tab.id} />,
    rect: new Rectangle(new Vector(8, 88), new Vector(380, window.innerHeight - 96)),
  });
  aiWindowTabIds.add(tab.id);
  markResearchPanelTab("ai", tab.id);
  return tab;
};

/** 没打开就打开；已打开但被同组其他页挡住就切到前台；已经看得见就关掉（不看键盘焦点，免得第一下只是抢走白板的焦点） */
AIWindow.toggle = () => {
  const existing = findOpenAIWindowTab();
  if (!existing) {
    AIWindow.open();
    return;
  }
  if (isTabVisibleInWorkspace(existing.id)) {
    const close = aiWindowCloseHandlers.get(existing.id);
    if (close) {
      close();
    } else {
      void TabWorkspace.close(existing.id);
    }
    return;
  }
  TabWorkspace.focus(existing.id);
};
// toggleAI 事件由 ResearchSession.registerResearchSession 转发到 AIWindow.toggle()；这里不能再监听，否则一次事件会切换两次
