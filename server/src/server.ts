import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import crypto from 'node:crypto';
import {
  parseAndValidateMessage,
  type WelcomeMessage,
  type ErrorMessage,
} from './protocol.js';
import { Room } from './room.js';

const PORT = Number(process.env.PORT) || 8080;

const room = new Room();

// HTTP server handling health checks (for Render / uptime pings) and WebSocket upgrades
const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        status: 'ok',
        service: 'cursorwire-server',
        clients: room.getClientCount(),
        uptime: Math.floor(process.uptime()),
      })
    );
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ server });

server.listen(PORT, () => {
  console.log(`[server] CursorWire server listening on port ${PORT}`);
});

/**
 * Transport-Level Heartbeat Ping-Pong Detection (Phase 8)
 *
 * Interval: Every 10s.
 * Mechanism: Under RFC 6455, WebSocket control frames (0x9 Ping, 0xA Pong) operate
 * directly at the framing layer. If a client connection drops silently (e.g. WiFi killed,
 * sleep, device crash) without a TCP FIN packet, isAlive stays false for 2 cycles (~20s).
 * The server terminates the dead connection and updates room presence immediately.
 */
const HEARTBEAT_INTERVAL_MS = 10000;

const heartbeatInterval = setInterval(() => {
  for (const session of room.getAllClients()) {
    if (!session.isAlive) {
      console.warn(`[heartbeat timeout] Client ${session.id} unresponsive. Terminating socket.`);
      room.removeClient(session.id);
      session.socket.terminate();
      room.broadcastPresence();
      continue;
    }

    session.isAlive = false;
    session.socket.ping();
  }
}, HEARTBEAT_INTERVAL_MS);

wss.on('close', () => {
  clearInterval(heartbeatInterval);
});

wss.on('connection', (ws: WebSocket) => {
  const clientId = crypto.randomUUID().slice(0, 8);
  const session = room.addClient(clientId, ws);

  console.log(`[connect] Client ${clientId} joined (${session.color}). Active clients: ${room.getClientCount()}`);

  // Register pong listener to reset liveness flag on RFC 6455 pong control frames
  ws.on('pong', () => {
    session.isAlive = true;
  });

  // 1. Send personal welcome acknowledgment to the new client
  const welcomeMsg: WelcomeMessage = {
    type: 'welcome',
    id: clientId,
    color: session.color,
  };
  ws.send(JSON.stringify(welcomeMsg));

  // 2. Broadcast updated authoritative presence list to all participants
  room.broadcastPresence();

  // 3. Phase 9 Late-Join Snapshot: Send current positions of all active participants
  const snapshot = room.getSnapshotForClient(clientId);
  if (snapshot) {
    ws.send(JSON.stringify(snapshot));
  }

  // Handle incoming frames with defensive protocol validation
  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      console.warn(`[validation error] Client ${clientId} sent binary frame (unsupported)`);
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

    // Phase 4 & Phase 9: Record position in room state and relay to other participants
    if (message.type === 'cursor-move') {
      room.updateCursor(clientId, message.x, message.y, message.seq);

      // Overwrite id with verified server session ID and exclude sender (no self-echo)
      room.broadcast(
        {
          type: 'cursor-move',
          id: clientId,
          x: message.x,
          y: message.y,
          seq: message.seq,
        },
        clientId
      );
      return;
    }

    // Phase 6: Broadcast reactions to all participants including the sender
    if (message.type === 'reaction') {
      room.broadcast({
        type: 'reaction',
        id: clientId,
        x: message.x,
        y: message.y,
        emoji: message.emoji,
        seq: message.seq,
      });
      return;
    }

    console.log(`[message accepted] Client ${clientId} ->`, message);
  });

  // Handle clean client disconnect
  ws.on('close', (code, reason) => {
    room.removeClient(clientId);
    console.log(`[disconnect] Client ${clientId} disconnected (code: ${code}, reason: ${reason.toString() || 'none'}). Active clients: ${room.getClientCount()}`);
    room.broadcastPresence();
  });

  ws.on('error', (error) => {
    console.error(`[socket error] Client ${clientId}:`, error.message);
  });
});

wss.on('error', (error) => {
  console.error('[server error]', error);
});

// Graceful shutdown handling
const gracefulShutdown = () => {
  console.log('\n[shutdown] Gracefully terminating server...');
  clearInterval(heartbeatInterval);
  wss.close(() => {
    server.close(() => {
      process.exit(0);
    });
  });
};

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);
