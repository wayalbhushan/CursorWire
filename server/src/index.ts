import { WebSocketServer, WebSocket } from 'ws';
import crypto from 'node:crypto';
import {
  parseAndValidateMessage,
  type SocketMessage,
  type WelcomeMessage,
  type PresenceUpdateMessage,
  type PresenceSnapshotMessage,
  type CursorSnapshot,
  type ErrorMessage,
  type ClientInfo,
} from '../../shared/protocol.js';

const PORT = Number(process.env.PORT) || 8080;

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

interface ClientSession {
  id: string;
  color: string;
  socket: WebSocket;
  isAlive: boolean;
  lastPosition?: { x: number; y: number; seq: number };
}

// In-memory registry of active client connections: clientId -> ClientSession
const clients = new Map<string, ClientSession>();

/**
 * Strategy: Dynamic pool assignment with fallback cycling.
 * Rationale: Finds the first color from COLOR_PALETTE not currently held by an active client.
 * This prevents color collisions even when clients churn/disconnect. If more than 8 clients
 * are concurrently connected, it falls back to round-robin cycling.
 */
let nextFallbackIndex = 0;
function assignColor(): string {
  const activeColors = new Set(Array.from(clients.values()).map((c) => c.color));
  const unusedColor = COLOR_PALETTE.find((color) => !activeColors.has(color));
  if (unusedColor) {
    return unusedColor;
  }
  const fallback = COLOR_PALETTE[nextFallbackIndex % COLOR_PALETTE.length]!;
  nextFallbackIndex += 1;
  return fallback;
}

/**
 * Reusable broadcast helper:
 * Sends a validated SocketMessage to all currently connected clients,
 * optionally omitting a specific client ID (e.g. the sender).
 */
function broadcast(message: SocketMessage, excludeId?: string): void {
  const payload = JSON.stringify(message);
  for (const client of clients.values()) {
    if (excludeId && client.id === excludeId) {
      continue;
    }
    if (client.socket.readyState === WebSocket.OPEN) {
      client.socket.send(payload);
    }
  }
}

/**
 * Helper to construct and broadcast the authoritative connected presence list.
 *
 * Design Decision:
 * We broadcast the full 'presence-update' array on both joins and leaves rather than
 * relying solely on isolated delta 'leave' messages. This makes presence self-healing:
 * even if a packet is dropped or a client reconnects, the client's presence list
 * immediately converges to reality with zero zombie cursors.
 */
function broadcastPresence(): void {
  const clientList: ClientInfo[] = Array.from(clients.values()).map((c) => ({
    id: c.id,
    color: c.color,
  }));

  const presenceMsg: PresenceUpdateMessage = {
    type: 'presence-update',
    clients: clientList,
  };

  broadcast(presenceMsg);
}

const wss = new WebSocketServer({ port: PORT }, () => {
  console.log(`Server listening on ws://localhost:${PORT}`);
});

/**
 * Heartbeat Ping-Pong Detection (Phase 8: Dead Connection Detection)
 *
 * Interval: Every 10s.
 * Mechanism:
 *  - Under RFC 6455, WebSocket control frames (0x9 Ping, 0xA Pong) operate at the transport layer.
 *  - The server emits a ping() frame. The client browser automatically replies with a pong frame.
 *  - If a connection loses network connectivity abruptly (e.g. WiFi turned off, machine sleep, crash)
 *    without a clean TCP FIN/RST packet, ws.on('close') is never triggered by the OS.
 *  - If isAlive remains false across 2 consecutive heartbeat intervals (~20s), the socket is deemed dead.
 *  - The server terminates the connection, purges the client from memory, and updates presence.
 */
const HEARTBEAT_INTERVAL_MS = 10000;

const heartbeatInterval = setInterval(() => {
  for (const [clientId, session] of clients.entries()) {
    if (!session.isAlive) {
      console.warn(`[heartbeat timeout] Client ${clientId} is unresponsive (dead connection). Terminating socket.`);
      clients.delete(clientId);
      session.socket.terminate(); // Hard-close the dead socket immediately
      broadcastPresence();
      continue;
    }

    // Mark as unconfirmed and issue a ping control frame
    session.isAlive = false;
    session.socket.ping();
  }
}, HEARTBEAT_INTERVAL_MS);

