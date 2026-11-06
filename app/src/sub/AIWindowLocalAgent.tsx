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
  LocalAgentStatus,
  LocalAgentTransport,
} from "@/core/service/dataManageService/aiEngine/LocalAgentTransport";
import { Settings } from "@/core/service/Settings";
import SettingsWindow from "@/sub/SettingsWindow";
import { setSettingsInitialPage, type SettingsSubPageId } from "@/sub/SettingsWindow/settings";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@radix-ui/react-collapsible";
import { AlertCircle, ChevronDown, ChevronRight, Info, LogIn, ShieldQuestion } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

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

/** 「每次询问」档下 AI 程序要写文件、跑命令时的确认卡片，样子和 API 方式的工具审批一致 */
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
  // 拒绝放左边、允许放右边，和 API 方式的审批按钮同一个顺序
  const options = [
    ...request.options.filter((option) => isReject(option.kind)),
    ...request.options.filter((option) => !isReject(option.kind)),
  ];

  return (
    <div className="flex justify-start gap-2">
      <div className="w-7 shrink-0" />
      <div className="bg-card border-border/70 flex max-w-[88%] min-w-0 flex-col gap-2 rounded-2xl rounded-bl-md border px-3 py-2 text-sm shadow-sm">
        <div className="text-muted-foreground flex items-center gap-1.5 text-xs">
          <ShieldQuestion className="size-3.5" />
          {t("ai.localAgent.permissionTitle", { name: agentName })}
        </div>
        <div className="font-medium wrap-anywhere select-text">{request.title}</div>
        {request.rawInput !== undefined && (
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
        )}
        <div className="flex flex-wrap justify-end gap-2">
          {options.map((option) => (
            <Button
              key={option.optionId}
              size="sm"
              className="h-7 px-2"
              variant={isReject(option.kind) ? "outline" : "default"}
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
    </div>
  );
}

function toastError(error: unknown) {
  toast.error(String(error));
}
