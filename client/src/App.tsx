import { useEffect, useState, useRef } from 'react';
import {
  parseAndValidateMessage,
  type ClientInfo,
  type CursorMoveMessage,
  type ReactionMessage,
} from '../../shared/protocol.js';

const WS_URL = 'ws://localhost:8080';

// Throttle interval for outgoing mousemove: ~30Hz (approx 33.3ms between messages)
const THROTTLE_INTERVAL_MS = 33;

/**
 * Interpolation Window: 100ms
 *
 * Rationale:
 * 100ms is approximately 3x the 33ms send interval.
 * This 3-packet buffer absorbs typical network jitter, packet clustering, and frame pacing delays
 * without the cursor stalling or jumping.
 *
 * Trade-off:
 * Adds a deliberate ~100ms visual latency in exchange for 60fps/120fps continuous, buttery-smooth
 * linear interpolation without abrupt snapping.
 */
const INTERPOLATION_WINDOW_MS = 100;

// Curated reaction emoji options
const REACTION_EMOJIS = ['🔥', '❤️', '🎉', '👏', '🚀'];

/**
 * Custom linear interpolation (LERP) function:
 * Computes position between start and end based on normalized progress t ∈ [0, 1].
 */
function lerp(start: number, end: number, t: number): number {
  return start + (end - start) * t;
}

declare global {
  interface Window {
    socket?: WebSocket;
    cursorwireSocket?: WebSocket;
    sendRaw?: (data: unknown) => void;
  }
}

interface RemoteCursor {
  id: string;
  x: number;
  y: number;
  seq: number;
}

interface CursorInterpolationState {
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  currX: number;
  currY: number;
  startTime: number;
}

interface ActiveReaction {
  key: string;
  id: string;
  x: number;
  y: number;
  emoji: string;
}

