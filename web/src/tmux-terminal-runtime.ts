import { isMobileApp, mobileStreamUrl, MOBILE_RESUME_EVENT } from "./mobile-runtime.js";

const RELEASE_GRACE_MS = 1_500;
const MAX_REPLAY_BYTES = 16 * 1024 * 1024;

export type TmuxTerminalTransportStatus = "CONNECTING" | "RECONNECTING" | "OFFLINE";

export type TmuxTerminalControlMessage = {
  type?: string;
  message?: string;
  requestId?: string;
  ok?: boolean;
  code?: number;
};

export type TmuxTerminalTransportEvent =
  | { type: "output"; data: string | Uint8Array; connectionId: number }
  | { type: "control"; message: TmuxTerminalControlMessage; everAttached: boolean }
  | { type: "status"; status: TmuxTerminalTransportStatus }
  | { type: "closed" };

export type TmuxTerminalTransportListener = (event: TmuxTerminalTransportEvent) => void;

type PathBuilder = () => string;

type RuntimeGlobal = typeof globalThis & {
  __feishuCodexBridgeTmuxTerminalTransports?: Map<string, TmuxTerminalTransport>;
};

const runtimeGlobal = globalThis as RuntimeGlobal;
const transports = runtimeGlobal.__feishuCodexBridgeTmuxTerminalTransports
  ?? (runtimeGlobal.__feishuCodexBridgeTmuxTerminalTransports = new Map());

export function getTmuxTerminalTransport(sessionId: string): TmuxTerminalTransport {
  const existing = transports.get(sessionId);
  if (existing && !existing.isDisposed()) return existing;
  const transport = new TmuxTerminalTransport(sessionId);
  transports.set(sessionId, transport);
  return transport;
}

export class TmuxTerminalTransport {
  private readonly listeners = new Set<TmuxTerminalTransportListener>();
  private socket: WebSocket | null = null;
  private connectionPending = false;
  private connectionGeneration = 0;
  private reconnectTimer = 0;
  private reconnectAttempt = 0;
  private releaseTimer = 0;
  private connectionId = 0;
  private everAttached = false;
  private disposed = false;
  private pathBuilder: PathBuilder | null = null;
  private replayChunks: Array<string | Uint8Array> = [];
  private replayBytes = 0;
  private replayComplete = true;

  public constructor(private readonly sessionId: string) {
    window.addEventListener("online", this.reconnectNow);
    window.addEventListener("offline", this.markOffline);
    document.addEventListener("visibilitychange", this.onVisibilityChange);
    window.addEventListener(MOBILE_RESUME_EVENT, this.forceReconnect);
  }

  public isDisposed(): boolean { return this.disposed; }

  public isOpen(): boolean { return this.socket?.readyState === WebSocket.OPEN; }

  public setPathBuilder(pathBuilder: PathBuilder): void {
    this.pathBuilder = pathBuilder;
  }

  public subscribe(listener: TmuxTerminalTransportListener): () => void {
    if (this.disposed) return () => {};
    window.clearTimeout(this.releaseTimer);
    this.releaseTimer = 0;
    this.listeners.add(listener);
    if (!this.replayComplete) {
      this.forceReconnect();
    } else {
      for (const chunk of this.replayChunks) listener({ type: "output", data: chunk, connectionId: this.connectionId });
    }
    this.connect();
    return () => {
      this.listeners.delete(listener);
      this.scheduleRelease();
    };
  }

