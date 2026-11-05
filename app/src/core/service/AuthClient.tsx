import { fetch } from "@tauri-apps/plugin-http";
import { createAuthClient } from "better-auth/client";

// 科研工作台只在本机工作：没有账号服务，也就不会连 hub.graphif.dev。
export const accountServiceBaseUrl: string = "";

// better-auth 要求绝对 URL，地址不合法（包括为空）时不创建客户端，模块加载不能同步抛错。
function isValidHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export const authClient = isValidHttpUrl(accountServiceBaseUrl)
  ? createAuthClient({
      baseURL: `${accountServiceBaseUrl}/api/auth`,
      plugins: [],
      fetchOptions: {
        customFetchImpl: fetch,
      },
    })
  : null;
