// Sequenced WebSocket protocol types for reliable session communication.
// Messages carry sequence numbers, are buffered, and replayed on reconnect.

// --- Session content types ---

export interface SessionOutputData {
  kind: 'output' | 'history' | 'exit' | 'error' | 'status_change' | 'waiting_state' | 'input_state';
  data?: string;
  exitCode?: number;
  status?: string;
  waiting?: boolean;
  state?: string;
}

export interface SessionInputData {
  kind: 'input' | 'resize' | 'kill';
  data?: string;
  cols?: number;
  rows?: number;
}

// --- Sequenced envelope types ---

export interface SequencedOutput {
  type: 'sequenced_output';
  sessionId: string;
  seq: number;
  content: SessionOutputData;
  timestamp: string;
}

export interface OutputAck {
  type: 'output_ack';
  sessionId: string;
  ackSeq: number;
}

export interface SequencedInput {
  type: 'sequenced_input';
  sessionId: string;
  seq: number;
  content: SessionInputData;
  timestamp: string;
}

export interface InputAck {
  type: 'input_ack';
  sessionId: string;
  ackSeq: number;
}

export interface ReplayRequest {
  type: 'replay_request';
  sessionId: string;
  fromSeq: number;
}

export interface Heartbeat {
  type: 'heartbeat';
  timestamp: string;
}

export interface ServerShutdown {
  type: 'server_shutdown';
  reason: string;
  reconnectDelayMs: number;
}

// --- Union types ---

export type ProtocolMessage =
  | SequencedOutput
  | OutputAck
  | SequencedInput
  | InputAck
  | ReplayRequest
  | Heartbeat
  | ServerShutdown;

// Legacy message types (backward compat during rollout)
export interface LegacyOutput {
  type: 'output';
  data: string;
}

export interface LegacyHistory {
  type: 'history';
  data: string;
}

export interface LegacyExit {
  type: 'exit';
  exitCode: number;
  status?: string;
}

export interface LegacyInput {
  type: 'input';
  data: string;
}

export interface LegacyResize {
  type: 'resize';
  cols: number;
  rows: number;
}

export interface LegacyKill {
  type: 'kill';
}

export type LegacyMessage =
  | LegacyOutput
  | LegacyHistory
  | LegacyExit
  | LegacyInput
  | LegacyResize
  | LegacyKill;

export type AnySessionMessage = ProtocolMessage | LegacyMessage;

// --- Constants ---

export const MAX_PENDING_MESSAGES = 100;
export const MESSAGE_TTL_MS = 5 * 60 * 1000; // 5 minutes
export const HEARTBEAT_INTERVAL_MS = 30_000;
export const MAX_RECONNECT_ATTEMPTS = 10;
export const RECONNECT_BACKOFF_CAP_MS = 30_000;

// --- Helpers ---

export function isSequencedMessage(msg: unknown): msg is ProtocolMessage {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    'type' in msg &&
    typeof (msg as { type: unknown }).type === 'string' &&
    [
      'sequenced_output',
      'output_ack',
      'sequenced_input',
      'input_ack',
      'replay_request',
      'heartbeat',
      'server_shutdown',
    ].includes((msg as { type: string }).type)
  );
}

export function isLegacyMessage(msg: unknown): msg is LegacyMessage {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    'type' in msg &&
    typeof (msg as { type: unknown }).type === 'string' &&
    ['output', 'history', 'exit', 'input', 'resize', 'kill'].includes(
      (msg as { type: string }).type
    )
  );
}
