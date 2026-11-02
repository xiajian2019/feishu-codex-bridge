import type {
  BridgeSSHApproveHostKeyRequest,
  BridgeSSHConnectRequest,
  BridgeSSHEventHandler,
  BridgeSSHEventName,
  BridgeSSHListenerHandle,
  BridgeSSHPrivateKeyInfo,
  BridgeSSHPrivateKeyHandleRequest,
  BridgeSSHResizeRequest,
  BridgeSSHSendRequest,
  BridgeSSHDisconnectRequest,
} from "./ssh-protocol.js";

export type {
  BridgeSSH,
  BridgeSSHApproveHostKeyRequest,
  BridgeSSHConnectRequest,
  BridgeSSHEventHandler,
  BridgeSSHEventName,
  BridgeSSHListenerHandle,
  BridgeSSHPrivateKeyInfo,
  BridgeSSHPrivateKeyHandleRequest,
  BridgeSSHResizeRequest,
  BridgeSSHSendRequest,
  BridgeSSHDisconnectRequest,
} from "./ssh-protocol.js";

export class SshNativeError extends Error {
  readonly operation: string;

  constructor(operation: string) {
    super("SSH 仅支持 Bridge 移动 App。");
    this.name = "SshNativeError";
    this.operation = operation;
  }
}

const unavailable = (operation: string): Promise<never> => Promise.reject(new SshNativeError(operation));

export function pickPrivateKey(): Promise<BridgeSSHPrivateKeyInfo> { return unavailable("pickPrivateKey"); }
export function discardPrivateKey(_request: BridgeSSHPrivateKeyHandleRequest): Promise<void> { return unavailable("discardPrivateKey"); }
export function connect(_request: BridgeSSHConnectRequest): Promise<void> { return unavailable("connect"); }
export function approveHostKey(_request: BridgeSSHApproveHostKeyRequest): Promise<void> { return unavailable("approveHostKey"); }
export function send(_request: BridgeSSHSendRequest): Promise<void> { return unavailable("send"); }
export function resize(_request: BridgeSSHResizeRequest): Promise<void> { return unavailable("resize"); }
export function disconnect(_request: BridgeSSHDisconnectRequest): Promise<void> { return unavailable("disconnect"); }
export function addListener<EventName extends BridgeSSHEventName>(
  _eventName: EventName,
  _listener: BridgeSSHEventHandler<EventName>,
): Promise<BridgeSSHListenerHandle> {
  return unavailable("addListener");
}
