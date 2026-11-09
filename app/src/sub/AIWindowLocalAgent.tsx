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
import { openLocalAgentTerminal, type LocalAgentInfo } from "@/core/service/dataManageService/aiEngine/LocalAgent";
import type {
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
  LogIn,
  ShieldAlert,
  ShieldCheck,
  ShieldQuestion,
} from "lucide-react";
import { useEffect, useState } from "react";
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
