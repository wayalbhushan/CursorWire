import { useEffect, useState, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { CursorWireConnection, type ConnectionStatus } from './connection.js';
import { CursorInterpolationManager } from './interpolation.js';
import { RemoteCursorView, ReactionBurstView, injectGlobalStyles } from './render.js';
import {
  type ClientInfo,
  type CursorSnapshot,
  type CursorMoveMessage,
  type ReactionMessage,
} from '../../server/src/protocol.js';

const WS_URL = import.meta.env.VITE_WS_URL || 'ws://localhost:8080';
const THROTTLE_INTERVAL_MS = 33; // ~30Hz mouse transmission
const REACTION_EMOJIS = ['🔥', '❤️', '🎉', '👏', '🚀'];

declare global {
  interface Window {
    socket?: WebSocket;
    cursorwireSocket?: WebSocket;
    sendRaw?: (data: unknown) => void;
    injectStaleCursor?: (staleSeq?: number) => void;
    injectStaleReaction?: (staleSeq?: number) => void;
  }
}

interface ActiveReaction {
  key: string;
  id: string;
  x: number;
  y: number;
  emoji: string;
}

export default function App() {
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const [reconnectAttempt, setReconnectAttempt] = useState<number>(0);
  const [myInfo, setMyInfo] = useState<ClientInfo | null>(null);
  const [clients, setClients] = useState<ClientInfo[]>([]);
  const [remoteCursors, setRemoteCursors] = useState<Record<string, { id: string; x: number; y: number }>>({});
  const [reactions, setReactions] = useState<ActiveReaction[]>([]);
  const [selectedEmoji, setSelectedEmoji] = useState<string>('🔥');
  const [discardedStaleCount, setDiscardedStaleCount] = useState<number>(0);
  const [showDevDrawer, setShowDevDrawer] = useState<boolean>(false);
  const [localCoords, setLocalCoords] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [txSeq, setTxSeq] = useState<number>(0);

  // References
  const connectionRef = useRef<CursorWireConnection | null>(null);
  const interpolationRef = useRef<CursorInterpolationManager>(new CursorInterpolationManager());
  const cursorDomRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const myIdRef = useRef<string | null>(null);
  const cursorSeqRef = useRef<number>(0);
  const reactionSeqRef = useRef<number>(0);
  const lastAppliedReactionSeqRef = useRef<Map<string, number>>(new Map());

  // Throttling state
  const lastSendTimeRef = useRef<number>(0);
  const pendingPosRef = useRef<{ x: number; y: number } | null>(null);
  const throttleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    injectGlobalStyles();
  }, []);

  useEffect(() => {
    myIdRef.current = myInfo?.id ?? null;
  }, [myInfo]);

  // Shared requestAnimationFrame render loop driven by interpolation manager
  useEffect(() => {
    let animFrameId: number;

    const renderLoop = () => {
      const now = performance.now();

      interpolationRef.current.step(now, (id, x, y) => {
        const el = cursorDomRefs.current.get(id);
        if (el) {
          el.style.transform = `translate3d(${x}px, ${y}px, 0)`;
        }
      });

      animFrameId = requestAnimationFrame(renderLoop);
    };

    animFrameId = requestAnimationFrame(renderLoop);
    return () => cancelAnimationFrame(animFrameId);
  }, []);

  // Keyboard shortcut listener (keys 1-5)
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

  // Connection Lifecycle
  useEffect(() => {
    const conn = new CursorWireConnection(WS_URL, {
      onStatusChange: (newStatus, attempt) => {
        setStatus(newStatus);
        setReconnectAttempt(attempt);
      },
      onWelcome: (id, color) => {
        myIdRef.current = id;
        setMyInfo({ id, color });
      },
      onPresenceUpdate: (updatedClients) => {
        setClients(updatedClients);
        const activeIds = new Set(updatedClients.map((c) => c.id));
        interpolationRef.current.syncActiveClients(activeIds);

        setRemoteCursors((prev) => {
          const next = { ...prev };
          let changed = false;
          for (const id of Object.keys(next)) {
            if (!activeIds.has(id)) {
              delete next[id];
              cursorDomRefs.current.delete(id);
              lastAppliedReactionSeqRef.current.delete(id);
              changed = true;
            }
          }
          return changed ? next : prev;
        });
      },
      onSnapshot: (cursors: CursorSnapshot[]) => {
        const now = performance.now();
        interpolationRef.current.initSnapshot(cursors, myIdRef.current, now);

        const initialMap: Record<string, { id: string; x: number; y: number }> = {};
        for (const c of cursors) {
          if (c.id !== myIdRef.current) {
            initialMap[c.id] = { id: c.id, x: c.x, y: c.y };
          }
        }
        setRemoteCursors((prev) => ({ ...prev, ...initialMap }));
      },
      onCursorMove: (msg: CursorMoveMessage) => {
        if (!msg.id || msg.id === myIdRef.current) return;

        const accepted = interpolationRef.current.updateTarget(
          msg.id,
          msg.x,
          msg.y,
          msg.seq,
          performance.now()
        );

        if (!accepted) {
          setDiscardedStaleCount((prev) => prev + 1);
          return;
        }

        setRemoteCursors((prev) => ({
          ...prev,
          [msg.id!]: { id: msg.id!, x: msg.x, y: msg.y },
        }));
      },
      onReaction: (msg: ReactionMessage) => {
        const senderId = msg.id || 'unknown';
        const lastSeq = lastAppliedReactionSeqRef.current.get(senderId) ?? -1;
        if (msg.seq <= lastSeq) {
          setDiscardedStaleCount((prev) => prev + 1);
          return;
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
      },
    });

    connectionRef.current = conn;
    conn.connect();

    // Dev test hooks
    if (import.meta.env.DEV) {
      window.socket = conn.getSocket() ?? undefined;
      window.cursorwireSocket = conn.getSocket() ?? undefined;
      window.sendRaw = (data: unknown) => conn.sendRaw(data);
      window.injectStaleCursor = (staleSeq = 1) => {
        conn.sendCursorMove(60, 60, staleSeq);
      };
      window.injectStaleReaction = (staleSeq = 1) => {
        conn.sendReaction(200, 200, '⚠️', staleSeq);
      };
    }

    const transmitCursor = (x: number, y: number) => {
      cursorSeqRef.current += 1;
      setTxSeq(cursorSeqRef.current);
      conn.sendCursorMove(x, y, cursorSeqRef.current);
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
      reactionSeqRef.current += 1;
      conn.sendReaction(
        Math.round(e.clientX),
        Math.round(e.clientY),
        selectedEmoji,
        reactionSeqRef.current
      );
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
      conn.disconnect();
      interpolationRef.current.clear();
      cursorDomRefs.current.clear();
      lastAppliedReactionSeqRef.current.clear();
    };
  }, [selectedEmoji]);

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
      {/* Active Reaction Bursts */}
      {reactions.map((r) => (
        <ReactionBurstView key={r.key} reactionKey={r.key} x={r.x} y={r.y} emoji={r.emoji} />
      ))}

      {/* Remote Cursors (Linear Interpolation) */}
      {Object.values(remoteCursors).map((cursor) => {
        const color = clientColorMap.get(cursor.id) || '#3b82f6';
        return (
          <RemoteCursorView
            key={cursor.id}
            id={cursor.id}
            x={cursor.x}
            y={cursor.y}
            color={color}
            domRef={(el) => {
              if (el) cursorDomRefs.current.set(cursor.id, el);
              else cursorDomRefs.current.delete(cursor.id);
            }}
          />
        );
      })}

      {/* Docked Top App Header */}
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
        <div data-no-burst style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
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

          <div style={{ width: '1px', height: '14px', background: '#222733' }} />

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
                ? `RECONNECTING (${reconnectAttempt}/5)`
                : status.toUpperCase()}
            </span>
          </div>

          {status === 'disconnected' && (
            <button
              type="button"
              onClick={() => connectionRef.current?.manualReconnect()}
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

        {/* Presence Roster */}
        <div data-no-burst style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
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

      {/* Canvas Prompt */}
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

      {/* Reaction Palette */}
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

      {/* Docked Bottom Status Bar */}
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
          <span>
            {WS_URL.startsWith('wss') ? 'WSS' : 'WS'}: {WS_URL.replace(/^wss?:\/\//, '')}
          </span>
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

      {/* Dev Verification Drawer */}
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

// Self-mounting entry point when loaded via index.html
if (typeof document !== 'undefined') {
  const rootElement = document.getElementById('root');
  if (rootElement && !rootElement.hasChildNodes()) {
    createRoot(rootElement).render(<App />);
  }
}
