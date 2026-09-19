/**
 * Protocol Definitions & Client Connection for CursorWire
 *
 * Self-contained transport layer and wire protocol definitions
 * for the client application.
 */

export interface ClientInfo {
  id: string;
  color: string;
}

export interface CursorSnapshot {
  id: string;
  x: number;
  y: number;
  seq: number;
}

export interface JoinMessage {
  type: 'join';
}

export interface WelcomeMessage {
  type: 'welcome';
  id: string;
  color: string;
}

export interface PresenceUpdateMessage {
  type: 'presence-update';
  clients: ClientInfo[];
}

export interface PresenceSnapshotMessage {
  type: 'presence-snapshot';
  cursors: CursorSnapshot[];
}

export interface CursorMoveMessage {
  type: 'cursor-move';
  id?: string;
  x: number;
  y: number;
  seq: number;
}

export interface ReactionMessage {
  type: 'reaction';
  id?: string;
  x: number;
  y: number;
  emoji: string;
  seq: number;
}

export interface LeaveMessage {
  type: 'leave';
  id: string;
}

export interface ErrorMessage {
  type: 'error';
  message: string;
  reason?: string;
}

export type SocketMessage =
  | JoinMessage
  | WelcomeMessage
  | PresenceUpdateMessage
  | PresenceSnapshotMessage
  | CursorMoveMessage
  | ReactionMessage
  | LeaveMessage
  | ErrorMessage;

export type ValidationResult =
  | { success: true; data: SocketMessage }
  | { success: false; error: string };

