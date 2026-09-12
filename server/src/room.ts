import { WebSocket } from 'ws';
import {
  type ClientInfo,
  type CursorSnapshot,
  type PresenceUpdateMessage,
  type PresenceSnapshotMessage,
  type SocketMessage,
} from './protocol.js';

export interface ClientSession {
  id: string;
  color: string;
  socket: WebSocket;
  isAlive: boolean;
  lastPosition?: { x: number; y: number; seq: number };
}

// Curated high-contrast color palette for client cursors/badges
const COLOR_PALETTE = [
  '#ef4444', // Red
  '#3b82f6', // Blue
  '#10b981', // Emerald
  '#f59e0b', // Amber
  '#8b5cf6', // Violet
  '#ec4899', // Pink
  '#06b6d4', // Cyan
  '#f97316', // Orange
];

/**
 * Room State Manager
 *
 * Encapsulates in-memory client presence, dynamic color allocation,
 * cursor position tracking for late-join snapshots, and broadcast fan-out.
 */
export class Room {
  private clients = new Map<string, ClientSession>();
  private nextFallbackIndex = 0;

  /**
   * Assigns a distinct color from COLOR_PALETTE.
   * Prioritizes unused colors to eliminate collisions even when clients churn.
   * Falls back to round-robin if > 8 concurrent clients connect.
   */
  private assignColor(): string {
    const activeColors = new Set(Array.from(this.clients.values()).map((c) => c.color));
    const unusedColor = COLOR_PALETTE.find((color) => !activeColors.has(color));
    if (unusedColor) {
      return unusedColor;
    }
    const fallback = COLOR_PALETTE[this.nextFallbackIndex % COLOR_PALETTE.length]!;
    this.nextFallbackIndex += 1;
    return fallback;
  }

  /**
   * Registers a newly connected client with an assigned color.
   */
  public addClient(clientId: string, socket: WebSocket): ClientSession {
    const color = this.assignColor();
    const session: ClientSession = {
      id: clientId,
      color,
      socket,
      isAlive: true,
    };
    this.clients.set(clientId, session);
    return session;
  }

  /**
   * Removes a client session upon disconnect.
   */
  public removeClient(clientId: string): boolean {
    return this.clients.delete(clientId);
  }

  public getClient(clientId: string): ClientSession | undefined {
    return this.clients.get(clientId);
  }

  public getAllClients(): ClientSession[] {
    return Array.from(this.clients.values());
  }

  public getClientCount(): number {
    return this.clients.size;
  }

  /**
   * Updates a client's last known cursor position (used for Phase 9 late-join snapshots).
   */
  public updateCursor(clientId: string, x: number, y: number, seq: number): void {
    const session = this.clients.get(clientId);
    if (session) {
      session.lastPosition = { x, y, seq };
    }
  }

  /**
   * Reusable broadcast helper:
   * Serializes once and distributes to all connected sockets.
   * Optionally excludes a specific client (e.g. the sender) to prevent self-echoes.
   */
  public broadcast(message: SocketMessage, excludeId?: string): void {
    const payload = JSON.stringify(message);
    for (const client of this.clients.values()) {
      if (excludeId && client.id === excludeId) {
        continue;
      }
      if (client.socket.readyState === WebSocket.OPEN) {
        client.socket.send(payload);
      }
    }
  }

  /**
   * Constructs and broadcasts the full authoritative presence list.
   * Full list broadcast guarantees self-healing state across all clients.
   */
  public broadcastPresence(): void {
    const clientList: ClientInfo[] = Array.from(this.clients.values()).map((c) => ({
      id: c.id,
      color: c.color,
    }));

    const presenceMsg: PresenceUpdateMessage = {
      type: 'presence-update',
      clients: clientList,
    };

    this.broadcast(presenceMsg);
  }

  /**
   * Generates a late-join snapshot containing the last known coordinates
   * of all active clients (excluding the requesting newcomer).
   */
  public getSnapshotForClient(newcomerId: string): PresenceSnapshotMessage | null {
    const existingCursors: CursorSnapshot[] = [];

    for (const [id, session] of this.clients.entries()) {
      if (id !== newcomerId && session.lastPosition) {
        existingCursors.push({
          id,
          x: session.lastPosition.x,
          y: session.lastPosition.y,
          seq: session.lastPosition.seq,
        });
      }
    }

    if (existingCursors.length === 0) {
      return null;
    }

    return {
      type: 'presence-snapshot',
      cursors: existingCursors,
    };
  }
}
