import { connect, type Socket } from "node:net";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer, type RawData } from "ws";

/** Production always connects to Screen Sharing on the Bridge host itself. */
export type RemoteDesktopConnector = () => Socket;
const defaultConnector: RemoteDesktopConnector = () => connect({ host: "127.0.0.1", port: 5900 });
const MAX_BUFFERED_BYTES = 2 * 1024 * 1024;

/** Forward binary RFB traffic without interpreting credentials or screen data. */
export class RemoteDesktopProxy {
  private readonly server = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 16 * 1024 * 1024 });
  private readonly clients = new Map<WebSocket, { socket: Socket; isAuthorized: () => boolean }>();

  constructor(private readonly connector: RemoteDesktopConnector = defaultConnector) {}

  public handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer, isAuthorized: () => boolean): void {
    this.server.handleUpgrade(request, socket, head, (client) => {
      if (!isAuthorized()) { client.close(1008, "Authorization expired"); return; }
      let upstream: Socket;
      try { upstream = this.connector(); }
      catch { client.close(1011, "Screen sharing unavailable"); return; }
      this.clients.set(client, { socket: upstream, isAuthorized });
      upstream.setNoDelay(true);
      upstream.setTimeout(10_000, () => upstream.destroy(new Error("Screen sharing connection timed out")));
      upstream.once("connect", () => upstream.setTimeout(0));

      const authorized = (): boolean => {
        if (isAuthorized()) return true;
        upstream.destroy();
        if (client.readyState === WebSocket.OPEN) client.close(1008, "Authorization expired");
        return false;
      };
      client.on("message", (data: RawData, binary: boolean) => {
        if (!authorized()) return;
        if (!binary) { client.close(1003, "Binary frames required"); upstream.destroy(); return; }
        const bytes = Array.isArray(data) ? Buffer.concat(data) : data instanceof ArrayBuffer ? Buffer.from(data) : data;
        if (!upstream.write(bytes)) {
          client.pause();
          upstream.once("drain", () => { if (client.readyState === WebSocket.OPEN && authorized()) client.resume(); });
        }
      });
      upstream.on("data", (data: Buffer) => {
        if (!authorized() || client.readyState !== WebSocket.OPEN) return;
        client.send(data, { binary: true }, (error) => {
          if (error) { upstream.destroy(); return; }
          if (upstream.isPaused() && client.bufferedAmount < MAX_BUFFERED_BYTES / 2) upstream.resume();
        });
        if (client.bufferedAmount >= MAX_BUFFERED_BYTES) upstream.pause();
      });
      upstream.on("error", () => { if (client.readyState === WebSocket.OPEN) client.close(1011, "Screen sharing unavailable"); });
      upstream.on("close", () => { if (client.readyState === WebSocket.OPEN) client.close(1000, "Screen sharing disconnected"); });
      client.on("error", () => upstream.destroy());
      client.on("close", () => { upstream.destroy(); this.clients.delete(client); });
    });
  }

  public revalidateClients(): void {
    for (const [client, state] of this.clients) {
      if (state.isAuthorized()) continue;
      state.socket.destroy();
      if (client.readyState === WebSocket.OPEN) client.close(1008, "Authorization expired");
    }
  }

  public stop(): void {
    for (const [client, state] of this.clients) { state.socket.destroy(); client.terminate(); }
    this.clients.clear();
    this.server.close();
  }
}
