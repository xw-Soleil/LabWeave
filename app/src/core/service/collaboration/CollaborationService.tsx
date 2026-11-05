import { Project, service } from "@/core/Project";
import type { Service } from "@/core/interfaces/Service";
import { Vector } from "@graphif/data-structures";
import { deserialize, serialize } from "@graphif/serializer";
import { toast } from "sonner";
import { uploadCollabAttachment } from "./CollabApi";
import type { CollabMember, CollabPresence, CollabRole } from "./CollabProtocol";
import { CollabTransport } from "./CollabTransport";
import {
  cloneStageMap,
  diffStageMap,
  emptyStageMap,
  stageArrayToMap,
  stageMapToArray,
  type StageMapDoc,
} from "./stageMap";

export type CollaborationStatus = "idle" | "connecting" | "synced" | "disconnected" | "error";

export type CollabStateSnapshot = {
  status: CollaborationStatus;
  roomId: string | null;
  inviteCode: string | null;
  version: number;
  role: CollabRole | null;
  /** 账号级成员（权限） */
  members: CollabMember[];
  /** 连接级在线列表（同用户多端各一条） */
  presences: CollabPresence[];
  userId: string | null;
  sessionId: string | null;
};

export type RemoteCursor = {
  sessionId: string;
  x: number;
  y: number;
};

export type RemoteCursorChat = RemoteCursor & {
  text: string;
};

const NO_COLLAB_MESSAGE = "科研工作台只在本机工作，不支持多人协作。";
const CURSOR_SEND_INTERVAL_MS = 33;
const CURSOR_CHAT_TIMEOUT_MS = 5_000;

@service("collaboration")
export class CollaborationService implements Service {
  private transport = new CollabTransport();
  private roomId: string | null = null;
  private inviteCode: string | null = null;
  private version = 0;
  private ackMap: StageMapDoc = emptyStageMap();
  private applyingRemote = false;
  private role: CollabRole | null = null;
  private members: CollabMember[] = [];
  private presences: CollabPresence[] = [];
  private status: CollaborationStatus = "idle";
  private inFlightOpId: string | null = null;
  private dirty = false;
  private userId: string | null = null;
  private sessionId: string | null = null;
  private readonly remoteCursors = new Map<string, RemoteCursor>();
  private readonly remoteCursorChats = new Map<string, RemoteCursorChat>();
  private lastCursorSentAt = 0;
  private lastLocalCursor: RemoteCursor | null = null;
  private cursorChatInput: HTMLInputElement | null = null;
  private cursorChatTimeout: ReturnType<typeof setTimeout> | null = null;
  private sessionToken: string | null = null;
  private attachmentSync: Promise<void> = Promise.resolve();
  private readonly syncedAttachments = new Map<string, Blob>();

  constructor(private readonly project: Project) {
    this.project.on("stage-commit", () => {
      void this.onLocalCommit();
    });
    this.project.on("attachment-add", () => {
      if (!this.isActive) return;
      void this.queueAttachmentSync().catch((error) => {
        toast.error(`上传附件失败：${error instanceof Error ? error.message : String(error)}`);
      });
    });
    this.project.canvas.element.addEventListener("pointermove", this.handlePointerMove);
    this.project.canvas.element.addEventListener("pointerleave", this.handlePointerLeave);
  }

  get isActive() {
    return this.roomId !== null && this.status !== "idle";
  }

  get currentRoomId() {
    return this.roomId;
  }

  get currentInviteCode() {
    return this.inviteCode;
  }

  get currentRole() {
    return this.role;
  }

  get currentMembers() {
    return this.members;
  }

  get currentPresences() {
    return this.presences;
  }

  get currentStatus() {
    return this.status;
  }

  get currentVersion() {
    return this.version;
  }

  get currentUserId() {
    return this.userId;
  }

  get currentSessionId() {
    return this.sessionId;
  }

  getRemoteCursors(): RemoteCursor[] {
    return [...this.remoteCursors.values()];
  }

  getRemoteCursorChats(): RemoteCursorChat[] {
    return [...this.remoteCursorChats.values()];
  }

