export interface DonationData {
  user: string;
  note?: string;
  amount: number;
  currency?: string;
}

/** 科研工作台不联网：没有账号服务地址，不去拉上游的支持者名单 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function fetchDonations(_signal?: AbortSignal): Promise<DonationData[]> {
  return [];
}
