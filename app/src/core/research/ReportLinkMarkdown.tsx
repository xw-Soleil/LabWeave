import { Dialog } from "@/components/ui/dialog";
import { open } from "@tauri-apps/plugin-shell";
import i18next from "i18next";
import type { ComponentProps } from "react";
import { toast } from "sonner";
import { defaultRehypePlugins } from "streamdown";
import { followReportLink } from "./ReportLinks";

/*
 * AI 面板里的回答会带指到卡片、批注、笔记的 rwb:// 链接（工具返回的 link），要能点了就跳。
 * 面板渲染 Markdown 用的 Streamdown 默认只认 http 这类协议，rwb:// 会被整个去掉、显示成「[blocked]」，
 * 所以这里放行这个协议，并换掉链接的部件：rwb:// 在程序里跳，网页链接问一句再用系统浏览器打开。
 */

const [sanitize, schema] = defaultRehypePlugins.sanitize as unknown as [
  unknown,
  { protocols?: Record<string, string[]> },
];

/** 给 Streamdown 的 rehypePlugins：和默认的一样，只是链接多认一个 rwb 协议 */
export const reportLinkRehypePlugins = [
  defaultRehypePlugins.raw,
  [sanitize, { ...schema, protocols: { ...schema.protocols, href: [...(schema.protocols?.href ?? []), "rwb"] } }],
  defaultRehypePlugins.harden,
] as NonNullable<ComponentProps<typeof import("streamdown").Streamdown>["rehypePlugins"]>;

/** 给 Streamdown 的 components.a */
export function ReportLinkAnchor({ href, children }: ComponentProps<"a">) {
  const follow = async () => {
    if (!href || (await followReportLink(href))) return;
    if (!/^(?:https?|mailto):/i.test(href)) return;
    // AI 写出来的网址先让人看一眼再开
    if (await Dialog.confirm(i18next.t("ai.link.confirm", { ns: "research" }), href)) await open(href);
  };
  return (
    <button
      type="button"
      className="text-primary cursor-pointer appearance-none text-left font-medium break-words underline"
      onClick={() => void follow().catch((error) => toast.error(String(error)))}
    >
      {children}
    </button>
  );
}
