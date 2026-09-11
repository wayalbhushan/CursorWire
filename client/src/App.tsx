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
 * Interpolation Window: 100ms (~3x the 33ms send interval)
 */
const INTERPOLATION_WINDOW_MS = 100;

// Reconnection policy parameters (Phase 8: Bounded Exponential Backoff)
const MAX_RECONNECT_ATTEMPTS = 5;
const BASE_RECONNECT_DELAY_MS = 1000;

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
    injectStaleCursor?: (staleSeq?: number) => void;
    injectStaleReaction?: (staleSeq?: number) => void;
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
  const [status, setStatus] = useState<'connecting' | 'connected' | 'disconnected' | 'reconnecting' | 'error'>('connecting');
  const [reconnectAttempt, setReconnectAttempt] = useState<number>(0);
  const [myInfo, setMyInfo] = useState<ClientInfo | null>(null);
  const [clients, setClients] = useState<ClientInfo[]>([]);
  const [remoteCursors, setRemoteCursors] = useState<Record<string, RemoteCursor>>({});
  const [reactions, setReactions] = useState<ActiveReaction[]>([]);
  const [selectedEmoji, setSelectedEmoji] = useState<string>('🔥');
  const [discardedStaleCount, setDiscardedStaleCount] = useState<number>(0);
  const [showDevDrawer, setShowDevDrawer] = useState<boolean>(false);

  // References for socket, client id, and sequence numbers
  const socketRef = useRef<WebSocket | null>(null);
  const myIdRef = useRef<string | null>(null);
  const cursorSeqRef = useRef<number>(0);
  const reactionSeqRef = useRef<number>(0);
  const selectedEmojiRef = useRef<string>('🔥');

  // Phase 7: Per-client, per-message-type sequence trackers
  const lastAppliedCursorSeqRef = useRef<Map<string, number>>(new Map());
  const lastAppliedReactionSeqRef = useRef<Map<string, number>>(new Map());

  // Phase 8: Reconnection state tracking
  const reconnectAttemptsRef = useRef<number>(0);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isUnmountingRef = useRef<boolean>(false);

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
   */
  useEffect(() => {
    let animFrameId: number;

    const renderLoop = () => {
      const now = performance.now();

      for (const [id, interp] of interpolationsRef.current.entries()) {
        const elapsed = now - interp.startTime;
        const progress = Math.min(Math.max(elapsed / INTERPOLATION_WINDOW_MS, 0), 1);

        interp.currX = lerp(interp.fromX, interp.toX, progress);
        interp.currY = lerp(interp.fromY, interp.toY, progress);

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

  /**
   * WebSocket Connection Lifecycle with Bounded Reconnect
   */
  useEffect(() => {
    isUnmountingRef.current = false;

    const connect = () => {
      if (isUnmountingRef.current) return;

      const socket = new WebSocket(WS_URL);
      socketRef.current = socket;

      if (import.meta.env.DEV) {
        window.socket = socket;
        window.cursorwireSocket = socket;
        window.sendRaw = (data: unknown) => {
          if (socket.readyState !== WebSocket.OPEN) return;
          const payload = typeof data === 'string' ? data : JSON.stringify(data);
          socket.send(payload);
        };

        window.injectStaleCursor = (staleSeq = 1) => {
          if (socket.readyState !== WebSocket.OPEN) return;
          const msg: CursorMoveMessage = {
            type: 'cursor-move',
            x: 60,
            y: 60,
            seq: staleSeq,
          };
          socket.send(JSON.stringify(msg));
        };

        window.injectStaleReaction = (staleSeq = 1) => {
          if (socket.readyState !== WebSocket.OPEN) return;
          const msg: ReactionMessage = {
            type: 'reaction',
            x: 200,
            y: 200,
            emoji: '⚠️',
            seq: staleSeq,
          };
          socket.send(JSON.stringify(msg));
        };
      }

      socket.onopen = () => {
        setStatus('connected');
        reconnectAttemptsRef.current = 0;
        setReconnectAttempt(0);
        if (reconnectTimeoutRef.current) {
          clearTimeout(reconnectTimeoutRef.current);
          reconnectTimeoutRef.current = null;
        }
      };

      socket.onmessage = (event) => {
        if (typeof event.data !== 'string') return;

        const result = parseAndValidateMessage(event.data);
        if (!result.success) return;

        const msg = result.data;

        switch (msg.type) {
          case 'welcome':
            myIdRef.current = msg.id;
            setMyInfo({ id: msg.id, color: msg.color });
            break;

          case 'presence-update': {
            setClients(msg.clients);
            const activeIds = new Set(msg.clients.map((c) => c.id));

            for (const id of Array.from(interpolationsRef.current.keys())) {
              if (!activeIds.has(id)) {
                interpolationsRef.current.delete(id);
                cursorDomRefs.current.delete(id);
                lastAppliedCursorSeqRef.current.delete(id);
                lastAppliedReactionSeqRef.current.delete(id);
              }
            }

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

          case 'presence-snapshot': {
            const now = performance.now();
            const initialRemoteCursors: Record<string, RemoteCursor> = {};

            for (const cursor of msg.cursors) {
              if (cursor.id === myIdRef.current) continue;

              interpolationsRef.current.set(cursor.id, {
                fromX: cursor.x,
                fromY: cursor.y,
                toX: cursor.x,
                toY: cursor.y,
                currX: cursor.x,
                currY: cursor.y,
                startTime: now,
              });

              lastAppliedCursorSeqRef.current.set(cursor.id, cursor.seq);

              initialRemoteCursors[cursor.id] = {
                id: cursor.id,
                x: cursor.x,
                y: cursor.y,
                seq: cursor.seq,
              };
            }

            setRemoteCursors((prev) => ({
              ...prev,
              ...initialRemoteCursors,
            }));
            break;
          }

          case 'cursor-move': {
            if (!msg.id || msg.id === myIdRef.current) break;

            const lastSeq = lastAppliedCursorSeqRef.current.get(msg.id) ?? -1;
            if (msg.seq <= lastSeq) {
              setDiscardedStaleCount((prev) => prev + 1);
              break;
            }

            lastAppliedCursorSeqRef.current.set(msg.id, msg.seq);

            const now = performance.now();
            const existing = interpolationsRef.current.get(msg.id);

            if (!existing) {
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
              existing.fromX = existing.currX;
              existing.fromY = existing.currY;
              existing.toX = msg.x;
              existing.toY = msg.y;
              existing.startTime = now;
            }

            setRemoteCursors((prev) => ({
              ...prev,
              [msg.id!]: {
                id: msg.id!,
                x: msg.x,
                y: msg.y,
                seq: msg.seq,
              },
            }));
            break;
          }

          case 'reaction': {
            const senderId = msg.id || 'unknown';

            const lastSeq = lastAppliedReactionSeqRef.current.get(senderId) ?? -1;
            if (msg.seq <= lastSeq) {
              setDiscardedStaleCount((prev) => prev + 1);
              break;
            }

            lastAppliedReactionSeqRef.current.set(senderId, msg.seq);

            const newReaction: ActiveReaction = {
              key: `${senderId}-${msg.seq}-${Date.now()}-${Math.random()}`,
              id: senderId,
              x: msg.x,
              y: msg.y,
              emoji: msg.emoji,
            };

            setReactions((prev) => [...prev, newReaction]);

            setTimeout(() => {
              setReactions((prev) => prev.filter((r) => r.key !== newReaction.key));
            }, 900);
            break;
          }

          default:
            break;
        }
      };

      socket.onclose = () => {
        myIdRef.current = null;
        setMyInfo(null);
        setClients([]);
        setRemoteCursors({});
        setReactions([]);
        interpolationsRef.current.clear();
        cursorDomRefs.current.clear();
        lastAppliedCursorSeqRef.current.clear();
        lastAppliedReactionSeqRef.current.clear();

        if (isUnmountingRef.current) {
          setStatus('disconnected');
          return;
        }

        if (reconnectAttemptsRef.current < MAX_RECONNECT_ATTEMPTS) {
          reconnectAttemptsRef.current += 1;
          setReconnectAttempt(reconnectAttemptsRef.current);
          setStatus('reconnecting');

          const delay = Math.min(
            BASE_RECONNECT_DELAY_MS * Math.pow(1.5, reconnectAttemptsRef.current - 1),
            6000
          );
          reconnectTimeoutRef.current = setTimeout(connect, delay);
        } else {
          setStatus('disconnected');
        }
      };

      socket.onerror = () => {};
    };

    connect();

    const transmitCursor = (x: number, y: number) => {
      if (!socketRef.current || socketRef.current.readyState !== WebSocket.OPEN) return;

      cursorSeqRef.current += 1;
      const msg: CursorMoveMessage = {
        type: 'cursor-move',
        x,
        y,
        seq: cursorSeqRef.current,
      };
      socketRef.current.send(JSON.stringify(msg));
      lastSendTimeRef.current = performance.now();
    };

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

    const handleCanvasClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && target.closest('button, a, input, select, textarea, [role="button"], [data-no-burst]')) {
        return;
      }

      if (!socketRef.current || socketRef.current.readyState !== WebSocket.OPEN) return;

      reactionSeqRef.current += 1;
      const reactionMsg: ReactionMessage = {
        type: 'reaction',
        x: Math.round(e.clientX),
        y: Math.round(e.clientY),
        emoji: selectedEmojiRef.current,
        seq: reactionSeqRef.current,
      };
      socketRef.current.send(JSON.stringify(reactionMsg));
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('click', handleCanvasClick);

    return () => {
      isUnmountingRef.current = true;
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('click', handleCanvasClick);

      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
      if (throttleTimerRef.current) {
        clearTimeout(throttleTimerRef.current);
        throttleTimerRef.current = null;
      }
      if (window.socket === socketRef.current) {
        delete window.socket;
        delete window.cursorwireSocket;
        delete window.sendRaw;
        delete window.injectStaleCursor;
        delete window.injectStaleReaction;
      }
      if (socketRef.current) {
        socketRef.current.close();
      }
    };
  }, []);

  const manualReconnect = () => {
    reconnectAttemptsRef.current = 0;
    setReconnectAttempt(0);
    setStatus('connecting');
    if (socketRef.current) {
      socketRef.current.close();
    }
    const socket = new WebSocket(WS_URL);
    socketRef.current = socket;
  };

  const clientColorMap = new Map<string, string>(clients.map((c) => [c.id, c.color]));

  return (
    <div
      style={{
        position: 'relative',
        width: '100vw',
        height: '100vh',
        overflow: 'hidden',
        userSelect: 'none',
        backgroundColor: '#090a0f',
        backgroundImage: 'radial-gradient(rgba(255, 255, 255, 0.08) 1px, transparent 1px)',
        backgroundSize: '28px 28px',
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
            fontSize: '34px',
            animation: 'emojiBurst 900ms cubic-bezier(0.16, 1, 0.3, 1) forwards',
            filter: 'drop-shadow(0 4px 12px rgba(0,0,0,0.4))',
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
              transition: 'none',
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

      {/* TOP FLOATING NAV: Brand + Presence Bar */}
      <header
        data-no-burst
        style={{
          position: 'fixed',
          top: '16px',
          left: '20px',
          right: '20px',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          pointerEvents: 'none',
          zIndex: 50,
        }}
      >
        {/* Left: Brand & Status Pill */}
        <div
          data-no-burst
          style={{
            pointerEvents: 'auto',
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            background: 'rgba(18, 20, 29, 0.75)',
            backdropFilter: 'blur(16px)',
            border: '1px solid rgba(255, 255, 255, 0.08)',
            padding: '6px 14px',
            borderRadius: '24px',
          }}
        >
          <span
            style={{
              fontWeight: 700,
              fontSize: '14px',
              letterSpacing: '-0.3px',
              color: '#f9fafb',
            }}
          >
            cursorwire
          </span>

          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              fontSize: '12px',
              color: '#9ca3af',
              borderLeft: '1px solid rgba(255, 255, 255, 0.1)',
              paddingLeft: '10px',
            }}
          >
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: '50%',
                backgroundColor:
                  status === 'connected'
                    ? '#10b981'
                    : status === 'reconnecting'
                    ? '#f59e0b'
                    : '#ef4444',
                animation: status === 'connected' ? 'livePulse 2.5s infinite' : 'none',
              }}
            />
            <span>
              {status === 'reconnecting'
                ? `reconnecting (${reconnectAttempt}/${MAX_RECONNECT_ATTEMPTS})`
                : status}
            </span>
          </div>

          {status === 'disconnected' && (
            <button
              type="button"
              onClick={manualReconnect}
              style={{
                marginLeft: '4px',
                padding: '2px 8px',
                background: '#3b82f6',
                color: '#ffffff',
                border: 'none',
                borderRadius: '12px',
                fontSize: '11px',
                cursor: 'pointer',
              }}
            >
              Reconnect
            </button>
          )}
        </div>

        {/* Right: Presence Pill */}
        <div
          data-no-burst
          style={{
            pointerEvents: 'auto',
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            background: 'rgba(18, 20, 29, 0.75)',
            backdropFilter: 'blur(16px)',
            border: '1px solid rgba(255, 255, 255, 0.08)',
            padding: '6px 12px',
            borderRadius: '24px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', marginRight: '4px' }}>
            {clients.map((client, idx) => {
              const isMe = myInfo?.id === client.id;
              return (
                <div
                  key={client.id}
                  title={`${client.id}${isMe ? ' (you)' : ''}`}
                  style={{
                    width: 22,
                    height: 22,
                    borderRadius: '50%',
                    backgroundColor: client.color,
                    border: '2px solid #090a0f',
                    marginLeft: idx === 0 ? 0 : -6,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: '10px',
                    fontWeight: 700,
                    color: '#ffffff',
                    cursor: 'default',
                    boxShadow: isMe ? `0 0 8px ${client.color}` : 'none',
                  }}
                >
                  {client.id.slice(0, 1).toUpperCase()}
                </div>
              );
            })}
          </div>

          <span style={{ fontSize: '12px', color: '#d1d5db', fontWeight: 500 }}>
            {clients.length} {clients.length === 1 ? 'client' : 'clients'}
          </span>

          {myInfo && (
            <span
              style={{
                fontSize: '11px',
                color: myInfo.color,
                fontWeight: 600,
                background: 'rgba(255, 255, 255, 0.06)',
                padding: '2px 6px',
                borderRadius: '10px',
              }}
            >
              you: {myInfo.id}
            </span>
          )}
        </div>
      </header>

      {/* CENTER HINT WATERMARK */}
      <div
        style={{
          position: 'absolute',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          textAlign: 'center',
          pointerEvents: 'none',
          color: 'rgba(255, 255, 255, 0.16)',
          fontSize: '14px',
          letterSpacing: '0.2px',
        }}
      >
        <p style={{ margin: 0, fontWeight: 500 }}>Move mouse to sync cursor · Click to burst reaction</p>
      </div>

      {/* BOTTOM FLOATING DOCK: Reaction Toolbar */}
      <nav
        data-no-burst
        style={{
          position: 'fixed',
          bottom: '24px',
          left: '50%',
          transform: 'translateX(-50%)',
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          background: 'rgba(18, 20, 29, 0.85)',
          backdropFilter: 'blur(20px)',
          border: '1px solid rgba(255, 255, 255, 0.1)',
          padding: '6px 10px',
          borderRadius: '32px',
          boxShadow: '0 8px 32px rgba(0, 0, 0, 0.5)',
          zIndex: 50,
        }}
      >
        {REACTION_EMOJIS.map((emoji) => {
          const isSelected = selectedEmoji === emoji;
          return (
            <button
              key={emoji}
              type="button"
              onClick={() => setSelectedEmoji(emoji)}
              style={{
                fontSize: '20px',
                padding: '6px 12px',
                borderRadius: '24px',
                border: isSelected ? `1.5px solid ${myInfo?.color || '#3b82f6'}` : '1.5px solid transparent',
                background: isSelected ? 'rgba(255, 255, 255, 0.12)' : 'transparent',
                cursor: 'pointer',
                transition: 'all 0.15s ease',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
              title={`Emit ${emoji}`}
            >
              {emoji}
            </button>
          );
        })}
      </nav>

      {/* BOTTOM-LEFT: Minimal Engineering Telemetry Readout */}
      <footer
        style={{
          position: 'fixed',
          bottom: '16px',
          left: '20px',
          fontFamily: 'var(--mono)',
          fontSize: '11px',
          color: 'rgba(255, 255, 255, 0.3)',
          pointerEvents: 'none',
          zIndex: 40,
        }}
      >
        raw ws · 30Hz throttled · 100ms LERP buffer · seq: {cursorSeqRef.current}
      </footer>

      {/* BOTTOM-RIGHT: Dev Tools Trigger & Drawer (Gated behind import.meta.env.DEV) */}
      {import.meta.env.DEV && (
        <div
          data-no-burst
          style={{
            position: 'fixed',
            bottom: '16px',
            right: '20px',
            zIndex: 60,
          }}
        >
          <button
            type="button"
            onClick={() => setShowDevDrawer(!showDevDrawer)}
            style={{
              padding: '4px 10px',
              fontSize: '11px',
              fontFamily: 'var(--mono)',
              background: 'rgba(18, 20, 29, 0.75)',
              backdropFilter: 'blur(12px)',
              border: '1px solid rgba(255, 255, 255, 0.1)',
              borderRadius: '16px',
              color: 'rgba(255, 255, 255, 0.5)',
              cursor: 'pointer',
            }}
          >
            {showDevDrawer ? '✕ Close Dev' : '⚙ Dev Test'}
          </button>

          {showDevDrawer && (
            <div
              style={{
                position: 'absolute',
                bottom: '36px',
                right: '0',
                width: '280px',
                background: 'rgba(14, 16, 24, 0.95)',
                backdropFilter: 'blur(20px)',
                border: '1px solid rgba(255, 255, 255, 0.12)',
                borderRadius: '12px',
                padding: '12px',
                boxShadow: '0 12px 36px rgba(0, 0, 0, 0.6)',
                fontSize: '11px',
                color: '#d1d5db',
              }}
            >
              <div style={{ fontWeight: 600, marginBottom: '8px', color: '#f3f4f6' }}>Dev Verification Controls</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '8px' }}>
                <button
                  type="button"
                  onClick={() => window.injectStaleCursor?.(1)}
                  style={{
                    padding: '4px 8px',
                    background: 'rgba(245, 158, 11, 0.15)',
                    border: '1px solid rgba(245, 158, 11, 0.4)',
                    color: '#fbbf24',
                    borderRadius: '4px',
                    cursor: 'pointer',
                    textAlign: 'left',
                  }}
                >
                  Inject Stale Cursor (seq: 1)
                </button>
                <button
                  type="button"
                  onClick={() => window.injectStaleReaction?.(1)}
                  style={{
                    padding: '4px 8px',
                    background: 'rgba(245, 158, 11, 0.15)',
                    border: '1px solid rgba(245, 158, 11, 0.4)',
                    color: '#fbbf24',
                    borderRadius: '4px',
                    cursor: 'pointer',
                    textAlign: 'left',
                  }}
                >
                  Inject Stale Reaction (seq: 1)
                </button>
              </div>
              <div style={{ borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: '6px', color: '#9ca3af' }}>
                <div>Stale packets dropped: <strong style={{ color: discardedStaleCount > 0 ? '#ef4444' : '#10b981' }}>{discardedStaleCount}</strong></div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