wss.on('close', () => {
  clearInterval(heartbeatInterval);
});

wss.on('connection', (ws) => {
  // Generate short unique client ID and assign distinct color
  const clientId = crypto.randomUUID().slice(0, 8);
  const color = assignColor();

  const session: ClientSession = {
    id: clientId,
    color,
    socket: ws,
    isAlive: true,
  };
  clients.set(clientId, session);

  console.log(`[connect] Client ${clientId} connected (${color}). Active clients: ${clients.size}`);

  // Register pong handler to reset liveness flag
  ws.on('pong', () => {
    session.isAlive = true;
  });

  // 1. Send personal welcome message to the joining client
  const welcomeMsg: WelcomeMessage = {
    type: 'welcome',
    id: clientId,
    color,
  };
  ws.send(JSON.stringify(welcomeMsg));

  // 2. Broadcast updated presence list to ALL clients (including the newcomer)
  broadcastPresence();

  // 3. Phase 9 Late-Join Snapshot:
  // Immediately provide the newcomer with the last known cursor positions of all other active participants.
  // Note: Clients who haven't moved their mouse yet are omitted from the snapshot until their first move.
  const existingCursors: CursorSnapshot[] = [];
  for (const [existingId, existingSession] of clients.entries()) {
    if (existingId !== clientId && existingSession.lastPosition) {
      existingCursors.push({
        id: existingId,
        x: existingSession.lastPosition.x,
        y: existingSession.lastPosition.y,
        seq: existingSession.lastPosition.seq,
      });
    }
  }

  if (existingCursors.length > 0) {
    const snapshotMsg: PresenceSnapshotMessage = {
      type: 'presence-snapshot',
      cursors: existingCursors,
    };
    ws.send(JSON.stringify(snapshotMsg));
  }

  // Handle incoming messages with strict protocol validation
  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      console.warn(`[validation error] Client ${clientId} sent binary data (unsupported)`);
      const errorResponse: ErrorMessage = {
        type: 'error',
        message: 'Invalid message format',
        reason: 'Binary data is not supported',
      };
      ws.send(JSON.stringify(errorResponse));
      return;
    }

    const rawText = data.toString();
    const result = parseAndValidateMessage(rawText);

    if (!result.success) {
      console.warn(`[validation error] Client ${clientId} message rejected: ${result.error}`);
      const errorResponse: ErrorMessage = {
        type: 'error',
        message: 'Invalid message',
        reason: result.error,
      };
      ws.send(JSON.stringify(errorResponse));
      return;
    }

    const message = result.data;

    // Phase 4 & Phase 9: Record last known position and relay cursor movement to other clients
    if (message.type === 'cursor-move') {
      // Record position in server state for late-joining clients
      session.lastPosition = {
        x: message.x,
        y: message.y,
        seq: message.seq,
      };

      // Security note: Overwrite client-supplied id with the trusted session clientId
      broadcast(
        {
          type: 'cursor-move',
          id: clientId,
          x: message.x,
          y: message.y,
          seq: message.seq,
        },
        clientId // Exclude sender: client never receives its own echo
      );
      return;
    }

    // Phase 6: Broadcast reactions to ALL clients INCLUDING the sender
    if (message.type === 'reaction') {
      // Design decision: Reactions are discrete events where the sender expects immediate visual confirmation
      // from the server at the same logical instant as other participants.
      broadcast({
        type: 'reaction',
        id: clientId,
        x: message.x,
        y: message.y,
        emoji: message.emoji,
        seq: message.seq,
      }); // Notice: No excludeId — sender also receives the broadcast
      return;
    }

    console.log(`[message accepted] Client ${clientId} ->`, message);
  });

  // Handle disconnection
  ws.on('close', (code, reason) => {
    clients.delete(clientId);
    console.log(`[disconnect] Client ${clientId} disconnected (code: ${code}, reason: ${reason.toString() || 'none'}). Active clients: ${clients.size}`);

    // Broadcast authoritative presence list to remaining clients
    broadcastPresence();
  });

  ws.on('error', (error) => {
    console.error(`[error] Client ${clientId} socket error:`, error.message);
  });
});

wss.on('error', (error) => {
  console.error('[server error]', error);
});
