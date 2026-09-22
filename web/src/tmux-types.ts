export type TmuxSessionStatus = "STARTING" | "RUNNING" | "EXITED" | "FAILED" | "STOPPED";

export interface TmuxSession {
  session_id: string;
  client_request_id: string | null;
  machine: string;
  cwd: string;
  tmux_socket: string;
  tmux_session: string;
  status: TmuxSessionStatus;
  error: string | null;
  last_screen: string;
  last_event_id: number;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  ended_at: string | null;
  attach_command: string;
}

export interface TmuxProjectOption {
  key: string;
  root: string;
  available: boolean;
}

export interface TmuxEvent {
  event_id: number;
  session_id: string;
  kind: string;
  payload: Record<string, unknown>;
  created_at: string;
}

export interface TmuxMessage {
  session_id: string;
  client_message_id: string;
  text: string;
  text_hash: string;
  source: "web" | "terminal";
  status: "PENDING" | "SENT" | "FAILED";
  delivery_attempts: number;
  error: string | null;
  created_at: string;
  delivered_at: string | null;
}

export interface TmuxSessionDetail {
  session: TmuxSession;
  messages: TmuxMessage[];
  events: TmuxEvent[];
}

export interface TmuxWebSocketEventMessage {
  type: "event";
  event: TmuxEvent;
}

export interface TmuxWebSocketReadyMessage {
  type: "ready";
  session: TmuxSession;
  cursor: number;
}

export interface TmuxWebSocketOutputMessage {
  type: "output";
  data: string;
}

export interface TmuxWebSocketErrorMessage {
  type: "error";
  message: string;
}

export type TmuxWebSocketMessage =
  | TmuxWebSocketEventMessage
  | TmuxWebSocketReadyMessage
  | TmuxWebSocketOutputMessage
  | TmuxWebSocketErrorMessage;
