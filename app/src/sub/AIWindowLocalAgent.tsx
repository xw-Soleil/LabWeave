import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  LocalAgentError,
  openLocalAgentTerminal,
  parseLocalAgentContext,
  type LocalAgentContextTable,
  type LocalAgentInfo,
} from "@/core/service/dataManageService/aiEngine/LocalAgent";
import type {
  LocalAgentContextReport,
  LocalAgentPermissionRequest,
  LocalAgentSessionControls,
  LocalAgentStatus,
  LocalAgentTransport,
} from "@/core/service/dataManageService/aiEngine/LocalAgentTransport";
import { Settings } from "@/core/service/Settings";
import SettingsWindow from "@/sub/SettingsWindow";
import { setSettingsInitialPage, type SettingsSubPageId } from "@/sub/SettingsWindow/settings";
import { cn } from "@/utils/cn";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@radix-ui/react-collapsible";
import {
  AlertCircle,
  ChevronDown,
  ChevronRight,
  Info,
  Loader2,
  LogIn,
  ShieldAlert,
  ShieldCheck,
  ShieldQuestion,
  X,
} from "lucide-react";
import { Fragment, useEffect, useRef, useState } from "react";
import { Streamdown } from "streamdown";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

/** 输入框底栏里各个小下拉共用的样子：平时只是一行灰字，悬停或展开时才有底色 */
export const composerMenuTriggerClass =
  "text-muted-foreground hover:bg-accent hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground flex h-7 max-w-36 min-w-0 cursor-pointer items-center gap-1 rounded-md px-1.5 text-xs transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50";

const emptyControls: LocalAgentSessionControls = {
  modes: [],
  currentMode: null,
  models: [],
  currentModel: null,
  commands: [],
};

function openSettings(pageId: string, subPage?: SettingsSubPageId) {
  setSettingsInitialPage(pageId, subPage);
  SettingsWindow.open("settings");
}

export function isLocalAgentReady(agent: LocalAgentInfo | undefined, customPath: string | undefined) {
  return Boolean(customPath || agent?.resolvedPath);
}

export function useLocalAgentStatus(transport: LocalAgentTransport | undefined): LocalAgentStatus | null {
  const [status, setStatus] = useState<LocalAgentStatus | null>(null);
  useEffect(() => {
    setStatus(null);
    return transport?.onStatus(setStatus);
  }, [transport]);
  return status;
}

export function useLocalAgentPermission(
  transport: LocalAgentTransport | undefined,
): LocalAgentPermissionRequest | null {
  const [request, setRequest] = useState<LocalAgentPermissionRequest | null>(null);
  useEffect(() => {
    setRequest(null);
    return transport?.onPermissionRequest(setRequest);
  }, [transport]);
  return request;
}

export function useLocalAgentControls(transport: LocalAgentTransport | undefined): LocalAgentSessionControls {
  const [controls, setControls] = useState<LocalAgentSessionControls>(emptyControls);
  useEffect(() => {
    setControls(emptyControls);
    return transport?.onControls(setControls);
  }, [transport]);
  return controls;
}

