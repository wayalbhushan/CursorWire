# CursorWire

A real-time multiplayer cursor and reaction sync engine built with TypeScript, Node.js, and React. All synchronization is implemented directly on top of the native browser WebSocket API and a minimal Node server. No real-time synchronization libraries or state frameworks (Socket.IO, Yjs, Liveblocks, PartyKit, Ably, Pusher) are used.

Live demo: [https://cursor-wire.vercel.app/](https://cursor-wire.vercel.app/)  
GitHub: [https://github.com/wayalbhushan/CursorWire.git](https://github.com/wayalbhushan/CursorWire.git)

---

## 1. Setup Instructions

Run these commands from a fresh clone. Node.js 18+ is required.

### 1. Run the WebSocket Server
```bash
cd server
npm install
npm run dev
```
The server listens on `ws://localhost:8080` (or the port specified by `PORT`).

### 2. Run the Client
Open a second terminal window:
```bash
cd client
npm install
npm run dev
```
Vite will start the client at `http://localhost:5173`.

---

## 2. Multi-Client Testing

1. Open `http://localhost:5173` in 3 to 5 separate browser tabs or windows side-by-side.
2. Move the mouse in one tab. Notice the other tabs render that cursor moving with its assigned color and ID.
3. Click anywhere on the canvas or press keys `1` through `5` to emit emoji reaction bursts (`🔥`, `❤️`, `🎉`, `👏`, `🚀`).
4. Close any tab. Within milliseconds, that client's cursor is removed and the presence list in the remaining tabs updates.

---

## 3. Live Demo & Render Cold Starts

- **Production Client (Vercel):** [https://cursor-wire.vercel.app/](https://cursor-wire.vercel.app/)
- **Production Server (Render):** `wss://cursorwire-server.onrender.com`

**Note on Render Free-Tier Cold Starts:**  
Render spins down free-tier web services after 15 minutes of inactivity. If no requests have arrived recently, the server can take 30 to 60 seconds to boot on the initial connection. During this wake-up window, the client status bar will show `RECONNECTING (X/5)` until the socket opens. An automated HTTP ping hits `https://cursorwire-server.onrender.com/health` periodically to reduce idle spin-downs, but cold starts remain a factor when the service is completely dormant.

---

## 4. Wire Protocol

All messages are JSON objects adhering to a discriminated union pattern with a literal `type` string field. Incoming messages are validated using runtime type guards defined in `server/src/protocol.ts`.

| Message Type | Direction | Payload Shape | Description |
|---|---|---|---|
| `welcome` | Server → Client | `{ type: 'welcome', id: string, color: string }` | Sent immediately after connection; assigns client ID and color. |
| `presence-update` | Server → All | `{ type: 'presence-update', clients: Array<{ id: string, color: string }> }` | Authoritative full list of all connected clients in the room. |
| `presence-snapshot` | Server → Client | `{ type: 'presence-snapshot', cursors: Array<{ id: string, x: number, y: number, seq: number }> }` | Initial positions of active peers sent to late-joining clients. |
| `cursor-move` | Client → Server → Others | `{ type: 'cursor-move', id?: string, x: number, y: number, seq: number }` | 30Hz position update. Server overwrites `id` with verified sender ID. |
| `reaction` | Client → Server → All | `{ type: 'reaction', id?: string, x: number, y: number, emoji: string, seq: number }` | Tap-to-emit emoji burst. Broadcast to all clients, including sender. |
| `leave` | Server → All | `{ type: 'leave', id: string }` | Sent on clean disconnect when a specific peer leaves. |
| `error` | Server → Client | `{ type: 'error', message: string, reason?: string }` | Sent when an incoming message fails schema validation. |

---

## 5. Throttling and Batching

Hardware mouse events fire at 60Hz to 120Hz (or higher on gaming mice). Sending every raw event over WebSockets creates unnecessary bandwidth overhead and message queue backlog.

- **Throttling interval:** Outgoing cursor coordinates are capped at **~30Hz (33.3ms intervals)**.
- **Batching mechanism:** When a mouse event occurs inside an active 33ms window, the coordinate is held in a `pendingPos` buffer. When the 33ms timer elapses, only the latest position is transmitted over the socket.
- **Bandwidth reduction:** Throttling cuts message volume by 50% to 75% compared to raw event streaming without visual degradation after interpolation.

---

## 6. Interpolation Strategy

Remote cursors do not jump directly to coordinates as packets arrive. They glide using linear interpolation (LERP) evaluated on every animation frame.

$$\text{pos}(t) = \text{from} + (\text{to} - \text{from}) \times \text{clamp}\left(\frac{t - t_{\text{start}}}{100\text{ ms}}, 0, 1\right)$$

- **Window size:** 100ms playback window (~3x the 33.3ms send interval).
- **Update behavior:** When a new `cursor-move` packet arrives, the client's current rendered position becomes the new `from` coordinate, the incoming coordinate becomes the `to` target, and `startTime` resets to `performance.now()`.
- **Render loop:** A single shared `requestAnimationFrame` loop steps all active remote cursors, writing directly to `transform = translate3d(x, y, 0)` for hardware acceleration.
- **Tradeoff:** The 100ms window introduces a constant 100ms visual lag behind the remote user's real-time input. In return, cursor motion remains fluid even when network packets arrive irregularly with ±30ms jitter.

---

## 7. Failure Handling

### Disconnect Detection (RFC 6455 Heartbeat)
When a tab closes cleanly, the browser sends a WebSocket close frame, triggering the server's `close` event immediately. However, when a connection drops abruptly (power loss, WiFi disconnect, sleep mode), the TCP connection hangs without a clean close frame.
- The server runs a heartbeat loop every 10 seconds.
- It sends a standard WebSocket ping frame (`ws.ping()`) to every client.
- The client automatically responds with an RFC 6455 pong frame, setting `session.isAlive = true`.
- If a client fails to respond across two consecutive heartbeat intervals (~20 seconds total), the server calls `socket.terminate()`, removes the client from memory, and broadcasts an updated presence list.

### Reconnection with Bounded Exponential Backoff
When the socket closes unexpectedly, the client reconnects automatically using exponential backoff:
$$\text{delay} = \min\left(1000 \times 1.5^{\text{attempt} - 1}, 6000\right)\text{ ms}$$
- Capped at **5 attempts** to avoid overloading the server.
- If all 5 attempts fail, status switches to `disconnected` and a manual `RECONNECT` button appears.
- On reconnection, the client joins as a fresh session, receiving a new ID and color. For an ephemeral cursor canvas, re-issuing an identity is preferred over maintaining persistent session tokens, as the previous cursor was already cleaned up.

### Out-of-Order Message Discarding
Packets can arrive out of order over the public internet.
- The client attaches an incrementing integer `seq` to each `cursor-move` and `reaction`.
- Receiving clients maintain independent `lastAppliedCursorSeq` and `lastAppliedReactionSeq` maps per remote peer ID.
- If a message arrives with a sequence number less than or equal to the last applied sequence number for that sender, it is discarded immediately.

---

## 8. Known Limitations

1. **New Identity on Reconnect:** Reconnecting generates a new client ID and color. State is ephemeral and does not persist across server restarts.
2. **Unnormalized Coordinate Space:** Cursors sync in absolute pixel coordinates `(clientX, clientY)`. If two users have drastically different viewport sizes, a remote cursor may appear off-screen.
3. **Single Server Process:** Room state is held in an in-memory `Map`. Multi-node horizontal scaling with a Redis Pub/Sub backplane is not implemented.
4. **No Authentication:** Access is open; users are identified by random 8-character hex IDs.

---

## 9. Time Spent

Approximately **14 hours** spent across 12 structured phases:
- Protocol design and runtime validation schemas: 2.5 hours
- Server room management and broadcast pipeline: 2.0 hours
- Throttling and RAF-driven LERP interpolation: 3.0 hours
- Reactions and CSS burst animations: 1.5 hours
- Sequence ordering and stale packet rejection: 1.0 hour
- Heartbeat ping/pong and backoff reconnection: 1.5 hours
- Late-join snapshots and engineering UI overhaul: 1.5 hours
- Deployment configuration and documentation: 1.0 hour

---

## 10. AI Tool Disclosure

Antigravity (Google DeepMind agentic AI) was used as a development tool during this project. It was utilized for scaffold generation, automated browser subagent testing (verifying multi-client synchronization across tabs), and drafting documentation sections. All architecture decisions, mathematical interpolation formulas, wire protocol schemas, and concurrency controls were verified line-by-line and can be explained and defended during the live interview.
