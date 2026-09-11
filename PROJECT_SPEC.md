PROMPT 0 — PROJECT SETUP AND SPEC FILE

We are building "cursorwire" — a real-time multiplayer cursor and reaction
sync application, built entirely on raw WebSockets. This is a take-home
assignment for a Software Engineering Intern role at Flam AI. It will be
reviewed by engineers and I will have to defend every part of it live,
including a cold bug-fix, so code must stay simple, readable, and fully
explainable by me — no generated complexity I don't understand.

STEP 1 — Save this entire message as a file at the project root, named
PROJECT_SPEC.md. Do not summarize or shorten it. This file is the source
of truth for the whole project. Before starting any future phase, re-read
PROJECT_SPEC.md first and check the new work against it.

STEP 2 — FULL REQUIREMENTS (verbatim from assignment brief)

Overview:
Build a real-time, multi-client interactive experience — multiple browser
tabs/devices join a shared "room," move cursors, and send reactions, with
all other clients seeing this live and smoothly. No WebSocket libraries,
no state-sync frameworks (Socket.IO, Yjs, Liveblocks, PartyKit, Ably,
Pusher, or any hosted real-time service). Raw WebSockets on the client.
The server may use the 'ws' npm package purely for the WebSocket
handshake/framing layer (this is a stated interpretation, not literally
banned — 'ws' is not in the excluded list and does zero sync/state work,
that is 100% custom).

Core requirements:
1. Real-time sync engine built from scratch — no socket/state-sync
   libraries. Client uses raw WebSocket API. Server is a minimal Node
   process, not a distributed system.
2. Shared cursor/reaction canvas — every client sees every other client's
   cursor live, on a shared canvas or DOM layer. At least one discrete
   reaction (tap-to-emit emoji burst) in addition to continuous cursor
   movement. New clients joining mid-session must see current
   participants' cursors within a reasonable, documented delay.
3. Interpolation and jitter handling — remote cursors must move smoothly
   despite irregular network update intervals, no teleporting/snapping.
   Must implement own interpolation (linear interpolation between last
   two known positions is the planned approach). Document the strategy
   and its latency-vs-smoothness tradeoff.
4. Disconnect/reconnect handling — detect disconnect (heartbeat/ping-pong
   or close/error events), remove cursor within a bounded time. Handle
   reconnect without duplicating cursor or requiring full page reload.
5. Conflict/ordering — messages will arrive out of order over real
   networks. Use sequence numbers or timestamps to discard stale updates.
   Document the approach.
6. Type safety — all client/server message types fully defined and
   validated in TypeScript. Unknown or malformed messages must be
   rejected, never silently accepted or crash the client.

Example demo application must support:
- Multiple simultaneous clients (test with 3-5 tabs minimum) seeing each
  other's cursors live
- At least one reaction type visible to all participants
- A visible client count / presence list
- Graceful behavior on tab close or lost network — no zombie cursors,
  no crash for remaining clients

What is explicitly evaluated (with weights):
- Protocol & sync engine design (35%) — message design, throttling,
  correctness of state relay
- Interpolation & real-time UX (25%) — smoothness under real network
  conditions, sound tradeoffs
- Server correctness (20%) — presence/room management, disconnect
  handling, no broadcast bugs (e.g. no O(n²) rebroadcast, no echoing a
  client's own action back to itself unless intentional)
- Example application (10%) — convincing multi-client demo
- Code quality (10%) — readability, architecture, documentation

What must NOT appear:
- Socket.IO, Yjs, PartyKit, Liveblocks, Ably, Pusher, or any real-time
  sync library/hosted service doing the actual sync work
- Raw, unthrottled mousemove events sent straight to network with no
  batching
- Cursors that visibly teleport/snap
- A server that is a naive broadcast loop with no disconnect cleanup
- Polling (repeated HTTP requests) presented as "real-time"

Documentation required in README.md:
- Setup instructions (running server + opening multiple clients)
- Known limitations, time spent
- Full protocol: message types and shapes, throttling/batching approach
- Interpolation strategy and reasoning, measured/estimated tradeoff
- Failure handling: disconnect, reconnect, out-of-order delivery,
  malformed messages
- Disclosure that Antigravity (AI tool) was used, and for what — this
  is explicitly permitted by the assignment FAQ and does not penalize us

Bonus (optional, attempt only after core is solid):
- Extrapolation instead of only interpolation
- Adaptive throttling based on measured round-trip latency
- Basic reconciliation of simultaneous conflicting actions
- Visualizing per-client latency/jitter in the demo UI
- Written (not implemented) horizontal scaling discussion

Live interview expectations (I must be able to do all of this personally,
without help, afterward):
- Demo multiple live clients interacting simultaneously
- Throttle the network live and explain interpolation behavior under it
- Walk through the message protocol and why it's shaped that way
- Explain step by step what happens when a client's tab closes
- Discuss how this would scale beyond a single server process

Timeline: 3-5 days. Submission: GitHub repo, optional live deployed demo
(must use a host supporting persistent WebSocket connections).

STEP 3 — TECH STACK (final, do not deviate without asking me first)

- Client: Vite + React + TypeScript (my existing stack, no new framework)
- Client-server transport: native browser WebSocket API on the client
- Server: Node.js + TypeScript, using the 'ws' npm package for WebSocket
  handshake/connection handling only — all room state, presence,
  broadcast logic, protocol validation, and message relay is custom code
  I write, not provided by any library
- No state-sync or real-time libraries anywhere in the stack
- Package manager: npm
- Deployment target: client on Vercel, server on Render or Railway
  (needs persistent WebSocket support, not serverless functions)

STEP 4 — BUILD PLAN SUMMARY (detailed phases will come as separate
prompts, one at a time — do not jump ahead)

1. Skeleton — server + client connect over raw WebSocket, no UI
2. Protocol types + validation — reject malformed messages safely
3. Presence/room state — join/leave broadcast, client tracking
4. Raw cursor broadcast — throttled mousemove relay, no smoothing yet
5. Interpolation — rAF-driven linear interpolation for smooth movement
6. Reactions — tap-to-emit emoji burst, broadcast to all
7. Ordering — sequence numbers, discard stale/out-of-order updates
8. Disconnect/reconnect — heartbeat, bounded cursor removal, clean
   reconnect without duplication
9. Late-join snapshot — new client gets current state immediately
10. Styling/polish — presence list, per-client colors, clean layout
11. Deployment — live client + persistent-connection server
12. README.md + ARCHITECTURE.md — full documentation per requirements

STEP 5 — PROJECT SETUP (do this now)

Initialize the project as a simple two-folder structure:

cursorwire/
├── client/      (Vite + React + TypeScript app)
├── server/      (Node + TypeScript WebSocket server)
├── README.md    (placeholder for now)
└── PROJECT_SPEC.md   (this file, saved in step 1)

Set up:
- client/: Vite React-TS template, no extra UI libraries yet
- server/: TypeScript, 'ws' package, ts-node-dev or tsx for local dev
- Root-level .gitignore covering node_modules, dist, .env
- Confirm both client and server run locally and print a simple
  "server listening" / "client loaded" message, with no actual
  WebSocket logic yet — that starts in Phase 1

Do NOT add any sync, state-management, or real-time library. Do NOT
scaffold cursor/reaction/presence logic yet — this prompt is setup only.

use @[Assignment.txt] for verifying everytime that we are doing correctly
 After setup, list out exactly what was installed and the folder
structure created, so I can verify it before we move to Phase 1.
