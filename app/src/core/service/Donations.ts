import { isResearchShell } from "@/core/research/ResearchShell";
import { fetch } from "@tauri-apps/plugin-http";
import { accountServiceBaseUrl } from "./AuthClient";

export interface DonationData {
  user: string;
  note?: string;
  amount: number;
  currency?: string;
}

export async function fetchDonations(signal?: AbortSignal): Promise<DonationData[]> {
  // 科研工作台不联网：没有账号服务地址，不去拉上游的支持者名单。
  if (isResearchShell()) return [];
  const response = await fetch(`${accountServiceBaseUrl}/api/donations`, { signal });
  if (!response.ok) throw new Error(`支持者名单请求失败（HTTP ${response.status}）`);
  const data: unknown = await response.json();
  if (
    !Array.isArray(data) ||
    !data.every(
      (item) =>
        item !== null &&
        typeof item === "object" &&
        typeof item.user === "string" &&
        typeof item.amount === "number" &&
        Number.isFinite(item.amount) &&
        (item.note === undefined || typeof item.note === "string") &&
        (item.currency === undefined || typeof item.currency === "string"),
    )
  )
    throw new Error("支持者名单格式异常，请稍后重试");
  return data;
}