/** 面板标题下面的小下拉：用设置里的接口，还是本机已经装好的某个程序 */
export function AISourceMenu({
  catalog,
  onOpen,
  model,
  disabled,
}: {
  catalog: LocalAgentInfo[] | null;
  onOpen: () => void;
  model: string;
  disabled: boolean;
}) {
  const { t } = useTranslation("research");
  const [backend] = Settings.use("aiBackend");
  const [agentId] = Settings.use("aiLocalAgent");
  const [paths] = Settings.use("aiLocalAgentPaths");
  const current = catalog?.find((agent) => agent.id === agentId);
  // 选中的程序就算没找到也列出来，免得下拉里没有勾选项
  const agents = (catalog ?? []).filter((agent) => isLocalAgentReady(agent, paths[agent.id]) || agent.id === agentId);
  const label = backend === "api" ? model || t("ai.localAgent.api") : (current?.name ?? agentId);

  return (
    <DropdownMenu onOpenChange={(open) => open && onOpen()}>
      <DropdownMenuTrigger
        disabled={disabled}
        title={t("ai.composer.source")}
        className="text-muted-foreground hover:text-foreground flex max-w-full cursor-pointer items-center gap-0.5 text-xs disabled:cursor-not-allowed disabled:opacity-50"
      >
        <span className="truncate">{label}</span>
        <ChevronDown className="size-3 shrink-0" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-60">
        <DropdownMenuRadioGroup
          value={backend === "api" ? "api" : agentId}
          onValueChange={(value) => {
            if (value === "api") {
              Settings.aiBackend = "api";
              return;
            }
            Settings.aiLocalAgent = value as LocalAgentInfo["id"];
            Settings.aiBackend = "localAgent";
          }}
        >
          <DropdownMenuRadioItem value="api">
            <span className="flex min-w-0 flex-col">
              <span>{t("ai.localAgent.api")}</span>
              {model && <span className="text-muted-foreground truncate text-xs">{model}</span>}
            </span>
          </DropdownMenuRadioItem>
          <DropdownMenuSeparator />
          <DropdownMenuLabel className="text-muted-foreground text-xs font-normal">
            {t("ai.localAgent.localGroup")}
          </DropdownMenuLabel>
          {agents.map((agent) => (
            <DropdownMenuRadioItem key={agent.id} value={agent.id}>
              <span className="flex-1">{agent.name}</span>
              {!isLocalAgentReady(agent, paths[agent.id]) ? (
                <span className="text-muted-foreground text-xs">{t("ai.localAgent.missing")}</span>
              ) : (
                !agent.tested && <span className="text-muted-foreground text-xs">{t("ai.localAgent.untested")}</span>
              )}
            </DropdownMenuRadioItem>
          ))}
          {agents.length === 0 && (
            <DropdownMenuItem disabled className="text-xs">
              {catalog ? t("ai.localAgent.noneFound") : t("ai.localAgent.searching")}
            </DropdownMenuItem>
          )}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => openSettings("ai", "localAgents")}>
          {t("ai.localAgent.manage")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** 程序自己报上来的模型；没有就不显示 */
export function LocalAgentModelMenu({
  controls,
  disabled,
  onSelect,
}: {
  controls: LocalAgentSessionControls;
  disabled: boolean;
  onSelect: (id: string) => void;
}) {
  const { t } = useTranslation("research");
  if (controls.models.length === 0) return null;
  const current = controls.models.find((model) => model.id === controls.currentModel);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={disabled}
        className={composerMenuTriggerClass}
        title={current?.name ?? t("ai.composer.model")}
      >
        <span className="truncate">{current?.name ?? controls.currentModel ?? t("ai.composer.model")}</span>
        <ChevronDown className="size-3 shrink-0" />
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="max-h-80 w-64 overflow-y-auto">
        <DropdownMenuLabel className="text-muted-foreground text-xs font-normal">
          {t("ai.composer.model")}
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup value={controls.currentModel ?? ""} onValueChange={onSelect}>
          {controls.models.map((model) => (
            <DropdownMenuRadioItem key={model.id} value={model.id}>
              <ChoiceText name={model.name} description={model.description} />
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// 这几档不受限制，照插件原样列出来但标红提醒；程序默认配置不是它们时，我们也从不自己切过去
const DANGEROUS_MODES = new Set(["bypassPermissions", "agent-full-access", "full-access", "yolo"]);

/** 程序自带的权限模式，名字和说明照程序给的原样显示，和两个 VS Code 插件一致 */
export function LocalAgentModeMenu({
  controls,
  disabled,
  onSelect,
}: {
  controls: LocalAgentSessionControls;
  disabled: boolean;
  onSelect: (id: string) => void;
}) {
  const { t } = useTranslation("research");
  if (controls.modes.length === 0) return null;
  const current = controls.modes.find((mode) => mode.id === controls.currentMode);
  const dangerous = controls.currentMode !== null && DANGEROUS_MODES.has(controls.currentMode);
  const Icon = dangerous ? ShieldAlert : ShieldCheck;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={disabled}
        className={cn(
          composerMenuTriggerClass,
          dangerous && "text-destructive hover:text-destructive data-[state=open]:text-destructive",
        )}
        title={current?.description || t("ai.composer.mode")}
      >
        <Icon className="size-3.5 shrink-0" />
        <span className="truncate">{current?.name ?? controls.currentMode ?? t("ai.composer.mode")}</span>
        <ChevronDown className="size-3 shrink-0" />
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-72">
        <DropdownMenuLabel className="text-muted-foreground text-xs font-normal">
          {t("ai.composer.mode")}
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup value={controls.currentMode ?? ""} onValueChange={onSelect}>
          {controls.modes.map((mode) => (
            <DropdownMenuRadioItem key={mode.id} value={mode.id}>
              <ChoiceText name={mode.name} description={mode.description} danger={DANGEROUS_MODES.has(mode.id)} />
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ChoiceText({ name, description, danger }: { name: string; description?: string; danger?: boolean }) {
  return (
    <span className={cn("flex min-w-0 flex-col gap-0.5", danger && "text-destructive")}>
      <span className="flex items-center gap-1 truncate">
        {danger && <ShieldAlert className="size-3.5 shrink-0" />}
        {name}
      </span>
      {description && (
        <span className={cn("text-xs leading-snug", danger ? "text-destructive/80" : "text-muted-foreground")}>
          {description}
        </span>
      )}
    </span>
  );
}

/** 输入框上方的一行提示：没找到程序、要登录、出错了，或者这个版本改不了白板 */
export function LocalAgentNotice({
  status,
  agent,
  agentId,
  missing,
  onRetry,
}: {
  status: LocalAgentStatus | null;
  agent: LocalAgentInfo | undefined;
  agentId: string;
  missing: boolean;
  onRetry: () => void;
}) {
  const { t } = useTranslation("research");
  const name = agent?.name ?? agentId;

  let tone: "error" | "info" = "error";
  let text: string;
  let details: string[] = [];
  let action: { label: string; run: () => void } | null = null;
  // 还没发过消息时状态是 idle，用目录先提示没找到，不必等发送失败
  const notStarted = !status || status.kind === "idle";

  if (status?.kind === "needs-login") {
    text = t("ai.localAgent.needsLogin", { name });
    if (status.loginCommand)
      action = {
        label: t("ai.localAgent.login"),
        run: () => void openLocalAgentTerminal(Settings.aiLocalAgent, "login").catch(toastError),
      };
  } else if (status?.kind === "agent-error" && status.reason === "no-research-folder") {
    text = t("ai.localAgent.errors.no-research-folder");
    action = { label: t("ai.localAgent.openSettings"), run: () => openSettings("folder") };
  } else if ((status?.kind === "agent-error" && status.reason === "not-found") || (missing && notStarted)) {
    text = t("ai.localAgent.notFound", { name });
    action = { label: t("ai.localAgent.openSettings"), run: () => openSettings("ai", "localAgents") };
  } else if (status?.kind === "agent-error") {
    text = t(`ai.localAgent.errors.${status.reason}`, { name });
    details = [status.detail, ...status.stderrTail].filter(Boolean);
    action = { label: t("ai.localAgent.retry"), run: onRetry };
  } else if (status?.kind === "ready" && !status.whiteboardTools) {
    tone = "info";
    text = t("ai.localAgent.noWhiteboardTools", { name });
  } else {
    return null;
  }

  const Icon = tone === "info" ? Info : status?.kind === "needs-login" ? LogIn : AlertCircle;
  return (
    <div className="bg-muted/60 mb-2 flex items-start gap-2 rounded-md px-2.5 py-2 text-xs">
      <Icon className={tone === "error" ? "text-destructive mt-px size-3.5 shrink-0" : "mt-px size-3.5 shrink-0"} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="leading-relaxed">{text}</span>
        {details.length > 0 && (
          <Collapsible className="group/details">
            <CollapsibleTrigger className="text-muted-foreground hover:text-foreground flex cursor-pointer items-center gap-1">
              <ChevronRight className="size-3 transition-transform group-data-[state=open]/details:rotate-90" />
              {t("ai.localAgent.details")}
            </CollapsibleTrigger>
            <CollapsibleContent>
              <pre className="bg-background mt-1 max-h-40 overflow-auto rounded p-1.5 font-mono text-[11px] whitespace-pre-wrap select-text">
                {details.join("\n")}
              </pre>
            </CollapsibleContent>
          </Collapsible>
        )}
      </div>
      {action && (
        <Button size="sm" variant="outline" className="h-6 shrink-0 px-2 text-xs" onClick={action.run}>
          {action.label}
        </Button>
      )}
    </div>
  );
}

/** AI 程序要写文件、跑命令时来问的卡片：上面写它要做什么，下面一列是它给的选项，照插件的样子允许在前、拒绝在后 */
export function LocalAgentPermissionCard({
  request,
  agentName,
  onRespond,
}: {
  request: LocalAgentPermissionRequest;
  agentName: string;
  onRespond: (optionId: string) => void;
}) {
  const { t } = useTranslation("research");
  const [submitted, setSubmitted] = useState(false);
  useEffect(() => setSubmitted(false), [request.requestId]);
  const isReject = (kind: string) => kind.startsWith("reject");
  const options = [
    ...request.options.filter((option) => !isReject(option.kind)),
    ...request.options.filter((option) => isReject(option.kind)),
  ];
  const command = commandOf(request.rawInput);

  return (
    <div className="bg-card border-border flex min-w-0 flex-col gap-2 rounded-lg border px-3 py-2.5 text-sm shadow-xs">
      <div className="flex items-center gap-1.5 text-xs font-medium">
        <ShieldQuestion className="text-primary size-3.5 shrink-0" />
        {t("ai.localAgent.permissionTitle", { name: agentName })}
      </div>
      <div className="wrap-anywhere select-text">{request.title}</div>
      {command ? (
        <pre className="bg-muted max-h-32 overflow-auto rounded-md px-2 py-1.5 font-mono text-xs whitespace-pre-wrap select-text">
          {command}
        </pre>
      ) : (
        request.rawInput !== undefined && (
          <Collapsible className="group/input">
            <CollapsibleTrigger className="text-muted-foreground hover:text-foreground flex cursor-pointer items-center gap-1 text-xs">
              <ChevronRight className="size-3 transition-transform group-data-[state=open]/input:rotate-90" />
              {t("ai.localAgent.permissionInput")}
            </CollapsibleTrigger>
            <CollapsibleContent>
              <pre className="bg-muted mt-1 max-h-48 overflow-auto rounded-md p-2 font-mono text-xs select-text">
                {JSON.stringify(request.rawInput, null, 2)}
              </pre>
            </CollapsibleContent>
          </Collapsible>
        )
      )}
      <div className="flex flex-col gap-1">
        {options.map((option, index) => (
          <Button
            key={option.optionId}
            size="sm"
            className="h-auto min-h-7 justify-start px-2.5 py-1 text-left whitespace-normal"
            variant={isReject(option.kind) ? "ghost" : index === 0 ? "default" : "outline"}
            disabled={submitted}
            onClick={() => {
              setSubmitted(true);
              onRespond(option.optionId);
            }}
          >
            {option.name}
          </Button>
        ))}
      </div>
    </div>
  );
}

// 跑命令的请求把命令单独摆出来（Codex 和 Claude Code 都放在 rawInput.command），其他请求收在「参数」里
function commandOf(rawInput: unknown): string | null {
  if (!rawInput || typeof rawInput !== "object") return null;
  const command = (rawInput as { command?: unknown }).command;
  if (typeof command === "string") return command;
  if (Array.isArray(command) && command.every((part) => typeof part === "string")) return command.join(" ");
  return null;
}

function toastError(error: unknown) {
  toast.error(String(error));
}

type ContextState =
  | { status: "loading" }
  | { status: "ready"; report: LocalAgentContextReport | null }
  | { status: "error"; detail: string };

// 照 Claude Code 插件的配色；程序以后多出来的分类按顺序取备用色
const CATEGORY_COLORS: Record<string, string> = {
  "system prompt": "#d97706",
  "system tools": "#3b82f6",
  "mcp server instructions": "#14b8a6",
  "mcp tools": "#22c55e",
  "custom agents": "#ec4899",
  "memory files": "#c8956a",
  skills: "#a855f7",
  messages: "#ef4444",
  "autocompact buffer": "#06b6d4",
};
const SPARE_COLORS = ["#f59e0b", "#6366f1", "#84cc16", "#f43f5e", "#0ea5e9"];

/**
 * 上下文用量弹层，盖在 AI 面板上（和插件一样不弹到窗口正中）。
 * 打开时跑一次程序自己的 /context 或 /status，结果不进对话，详见 LOCAL_AGENT_CONTEXT_COMMANDS。
 */
export function LocalAgentContextPanel({
  transport,
  chatId,
  agentName,
  command,
  usage,
  onClose,
}: {
  transport: LocalAgentTransport;
  chatId: string;
  agentName: string;
  command: { name: string; isolated: boolean };
  usage: { used: number; size: number } | null;
  onClose: () => void;
}) {
  const { t } = useTranslation("research");
  const [state, setState] = useState<ContextState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const cardRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    transport.inspectContext(chatId).then(
      (report) => {
        if (!cancelled) setState({ status: "ready", report });
      },
      (error) => {
        if (!cancelled)
          setState({
            status: "error",
            detail: error instanceof LocalAgentError ? error.detail || error.reason : String(error),
          });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [transport, chatId, attempt]);
  useEffect(() => {
    cardRef.current?.focus();
  }, []);
  const title = t("ai.contextDialog.title");
  return (
    <div
      className="absolute inset-0 z-30 flex items-start justify-center bg-black/25 p-3 pt-10"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.stopPropagation();
          onClose();
        }}
        className="bg-popover text-popover-foreground flex max-h-full w-full max-w-md flex-col gap-3 overflow-y-auto rounded-xl border p-4 text-sm shadow-xl outline-none"
      >
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <div className="text-base font-semibold">{title}</div>
            <div className="text-muted-foreground mt-0.5 text-xs">
              {command.isolated
                ? t("ai.contextDialog.isolated", { command: command.name })
                : t("ai.contextDialog.quiet", { name: agentName, command: command.name })}
            </div>
          </div>
          <button
            className="text-muted-foreground hover:text-foreground cursor-pointer rounded-md p-1"
            aria-label={t("ai.contextDialog.close")}
            onClick={onClose}
          >
            <X className="size-4" />
          </button>
        </div>
        {state.status === "loading" && (
          <div className="text-muted-foreground flex items-center gap-2 py-6">
            <Loader2 className="size-4 animate-spin" />
            {t("ai.contextDialog.loading")}
          </div>
        )}
        {state.status === "error" && (
          <div className="flex flex-col items-start gap-2 py-2">
            <div className="text-destructive flex items-start gap-1.5">
              <AlertCircle className="mt-0.5 size-4 shrink-0" />
              <span className="wrap-anywhere select-text">
                {t("ai.contextDialog.failed", { detail: state.detail, interpolation: { escapeValue: false } })}
              </span>
            </div>
            <Button size="sm" variant="outline" onClick={() => setAttempt((count) => count + 1)}>
              {t("ai.contextDialog.retry")}
            </Button>
          </div>
        )}
        {state.status === "ready" && <ContextReportView report={state.report} usage={usage} />}
      </div>
    </div>
  );
}

function ContextReportView({
  report,
  usage,
}: {
  report: LocalAgentContextReport | null;
  usage: { used: number; size: number } | null;
}) {
  const { t } = useTranslation("research");
  const details = report ? parseLocalAgentContext(report.text) : null;
  const field = (name: string) => details?.fields.find((item) => item.label.toLowerCase() === name)?.value;
  const usageSummary = usage ? (
    <>
      <div className="tabular-nums">
        {t("ai.composer.contextUsed", {
          used: formatTokens(usage.used),
          size: formatTokens(usage.size),
          percent: `${((usage.used / usage.size) * 100).toFixed(1)}%`,
        })}
      </div>
      <UsageBar segments={[{ key: "used", percent: (usage.used / usage.size) * 100, color: "#ef4444" }]} />
    </>
  ) : (
    <div className="text-muted-foreground">{t("ai.composer.contextEmpty")}</div>
  );

  // Claude Code 的 /context：分类表 + 记忆文件等明细
  if (details && details.categories.length > 0) {
    const counted = details.categories.filter((category) => !category.deferred);
    const ordered = [...counted.filter((category) => !category.free), ...counted.filter((category) => category.free)];
    const deferred = details.categories.filter((category) => category.deferred);
    let spare = 0;
    const colorOf = new Map(
      ordered
        .filter((category) => !category.free)
        .map((category) => [
          category.name,
          CATEGORY_COLORS[category.name.toLowerCase()] ?? SPARE_COLORS[spare++ % SPARE_COLORS.length],
        ]),
    );
    const memory = details.tables.filter((table) => /memory/i.test(table.title) && table.rows.length > 0);
    const others = details.tables.filter((table) => !/memory/i.test(table.title) && table.rows.length > 0);
    return (
      <div className="flex flex-col gap-3 select-text [&_*]:select-text">
        <div>
          {field("model") && <div>{field("model")}</div>}
          {field("tokens") && <div className="tabular-nums">{field("tokens")}</div>}
        </div>
        <UsageBar
          segments={ordered
            .filter((category) => !category.free)
            .map((category) => ({ key: category.name, percent: category.percent, color: colorOf.get(category.name)! }))}
        />
        <table className="w-full border-collapse tabular-nums">
          <thead>
            <tr className="text-muted-foreground border-b text-xs">
              <th className="py-1.5 text-left font-medium">{t("ai.contextDialog.category")}</th>
              <th className="py-1.5 text-right font-medium">{t("ai.contextDialog.tokens")}</th>
              <th className="w-16 py-1.5 text-right font-medium">{t("ai.contextDialog.share")}</th>
            </tr>
          </thead>
          <tbody>
            {ordered.map((category) => (
              <tr key={category.name}>
                <td className="py-1">
                  <span className="flex items-center gap-2">
                    <span
                      className="size-2.5 shrink-0 rounded-sm"
                      style={{ backgroundColor: colorOf.get(category.name) ?? "transparent" }}
                    />
                    {category.name}
                  </span>
                </td>
                <td className="py-1 text-right">{category.tokens}</td>
                <td className="text-muted-foreground py-1 text-right">{formatShare(category.percent)}</td>
              </tr>
            ))}
            {deferred.map((category) => (
              <tr key={category.name} className="text-muted-foreground" title={t("ai.contextDialog.deferred")}>
                <td className="py-1">
                  <span className="flex items-center gap-2">
                    <span className="size-2.5 shrink-0" />
                    {category.name}
                  </span>
                </td>
                <td className="py-1 text-right">{category.tokens}</td>
                <td className="py-1 text-right">—</td>
              </tr>
            ))}
          </tbody>
        </table>
        {deferred.length > 0 && <div className="text-muted-foreground text-xs">{t("ai.contextDialog.deferred")}</div>}
        {memory.map((table) => (
          <ContextTable key={table.title} table={table} title={t("ai.contextDialog.memoryFiles")} open />
        ))}
        {others.map((table) => (
          <ContextTable key={table.title} table={table} title={table.title} />
        ))}
      </div>
    );
  }

  // Codex 的 /status：总量来自程序每轮报的用量，其余逐项列出
  if (details && details.fields.length > 0) {
    return (
      <div className="flex flex-col gap-3 select-text [&_*]:select-text">
        {usageSummary}
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
          {details.fields.map((item) => (
            <Fragment key={item.label}>
              <dt className="text-muted-foreground">{item.label}</dt>
              <dd className="wrap-anywhere">{item.value}</dd>
            </Fragment>
          ))}
        </dl>
      </div>
    );
  }

  // 程序改了输出格式、读不出来时，原样显示它的文字
  if (report && report.text.trim()) {
    return (
      <div className="flex flex-col gap-3 select-text [&_*]:select-text">
        {usageSummary}
        <Streamdown className="pg-ai-markdown">{report.text}</Streamdown>
      </div>
    );
  }
  return <div className="flex flex-col gap-3">{usageSummary}</div>;
}

function UsageBar({ segments }: { segments: { key: string; percent: number; color: string }[] }) {
  return (
    <div className="bg-muted flex h-2 w-full overflow-hidden rounded-full">
      {segments.map((segment) => (
        <div
          key={segment.key}
          className="h-full shrink-0"
          style={{
            width: `${Math.min(100, segment.percent)}%`,
            minWidth: segment.percent > 0 ? 2 : 0,
            backgroundColor: segment.color,
          }}
        />
      ))}
    </div>
  );
}

function ContextTable({
  table,
  title,
  open = false,
}: {
  table: LocalAgentContextTable;
  title: string;
  open?: boolean;
}) {
  // 第一列是名字（记忆文件取路径那列），最后一列是 Token 数
  const pathColumn = table.columns.findIndex((column) => /path/i.test(column));
  const nameColumn = pathColumn >= 0 ? pathColumn : 0;
  const tokenColumn = table.columns.findIndex((column) => /tokens/i.test(column));
  return (
    <Collapsible defaultOpen={open}>
      <CollapsibleTrigger className="text-muted-foreground hover:text-foreground group flex w-full cursor-pointer items-center gap-1 text-xs font-medium tracking-wide uppercase">
        <ChevronRight className="size-3.5 transition-transform group-data-[state=open]:rotate-90" />
        {title}
        <span className="font-normal">（{table.rows.length}）</span>
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-1 flex flex-col gap-0.5 pl-4.5">
        {table.rows.map((row, index) => (
          <div key={index} className="flex items-baseline gap-3">
            <span className="min-w-0 flex-1 text-xs wrap-anywhere">{row[nameColumn]}</span>
            <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
              {row[tokenColumn >= 0 ? tokenColumn : row.length - 1]}
            </span>
          </div>
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
}

function formatShare(percent: number): string {
  return percent > 0 && percent < 0.1 ? "<0.1%" : `${percent.toFixed(1)}%`;
}

function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(count % 1_000_000 === 0 ? 0 : 1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
  return String(count);
}