export function validateMessage(raw: unknown): ValidationResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { success: false, error: 'Message payload must be a non-null object' };
  }

  const obj = raw as Record<string, unknown>;

  if (typeof obj.type !== 'string') {
    return { success: false, error: 'Message must have a string "type" field' };
  }

  switch (obj.type) {
    case 'join': {
      return { success: true, data: { type: 'join' } };
    }

    case 'welcome': {
      if (typeof obj.id !== 'string' || obj.id.trim() === '') {
        return { success: false, error: 'Welcome message must include a non-empty string "id"' };
      }
      if (typeof obj.color !== 'string' || obj.color.trim() === '') {
        return { success: false, error: 'Welcome message must include a non-empty string "color"' };
      }
      return { success: true, data: { type: 'welcome', id: obj.id, color: obj.color } };
    }

    case 'presence-update': {
      if (!Array.isArray(obj.clients)) {
        return { success: false, error: 'Presence-update "clients" must be an array' };
      }
      for (let i = 0; i < obj.clients.length; i++) {
        const item = obj.clients[i];
        if (typeof item !== 'object' || item === null) {
          return { success: false, error: `Presence-update client at index ${i} must be an object` };
        }
        const clientObj = item as Record<string, unknown>;
        if (typeof clientObj.id !== 'string' || clientObj.id.trim() === '') {
          return { success: false, error: `Presence-update client at index ${i} missing valid "id"` };
        }
        if (typeof clientObj.color !== 'string' || clientObj.color.trim() === '') {
          return { success: false, error: `Presence-update client at index ${i} missing valid "color"` };
        }
      }
      return {
        success: true,
        data: {
          type: 'presence-update',
          clients: obj.clients as ClientInfo[],
        },
      };
    }

    case 'presence-snapshot': {
      if (!Array.isArray(obj.cursors)) {
        return { success: false, error: 'Presence-snapshot "cursors" must be an array' };
      }
      for (let i = 0; i < obj.cursors.length; i++) {
        const item = obj.cursors[i];
        if (typeof item !== 'object' || item === null) {
          return { success: false, error: `Presence-snapshot cursor at index ${i} must be an object` };
        }
        const c = item as Record<string, unknown>;
        if (typeof c.id !== 'string' || c.id.trim() === '') {
          return { success: false, error: `Presence-snapshot cursor at index ${i} missing valid "id"` };
        }
        if (typeof c.x !== 'number' || !Number.isFinite(c.x)) {
          return { success: false, error: `Presence-snapshot cursor at index ${i} invalid "x"` };
        }
        if (typeof c.y !== 'number' || !Number.isFinite(c.y)) {
          return { success: false, error: `Presence-snapshot cursor at index ${i} invalid "y"` };
        }
        if (typeof c.seq !== 'number' || !Number.isInteger(c.seq) || c.seq < 0) {
          return { success: false, error: `Presence-snapshot cursor at index ${i} invalid "seq"` };
        }
      }
      return {
        success: true,
        data: {
          type: 'presence-snapshot',
          cursors: obj.cursors as CursorSnapshot[],
        },
      };
    }

    case 'cursor-move': {
      if (typeof obj.x !== 'number' || !Number.isFinite(obj.x)) {
        return { success: false, error: 'Cursor move "x" must be a finite number' };
      }
      if (typeof obj.y !== 'number' || !Number.isFinite(obj.y)) {
        return { success: false, error: 'Cursor move "y" must be a finite number' };
      }
      if (typeof obj.seq !== 'number' || !Number.isInteger(obj.seq) || obj.seq < 0) {
        return { success: false, error: 'Cursor move "seq" must be a non-negative integer' };
      }
      if (obj.id !== undefined && typeof obj.id !== 'string') {
        return { success: false, error: 'Cursor move "id", if provided, must be a string' };
      }

      const msg: CursorMoveMessage = {
        type: 'cursor-move',
        x: obj.x,
        y: obj.y,
        seq: obj.seq,
      };
      if (typeof obj.id === 'string') {
        msg.id = obj.id;
      }
      return { success: true, data: msg };
    }

    case 'reaction': {
      if (typeof obj.x !== 'number' || !Number.isFinite(obj.x)) {
        return { success: false, error: 'Reaction "x" must be a finite number' };
      }
      if (typeof obj.y !== 'number' || !Number.isFinite(obj.y)) {
        return { success: false, error: 'Reaction "y" must be a finite number' };
      }
      if (typeof obj.seq !== 'number' || !Number.isInteger(obj.seq) || obj.seq < 0) {
        return { success: false, error: 'Reaction "seq" must be a non-negative integer' };
      }
      if (typeof obj.emoji !== 'string' || obj.emoji.trim().length === 0) {
        return { success: false, error: 'Reaction "emoji" must be a non-empty string' };
      }
      if (obj.id !== undefined && typeof obj.id !== 'string') {
        return { success: false, error: 'Reaction "id", if provided, must be a string' };
      }

      const msg: ReactionMessage = {
        type: 'reaction',
        x: obj.x,
        y: obj.y,
        emoji: obj.emoji,
        seq: obj.seq,
      };
      if (typeof obj.id === 'string') {
        msg.id = obj.id;
      }
      return { success: true, data: msg };
    }

    case 'leave': {
      if (typeof obj.id !== 'string' || obj.id.trim() === '') {
        return { success: false, error: 'Leave message must include a non-empty string "id"' };
      }
      return { success: true, data: { type: 'leave', id: obj.id } };
    }

    case 'error': {
      if (typeof obj.message !== 'string') {
        return { success: false, error: 'Error message must include a string "message"' };
      }
      const msg: ErrorMessage = {
        type: 'error',
        message: obj.message,
      };
      if (typeof obj.reason === 'string') {
        msg.reason = obj.reason;
      }
      return { success: true, data: msg };
    }

    default:
      return { success: false, error: `Unrecognized message type: "${obj.type}"` };
  }
}

export function parseAndValidateMessage(rawText: string): ValidationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    return {
      success: false,
      error: `Malformed JSON: ${err instanceof Error ? err.message : 'Parse error'}`,
    };
  }

  return validateMessage(parsed);
}

export type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'error';

export interface ConnectionCallbacks {
  onStatusChange?: (status: ConnectionStatus, attempt: number) => void;
  onWelcome?: (id: string, color: string) => void;
  onPresenceUpdate?: (clients: ClientInfo[]) => void;
  onSnapshot?: (cursors: CursorSnapshot[]) => void;
  onCursorMove?: (msg: CursorMoveMessage) => void;
  onReaction?: (msg: ReactionMessage) => void;
  onError?: (err: string) => void;
}

const MAX_RECONNECT_ATTEMPTS = 5;
const BASE_RECONNECT_DELAY_MS = 1000;

