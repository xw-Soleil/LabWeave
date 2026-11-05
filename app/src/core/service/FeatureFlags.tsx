import { authClient } from "./AuthClient";

// 云服务一律关闭：没有账号服务，AI 云功能和遥测也不开
export namespace FeatureFlags {
  /**
   * 用户登录、注册以及所有和云服务有关的功能
   */
  export const USER = authClient !== null;
  /**
   * AI扩展节点等所有和AI有关的功能
   */
  export const AI: boolean = false;
  export const TELEMETRY: boolean = false;
}
