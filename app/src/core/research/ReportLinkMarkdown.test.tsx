// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { Streamdown } from "streamdown";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  follow: vi.fn(async (url: string) => url.startsWith("rwb:")),
  confirm: vi.fn(async () => true),
  open: vi.fn(async () => {}),
}));
vi.mock("./ReportLinks", () => ({ followReportLink: mocks.follow }));
vi.mock("@/components/ui/dialog", () => ({ Dialog: { confirm: mocks.confirm } }));
vi.mock("@tauri-apps/plugin-shell", () => ({ open: mocks.open }));
vi.mock("i18next", () => ({ default: { t: (key: string) => key } }));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

import { ReportLinkAnchor, reportLinkRehypePlugins } from "./ReportLinkMarkdown";

const source = "[卡片：边界条件](rwb://open?project=课题&path=白板.prg&target=c1) 和 [网页](https://example.com/x)";

async function show(node: React.ReactNode): Promise<HTMLElement> {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement("div");
  document.body.append(host);
  await act(async () => {
    createRoot(host).render(node);
    await new Promise((resolve) => setTimeout(resolve, 100));
  });
  return host;
}

beforeEach(() => vi.clearAllMocks());

describe("AI 回答里的链接", () => {
  it("不放行时 rwb:// 会被去掉、显示成 [blocked]——这就是要加这一层的原因", async () => {
    const host = await show(<Streamdown>{source}</Streamdown>);
    expect(host.textContent).toContain("[blocked]");
  });

  it("放行以后：rwb:// 点了在程序里跳，网页链接问一句再用系统浏览器打开", async () => {
    const host = await show(
      <Streamdown rehypePlugins={reportLinkRehypePlugins} components={{ a: ReportLinkAnchor as never }}>
        {source}
      </Streamdown>,
    );
    expect(host.textContent).not.toContain("[blocked]");
    const [card, web] = [...host.querySelectorAll("button")];
    expect(card.textContent).toBe("卡片：边界条件");

    await act(async () => card.click());
    expect(mocks.follow).toHaveBeenLastCalledWith(
      "rwb://open?project=%E8%AF%BE%E9%A2%98&path=%E7%99%BD%E6%9D%BF.prg&target=c1",
    );
    expect(mocks.open).not.toHaveBeenCalled();

    await act(async () => web.click());
    expect(mocks.confirm).toHaveBeenCalledWith("ai.link.confirm", "https://example.com/x");
    expect(mocks.open).toHaveBeenCalledWith("https://example.com/x");

    mocks.confirm.mockResolvedValueOnce(false);
    await act(async () => web.click());
    expect(mocks.open).toHaveBeenCalledTimes(1);
  });
});
