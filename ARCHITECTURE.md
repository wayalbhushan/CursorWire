# System Architecture & Technical Specifications

This document outlines the architectural decisions, component boundaries, data flow pipelines, state ownership models, and extensibility considerations of **CursorWire**.

---

## 1. End-to-End Data Flow Pipeline

The following ASCII diagram illustrates the path of a cursor movement event from local hardware input to remote screen rendering:

```
[User moves mouse]
       │
       ▼
[client/src/App.tsx: handleMouseMove]
       │
       ▼ (Check: elapsed >= 33ms?)
  ┌────┴───────────────────────────┐
  │ YES                            │ NO
  ▼                                ▼
[Transmit immediately]        [Buffer in pendingPosRef]
       │                           │
       │                      (Timer expires after remaining ms)
       │                           │
       └───────────────────────────┘
                     │
                     ▼
       [client/src/connection.ts: sendCursorMove]
                     │ (JSON payload + sequence stamp)
                     ▼
         [Browser WebSocket API: ws.send()]
                     │
                     │ (RFC 6455 Frame over TCP)
                     ▼
         [server/src/server.ts: wss.on('message')]
                     │
                     ▼
       [server/src/protocol.ts: parseAndValidateMessage]
                     │
        ┌────────────┴────────────┐
        │ Valid?                  │ Malformed?
        ▼                         ▼
   [Extract data]           [Send error frame to client & discard]
        │
        ▼
   [server/src/room.ts: updateCursor]
        │ (Record position in memory for late-join snapshot)
        ▼
   [server/src/room.ts: broadcast]
        │ (Stamp authenticated sender ID; exclude sender socket)
        ▼
   [Remote Clients: ws.onmessage]
        │
        ▼
   [client/src/connection.ts: parseAndValidateMessage]
        │
        ▼
   [client/src/interpolation.ts: updateTarget]
        │
        ▼ (Check: incoming seq > lastAppliedSeq?)
   ┌────┴───────────────────────────┐
   │ YES                            │ NO (Out-of-order or duplicate)
   ▼                                ▼
[Update LERP target & reset timer] [Increment discarded counter & drop]
   │
   ▼
[client/src/App.tsx: requestAnimationFrame Render Loop]
   │
   ▼
[client/src/interpolation.ts: step]
   │ (Evaluate LERP progress: progress = elapsed / 100ms)
   ▼
[client/src/render.ts: translate3d(x, y, 0)]
   │
   ▼
[GPU Composite & Display]
```

---

## 2. Use of the 'ws' Package on the Server

The assignment specification prohibits state-sync and socket libraries (Socket.IO, Yjs, Liveblocks, PartyKit, Ably, Pusher), while requiring a minimal Node.js server.

We use the npm `ws` package on the server **strictly as an RFC 6455 protocol transport framing library**, for the following technical reasons:
1. **Node.js lacks built-in WebSocket server primitives:** Unlike modern browsers which have `window.WebSocket`, Node's standard library does not ship with a stable, native WebSocket server engine.
2. **RFC 6455 Protocol Framing:** WebSockets require a SHA-1 `Sec-WebSocket-Accept` handshake hash, byte-level bit-masking for client-to-server frames, payload length encodings (7-bit, 16-bit, 64-bit), and frame fragmentation handling. Re-implementing TCP frame parsing from scratch introduces significant socket-level bugs unrelated to state synchronization.
3. **Zero Sync Logic in 'ws':** The `ws` library provides raw socket primitives (`ws.send()`, `ws.on('message')`, `ws.ping()`). It contains zero rooms, zero presence, zero serialization, zero throttling, zero validation, and zero state management. Every piece of room management, client tracking, protocol validation, sequence discarding, and broadcast routing is written from scratch in custom TypeScript code.

---

## 3. Separation of Concerns

The project is structured into seven distinct modules across client and server. Each module has a single responsibility and does not cross boundaries:

```
server/src/
├── protocol.ts      # Pure wire schemas, type definitions, and schema validation
├── room.ts          # In-memory presence, color allocation, snapshots, broadcast fanout
└── server.ts        # HTTP entry, WebSocket upgrade handling, RFC 6455 ping/pong heartbeat

client/src/
├── connection.ts    # Client WebSocket transport, exponential backoff, message dispatch
├── interpolation.ts # Linear interpolation math, 100ms jitter buffer, sequence ordering
├── render.ts        # Pure DOM rendering (SVG cursor offsets, reaction burst keyframes)
└── App.tsx          # Application shell, 30Hz event throttling, hotkeys, status bar
```

### Module Responsibilities