  public send(payload: unknown): boolean {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
    try {
      this.socket.send(typeof payload === "string" ? payload : JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  }

  public forceReconnect = (): void => {
    if (this.disposed) return;
    window.clearTimeout(this.releaseTimer);
    this.releaseTimer = 0;
    window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = 0;
    this.connectionGeneration += 1;
    this.connectionPending = false;
    const previousSocket = this.socket;
    this.socket = null;
    if (previousSocket && previousSocket.readyState < WebSocket.CLOSING) previousSocket.close(1000, "client reconnect");
    this.emit({ type: "closed" });
    if (this.listeners.size > 0) this.connect();
  };

  public release(): void {
    this.scheduleRelease();
  }

  private scheduleRelease(): void {
    if (this.listeners.size > 0 || this.releaseTimer || this.disposed) return;
    this.releaseTimer = window.setTimeout(() => {
      this.releaseTimer = 0;
      if (this.listeners.size === 0) this.closeNow();
    }, RELEASE_GRACE_MS);
  }

  private connect = (): void => {
    if (this.disposed || this.listeners.size === 0 || this.connectionPending) return;
    if (this.socket?.readyState === WebSocket.OPEN || this.socket?.readyState === WebSocket.CONNECTING) return;
    if (!this.pathBuilder) return;
    if (isMobileApp() && document.visibilityState === "hidden") return;
    if (navigator.onLine === false) {
      this.emit({ type: "status", status: "OFFLINE" });
      return;
    }
    const path = this.pathBuilder();
    const requestGeneration = ++this.connectionGeneration;
    const nextConnectionId = this.connectionId + 1;
    this.connectionPending = true;
    this.replayChunks = [];
    this.replayBytes = 0;
    this.replayComplete = true;
    this.emit({ type: "status", status: this.everAttached ? "RECONNECTING" : "CONNECTING" });
    const openSocket = (value: string): void => {
      if (this.disposed || requestGeneration !== this.connectionGeneration) return;
      this.connectionPending = false;
      if (navigator.onLine === false || (isMobileApp() && document.visibilityState === "hidden")) return;
      const address = new URL(value);
      address.protocol = address.protocol === "https:" ? "wss:" : "ws:";
      let nextSocket: WebSocket;
      try {
        nextSocket = new WebSocket(address.href);
      } catch {
        this.scheduleReconnect();
        return;
      }
      this.socket = nextSocket;
      this.connectionId = nextConnectionId;
      nextSocket.binaryType = "arraybuffer";
      nextSocket.onopen = () => {
        if (this.disposed || this.socket !== nextSocket) nextSocket.close();
        else this.reconnectAttempt = 0;
      };
      nextSocket.onmessage = (event) => {
        if (this.disposed || this.socket !== nextSocket) return;
        if (typeof event.data === "string") {
          this.handleTextMessage(event.data);
        } else if (event.data instanceof ArrayBuffer) {
          this.handleOutput(new Uint8Array(event.data));
        } else if (event.data instanceof Blob) {
          void event.data.arrayBuffer().then((output) => {
            if (!this.disposed && this.socket === nextSocket) this.handleOutput(new Uint8Array(output));
          });
        }
      };
      nextSocket.onerror = () => {
        if (!this.disposed && this.socket === nextSocket) {
          this.emit({ type: "status", status: this.everAttached ? "RECONNECTING" : "CONNECTING" });
        }
      };
      nextSocket.onclose = () => {
        if (this.socket === nextSocket) this.socket = null;
        this.emit({ type: "closed" });
        if (!this.disposed) this.scheduleReconnect();
      };
    };
    if (isMobileApp()) {
      void mobileStreamUrl(path).then(openSocket).catch(() => {
        if (this.disposed || requestGeneration !== this.connectionGeneration) return;
        this.connectionPending = false;
        this.scheduleReconnect();
      });
    } else {
      openSocket(new URL(path, window.location.origin).href);
    }
  };

  private handleTextMessage(data: string): void {
    try {
      const message = JSON.parse(data) as TmuxTerminalControlMessage;
      if (message.type === "submission-result" || message.type === "error" || message.type === "input-error" || message.type === "exit") {
        this.emit({ type: "control", message, everAttached: this.everAttached });
        return;
      }
    } catch {
      this.handleOutput(data);
      return;
    }
    this.handleOutput(data);
  }

  private handleOutput(data: string | Uint8Array): void {
    const replayData = typeof data === "string" ? data : data.slice();
    const bytes = typeof replayData === "string" ? new TextEncoder().encode(replayData).byteLength : replayData.byteLength;
    if (this.replayComplete) {
      if (this.replayBytes + bytes > MAX_REPLAY_BYTES) {
        this.replayChunks = [];
        this.replayBytes = 0;
        this.replayComplete = false;
      } else {
        this.replayChunks.push(replayData);
        this.replayBytes += bytes;
      }
    }
    this.everAttached = true;
    this.emit({ type: "output", data, connectionId: this.connectionId });
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.listeners.size === 0 || this.reconnectTimer || navigator.onLine === false) return;
    const delay = Math.min(1_000 * 2 ** Math.min(this.reconnectAttempt, 4), 15_000);
    this.reconnectAttempt += 1;
    this.emit({ type: "status", status: this.everAttached ? "RECONNECTING" : "CONNECTING" });
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = 0;
      this.connect();
    }, delay);
  }

  private reconnectNow = (): void => {
    if (this.disposed || document.visibilityState === "hidden") return;
    window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = 0;
    this.connect();
  };

  private markOffline = (): void => {
    if (this.disposed) return;
    this.emit({ type: "status", status: "OFFLINE" });
    window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = 0;
    const previousSocket = this.socket;
    this.socket = null;
    if (previousSocket && previousSocket.readyState < WebSocket.CLOSING) previousSocket.close();
  };

  private onVisibilityChange = (): void => {
    if (isMobileApp() && document.visibilityState === "hidden") {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = 0;
      const previousSocket = this.socket;
      this.socket = null;
      if (previousSocket && previousSocket.readyState < WebSocket.CLOSING) previousSocket.close(1000, "page hidden");
    } else {
      this.reconnectNow();
    }
  };

  private emit(event: TmuxTerminalTransportEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private closeNow(): void {
    if (this.disposed) return;
    this.disposed = true;
    window.clearTimeout(this.reconnectTimer);
    window.clearTimeout(this.releaseTimer);
    window.removeEventListener("online", this.reconnectNow);
    window.removeEventListener("offline", this.markOffline);
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
    window.removeEventListener(MOBILE_RESUME_EVENT, this.forceReconnect);
    const previousSocket = this.socket;
    this.socket = null;
    if (previousSocket && previousSocket.readyState < WebSocket.CLOSING) previousSocket.close(1000, "client released");
    if (transports.get(this.sessionId) === this) transports.delete(this.sessionId);
  }
}
