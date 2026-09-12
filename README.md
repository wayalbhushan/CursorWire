# CursorWire — Real-Time Multiplayer Cursor & State Sync Engine

CursorWire is an interactive, multi-client real-time state synchronization engine built from scratch on **raw WebSockets** (RFC 6455).

No socket libraries, state-sync frameworks, or hosted real-time services (Socket.IO, Yjs, Liveblocks, PartyKit, Ably, Pusher) were used. The client runs on native browser `WebSocket` APIs, and the server is a minimal Node.js process using `ws` strictly for the low-level connection framing layer.

---

## 1. Quick Start & Setup Instructions

### Prerequisites
- Node.js 18+ (tested on Node 20 / 22)
- npm

### 1. Start the WebSocket Server
```bash
cd server
npm install
npm run dev
```
The server will start listening at `ws://localhost:8080`.

### 2. Start the Client Application
Open a new terminal:
```bash
cd client
npm install
npm run dev
```
Vite will boot the client at `http://localhost:5173`.

### 3. Simulating Multi-Client Sessions
1. Open `http://localhost:5173` across **3–5 separate browser tabs or windows** (or side-by-side split screens).
2. Move your mouse in any window: watch other clients see your cursor track smoothly in real-time with your assigned distinct color badge.
3. Click anywhere on the dark canvas or press keys **1–5** to burst reactions (`🔥`, `❤️`, `🎉`, `👏`, `🚀`).
4. Close a tab: the client immediately disappears from the presence roster in remaining tabs without leaving zombie cursors.

---

## 2. Wire Protocol Design

All communication uses JSON frames with a strict discriminated union pattern keyed on the `type` property.

### Message Types & Schemas

| Message Type | Direction | Payload Schema | Purpose |
|---|---|---|---|
| `welcome` | Server → Client | `{ type: 'welcome', id: string, color: string }` | Assigns unique 8-char client ID and assigned color |
| `presence-update` | Server → All | `{ type: 'presence-update', clients: Array<{ id: string, color: string }> }` | Authoritative connected client roster |
| `presence-snapshot` | Server → Client | `{ type: 'presence-snapshot', cursors: Array<{ id: string, x: number, y: number, seq: number }> }` | Late-join snapshot of current cursor positions |
| `cursor-move` | Client → Server → Others | `{ type: 'cursor-move', id?: string, x: number, y: number, seq: number }` | 30Hz throttled cursor coordinate update |
| `reaction` | Client → Server → All | `{ type: 'reaction', id?: string, x: number, y: number, emoji: string, seq: number }` | Tap-to-emit discrete reaction burst |
| `leave` | Server → All | `{ type: 'leave', id: string }` | Clean disconnect notification |
| `error` | Server → Client | `{ type: 'error', message: string, reason?: string }` | Rejection of malformed or invalid packets |

### Throttling & Bandwidth Management
- Native browser `mousemove` events fire at 60Hz–120Hz. Transmitting every raw mousemove is wasteful and degrades network performance.
- **Throttling Strategy:** Client outgoing cursor movements are capped at **~30Hz (33.3ms intervals)**.
- If a mousemove occurs before the 33ms window expires, it updates a `pendingPos` buffer. When the timer fires, only the latest position is transmitted.
- This cuts network traffic by 50%–75% while maintaining trajectory fidelity.

---

## 3. Interpolation & Jitter Handling

### Linear Interpolation (LERP) Architecture
Remote cursors do not snap or teleport directly to incoming network coordinates. Instead, they glide using custom linear interpolation driven by a shared `requestAnimationFrame` render loop:

$$\text{curr} = \text{from} + (\text{to} - \text{from}) \times \text{clamp}\left(\frac{\text{elapsed}}{\text{WINDOW}}, 0, 1\right)$$

- **Playback Window:** 100ms (~3× the 33ms send interval).
- When a new coordinate arrives:
  1. The current rendered position becomes the new `from` point.
  2. The newly received coordinate becomes the `to` point.
  3. `startTime` resets to `performance.now()`.
- Positioning is applied using hardware-accelerated `translate3d(x, y, 0)` on an SVG pointer element whose tip is precisely aligned via a fixed `(-5.5px, -3.5px)` offset.

### Latency vs. Smoothness Tradeoff
- **Added Latency:** 100ms visual delay.
- **Measured Benefit:** Total elimination of jitter and stutter under variable packet arrival delays (tested under Chrome DevTools network throttling). The cursor movement appears continuous rather than discrete jumps.

---

## 4. Failure Handling & Resilience

### 1. Disconnect Detection (Transport-Level Heartbeat)
- **Problem:** If a client loses network abruptly (WiFi dies, device sleeps, browser crashes), no clean TCP FIN packet is sent, so `ws.on('close')` never fires.
- **Solution:** The server runs an RFC 6455 transport-level heartbeat ping every 10s (`ws.ping()`). If a socket fails to respond across two consecutive cycles (~20s), the server terminates the dead socket and purges the client from memory.

### 2. Bounded Exponential Backoff Reconnect
- When disconnected unexpectedly, the client automatically attempts reconnection with exponential backoff:
  $$\text{delay} = \min(1000 \times 1.5^{\text{attempt} - 1}, 6000)\text{ ms}$$
- Capped at **5 attempts** to prevent connection spam. If all fail, the UI displays a clean `RECONNECT` button.

### 3. Out-of-Order & Stale Packet Discarding
- Every `cursor-move` and `reaction` message carries a strictly monotonically increasing sequence number (`seq`).
- The client maintains `lastAppliedCursorSeq` and `lastAppliedReactionSeq` per remote peer.
- If an update arrives with `seq <= lastAppliedSeq`, it is discarded immediately, protecting against packet reordering.

### 4. Late-Join Snapshot
- Newcomers receive a `presence-snapshot` immediately upon joining, displaying existing participants' cursors instantly without waiting for them to move their mouse.

### 5. Defensive Validation
- Incoming frames are verified against runtime type guards (`validateMessage`). Malformed JSON, binary frames, negative sequence numbers, or invalid fields are rejected with structured error responses, never crashing the server or client.

---

## 5. Submission File Structure

```
multiplayer-sync-assignment/
├── server/
│   ├── src/
│   │   ├── server.ts
│   │   ├── room.ts
│   │   └── protocol.ts
│   └── package.json
│
├── client/
│   ├── src/
│   │   ├── connection.ts
│   │   ├── interpolation.ts
│   │   ├── render.ts
│   │   └── App.tsx
│   └── package.json
│
├── README.md
└── ARCHITECTURE.md
```

---

## 6. Known Limitations

1. **In-Memory Server State:** Server room state lives in memory (`Map<string, ClientSession>`). Restarting the server resets active sessions.
2. **Single Server Process:** No Redis Pub/Sub or cluster backplane is implemented; clients must connect to the same server instance.
3. **No User Authentication:** Clients are assigned anonymous 8-character hex IDs.

---

## 7. Time Spent & AI Tool Disclosure

- **Total Time Spent:** ~14 hours across architecture, protocol validation, interpolation math, testing, and UI refinement.
- **AI Tool Disclosure:** Antigravity (Advanced Agentic AI by Google DeepMind) was used as a pair-programming assistant for rapid boilerplate generation, cross-browser subagent testing, and documentation formatting. All architectural decisions, protocol validation guards, interpolation formulas, and networking logic were verified and defended line-by-line.
