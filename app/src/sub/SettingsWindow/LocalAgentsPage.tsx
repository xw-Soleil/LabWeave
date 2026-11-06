import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  getLocalAgentCatalog,
  openLocalAgentTerminal,
  type LocalAgentInfo,
  type LocalAgentTerminalAction,
} from "@/core/service/dataManageService/aiEngine/LocalAgent";
import { Settings } from "@/core/service/Settings";
import { cn } from "@/utils/cn";
import { open } from "@tauri-apps/plugin-dialog";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Check, Copy, FolderOpen, LogIn, RotateCcw, SquareTerminal } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

/** 本机装了哪些 AI 程序。用户在终端里装完切回来时重新找一遍 */
export function useLocalAgentCatalog(): [LocalAgentInfo[] | null, () => void] {
  const [catalog, setCatalog] = useState<LocalAgentInfo[] | null>(null);
  const refresh = useCallback(() => {
    getLocalAgentCatalog().then(setCatalog, (error) => {
      setCatalog([]);
      toast.error(String(error));
    });
  }, []);
  useEffect(() => {
    refresh();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [refresh]);
  return [catalog, refresh];
}

/** 设置 → AI → 本机 AI 程序：每个程序找没找到、怎么装、怎么登录 */
export default function LocalAgentsPage() {
  const { t } = useTranslation("research");
  const [catalog] = useLocalAgentCatalog();

  if (!catalog) return null;
  return (
    <div className="flex max-w-[640px] flex-col gap-4 text-[13px] leading-relaxed">
      <p>{t("settings.localAgents.intro")}</p>
      <p className="text-muted-foreground">{t("settings.localAgents.adapterNote")}</p>
      <ul className="flex flex-col gap-2">
        {catalog.map((agent) => (
          <AgentRow key={agent.id} agent={agent} />
        ))}
      </ul>
    </div>
  );
}

function AgentRow({ agent }: { agent: LocalAgentInfo }) {
  const { t } = useTranslation("research");
  const [paths] = Settings.use("aiLocalAgentPaths");
  const customPath = paths[agent.id];
  const path = customPath ?? agent.resolvedPath;
  const state = path ? "found" : agent.hostFound ? "noAdapter" : "missing";

  const runInTerminal = (action: LocalAgentTerminalAction) =>
    openLocalAgentTerminal(agent.id, action).catch((error) => toast.error(String(error)));

  const choosePath = async () => {
    const picked = await open({ directory: false, multiple: false, title: t("settings.localAgents.choosePath") });
    if (typeof picked === "string") Settings.aiLocalAgentPaths = { ...paths, [agent.id]: picked };
  };
  const clearPath = () => {
    const rest = { ...paths };
    delete rest[agent.id];
    Settings.aiLocalAgentPaths = rest;
  };

  return (
    <li className="border-border flex flex-col gap-2 rounded-md border p-3">
      <div className="flex items-center gap-2">
        <span className="font-medium">{agent.name}</span>
        {!agent.tested && (
          <Badge variant="outline" className="text-muted-foreground font-normal">
            {t("settings.localAgents.untested")}
          </Badge>
        )}
        <span className="flex-1" />
        <span
          className={cn(
            "flex items-center gap-1.5 text-[12px]",
            state === "found" ? "text-foreground" : "text-muted-foreground",
          )}
        >
          <span
            className={cn(
              "size-1.5 rounded-full",
              state === "found" ? "bg-emerald-500" : state === "noAdapter" ? "bg-amber-500" : "bg-muted-foreground/40",
            )}
          />
          {t(`settings.localAgents.state.${customPath ? "custom" : state}`)}
        </span>
      </div>
      {path && <code className="text-muted-foreground font-mono text-[12px] break-all select-text">{path}</code>}
      {state === "noAdapter" && (
        <p className="text-muted-foreground">{t("settings.localAgents.noAdapterHint", { name: agent.name })}</p>
      )}
      {state !== "found" && !agent.installCommand && (
        <p className="text-muted-foreground">
          {t("settings.localAgents.installByHomepage")}
          <span className="font-mono text-[12px] break-all select-text">{agent.homepage}</span>
        </p>
      )}
      <div className="flex flex-wrap gap-1.5">
        {agent.installCommand && !agent.resolvedPath && (
          <>
            <Button variant="outline" size="sm" className="h-7 text-[13px]" onClick={() => runInTerminal("install")}>
              <SquareTerminal className="size-3.5" />
              {t("settings.localAgents.install")}
            </Button>
            <CopyButton text={agent.installCommand} />
          </>
        )}
        {agent.loginCommand && (path || agent.hostFound) && (
          <Button variant="outline" size="sm" className="h-7 text-[13px]" onClick={() => runInTerminal("login")}>
            <LogIn className="size-3.5" />
            {t("settings.localAgents.login")}
          </Button>
        )}
        {customPath ? (
          <Button variant="ghost" size="sm" className="h-7 text-[13px]" onClick={clearPath}>
            <RotateCcw className="size-3.5" />
            {t("settings.localAgents.clearPath")}
          </Button>
        ) : (
          <Button variant="ghost" size="sm" className="h-7 text-[13px]" onClick={() => void choosePath()}>
            <FolderOpen className="size-3.5" />
            {t("settings.localAgents.choosePath")}
          </Button>
        )}
      </div>
    </li>
  );
}

function CopyButton({ text }: { text: string }) {
  const { t } = useTranslation("research");
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (error) {
      toast.error(String(error));
    }
  };
  return (
    <Button variant="ghost" size="sm" className="h-7 text-[13px]" onClick={() => void copy()}>
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      {copied ? t("settings.localAgents.copied") : t("settings.localAgents.copyInstall")}
    </Button>
  );
}
