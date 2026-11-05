import type { ClientToServerMessage, ServerToClientMessage } from "./CollabProtocol";

export type CollabTransportHandlers = {
  onMessage: (msg: ServerToClientMessage) => void;
  onOpen?: () => void;
  onClose?: () => void;
  onError?: (error: Event) => void;
};

/**
 * 协作服务地址。科研工作台只在本机工作：返回空地址，所有协作请求都会在发出前报错。
 */
export function resolveCollabHttpBase(): string {
  return "";
}

export function resolveCollabWsUrl(token: string): string {
  const httpBase = resolveCollabHttpBase();
  if (!httpBase) throw new Error("COLLAB_BASE_URL_MISSING");
  const url = new URL(httpBase);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/ws";
  url.search = "";
  url.searchParams.set("token", token);
  return url.toString();
}

/** 心跳间隔：需明显小于服务端 60s 超时 */
const HEARTBEAT_INTERVAL_MS = 20_000;

export class CollabTransport {
  private ws: WebSocket | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  get connected() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  connect(token: string, handlers: CollabTransportHandlers) {
    this.disconnect();
    const url = resolveCollabWsUrl(token);
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.onopen = () => {
      this.send({ type: "auth", token });
      // 立即发一次心跳，再按固定间隔持续发送
      this.send({ type: "ping" });
      this.pingTimer = setInterval(() => {
        this.send({ type: "ping" });
      }, HEARTBEAT_INTERVAL_MS);
      handlers.onOpen?.();
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(String(event.data)) as ServerToClientMessage;
        handlers.onMessage(msg);
      } catch {
        /* ignore */
      }
    };

    ws.onerror = (event) => {
      handlers.onError?.(event);
    };

    ws.onclose = () => {
      if (this.pingTimer) {
        clearInterval(this.pingTimer);
        this.pingTimer = null;
      }
      handlers.onClose?.();
    };
  }

  send(msg: ClientToServerMessage) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  disconnect() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onerror = null;
      this.ws.onclose = null;
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.close();
      }
      this.ws = null;
    }
  }
}
