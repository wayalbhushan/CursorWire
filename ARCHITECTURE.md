# Architecture & Design Specification: CursorWire

This document outlines the modular architecture, component responsibilities, state ownership model, data flow, network budget, and extensibility of **CursorWire** — a real-time multiplayer cursor and reaction sync engine built without third-party socket or state-sync libraries.

---

## 1. System Overview & Modular Separation

CursorWire is divided strictly into isolated modules adhering to single-responsibility boundaries. Neither transport code handles UI rendering, nor does UI rendering know about WebSocket protocol framing.

```
CursorWire/
├── server/
│   ├── src/
│   │   ├── server.ts      # WebSocket transport lifecycle, port listening, ping/pong heartbeat
│   │   ├── room.ts        # Authoritative room presence, dynamic color allocation, late-join snapshot
│   │   └── protocol.ts    # Wire message schemas, discriminated union types, defensive validators
│   └── package.json
│
├── client/
│   ├── src/
│   │   ├── connection.ts     # Client WebSocket transport layer, reconnect backoff, message dispatch
│   │   ├── interpolation.ts  # Linear interpolation (LERP), 100ms jitter buffer, sequence ordering
│   │   ├── render.ts         # Pure DOM drawing (SVG offset pointers, reaction burst animations, CSS)
│   │   └── App.tsx           # React application shell, 30Hz mouse throttling, hotkeys, status UI
│   └── package.json
│
├── README.md
└── ARCHITECTURE.md
```

---

## 2. Component Responsibilities

### Server Architecture

#### `server/src/protocol.ts` (Protocol & Validation Layer)
- Defines the wire format using TypeScript discriminated unions (`type` field as discriminant).
- Zero external dependencies.
- Exposes `parseAndValidateMessage(rawText: string): ValidationResult` to ensure malformed JSON or invalid property types are caught before reaching server state.

#### `server/src/room.ts` (State & Room Management Layer)
- Manages in-memory client sessions (`Map<string, ClientSession>`).
- Dynamic color allocation: checks colors currently held by active clients in the room to eliminate color collisions during churn.
- Stores each client's last known `(x, y, seq)` coordinate.
- Authoritative presence generation: broadcasts full client rosters on join/leave, ensuring self-healing state across transient network blips.
- Broadcast fan-out: sends payloads once per connection, with optional sender exclusion (prevents echo loops).

#### `server/src/server.ts` (Transport & Network Lifecycle Layer)
- Minimal HTTP/WebSocket server listening on port 8080 (or `process.env.PORT`).
- Transport-level heartbeat: sends RFC 6455 `ws.ping()` frames every 10 seconds. Terminate dead sockets if unanswered across two consecutive cycles (~20s).
- Routes validated messages to `Room`.

---

### Client Architecture

#### `client/src/connection.ts` (Transport Layer)
- Encapsulates the native browser `WebSocket` object.
- Manages connection status (`connecting`, `connected`, `reconnecting`, `disconnected`, `error`).
- Implements bounded exponential backoff reconnection (base 1000ms, factor 1.5, max 6000ms, cap 5 attempts).
- Re-exposes incoming messages through clean callback subscriptions (`onWelcome`, `onPresenceUpdate`, `onSnapshot`, `onCursorMove`, `onReaction`).
- Zero DOM manipulation and zero UI rendering.

#### `client/src/interpolation.ts` (Interpolation & Jitter Engine)
- Solves network update irregularity by maintaining a 100ms playback buffer (~3x the 33ms send rate).
- Evaluates `lerp(from, to, progress)` continuously on every animation frame.
- Sequence ordering: tracks `lastAppliedCursorSeq` per client. Discards older/duplicate packets arriving out of order.
- Late-join snapshot initialization: populates initial cursor positions instantly without waiting for participants to move their mouse.

#### `client/src/render.ts` (Pure Rendering Layer)
- SVG cursor arrow component with precision tip compensation (`left: -5.5px, top: -3.5px`), aligning the arrow tip to the coordinate point.
- High-contrast monospace client ID badge adjacent to the pointer tip.
- Discrete CSS keyframe burst animation for reactions (`emojiBurst`).
- Automatically injects required global CSS tokens and resets.