export default function App() {
  const [status, setStatus] = useState<'connecting' | 'connected' | 'disconnected' | 'error'>('connecting');
  const [myInfo, setMyInfo] = useState<ClientInfo | null>(null);
  const [clients, setClients] = useState<ClientInfo[]>([]);
  const [remoteCursors, setRemoteCursors] = useState<Record<string, RemoteCursor>>({});
  const [reactions, setReactions] = useState<ActiveReaction[]>([]);
  const [selectedEmoji, setSelectedEmoji] = useState<string>('🔥');

  // References for socket, client id, and sequence numbers
  const socketRef = useRef<WebSocket | null>(null);
  const myIdRef = useRef<string | null>(null);
  const cursorSeqRef = useRef<number>(0);

  /**
   * Separate sequence counters for cursor movements vs reactions:
   * Cursor movement is high-frequency (~30Hz) continuous streaming where seq numbers are used to
   * discard stale frames. Reactions are discrete user events. Separating them prevents continuous
   * mouse tracking from inflating and desynchronizing the reaction sequence space.
   */
  const reactionSeqRef = useRef<number>(0);
  const selectedEmojiRef = useRef<string>('🔥');

  // Throttling state references (outgoing)
  const lastSendTimeRef = useRef<number>(0);
  const pendingPosRef = useRef<{ x: number; y: number } | null>(null);
  const throttleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Interpolation state references (incoming, driven by requestAnimationFrame)
  const interpolationsRef = useRef<Map<string, CursorInterpolationState>>(new Map());
  const cursorDomRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  useEffect(() => {
    myIdRef.current = myInfo?.id ?? null;
  }, [myInfo]);

  useEffect(() => {
    selectedEmojiRef.current = selectedEmoji;
  }, [selectedEmoji]);

  /**
   * Shared requestAnimationFrame Render Loop for Remote Cursors
   * Runs once per frame (~60Hz / 120Hz / 144Hz depending on monitor refresh rate).
   * Directly updates DOM node transforms using calculated lerp values to prevent React re-render overhead.
   */
  useEffect(() => {
    let animFrameId: number;

    const renderLoop = () => {
      const now = performance.now();

      for (const [id, interp] of interpolationsRef.current.entries()) {
        const elapsed = now - interp.startTime;
        // Clamp progress strictly between 0 and 1
        const progress = Math.min(Math.max(elapsed / INTERPOLATION_WINDOW_MS, 0), 1);

        // Calculate smooth interpolated coordinates using custom lerp
        interp.currX = lerp(interp.fromX, interp.toX, progress);
        interp.currY = lerp(interp.fromY, interp.toY, progress);

        // Apply position directly to DOM element
        const el = cursorDomRefs.current.get(id);
        if (el) {
          el.style.transform = `translate3d(${interp.currX}px, ${interp.currY}px, 0)`;
        }
      }

      animFrameId = requestAnimationFrame(renderLoop);
    };

    animFrameId = requestAnimationFrame(renderLoop);

    return () => {
      cancelAnimationFrame(animFrameId);
    };
  }, []);

  useEffect(() => {
    console.log(`[ws] Connecting to ${WS_URL}...`);
    const socket = new WebSocket(WS_URL);
    socketRef.current = socket;

    // Dev mode console tools
    if (import.meta.env.DEV) {
      window.socket = socket;
      window.cursorwireSocket = socket;
      window.sendRaw = (data: unknown) => {
        if (socket.readyState !== WebSocket.OPEN) {
          console.warn(`[test harness] Cannot send — socket not open (readyState: ${socket.readyState})`);
          return;
        }
        const payload = typeof data === 'string' ? data : JSON.stringify(data);
        socket.send(payload);
        console.log('[test harness] Sent message to server:', payload);
      };
    }

    socket.onopen = () => {
      console.log('[ws] Connected to server');
      setStatus('connected');
    };

    socket.onmessage = (event) => {
      if (typeof event.data !== 'string') {
        console.warn('[ws incoming error] Non-string frame received from server');
        return;
      }

      const result = parseAndValidateMessage(event.data);
      if (!result.success) {
        console.warn(`[ws incoming error] Message rejected: ${result.error}`, event.data);
        return;
      }

      const msg = result.data;

      switch (msg.type) {
        case 'welcome':
          console.log(`[ws] Welcomed as client ${msg.id} with color ${msg.color}`);
          myIdRef.current = msg.id;
          setMyInfo({ id: msg.id, color: msg.color });
          break;

        case 'presence-update': {
          setClients(msg.clients);
          const activeIds = new Set(msg.clients.map((c) => c.id));

          // Cleanup interpolation state for disconnected clients (prevents animation leaks / zombie targets)
          for (const id of Array.from(interpolationsRef.current.keys())) {
            if (!activeIds.has(id)) {
              interpolationsRef.current.delete(id);
              cursorDomRefs.current.delete(id);
            }
          }

          // Cleanup React state
          setRemoteCursors((prev) => {
            const next = { ...prev };
            let changed = false;
            for (const id of Object.keys(next)) {
              if (!activeIds.has(id)) {
                delete next[id];
                changed = true;
              }
            }
            return changed ? next : prev;
          });
          break;
        }

        case 'cursor-move': {
          if (msg.id && msg.id !== myIdRef.current) {
            const now = performance.now();
            const existing = interpolationsRef.current.get(msg.id);

            if (!existing) {
              // First position received for this remote client
              interpolationsRef.current.set(msg.id, {
                fromX: msg.x,
                fromY: msg.y,
                toX: msg.x,
                toY: msg.y,
                currX: msg.x,
                currY: msg.y,
                startTime: now,
              });
            } else {
              // Smooth transition:
              // Ease from current visible interpolated position to the newly received target
              existing.fromX = existing.currX;
              existing.fromY = existing.currY;
              existing.toX = msg.x;
              existing.toY = msg.y;
              existing.startTime = now;
            }

            // Keep React state in sync for DevTools and UI coordinate indicators
            setRemoteCursors((prev) => ({
              ...prev,
              [msg.id!]: {
                id: msg.id!,
                x: msg.x,
                y: msg.y,
                seq: msg.seq,
              },
            }));
          }
          break;
        }

        case 'reaction': {
          // Phase 6: Render incoming reaction burst (including our own echoed reaction)
          const newReaction: ActiveReaction = {
            key: `${msg.id || 'anon'}-${msg.seq}-${Date.now()}-${Math.random()}`,
            id: msg.id || 'unknown',
            x: msg.x,
            y: msg.y,
            emoji: msg.emoji,
          };

          setReactions((prev) => [...prev, newReaction]);

          // Automatically clean up this reaction after animation completes (~900ms)
          setTimeout(() => {
            setReactions((prev) => prev.filter((r) => r.key !== newReaction.key));
          }, 900);
          break;
        }

        case 'error':
          console.warn('[ws] Server reported protocol error:', msg.message, msg.reason);
          break;

        default:
          break;
      }
    };

    socket.onclose = (event) => {
      console.log(`[ws] Disconnected from server (code: ${event.code}, clean: ${event.wasClean})`);
      setStatus('disconnected');
      myIdRef.current = null;
      setMyInfo(null);
      setClients([]);
      setRemoteCursors({});
      setReactions([]);
      interpolationsRef.current.clear();
      cursorDomRefs.current.clear();
    };

    socket.onerror = (error) => {
      console.error('[ws] Socket error observed:', error);
      setStatus('error');
    };

    // Helper to transmit cursor position to server
    const transmitCursor = (x: number, y: number) => {
      if (socket.readyState !== WebSocket.OPEN) return;

      cursorSeqRef.current += 1;
      const msg: CursorMoveMessage = {
        type: 'cursor-move',
        x,
        y,
        seq: cursorSeqRef.current,
      };
      socket.send(JSON.stringify(msg));
      lastSendTimeRef.current = performance.now();
    };

    /**
     * Mousemove handler with strict ~30Hz (33ms) throttling.
     * Combines immediate leading-edge transmission with trailing-edge delivery
     * so that the final resting position of the mouse is never lost.
     */
    const handleMouseMove = (e: MouseEvent) => {
      const x = Math.round(e.clientX);
      const y = Math.round(e.clientY);
      const now = performance.now();
      const elapsed = now - lastSendTimeRef.current;

      if (elapsed >= THROTTLE_INTERVAL_MS) {
        if (throttleTimerRef.current) {
          clearTimeout(throttleTimerRef.current);
          throttleTimerRef.current = null;
        }
        pendingPosRef.current = null;
        transmitCursor(x, y);
      } else {
        pendingPosRef.current = { x, y };
        if (!throttleTimerRef.current) {
          const remainingDelay = THROTTLE_INTERVAL_MS - elapsed;
          throttleTimerRef.current = setTimeout(() => {
            throttleTimerRef.current = null;
            if (pendingPosRef.current) {
              transmitCursor(pendingPosRef.current.x, pendingPosRef.current.y);
              pendingPosRef.current = null;
            }
          }, remainingDelay);
        }
      }
    };

    /**
     * Click handler to emit reaction burst.
     * Ignores clicks on interactive UI controls (buttons, inputs, links).
     */
    const handleCanvasClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && target.closest('button, a, input, select, textarea, [role="button"]')) {
        return;
      }

      if (socket.readyState !== WebSocket.OPEN) return;

      reactionSeqRef.current += 1;
      const reactionMsg: ReactionMessage = {
        type: 'reaction',
        x: Math.round(e.clientX),
        y: Math.round(e.clientY),
        emoji: selectedEmojiRef.current,
        seq: reactionSeqRef.current,
      };
      socket.send(JSON.stringify(reactionMsg));
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('click', handleCanvasClick);

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('click', handleCanvasClick);
      if (throttleTimerRef.current) {
        clearTimeout(throttleTimerRef.current);
        throttleTimerRef.current = null;
      }
      if (window.socket === socket) {
        delete window.socket;
        delete window.cursorwireSocket;
        delete window.sendRaw;
      }
      socket.close();
    };
  }, []);

  const clientColorMap = new Map<string, string>(clients.map((c) => [c.id, c.color]));

  return (
    <div
      style={{
        minHeight: '100vh',
        width: '100vw',
        padding: '2rem',
        boxSizing: 'border-box',
        fontFamily: 'system-ui, -apple-system, sans-serif',
        userSelect: 'none',
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      {/* Active Reactions Layer (Discrete CSS Keyframe Bursts) */}
      {reactions.map((r) => (
        <div
          key={r.key}
          style={{
            position: 'fixed',
            left: `${r.x}px`,
            top: `${r.y}px`,
            pointerEvents: 'none',
            zIndex: 10000,
            fontSize: '32px',
            animation: 'emojiBurst 900ms cubic-bezier(0.16, 1, 0.3, 1) forwards',
            filter: 'drop-shadow(0 4px 10px rgba(0,0,0,0.3))',
            userSelect: 'none',
          }}
        >
          {r.emoji}
        </div>
      ))}

      {/* Remote Cursors Layer (Smooth custom LERP driven by requestAnimationFrame) */}
      {Object.values(remoteCursors).map((cursor) => {
        const color = clientColorMap.get(cursor.id) || '#3b82f6';
        return (
          <div
            key={cursor.id}
            ref={(el) => {
              if (el) {
                cursorDomRefs.current.set(cursor.id, el);
              } else {
                cursorDomRefs.current.delete(cursor.id);
              }
            }}
            style={{
              position: 'fixed',
              left: 0,
              top: 0,
              transform: `translate3d(${cursor.x}px, ${cursor.y}px, 0)`,
              pointerEvents: 'none',
              zIndex: 9999,
              transition: 'none', // Strictly no CSS transition shortcut — driven by custom rAF lerp!
              willChange: 'transform',
            }}
          >
            {/* SVG Cursor Pointer with compensating offset so the visual tip (5.5, 3.5) lands precisely at (0, 0) */}
            <svg
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              style={{
                position: 'absolute',
                left: '-5.5px',
                top: '-3.5px',
                overflow: 'visible',
                filter: 'drop-shadow(0 2px 4px rgba(0,0,0,0.3))',
              }}
            >
              <path
                d="M5.5 3.5L18.5 11L12 13L9 20L5.5 3.5Z"
                fill={color}
                stroke="#ffffff"
                strokeWidth="1.5"
                strokeLinejoin="round"
              />
            </svg>

            {/* Client ID Label Badge: absolutely positioned to prevent any layout shift on the arrow */}
            <div
              style={{
                position: 'absolute',
                left: '14px',
                top: '16px',
                padding: '2px 6px',
                borderRadius: '4px',
                backgroundColor: color,
                color: '#ffffff',
                fontSize: '11px',
                fontWeight: 600,
                letterSpacing: '0.5px',
                boxShadow: '0 2px 4px rgba(0,0,0,0.25)',
                whiteSpace: 'nowrap',
              }}
            >
              {cursor.id}
            </div>
          </div>
        );
      })}

      {/* Main Application Information & Presence UI */}
      <div style={{ maxWidth: '640px' }}>
        <header style={{ marginBottom: '1.5rem', borderBottom: '1px solid #e5e7eb', paddingBottom: '1rem' }}>
          <h1 style={{ margin: '0 0 0.25rem' }}>cursorwire</h1>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', fontSize: '0.95rem' }}>
            <span>Status: <strong style={{ color: status === 'connected' ? '#10b981' : '#ef4444' }}>{status}</strong></span>
            {myInfo && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}>
                • You:
                <span style={{ width: 12, height: 12, borderRadius: '50%', background: myInfo.color, display: 'inline-block' }} />
                <code>{myInfo.id}</code>
              </span>
            )}
          </div>
        </header>

        {/* Phase 6 Reaction Selector Toolbar */}
        <section style={{ padding: '1rem', border: '1px solid #e5e7eb', borderRadius: '8px', background: '#ffffff', marginBottom: '1.5rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.75rem' }}>
            <div>
              <h4 style={{ margin: '0 0 0.25rem', fontSize: '0.95rem' }}>Tap-to-Emit Reaction</h4>
              <p style={{ margin: 0, fontSize: '0.85rem', color: '#6b7280' }}>
                Click anywhere on the screen to burst your reaction to everyone!
              </p>
            </div>
            <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
              {REACTION_EMOJIS.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  onClick={() => setSelectedEmoji(emoji)}
                  style={{
                    fontSize: '1.25rem',
                    padding: '0.35rem 0.55rem',
                    borderRadius: '6px',
                    border: selectedEmoji === emoji ? '2px solid #3b82f6' : '1px solid #e5e7eb',
                    background: selectedEmoji === emoji ? '#eff6ff' : '#ffffff',
                    cursor: 'pointer',
                    transition: 'all 0.15s ease',
                  }}
                  title={`Select ${emoji}`}
                >
                  {emoji}
                </button>
              ))}
            </div>
          </div>
        </section>

        <section style={{ padding: '1.25rem', border: '1px solid #e5e7eb', borderRadius: '8px', background: '#f9fafb', marginBottom: '1.5rem' }}>
          <h3 style={{ margin: '0 0 0.75rem' }}>Active Room Presence ({clients.length})</h3>
          {clients.length === 0 ? (
            <p style={{ margin: 0, color: '#6b7280', fontSize: '0.9rem' }}>Connecting to room...</p>
          ) : (
            <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              {clients.map((client) => {
                const isMe = myInfo?.id === client.id;
                const remote = remoteCursors[client.id];
                return (
                  <li
                    key={client.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.5rem',
                      padding: '0.4rem 0.6rem',
                      background: '#ffffff',
                      borderRadius: '6px',
                      border: isMe ? `1.5px solid ${client.color}` : '1px solid #e5e7eb',
                      fontSize: '0.9rem',
                    }}
                  >
                    <span
                      style={{
                        width: 12,
                        height: 12,
                        borderRadius: '50%',
                        backgroundColor: client.color,
                        flexShrink: 0,
                      }}
                    />
                    <code>{client.id}</code>
                    {isMe ? (
                      <span style={{ fontSize: '0.75rem', fontWeight: 600, color: client.color, marginLeft: 'auto' }}>
                        (you)
                      </span>
                    ) : (
                      <span style={{ fontSize: '0.75rem', color: '#6b7280', marginLeft: 'auto', fontFamily: 'monospace' }}>
                        {remote ? `x: ${remote.x}, y: ${remote.y}` : 'idle'}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section style={{ padding: '1rem', border: '1px solid #e5e7eb', borderRadius: '8px', background: '#ffffff' }}>
          <h4 style={{ margin: '0 0 0.5rem' }}>Phase 6: Multi-client Emoji Bursts Active</h4>
          <p style={{ margin: '0 0 0.5rem', fontSize: '0.85rem', color: '#4b5563' }}>
            Clicking emits an animated emoji burst broadcast to all clients (including sender). Each burst animates and cleans up independently over 900ms without affecting cursor interpolation.
          </p>
          <div style={{ display: 'flex', gap: '1.5rem', fontSize: '0.85rem', color: '#6b7280', flexWrap: 'wrap' }}>
            <div>Cursor seq: <strong>{cursorSeqRef.current}</strong></div>
            <div>Reaction seq: <strong>{reactionSeqRef.current}</strong></div>
            <div>Active reactions: <strong>{reactions.length}</strong></div>
          </div>
        </section>
      </div>
    </div>
  );
}
