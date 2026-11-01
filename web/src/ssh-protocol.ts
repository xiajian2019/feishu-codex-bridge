/**
 * The browser-facing contract for the future Capacitor BridgeSSH plugin.
 *
 * This module deliberately contains no Capacitor or WebSocket code. Keeping
 * the wire types here lets the React page use the same contract as the native
 * wrapper without introducing a browser-side fake connection.
 */

export const SSH_DEFAULT_PORT = 22;
export const SSH_DEFAULT_HOST = "";
export const SSH_DEFAULT_COLS = 80;
export const SSH_DEFAULT_ROWS = 24;
export const SSH_MIN_COLS = 2;
export const SSH_MAX_COLS = 512;
export const SSH_MIN_ROWS = 1;
export const SSH_MAX_ROWS = 256;
export const SSH_MAX_PRIVATE_KEY_PASSPHRASE_BYTES = 256 * 1024;

export type BridgeSSHConnectionState =
  | "idle"
  | "connecting"
  | "awaiting-host-key"
  | "connected"
  | "reconnecting"
  | "disconnecting"
  | "disconnected"
  | "exited"
  | "error";

export const BRIDGE_SSH_CONNECTION_STATES: readonly BridgeSSHConnectionState[] = [
  "idle",
  "connecting",
  "awaiting-host-key",
  "connected",
  "reconnecting",
  "disconnecting",
  "disconnected",
  "exited",
  "error",
];

export interface BridgeSSHConnectRequest {
  sessionId: string;
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKeyId?: string;
  privateKeyPassphrase?: string;
  cols: number;
  rows: number;
  startupCommand?: string;
}

export interface BridgeSSHPrivateKeyInfo {
  keyId: string;
  fileName: string;
  format: string;
  encrypted: boolean;
}

export interface BridgeSSHPrivateKeyHandleRequest {
  keyId: string;
}

export interface BridgeSSHApproveHostKeyRequest {
  sessionId: string;
  accept: boolean;
}

export interface BridgeSSHSendRequest {
  sessionId: string;
  dataBase64: string;
}

export interface BridgeSSHResizeRequest {
  sessionId: string;
  cols: number;
  rows: number;
}

export interface BridgeSSHDisconnectRequest {
  sessionId: string;
}

export interface BridgeSSHStateEvent {
  sessionId: string;
  state: BridgeSSHConnectionState;
  /** A user-facing, non-secret status or error message from the native side. */
  message?: string;
  /** A stable, non-secret error code when the native side has one. */
  errorCode?: string;
  retryable?: boolean;
}

export interface BridgeSSHHostKeyEvent {
  sessionId: string;
  fingerprint: string;
  keyType?: string;
  algorithm?: string;
  host?: string;
  port?: number;
}

export interface BridgeSSHOutputEvent {
  sessionId: string;
  /** SSH bytes encoded as standard Base64; this is not terminal text. */
  dataBase64: string;
}

export interface BridgeSSHExitEvent {
  sessionId: string;
  code?: number;
  signal?: string;
  message?: string;
  errorCode?: string;
}

export interface BridgeSSHEventMap {
  sshState: BridgeSSHStateEvent;
  sshHostKey: BridgeSSHHostKeyEvent;
  sshOutput: BridgeSSHOutputEvent;
  sshExit: BridgeSSHExitEvent;
}

export type BridgeSSHEventName = keyof BridgeSSHEventMap;
export type BridgeSSHEventHandler<EventName extends BridgeSSHEventName> =
  (event: BridgeSSHEventMap[EventName]) => void;

export interface BridgeSSHListenerHandle {
  remove(): Promise<void>;
}

export type BridgeSSHCallResult = void | Promise<void>;

/** Type-compatible surface for Capacitor's `registerPlugin("BridgeSSH")`. */
export interface BridgeSSH {
  pickPrivateKey(): Promise<BridgeSSHPrivateKeyInfo>;
  discardPrivateKey(request: BridgeSSHPrivateKeyHandleRequest): BridgeSSHCallResult;
  connect(request: BridgeSSHConnectRequest): BridgeSSHCallResult;
  approveHostKey(request: BridgeSSHApproveHostKeyRequest): BridgeSSHCallResult;
  send(request: BridgeSSHSendRequest): BridgeSSHCallResult;
  resize(request: BridgeSSHResizeRequest): BridgeSSHCallResult;
  disconnect(request: BridgeSSHDisconnectRequest): BridgeSSHCallResult;
  addListener<EventName extends BridgeSSHEventName>(
    eventName: EventName,
    listener: BridgeSSHEventHandler<EventName>,
  ): Promise<BridgeSSHListenerHandle>;
}

