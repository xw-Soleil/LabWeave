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

vi.mock("@/core/service/Settings", () => ({ Settings: {} }));
vi.mock("@/sub/SettingsWindow", () => ({ default: { open: vi.fn() } }));
vi.mock("@/sub/SettingsWindow/settings", () => ({ setSettingsInitialPage: vi.fn() }));
vi.mock("streamdown", () => ({ Streamdown: () => null }));
import { LocalAgentNotice } from "./AIWindowLocalAgent";

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

async function show(status: LocalAgentStatus, language = "zh_CN") {
  const i18n = createInstance();
  const locale = parse(readFileSync(path.resolve(`app/src/locales/${language}.yml`), "utf8"));
  await i18n.init({ lng: language, resources: { [language]: { research: locale.research } } });
  await act(async () =>
    root.render(
      <I18nextProvider i18n={i18n}>
        <LocalAgentNotice status={status} agent={undefined} agentId="Claude Code" missing={false} onRetry={vi.fn()} />
      </I18nextProvider>,
    ),
  );
}

describe("local agent restoration notice", () => {
  it.each(["zh_CN", "en"])("shows the fallback, reason and old ID in %s", async (language) => {
    await show(
      {
        kind: "ready",
        whiteboardTools: true,
        recovery: {
          previousSessionId: "original-id",
          cwd: "C:\\Research\\项目",
          reason: "load-failed",
          detail: "Cannot read <transcript>",
        },
      },
      language,
    );
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(container.textContent).toContain(
      language === "zh_CN" ? "没接上上次的对话" : "The previous conversation was not restored",
    );
    expect(container.textContent).toContain(language === "zh_CN" ? "新开对话" : "A new conversation");
    expect(container.textContent).toContain("Cannot read <transcript>");
    expect(container.querySelector("transcript")).toBeNull();
    await act(async () => container.querySelector("button")!.click());
    expect(container.textContent).toContain("original-id");
    expect(container.textContent).toContain("C:\\Research\\项目");
  });

  it("explains unsupported restore and also retains the no-tools notice", async () => {
    await show({
      kind: "ready",
      whiteboardTools: false,
      recovery: {
        previousSessionId: "original",
        cwd: "/research",
        reason: "unsupported",
        detail: "",
      },
    });
    expect(container.textContent).toContain("没有声明支持载入已有会话");
    expect(container.textContent).toContain("还不能让 Claude Code 直接读改白板");
  });

  it("does not claim failure for a successfully restored or fresh conversation", async () => {
    await show({ kind: "ready", whiteboardTools: true });
    expect(container.textContent).toBe("");
  });
});