/**
 * Transport Layer (Client-Side WebSocket Plumbing)
 *
 * Strictly encapsulates raw browser WebSocket connections,
 * message framing, bounded exponential backoff reconnection,
 * and dispatching parsed/validated protocol messages to listeners.
 */
export class CursorWireConnection {
  private url: string;
  private socket: WebSocket | null = null;
  private status: ConnectionStatus = 'connecting';
  private reconnectAttempts = 0;
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private isManuallyClosed = false;
  private callbacks: ConnectionCallbacks = {};

  constructor(url: string, callbacks: ConnectionCallbacks = {}) {
    this.url = url;
    this.callbacks = callbacks;
  }

  public setCallbacks(callbacks: ConnectionCallbacks): void {
    this.callbacks = callbacks;
  }

  public getStatus(): ConnectionStatus {
    return this.status;
  }

  public getReconnectAttempts(): number {
    return this.reconnectAttempts;
  }

  public getSocket(): WebSocket | null {
    return this.socket;
  }

  private setStatus(status: ConnectionStatus): void {
    this.status = status;
    this.callbacks.onStatusChange?.(status, this.reconnectAttempts);
  }

  public connect(): void {
    this.isManuallyClosed = false;

    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        // Ignore close error during reconnect
      }
    }

    this.setStatus(this.reconnectAttempts > 0 ? 'reconnecting' : 'connecting');

    try {
      this.socket = new WebSocket(this.url);
    } catch (err) {
      this.setStatus('error');
      this.callbacks.onError?.(err instanceof Error ? err.message : 'WebSocket initialization failed');
      this.scheduleReconnect();
      return;
    }

    this.socket.onopen = () => {
      this.reconnectAttempts = 0;
      if (this.reconnectTimeout) {
        clearTimeout(this.reconnectTimeout);
        this.reconnectTimeout = null;
      }
      this.setStatus('connected');
    };

    this.socket.onmessage = (event) => {
      if (typeof event.data !== 'string') return;

      const result = parseAndValidateMessage(event.data);
      if (!result.success) {
        this.callbacks.onError?.(result.error);
        return;
      }

      const msg: SocketMessage = result.data;

      switch (msg.type) {
        case 'welcome':
          this.callbacks.onWelcome?.(msg.id, msg.color);
          break;
        case 'presence-update':
          this.callbacks.onPresenceUpdate?.(msg.clients);
          break;
        case 'presence-snapshot':
          this.callbacks.onSnapshot?.(msg.cursors);
          break;
        case 'cursor-move':
          this.callbacks.onCursorMove?.(msg);
          break;
        case 'reaction':
          this.callbacks.onReaction?.(msg);
          break;
        default:
          break;
      }
    };

    this.socket.onclose = () => {
      if (this.isManuallyClosed) {
        this.setStatus('disconnected');
        return;
      }

      this.scheduleReconnect();
    };

    this.socket.onerror = () => {
      // Error event is followed by onclose
    };
  }

  private scheduleReconnect(): void {
    if (this.isManuallyClosed) return;

    if (this.reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      this.reconnectAttempts += 1;
      this.setStatus('reconnecting');

      const delay = Math.min(
        BASE_RECONNECT_DELAY_MS * Math.pow(1.5, this.reconnectAttempts - 1),
        6000
      );

      this.reconnectTimeout = setTimeout(() => {
        this.connect();
      }, delay);
    } else {
      this.setStatus('disconnected');
    }
  }

  public manualReconnect(): void {
    this.reconnectAttempts = 0;
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    this.connect();
  }

  public sendCursorMove(x: number, y: number, seq: number): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;

    const msg: CursorMoveMessage = {
      type: 'cursor-move',
      x,
      y,
      seq,
    };
    this.socket.send(JSON.stringify(msg));
  }

  public sendReaction(x: number, y: number, emoji: string, seq: number): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;

    const msg: ReactionMessage = {
      type: 'reaction',
      x,
      y,
      emoji,
      seq,
    };
    this.socket.send(JSON.stringify(msg));
  }

  public sendRaw(data: unknown): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    const payload = typeof data === 'string' ? data : JSON.stringify(data);
    this.socket.send(payload);
  }

  public disconnect(): void {
    this.isManuallyClosed = true;
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
    this.setStatus('disconnected');
  }
}