export interface BridgeSSHDimensions {
  cols: number;
  rows: number;
}

export function isBridgeSSHConnectionState(value: unknown): value is BridgeSSHConnectionState {
  return typeof value === "string"
    && (BRIDGE_SSH_CONNECTION_STATES as readonly string[]).includes(value);
}

function normalizeRequiredText(value: unknown, field: string): string {
  if (typeof value !== "string") throw new TypeError(`${field} must be a string.`);
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${field} must not be empty.`);
  if (/[\u0000-\u001f\u007f]/.test(normalized)) throw new TypeError(`${field} contains a control character.`);
  return normalized;
}

function normalizeOptionalText(value: unknown, field: string, maximumBytes?: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new TypeError(`${field} must be a string.`);
  if (value.includes("\u0000")) throw new TypeError(`${field} contains a NUL character.`);
  if (maximumBytes !== undefined && new TextEncoder().encode(value).byteLength > maximumBytes) {
    throw new RangeError(`${field} must not exceed ${maximumBytes} UTF-8 bytes.`);
  }
  return value;
}

function normalizeOptionalIdentifier(value: unknown, field: string): string | undefined {
  const text = normalizeOptionalText(value, field);
  if (text === undefined || !text.trim()) return undefined;
  const normalized = text.trim();
  if (/[\u0000-\u001f\u007f]/.test(normalized) || /\s/.test(normalized)) {
    throw new TypeError(`${field} must not contain whitespace or control characters.`);
  }
  return normalized;
}

function normalizeInteger(value: unknown, field: string, minimum: number, maximum: number): number {
  const candidate = typeof value === "string" ? value.trim() : value;
  if ((typeof candidate !== "number" && typeof candidate !== "string")
    || (typeof candidate === "string" && !/^\d+$/.test(candidate))) {
    throw new TypeError(`${field} must be an integer.`);
  }
  const normalized = Number(candidate);
  if (!Number.isSafeInteger(normalized) || normalized < minimum || normalized > maximum) {
    throw new RangeError(`${field} must be between ${minimum} and ${maximum}.`);
  }
  return normalized;
}

export function normalizeSshSessionId(value: unknown): string {
  return normalizeRequiredText(value, "sessionId");
}

export function normalizeSshHost(value: unknown): string {
  const host = normalizeRequiredText(value, "host");
  if (/\s/.test(host)) throw new TypeError("host must not contain whitespace.");
  return host;
}

export function normalizeSshUsername(value: unknown): string {
  const username = normalizeRequiredText(value, "username");
  if (/\s/.test(username)) throw new TypeError("username must not contain whitespace.");
  return username;
}

export function normalizeSshPort(value: unknown): number {
  return normalizeInteger(value, "port", 1, 65_535);
}

export function normalizeSshDimension(value: unknown, field: "cols" | "rows"): number {
  return field === "cols"
    ? normalizeInteger(value, field, SSH_MIN_COLS, SSH_MAX_COLS)
    : normalizeInteger(value, field, SSH_MIN_ROWS, SSH_MAX_ROWS);
}

export function normalizeSshDimensions(cols: unknown, rows: unknown): BridgeSSHDimensions {
  return { cols: normalizeSshDimension(cols, "cols"), rows: normalizeSshDimension(rows, "rows") };
}

export function normalizeSshPrivateKeyInfo(value: unknown): BridgeSSHPrivateKeyInfo {
  if (!value || typeof value !== "object") throw new TypeError("SSH private-key info must be an object.");
  const input = value as Record<string, unknown>;
  const keyId = normalizeOptionalIdentifier(input.keyId, "keyId");
  if (!keyId) throw new TypeError("keyId must not be empty.");
  const fileName = normalizeRequiredText(input.fileName, "fileName");
  const format = normalizeRequiredText(input.format, "format");
  if (typeof input.encrypted !== "boolean") throw new TypeError("encrypted must be a boolean.");
  return { keyId, fileName, format, encrypted: input.encrypted };
}

export function normalizeSshConnectRequest(value: unknown): BridgeSSHConnectRequest {
  if (!value || typeof value !== "object") throw new TypeError("SSH connect request must be an object.");
  const input = value as Record<string, unknown>;
  const { cols, rows } = normalizeSshDimensions(input.cols, input.rows);
  const request: BridgeSSHConnectRequest = {
    sessionId: normalizeSshSessionId(input.sessionId),
    host: normalizeSshHost(input.host),
    port: normalizeSshPort(input.port),
    username: normalizeSshUsername(input.username),
    cols,
    rows,
  };
  const password = normalizeOptionalText(input.password, "password");
  if (password) request.password = password;
  if (input.privateKey !== undefined) {
    throw new TypeError("privateKey is not supported; use privateKeyId.");
  }
  const privateKeyId = normalizeOptionalIdentifier(input.privateKeyId, "privateKeyId");
  if (privateKeyId) request.privateKeyId = privateKeyId;
  const privateKeyPassphrase = normalizeOptionalText(
    input.privateKeyPassphrase,
    "privateKeyPassphrase",
    SSH_MAX_PRIVATE_KEY_PASSPHRASE_BYTES,
  );
  if (privateKeyPassphrase) request.privateKeyPassphrase = privateKeyPassphrase;
  const startupCommand = normalizeOptionalText(input.startupCommand, "startupCommand");
  if (startupCommand?.trim()) request.startupCommand = startupCommand;
  if (!request.password && !request.privateKeyId) {
    throw new TypeError("password or privateKeyId must be provided.");
  }
  return request;
}

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64_VALUES = new Uint8Array(256);
for (let index = 0; index < BASE64_VALUES.length; index += 1) BASE64_VALUES[index] = 255;
for (let index = 0; index < BASE64_ALPHABET.length; index += 1) {
  BASE64_VALUES[BASE64_ALPHABET.charCodeAt(index)] = index;
}

function normalizeBase64(value: string): string {
  if (typeof value !== "string") throw new TypeError("Base64 value must be a string.");
  const compact = value.replace(/[\t\n\f\r ]/g, "");
  if (!compact) return "";
  if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(compact)) throw new TypeError("Invalid Base64 value.");

  const paddingIndex = compact.indexOf("=");
  const raw = paddingIndex < 0 ? compact : compact.slice(0, paddingIndex);
  const suppliedPadding = paddingIndex < 0 ? 0 : compact.length - paddingIndex;
  if (raw.length % 4 === 1) throw new TypeError("Invalid Base64 value.");
  const requiredPadding = (4 - (raw.length % 4)) % 4;
  if (suppliedPadding !== 0 && (suppliedPadding !== requiredPadding || compact.length % 4 !== 0)) {
    throw new TypeError("Invalid Base64 padding.");
  }
  return raw.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(requiredPadding);
}

/** Encode UTF-8 text or arbitrary bytes without relying on Node's Buffer. */
export function encodeBase64(value: string | Uint8Array): string {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  if (!(bytes instanceof Uint8Array)) throw new TypeError("Base64 input must be text or Uint8Array.");
  let encoded = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index]!;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    encoded += BASE64_ALPHABET[first >> 2];
    encoded += BASE64_ALPHABET[((first & 0x03) << 4) | ((second ?? 0) >> 4)];
    encoded += second === undefined
      ? "="
      : BASE64_ALPHABET[((second & 0x0f) << 2) | ((third ?? 0) >> 6)];
    encoded += third === undefined ? "=" : BASE64_ALPHABET[third & 0x3f];
  }
  return encoded;
}

/** Decode standard or URL-safe Base64 into a fresh byte array. */
export function decodeBase64(value: string): Uint8Array {
  const normalized = normalizeBase64(value);
  if (!normalized) return new Uint8Array();
  const padding = normalized.endsWith("==") ? 2 : normalized.endsWith("=") ? 1 : 0;
  const output = new Uint8Array((normalized.length / 4) * 3 - padding);
  let outputIndex = 0;
  for (let index = 0; index < normalized.length; index += 4) {
    const first = BASE64_VALUES[normalized.charCodeAt(index)]!;
    const second = BASE64_VALUES[normalized.charCodeAt(index + 1)]!;
    const thirdChar = normalized.charCodeAt(index + 2);
    const fourthChar = normalized.charCodeAt(index + 3);
    const third = thirdChar === 61 ? 0 : BASE64_VALUES[thirdChar]!;
    const fourth = fourthChar === 61 ? 0 : BASE64_VALUES[fourthChar]!;
    if (first === 255 || second === 255 || third === 255 || fourth === 255) {
      throw new TypeError("Invalid Base64 value.");
    }
    output[outputIndex++] = (first << 2) | (second >> 4);
    if (outputIndex < output.length) output[outputIndex++] = ((second & 0x0f) << 4) | (third >> 2);
    if (outputIndex < output.length) output[outputIndex++] = ((third & 0x03) << 6) | fourth;
  }
  return output;
}

export function base64ToString(value: string): string {
  return new TextDecoder().decode(decodeBase64(value));
}

export const bytesToBase64 = encodeBase64;
export const stringToBase64 = encodeBase64;
export const base64ToBytes = decodeBase64;
