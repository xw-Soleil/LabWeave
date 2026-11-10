// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { createInstance } from "i18next";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { parse } from "yaml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalAgentStatus } from "@/core/service/dataManageService/aiEngine/LocalAgent";
import type { LocalAgentTransport } from "@/core/service/dataManageService/aiEngine/LocalAgentTransport";
import { toast } from "sonner";

vi.mock("@/core/service/Settings", () => ({ Settings: {} }));
vi.mock("@/sub/SettingsWindow", () => ({ default: { open: vi.fn() } }));
vi.mock("@/sub/SettingsWindow/settings", () => ({ setSettingsInitialPage: vi.fn() }));
vi.mock("streamdown", () => ({ Streamdown: () => null }));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
import { LocalAgentNotice, useLocalAgentStatus } from "./AIWindowLocalAgent";

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function show(status: LocalAgentStatus, language = "zh_CN", onAcknowledge = vi.fn(async () => {})) {
  const i18n = createInstance();
  const locale = parse(readFileSync(path.resolve(`app/src/locales/${language}.yml`), "utf8"));
  await i18n.init({ lng: language, resources: { [language]: { research: locale.research } } });
  await act(async () =>
    root.render(
      <I18nextProvider i18n={i18n}>
        <LocalAgentNotice
          status={status}
          agent={undefined}
          agentId="Claude Code"
          missing={false}
          onRetry={vi.fn()}
          onAcknowledge={onAcknowledge}
        />
      </I18nextProvider>,
    ),
  );
}

describe("local agent restoration notice", () => {
  it.each(["zh_CN", "en"])("explains recovery in %s without exposing legacy diagnostics", async (language) => {
    const acknowledge = vi.fn(async () => {});
    const legacyRecovery = {
      previousSessionId: "original-id",
      cwd: "C:\\Research\\项目",
      reason: "load-failed" as const,
      detail: '{"code":-32603,"data":{"token":"secret","stack":"internal-stack"}}',
    };
    await show(
      {
        kind: "ready",
        whiteboardTools: true,
        recovery: legacyRecovery,
      },
      language,
      acknowledge,
    );
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(container.textContent).toContain(
      language === "zh_CN" ? "没接上上次的对话" : "The previous conversation was not restored",
    );
    expect(container.textContent).toContain(language === "zh_CN" ? "新开对话" : "A new conversation");
    expect(container.textContent).toContain(language === "zh_CN" ? "未能读取" : "could not read");
    await act(async () => container.querySelector("button")!.click());
    expect(acknowledge).toHaveBeenCalledOnce();
    for (const internal of ["original-id", legacyRecovery.cwd, "-32603", "secret", "internal-stack"])
      expect(container.textContent).not.toContain(internal);
  });

  it("explains unsupported restore and also retains the no-tools notice", async () => {
    await show({
      kind: "ready",
      whiteboardTools: false,
      recovery: {
        previousSessionId: "original",
        reason: "unsupported",
      },
    });
    expect(container.textContent).toContain("没有声明支持载入已有会话");
    expect(container.textContent).toContain("还不能让 Claude Code 直接读改白板");
  });

  it("does not claim failure for a successfully restored or fresh conversation", async () => {
    await show({ kind: "ready", whiteboardTools: true });
    expect(container.textContent).toBe("");
  });

  it("reports a failed acknowledgement instead of hiding the notice", async () => {
    await show(
      { kind: "ready", whiteboardTools: true, recovery: { previousSessionId: "old", reason: "not-found" } },
      "zh_CN",
      vi.fn().mockRejectedValue(new Error("disk failed")),
    );
    await act(async () => container.querySelector("button")!.click());
    expect(toast.error).toHaveBeenCalledWith("提示未能清除，请再试一次。");
    expect(container.textContent).toContain("程序找不到上次的对话记录");
  });

  it("does not replay another chat's recovery notice while the selected chat is loading", async () => {
    const status: LocalAgentStatus = {
      kind: "ready",
      chatId: "first",
      whiteboardTools: true,
      recovery: { previousSessionId: "old", reason: "load-failed" },
    };
    const transport = {
      onStatus: (listener: (value: LocalAgentStatus) => void) => {
        listener(status);
        return () => {};
      },
    } as LocalAgentTransport;
    function Status({ chatId }: { chatId: string }) {
      return <span>{JSON.stringify(useLocalAgentStatus(transport, chatId))}</span>;
    }
    await act(async () => root.render(<Status chatId="first" />));
    expect(container.textContent).toContain("recovery");
    await act(async () => root.render(<Status chatId="second" />));
    expect(container.textContent).toBe('{"kind":"starting"}');
  });
});