  openCursorChat() {
    if (!this.isActive || !this.transport.connected || this.cursorChatInput) return;
    const location = this.lastLocalCursor ?? this.project.renderer.transformView2World(new Vector(0, 0));
    const input = document.createElement("input");
    input.type = "text";
    input.maxLength = 200;
    input.placeholder = "说点什么...";
    input.setAttribute("aria-label", "协作光标聊天");
    Object.assign(input.style, {
      position: "fixed",
      zIndex: "60",
      width: "180px",
      height: "28px",
      padding: "0 8px",
      border: "2px solid currentColor",
      borderRadius: "4px",
      color: this.selfPresence?.color ?? "#3b82f6",
      background: "var(--background)",
      outline: "none",
      fontSize: "12px",
    });
    document.body.append(input);
    this.cursorChatInput = input;
    this.positionCursorChatInput(location);
    input.addEventListener("input", this.handleCursorChatInput);
    input.addEventListener("keydown", this.handleCursorChatKeydown);
    this.sendCursorChat(input.value, location);
    this.resetCursorChatTimeout();
    requestAnimationFrame(() => input.focus());
  }

  get canEdit() {
    return this.role === "owner" || this.role === "editor";
  }

  getState(): CollabStateSnapshot {
    return {
      status: this.status,
      roomId: this.roomId,
      inviteCode: this.inviteCode,
      version: this.version,
      role: this.role,
      members: [...this.members],
      presences: [...this.presences],
      userId: this.userId,
      sessionId: this.sessionId,
    };
  }

  private emitState() {
    this.project.emit("collab-state", this.getState());
  }

  private setStatus(status: CollaborationStatus) {
    this.status = status;
    this.project.emit("collab-status", status);
    this.emitState();
  }

  private snapshotMap(): StageMapDoc {
    return stageArrayToMap(serialize(this.project.stage) as unknown[]);
  }

  private async syncAttachments() {
    if (!this.roomId || !this.sessionToken) return;
    const pending = [...this.project.attachments.entries()].filter(
      ([id, blob]) => this.syncedAttachments.get(id) !== blob,
    );
    await Promise.all(
      pending.map(async ([attachmentId, blob]) => {
        await uploadCollabAttachment(this.sessionToken!, this.roomId!, attachmentId, blob);
        this.syncedAttachments.set(attachmentId, blob);
      }),
    );
  }

  private queueAttachmentSync(): Promise<void> {
    const next = this.attachmentSync.then(() => this.syncAttachments());
    this.attachmentSync = next.catch(() => undefined);
    return next;
  }

  private applyStageMap(doc: StageMapDoc, tags?: string[], references?: Project["references"]) {
    this.applyingRemote = true;
    try {
      const array = stageMapToArray(doc);
      this.project.stage = deserialize(structuredClone(array), this.project);
      if (tags) this.project.tags = tags;
      if (references) this.project.references = references;
      this.project.stageManager.updateReferences();
      this.project.historyManager.clearHistory();
      this.ackMap = cloneStageMap(doc);
    } finally {
      this.applyingRemote = false;
    }
  }

