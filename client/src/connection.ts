import {
  parseAndValidateMessage,
  type SocketMessage,
  type ClientInfo,
  type CursorSnapshot,
  type CursorMoveMessage,
  type ReactionMessage,
} from '../../server/src/protocol.js';

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