#### `client/src/App.tsx` (Application & Interaction Layer)
- Coordinates `CursorWireConnection`, `CursorInterpolationManager`, and `render.ts`.
- Captures native mouse movements, throttles them to ~30Hz (33ms interval), and transmits sequence-stamped `cursor-move` packets.
- Listens to canvas clicks to dispatch reactions.
- Provides keyboard shortcuts (Keys `1`–`5`) for reaction tool switching.
- Renders the docked engineering header and full-width bottom status telemetry bar.

---

## 3. End-to-End Data Flow

```
[Local Mouse Move]
       │
       ▼
 [App.tsx Throttler] (~30Hz / 33ms)
       │
       ▼
[connection.ts sendCursorMove] (RFC 6455 Frame)
       │
       ▼
 [server.ts on('message')] ──> [protocol.ts validateMessage]
                                           │ (valid)
                                           ▼
                                [room.ts updateCursor]
                                           │
                                           ▼
                              [room.ts broadcast(excludeSender)]
                                           │
                                ┌──────────┴──────────┐
                                ▼                     ▼
                       [Client B WebSocket]  [Client C WebSocket]
                                │                     │
                                ▼                     ▼
                       [connection.ts]       [connection.ts]
                                │                     │
                                ▼                     ▼
                     [interpolation.ts]    [interpolation.ts]
                     (Push target & seq)   (Push target & seq)
                                │                     │
                                ▼                     ▼
                     [rAF Render Loop]     [rAF Render Loop]
                                │                     │
                                ▼                     ▼
                       [render.ts / DOM]     [render.ts / DOM]
```

---

## 4. State Ownership Matrix

| State Component | Owner / Authoritative Source | Relay Mechanism | Fallback / Healing |
|---|---|---|---|
| **Client ID & Color** | Server (`room.ts`) | `welcome` & `presence-update` | Assigned on join, cleared on disconnect |
| **Room Presence Roster** | Server (`room.ts`) | Full roster broadcast on join/leave | Full list overwrite prevents zombie cursors |
| **Last Known Cursor Positions** | Server (`room.ts`) | `presence-snapshot` on join | Initialized immediately on connection |
| **Active Cursor Coordinates** | Client (`App.tsx`) | 30Hz throttled `cursor-move` | Interpolated via `interpolation.ts` LERP |
| **Reactions (Emoji Bursts)** | Client (`App.tsx`) | Broadcast to all including sender | 900ms self-cleanup timer per burst |

---

## 5. Network Budget & Performance Profile

- **Cursor Update Frequency:** ~30Hz (capped at 33ms intervals).
- **Packet Size:**
  - Outgoing `cursor-move`: `{"type":"cursor-move","x":842,"y":319,"seq":142}` ≈ 52 bytes.
  - Server-stamped broadcast: `{"type":"cursor-move","id":"60b48ec0","x":842,"y":319,"seq":142}` ≈ 68 bytes.
- **Bandwidth per client at 30Hz:**
  - Upstream: 30 × 52 B/s ≈ 1.56 KB/s.
  - Downstream (N clients active): 30 × (N - 1) × 68 B/s.
  - For 5 simultaneous active clients: Downstream ≈ 8.16 KB/s (negligible).
- **Latency vs. Smoothness:**
  - 100ms LERP buffer introduces a deliberate 100ms visual buffer delay.
  - In exchange, cursor trajectory remains fluid and free of teleporting even with ±40ms network jitter.

---

## 6. Extensibility: Adding a New Action Type

The modular architecture allows adding new real-time actions (e.g. `laser-pointer` or `canvas-draw`) without modifying transport code:

1. **Add Type to `server/src/protocol.ts`:**
   ```ts
   export interface LaserPointerMessage {
     type: 'laser-pointer';
     id?: string;
     x: number;
     y: number;
     active: boolean;
   }
   ```
   Add to `SocketMessage` union and add branch in `validateMessage()`.

2. **Handle in `server/src/server.ts`:**
   ```ts
   if (message.type === 'laser-pointer') {
     room.broadcast({ ...message, id: clientId }, clientId);
     return;
   }
   ```

3. **Expose Callback in `client/src/connection.ts`:**
   Add `onLaserPointer?: (msg: LaserPointerMessage) => void` in `ConnectionCallbacks`. The WebSocket transport plumbing remains untouched.

4. **Render in `client/src/render.ts` & `App.tsx`:**
   Implement drawing helper in `render.ts` and attach mouse listener in `App.tsx`.