  async createRoom(): Promise<{ roomId: string; inviteCode: string }> {
    throw new Error(NO_COLLAB_MESSAGE);
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async joinRoom(_inviteCode: string): Promise<void> {
    throw new Error(NO_COLLAB_MESSAGE);
  }

  private async onLocalCommit() {
    if (!this.isActive || this.applyingRemote) return;
    if (!this.canEdit) {
      toast.error("当前为只读权限，无法编辑");
      this.applyStageMap(this.ackMap);
      return;
    }
    if (!this.transport.connected) {
      this.setStatus("disconnected");
      return;
    }

    this.dirty = true;
    try {
      await this.queueAttachmentSync();
    } catch (error) {
      this.setStatus("error");
      toast.error(`上传附件失败：${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    this.flushIfDirty();
  }

  private readonly handlePointerMove = (event: PointerEvent) => {
    if (!this.isActive || !this.transport.connected) return;
    const now = performance.now();
    if (now - this.lastCursorSentAt < CURSOR_SEND_INTERVAL_MS) return;
    this.lastCursorSentAt = now;
    const viewLocation = this.project.canvas.clientToView(event.clientX, event.clientY);
    const worldLocation = this.project.renderer.transformView2World(viewLocation);
    this.lastLocalCursor = { sessionId: this.sessionId ?? "", x: worldLocation.x, y: worldLocation.y };
    this.transport.send({ type: "cursor", x: worldLocation.x, y: worldLocation.y });
    if (this.cursorChatInput) {
      this.positionCursorChatInput(this.lastLocalCursor);
      this.sendCursorChat(this.cursorChatInput.value, this.lastLocalCursor);
    }
  };

  private readonly handlePointerLeave = () => {
    if (this.isActive && this.transport.connected) this.transport.send({ type: "cursor", x: null, y: null });
  };

  private get selfPresence() {
    return this.presences.find((presence) => presence.sessionId === this.sessionId);
  }

  private readonly handleCursorChatInput = () => {
    if (!this.cursorChatInput || !this.lastLocalCursor) return;
    this.sendCursorChat(this.cursorChatInput.value, this.lastLocalCursor);
    this.resetCursorChatTimeout();
  };

  private readonly handleCursorChatKeydown = (event: KeyboardEvent) => {
    if (event.key === "Escape" || event.key === "Enter") {
      event.preventDefault();
      this.closeCursorChat();
    }
  };

  private positionCursorChatInput(location: Pick<RemoteCursor, "x" | "y">) {
    if (!this.cursorChatInput) return;
    const clientLocation = this.project.canvas.viewToClient(
      this.project.renderer.transformWorld2View(new Vector(location.x, location.y)),
    );
    this.cursorChatInput.style.left = `${clientLocation.x + 14}px`;
    this.cursorChatInput.style.top = `${clientLocation.y + 14}px`;
  }

  private sendCursorChat(text: string, location: Pick<RemoteCursor, "x" | "y">) {
    this.transport.send({ type: "cursor_chat", x: location.x, y: location.y, text });
  }

  private resetCursorChatTimeout() {
    if (this.cursorChatTimeout) clearTimeout(this.cursorChatTimeout);
    this.cursorChatTimeout = setTimeout(() => this.closeCursorChat(), CURSOR_CHAT_TIMEOUT_MS);
  }

  private closeCursorChat() {
    if (this.cursorChatTimeout) clearTimeout(this.cursorChatTimeout);
    this.cursorChatTimeout = null;
    const input = this.cursorChatInput;
    this.cursorChatInput = null;
    input?.remove();
    this.transport.send({ type: "cursor_chat", x: null, y: null, text: "" });
  }

  private flushIfDirty() {
    if (!this.dirty || this.inFlightOpId || !this.transport.connected || !this.isActive) return;
    const nextMap = this.snapshotMap();
    const delta = diffStageMap(this.ackMap, nextMap);
    if (!delta) {
      this.dirty = false;
      return;
    }
    const opId = crypto.randomUUID();
    this.inFlightOpId = opId;
    this.dirty = false;
    this.transport.send({
      type: "op",
      baseVersion: this.version,
      delta,
      opId,
    });
  }

  leave() {
    this.transport.disconnect();
    this.roomId = null;
    this.inviteCode = null;
    this.role = null;
    this.members = [];
    this.presences = [];
    this.remoteCursors.clear();
    this.remoteCursorChats.clear();
    this.lastLocalCursor = null;
    this.closeCursorChat();
    this.inFlightOpId = null;
    this.dirty = false;
    this.version = 0;
    this.userId = null;
    this.sessionId = null;
    this.sessionToken = null;
    this.syncedAttachments.clear();
    this.ackMap = emptyStageMap();
    this.setStatus("idle");
  }

  dispose() {
    this.leave();
    this.project.canvas.element.removeEventListener("pointermove", this.handlePointerMove);
    this.project.canvas.element.removeEventListener("pointerleave", this.handlePointerLeave);
  }
}
