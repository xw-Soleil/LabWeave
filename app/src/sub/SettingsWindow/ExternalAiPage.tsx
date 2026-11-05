import { Button } from "@/components/ui/button";
import { invoke } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { buildExternalAiMcpCommands, type ExternalAiMcpLaunch } from "./externalAiCommands";

/** 设置 → AI → 连接外部 AI：给出配好路径、能直接复制的命令 */
export default function ExternalAiPage() {
  const { t } = useTranslation("research");
  const [launch, setLaunch] = useState<ExternalAiMcpLaunch | null>(null);

  useEffect(() => {
    invoke<ExternalAiMcpLaunch>("external_ai_mcp_launch")
      .then(setLaunch)
      .catch(() => setLaunch({ node: null, script: null, appHome: null }));
  }, []);

  if (!launch) return null;
  const commands = buildExternalAiMcpCommands(launch);

  return (
    <div className="flex max-w-[640px] flex-col gap-4 text-[13px] leading-relaxed">
      <p>{t("settings.externalAi.intro")}</p>
      <p className="text-muted-foreground">{t("settings.externalAi.live")}</p>
      {!commands ? (
        <p className="text-muted-foreground">{t("settings.externalAi.unavailable")}</p>
      ) : (
        <>
          {!launch.node && <p className="text-destructive">{t("settings.externalAi.noNode")}</p>}
          <CommandBlock title={t("settings.externalAi.claudeCode")} text={commands.claudeCode} />
          <CommandBlock title={t("settings.externalAi.codex")} text={commands.codex} />
          <CommandBlock
            title={t("settings.externalAi.others")}
            hint={t("settings.externalAi.othersHint")}
            text={commands.json}
          />
          {launch.appHome && (
            <p className="text-muted-foreground">{t("settings.externalAi.appHomeNote", { home: launch.appHome })}</p>
          )}
        </>
      )}
    </div>
  );
}

function CommandBlock({ title, hint, text }: { title: string; hint?: string; text: string }) {
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
    <section className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">{title}</span>
        <Button variant="outline" size="sm" className="h-7 text-[13px]" onClick={copy}>
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          {copied ? t("settings.externalAi.copied") : t("settings.externalAi.copy")}
        </Button>
      </div>
      {hint && <span className="text-muted-foreground">{hint}</span>}
      <pre className="bg-muted text-foreground rounded-md p-2.5 font-mono text-[12px] break-all whitespace-pre-wrap select-text">
        {text}
      </pre>
    </section>
  );
}
