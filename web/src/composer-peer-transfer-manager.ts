import { createFileTransferManager, type FileItem, type FileTransferManager, type TransferNotice } from "@thebkht/rtc-file-transfer";
import { peerJsSignaling } from "@thebkht/rtc-file-transfer/adapters";
import type { DataConnection, Peer } from "peerjs";

export const COMPOSER_PEER_TEXT_FILE_NAME = "__feishu_composer_text__.txt";

export type ComposerPeerManager = {
  manager: FileTransferManager;
  peer: Peer;
  connectTo: (peerId: string) => DataConnection;
  dispose: () => void;
};

type ComposerPeerConnection = DataConnection & { metadata?: unknown };
type ComposerPeerConnectionListener = (connection: ComposerPeerConnection) => void;

/**
 * @thebkht/rtc-file-transfer deliberately leaves authentication to the
 * signaling layer. The QR token is carried as PeerJS connection metadata, and
 * the facade drops connections that did not present the current capability.
 */
function authenticatedPeer(peer: Peer, token: string): {
  on: (event: "connection", listener: ComposerPeerConnectionListener) => void;
  off: (event: "connection", listener: ComposerPeerConnectionListener) => void;
  connect: (peerId: string) => ComposerPeerConnection;
} {
  const handlers = new Map<ComposerPeerConnectionListener, (connection: ComposerPeerConnection) => void>();
  return {
    on(_event, listener) {
      const wrapped = (connection: ComposerPeerConnection): void => {
        if (connection.metadata && typeof connection.metadata === "object"
          && (connection.metadata as { composerToken?: unknown }).composerToken === token) {
          listener(connection);
        } else {
          connection.close();
        }
      };
      handlers.set(listener, wrapped);
      peer.on("connection", wrapped);
    },
    off(_event, listener) {
      const wrapped = handlers.get(listener);
      if (wrapped) peer.off("connection", wrapped);
      handlers.delete(listener);
    },
    connect(peerId) {
      return peer.connect(peerId, {
        reliable: true,
        serialization: "binary",
        metadata: { composerToken: token },
      }) as ComposerPeerConnection;
    },
  };
}

export function createComposerPeerManager(input: {
  peer: Peer;
  token: string;
  onItemsChange: (items: FileItem[]) => void;
  onNotice: (notice: TransferNotice) => void;
  destroyPeer?: boolean;
}): ComposerPeerManager {
  const transport = authenticatedPeer(input.peer, input.token);
  const signaling = peerJsSignaling(transport);
  const manager = createFileTransferManager({
    peerId: input.peer.id,
    iceServers: [],
    capabilities: ["blocks", "flow"],
    limits: { windowBytes: 2 * 1024 * 1024 },
    sendSignal: signaling.sendSignal,
    onItemsChange: input.onItemsChange,
    onNotice: input.onNotice,
  });
  const detach = signaling.connect(manager);
  return {
    manager,
    peer: input.peer,
    connectTo: (peerId) => signaling.connectTo(peerId) as DataConnection,
    dispose: () => {
      detach();
      manager.dispose();
      if (input.destroyPeer !== false && !input.peer.destroyed) input.peer.destroy();
    },
  };
}