- **Transport (`server.ts`, `connection.ts`):** Handles TCP/WebSocket socket state, event listeners, frame transport, and connection lifecycles. Zero awareness of DOM, UI, or interpolation math.
- **Protocol (`protocol.ts`):** Defines the wire contract using TypeScript discriminated unions. Provides runtime type guards ensuring untrusted payloads are rejected safely.
- **Room State (`room.ts`):** Authoritative state store for connected sessions. Manages client identities, collision-free color assignment, and broadcast routing.
- **Interpolation & Ordering (`interpolation.ts`):** Pure mathematical state smoothing over time. Manages sequence numbers and buffer windows. Zero dependency on DOM or WebSockets.
- **Rendering (`render.ts`):** Pure drawing functions. Applies SVG tip offset geometry and handles CSS keyframe animations.
- **Application Orchestration (`App.tsx`):** Glues the modules together. Binds window event listeners, enforces outgoing 30Hz throttling, and coordinates the render loop.

---

## 4. Evaluation Criteria: Deep Technical Analysis

### A. Protocol Design & Bandwidth Budgeting

- **Discriminated Union Structure:** Every packet contains a literal string `type` property. TypeScript discriminates message payloads, ensuring compile-time and runtime type safety.
- **Server-Authoritative Identity:** Clients cannot forge identities. While a client sends `{ type: 'cursor-move', x, y, seq }`, the server overwrites any client-supplied ID with the authenticated session client ID before broadcasting.
- **Bandwidth Consumption:**
  - Raw `mousemove` rate: ~60–120Hz (60–120 packets/sec).
  - Throttled rate: ~30Hz (capped at 33.3ms intervals).
  - Outgoing payload size: ~52 bytes.
  - Upstream network cost per client: $30 \times 52\text{ bytes} \approx 1.56\text{ KB/sec}$.
  - Downstream network cost for $N$ clients: $30 \times (N - 1) \times 68\text{ bytes}$. For 5 clients: $\approx 8.16\text{ KB/sec}$.

### B. Client-Side Interpolation & Jitter Handling

- **Chosen Approach:** Linear interpolation (LERP) between the last known rendered coordinate and the newly received target across a 100ms playback window.
- **Why not Extrapolation (Dead Reckoning)?** Extrapolation predicts future coordinates based on velocity vectors ($\vec{v} = \Delta\vec{x} / \Delta t$). While it eliminates visual latency, human mouse movements involve frequent, erratic direction changes. Extrapolation causes severe overshoot artifacts when the user abruptly stops or reverses direction, requiring sudden snapping corrections. LERP guarantees smooth, trajectory-faithful paths without overshoot.
- **Tradeoff Analysis:** The 100ms window introduces a deliberate 100ms visual buffer delay. In exchange, remote cursor motion remains completely smooth even with variable network arrival intervals of 15ms to 60ms.

### C. Server Correctness & Broadcast Architecture

- **Presence Convergence:** Rather than relying solely on incremental `join` and `leave` delta messages (which can desynchronize if a single packet drops), the server broadcasts the full authoritative client list (`presence-update`) upon any join or leave event. This ensures self-healing state across all clients.
- **$O(N)$ Broadcast Fan-Out:** The server maintains an active socket map. Broadcasting iterates through clients once ($O(N)$ complexity) and serializes the JSON string once per broadcast call, avoiding redundant serialization loops.
- **Self-Echo Suppression (Cursor Movement):** When Client A moves their cursor, the server broadcasts the update to all clients *except* Client A (`excludeId: clientId`). Client A renders their local cursor instantly via native OS mouse events; echoing it back would introduce visual jitter and wasted bandwidth.
- **Intentional Self-Echo (Reactions):** Unlike cursor movement, reactions (`reaction`) are broadcast to **all clients including the sender**. Reactions are discrete events where the sender expects server acknowledgment at the same logical timestamp as other participants. Broadcasting to the sender verifies that the packet traversed the full round-trip pipeline.

---

## 5. Extensibility: Adding a New Action Type

The system's modularity allows adding new interaction types (e.g. a collaborative whiteboard brush or laser pointer) without modifying transport plumbing:

1. **Extend Protocol (`server/src/protocol.ts`):**
   ```ts
   export interface LaserPointerMessage {
     type: 'laser-pointer';
     id?: string;
     x: number;
     y: number;
     active: boolean;
   }
   ```
   Add `LaserPointerMessage` to the `SocketMessage` union and add a validation branch in `validateMessage()`.

2. **Handle Relay in Server (`server/src/server.ts`):**
   ```ts
   if (message.type === 'laser-pointer') {
     room.broadcast({ ...message, id: clientId }, clientId);
     return;
   }
   ```

3. **Subscribe in Client Transport (`client/src/connection.ts`):**
   Add `onLaserPointer?: (msg: LaserPointerMessage) => void` to `ConnectionCallbacks`. The underlying WebSocket connection and reconnect logic remain completely unchanged.

4. **Render in UI (`client/src/render.ts` & `App.tsx`):**
   Add drawing functions in `render.ts` and dispatch `connection.sendLaserPointer(x, y, active)` from event handlers in `App.tsx`.
