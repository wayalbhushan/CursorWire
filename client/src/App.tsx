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
  const [localCoords, setLocalCoords] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [txSeq, setTxSeq] = useState<number>(0);

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

  // Keyboard shortcut listener for reaction switching (keys 1-5)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return;
      }
      const num = parseInt(e.key, 10);
      if (num >= 1 && num <= REACTION_EMOJIS.length) {
        setSelectedEmoji(REACTION_EMOJIS[num - 1]);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

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
      setTxSeq(cursorSeqRef.current);
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
      setLocalCoords({ x, y });
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
        backgroundColor: '#0a0c10',
        backgroundImage: `
          linear-gradient(to right, rgba(255, 255, 255, 0.035) 1px, transparent 1px),
          linear-gradient(to bottom, rgba(255, 255, 255, 0.035) 1px, transparent 1px)
        `,
        backgroundSize: '32px 32px',
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
            filter: 'drop-shadow(0 2px 8px rgba(0,0,0,0.5))',
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
              width="22"
              height="22"
              viewBox="0 0 24 24"
              fill="none"
              style={{
                position: 'absolute',
                left: '-5.5px',
                top: '-3.5px',
                overflow: 'visible',
                filter: 'drop-shadow(0 1px 3px rgba(0,0,0,0.4))',
              }}
            >
              <path
                d="M5.5 3.5L18.5 11L12 13L9 20L5.5 3.5Z"
                fill={color}
                stroke="#0a0c10"
                strokeWidth="1.5"
                strokeLinejoin="round"
              />
            </svg>

            {/* Client ID Label: sharp rectangular badge, no pill radius */}
            <div
              style={{
                position: 'absolute',
                left: '12px',
                top: '14px',
                padding: '1px 5px',
                borderRadius: '2px',
                backgroundColor: color,
                color: '#ffffff',
                fontFamily: 'var(--mono)',
                fontSize: '10px',
                fontWeight: 600,
                letterSpacing: '0.4px',
                boxShadow: '0 1px 4px rgba(0,0,0,0.35)',
                whiteSpace: 'nowrap',
              }}
            >
              {cursor.id}
            </div>
          </div>
        );
      })}

      {/* DOCKED TOP BAR: Brand, Connection Telemetry, and Active Peer Roster */}
      <header
        data-no-burst
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          height: '42px',
          background: '#0f1117',
          borderBottom: '1px solid #1e222d',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 16px',
          zIndex: 50,
          userSelect: 'none',
        }}
      >
        {/* Left: Brand Identity + Protocol Tag + Connection Status */}
        <div
          data-no-burst
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
          }}
        >
          <span
            style={{
              fontFamily: 'var(--mono)',
              fontWeight: 700,
              fontSize: '13px',
              letterSpacing: '0.5px',
              color: '#f3f4f6',
            }}
          >
            CURSORWIRE
          </span>

          <span
            style={{
              fontFamily: 'var(--mono)',
              fontSize: '10px',
              color: '#6b7280',
              border: '1px solid #272c38',
              borderRadius: '2px',
              padding: '1px 5px',
              background: '#141720',
            }}
          >
            RAW-WS // V1
          </span>

          <div
            style={{
              width: '1px',
              height: '14px',
              background: '#222733',
            }}
          />

          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              fontFamily: 'var(--mono)',
              fontSize: '11px',
              color: '#9ca3af',
              border: '1px solid #222733',
              borderRadius: '2px',
              padding: '2px 8px',
              background: '#13161f',
            }}
          >
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: '1px',
                backgroundColor:
                  status === 'connected'
                    ? '#10b981'
                    : status === 'reconnecting'
                    ? '#f59e0b'
                    : '#ef4444',
                animation: status === 'connected' ? 'liveDot 2.2s infinite' : 'none',
              }}
            />
            <span>
              {status === 'reconnecting'
                ? `RECONNECTING (${reconnectAttempt}/${MAX_RECONNECT_ATTEMPTS})`
                : status.toUpperCase()}
            </span>
          </div>

          {status === 'disconnected' && (
            <button
              type="button"
              onClick={manualReconnect}
              style={{
                padding: '2px 8px',
                fontFamily: 'var(--mono)',
                fontSize: '11px',
                background: 'rgba(59, 130, 246, 0.1)',
                border: '1px solid #3b82f6',
                color: '#60a5fa',
                borderRadius: '2px',
                cursor: 'pointer',
              }}
            >
              RECONNECT
            </button>
          )}
        </div>

        {/* Right: Connected Peers Roster */}
        <div
          data-no-burst
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
          }}
        >
          <span
            style={{
              fontFamily: 'var(--mono)',
              fontSize: '11px',
              color: '#6b7280',
              textTransform: 'uppercase',
            }}
          >
            PEERS ({clients.length}):
          </span>

          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            {clients.map((client) => {
              const isMe = myInfo?.id === client.id;
              return (
                <div
                  key={client.id}
                  title={`${client.id}${isMe ? ' (local client)' : ''}`}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '5px',
                    fontFamily: 'var(--mono)',
                    fontSize: '11px',
                    padding: '2px 7px',
                    borderRadius: '2px',
                    background: isMe ? 'rgba(255, 255, 255, 0.05)' : '#13161f',
                    border: isMe ? `1px solid ${client.color}` : '1px solid #222733',
                    color: isMe ? '#f3f4f6' : '#9ca3af',
                  }}
                >
                  <span
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: '1px',
                      backgroundColor: client.color,
                    }}
                  />
                  <span>
                    {client.id}
                    {isMe ? ' (YOU)' : ''}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </header>

      {/* CENTER CANVAS PROMPT */}
      <div
        style={{
          position: 'absolute',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          textAlign: 'center',
          pointerEvents: 'none',
          fontFamily: 'var(--mono)',
          fontSize: '11px',
          letterSpacing: '1.5px',
          color: 'rgba(255, 255, 255, 0.12)',
          textTransform: 'uppercase',
          userSelect: 'none',
        }}
      >
        <p style={{ margin: 0, fontWeight: 500 }}>
          Shared Real-Time Canvas · Move to sync · Click to burst reaction
        </p>
      </div>

      {/* REACTION PALETTE DOCK (Clean, professional tool palette above telemetry bar) */}
      <nav
        data-no-burst
        style={{
          position: 'fixed',
          bottom: '36px',
          left: '50%',
          transform: 'translateX(-50%)',
          display: 'flex',
          alignItems: 'center',
          gap: '4px',
          background: '#12141a',
          border: '1px solid #222733',
          padding: '4px 6px',
          borderRadius: '4px',
          boxShadow: '0 4px 16px rgba(0, 0, 0, 0.5)',
          zIndex: 50,
        }}
      >
        <span
          style={{
            fontFamily: 'var(--mono)',
            fontSize: '10px',
            color: '#6b7280',
            padding: '0 6px 0 2px',
            borderRight: '1px solid #222733',
            marginRight: '2px',
          }}
        >
          REACT:
        </span>

        {REACTION_EMOJIS.map((emoji, idx) => {
          const isSelected = selectedEmoji === emoji;
          return (
            <button
              key={emoji}
              type="button"
              onClick={() => setSelectedEmoji(emoji)}
              style={{
                position: 'relative',
                width: '36px',
                height: '34px',
                padding: 0,
                borderRadius: '2px',
                border: isSelected
                  ? `1px solid ${myInfo?.color || '#3b82f6'}`
                  : '1px solid transparent',
                background: isSelected ? 'rgba(255, 255, 255, 0.08)' : 'transparent',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: '18px',
                lineHeight: 1,
              }}
              title={`Reaction [${idx + 1}]: ${emoji}`}
            >
              <span>{emoji}</span>
              <span
                style={{
                  position: 'absolute',
                  top: '1px',
                  right: '2px',
                  fontFamily: 'var(--mono)',
                  fontSize: '8px',
                  color: isSelected ? '#ffffff' : '#6b7280',
                  lineHeight: 1,
                }}
              >
                {idx + 1}
              </span>
            </button>
          );
        })}
      </nav>

      {/* DOCKED BOTTOM STATUS / TELEMETRY BAR (Full width engineering status bar) */}
      <footer
        style={{
          position: 'fixed',
          bottom: 0,
          left: 0,
          right: 0,
          height: '26px',
          background: '#0d0f14',
          borderTop: '1px solid #1e222d',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 14px',
          fontFamily: 'var(--mono)',
          fontSize: '11px',
          color: '#6b7280',
          zIndex: 45,
          userSelect: 'none',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <span>PORT: 8080 (WS)</span>
          <span style={{ color: '#272c38' }}>|</span>
          <span>RATE: 30HZ THROTTLED</span>
          <span style={{ color: '#272c38' }}>|</span>
          <span>INTERP: 100MS LERP</span>
          <span style={{ color: '#272c38' }}>|</span>
          <span>TX SEQ: #{txSeq}</span>
          <span style={{ color: '#272c38' }}>|</span>
          <span>
            DROPPED STALE:{' '}
            <strong style={{ color: discardedStaleCount > 0 ? '#f59e0b' : '#6b7280' }}>
              {discardedStaleCount}
            </strong>
          </span>
          <span style={{ color: '#272c38' }}>|</span>
          <span>
            POS: X:{localCoords.x} Y:{localCoords.y}
          </span>
        </div>

        {/* Right side of status bar: Dev drawer toggle */}
        {import.meta.env.DEV && (
          <div data-no-burst style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <button
              type="button"
              onClick={() => setShowDevDrawer(!showDevDrawer)}
              style={{
                fontFamily: 'var(--mono)',
                fontSize: '10px',
                padding: '1px 6px',
                background: showDevDrawer ? 'rgba(59, 130, 246, 0.15)' : 'transparent',
                border: '1px solid #2a313d',
                borderRadius: '2px',
                color: showDevDrawer ? '#60a5fa' : '#9ca3af',
                cursor: 'pointer',
              }}
            >
              {showDevDrawer ? '✕ CLOSE DEV' : '⚙ DEV TOOLS'}
            </button>
          </div>
        )}
      </footer>

      {/* DEV TOOLS DRAWER (Anchored above status bar) */}
      {import.meta.env.DEV && showDevDrawer && (
        <div
          data-no-burst
          style={{
            position: 'fixed',
            bottom: '32px',
            right: '12px',
            width: '280px',
            background: '#12141a',
            border: '1px solid #222733',
            borderRadius: '4px',
            padding: '12px',
            boxShadow: '0 8px 24px rgba(0, 0, 0, 0.6)',
            fontSize: '11px',
            color: '#d1d5db',
            zIndex: 60,
          }}
        >
          <div
            style={{
              fontFamily: 'var(--mono)',
              fontWeight: 600,
              marginBottom: '8px',
              color: '#f3f4f6',
              fontSize: '11px',
              borderBottom: '1px solid #1e222d',
              paddingBottom: '4px',
            }}
          >
            DEV VERIFICATION CONTROLS
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '8px' }}>
            <button
              type="button"
              onClick={() => window.injectStaleCursor?.(1)}
              style={{
                padding: '4px 8px',
                background: 'rgba(245, 158, 11, 0.12)',
                border: '1px solid rgba(245, 158, 11, 0.35)',
                color: '#fbbf24',
                borderRadius: '2px',
                cursor: 'pointer',
                textAlign: 'left',
                fontFamily: 'var(--mono)',
                fontSize: '10px',
              }}
            >
              Inject Stale Cursor (seq: 1)
            </button>
            <button
              type="button"
              onClick={() => window.injectStaleReaction?.(1)}
              style={{
                padding: '4px 8px',
                background: 'rgba(245, 158, 11, 0.12)',
                border: '1px solid rgba(245, 158, 11, 0.35)',
                color: '#fbbf24',
                borderRadius: '2px',
                cursor: 'pointer',
                textAlign: 'left',
                fontFamily: 'var(--mono)',
                fontSize: '10px',
              }}
            >
              Inject Stale Reaction (seq: 1)
            </button>
          </div>
          <div
            style={{
              borderTop: '1px solid #1e222d',
              paddingTop: '6px',
              fontFamily: 'var(--mono)',
              fontSize: '10px',
              color: '#9ca3af',
            }}
          >
            <div>
              Stale packets dropped:{' '}
              <strong style={{ color: discardedStaleCount > 0 ? '#ef4444' : '#10b981' }}>
                {discardedStaleCount}
              </strong>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

