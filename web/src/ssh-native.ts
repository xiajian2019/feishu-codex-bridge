import { registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import { normalizeSshPrivateKeyInfo } from "./ssh-protocol.js";
import type {
  BridgeSSH,
  BridgeSSHApproveHostKeyRequest,
  BridgeSSHConnectRequest,
  BridgeSSHDisconnectRequest,
  BridgeSSHEventHandler,
  BridgeSSHEventMap,
  BridgeSSHEventName,
  BridgeSSHPrivateKeyInfo,
  BridgeSSHPrivateKeyHandleRequest,
  BridgeSSHResizeRequest,
  BridgeSSHSendRequest,
} from "./ssh-protocol.js";

export type {
  BridgeSSH,
  BridgeSSHApproveHostKeyRequest,
  BridgeSSHConnectRequest,
  BridgeSSHDisconnectRequest,
  BridgeSSHEventHandler,
  BridgeSSHEventMap,
  BridgeSSHEventName,
  BridgeSSHListenerHandle,
  BridgeSSHPrivateKeyInfo,
  BridgeSSHPrivateKeyHandleRequest,
  BridgeSSHResizeRequest,
  BridgeSSHSendRequest,
} from "./ssh-protocol.js";

export type SshConnectOptions = BridgeSSHConnectRequest;
export type SshHostKeyApproval = BridgeSSHApproveHostKeyRequest;
export type SshSendOptions = BridgeSSHSendRequest;
export type SshResizeOptions = BridgeSSHResizeRequest;
export type SshDisconnectOptions = BridgeSSHDisconnectRequest;
export type SshStateEvent = BridgeSSHEventMap["sshState"];
export type SshHostKeyEvent = BridgeSSHEventMap["sshHostKey"];
export type SshOutputEvent = BridgeSSHEventMap["sshOutput"];
export type SshExitEvent = BridgeSSHEventMap["sshExit"];

// There is deliberately no web implementation here. Browser callers receive a
// clear error from the wrappers below instead of silently using another transport.
const NativeBridgeSSH = registerPlugin<BridgeSSH>("BridgeSSH");

export class SshNativeError extends Error {
  readonly operation: string;

  constructor(operation: string) {
    super("SSH native plugin unavailable or " + operation
      + " was rejected. Open this page in a Bridge App with SSH support.");
    this.name = "SshNativeError";
    this.operation = operation;
  }
}

async function invokeNative<T>(
  operation: string,
  action: () => T | Promise<T>,
): Promise<T> {
  try {
    return await action();
  } catch {
    // Do not attach the native error as a cause: plugin errors can accidentally
    // contain credentials or terminal output. The page still gets a stable,
    // actionable error without retaining sensitive data in this module.
    throw new SshNativeError(operation);
  }
}

export function connect(request: BridgeSSHConnectRequest): Promise<void> {
  return invokeNative("connect", () => NativeBridgeSSH.connect(request));
}

export function pickPrivateKey(): Promise<BridgeSSHPrivateKeyInfo> {
  return invokeNative("pickPrivateKey", async () => {
    const result = await NativeBridgeSSH.pickPrivateKey();
    return normalizeSshPrivateKeyInfo(result);
  });
}

export function discardPrivateKey(request: BridgeSSHPrivateKeyHandleRequest): Promise<void> {
  return invokeNative("discardPrivateKey", () => NativeBridgeSSH.discardPrivateKey(request));
}

export function approveHostKey(request: BridgeSSHApproveHostKeyRequest): Promise<void> {
  return invokeNative("approveHostKey", () => NativeBridgeSSH.approveHostKey(request));
}

export function send(request: BridgeSSHSendRequest): Promise<void> {
  return invokeNative("send", () => NativeBridgeSSH.send(request));
}

export function resize(request: BridgeSSHResizeRequest): Promise<void> {
  return invokeNative("resize", () => NativeBridgeSSH.resize(request));
}

export function disconnect(request: BridgeSSHDisconnectRequest): Promise<void> {
  return invokeNative("disconnect", () => NativeBridgeSSH.disconnect(request));
}

export function addListener<EventName extends BridgeSSHEventName>(
  eventName: EventName,
  listener: BridgeSSHEventHandler<EventName>,
): Promise<PluginListenerHandle> {
  return invokeNative(
    "addListener:" + eventName,
    () => NativeBridgeSSH.addListener(eventName, listener),
  );
}
