import { useEffect, useState, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import './App.css';
import {
  CursorWireConnection,
  type ConnectionStatus,
  type ClientInfo,
  type CursorSnapshot,
  type CursorMoveMessage,
  type ReactionMessage,
} from './connection.js';
import { CursorInterpolationManager } from './interpolation.js';
import { RemoteCursorView, ReactionBurstView } from './render.js';
import { TopBar } from './components/TopBar.js';
import { PresenceRoster } from './components/PresenceRoster.js';
import { CanvasPrompt } from './components/CanvasPrompt.js';
import { ReactionDock } from './components/ReactionDock.js';
import { EngineeringReadout } from './components/EngineeringReadout.js';
import { DevToolsDrawer } from './components/DevToolsDrawer.js';

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
  const selectedEmojiRef = useRef<string>(selectedEmoji);
  selectedEmojiRef.current = selectedEmoji;
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
        selectedEmojiRef.current,
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
  }, []);

  const clientColorMap = new Map<string, string>(clients.map((c) => [c.id, c.color]));

  return (
    <div className="app-canvas">
      {/* Active Reaction Bursts */}
      {reactions.map((r) => (
        <ReactionBurstView key={r.key} reactionKey={r.key} x={r.x} y={r.y} emoji={r.emoji} />
      ))}

      {/* Remote Cursors (Linear Interpolation) */}
      {Object.values(remoteCursors).map((cursor) => (
        <RemoteCursorView
          key={cursor.id}
          id={cursor.id}
          x={cursor.x}
          y={cursor.y}
          color={clientColorMap.get(cursor.id) || '#3b82f6'}
          domRef={(el) => {
            if (el) cursorDomRefs.current.set(cursor.id, el);
            else cursorDomRefs.current.delete(cursor.id);
          }}
        />
      ))}

      {/* Docked Top App Header */}
      <TopBar
        status={status}
        reconnectAttempt={reconnectAttempt}
        onManualReconnect={() => connectionRef.current?.manualReconnect()}
      >
        <PresenceRoster clients={clients} myId={myInfo?.id ?? null} />
      </TopBar>

      {/* Canvas Prompt */}
      <CanvasPrompt />

      {/* Reaction Palette Dock */}
      <ReactionDock
        selectedEmoji={selectedEmoji}
        onSelect={setSelectedEmoji}
        emojis={REACTION_EMOJIS}
        accentColor={myInfo?.color}
      />

      {/* Docked Bottom Status Bar */}
      <EngineeringReadout
        wsUrl={WS_URL}
        discardedStaleCount={discardedStaleCount}
        txSeq={txSeq}
        localCoords={localCoords}
      >
        {import.meta.env.DEV && (
          <button
            type="button"
            className={`dev-tools-toggle ${showDevDrawer ? 'dev-tools-toggle--active' : ''}`}
            onClick={() => setShowDevDrawer(!showDevDrawer)}
          >
            {showDevDrawer ? '✕ CLOSE DEV' : '⚙ DEV TOOLS'}
          </button>
        )}
      </EngineeringReadout>

      {/* Dev Verification Drawer */}
      {import.meta.env.DEV && (
        <DevToolsDrawer
          isOpen={showDevDrawer}
          onToggle={() => setShowDevDrawer(!showDevDrawer)}
          discardedStaleCount={discardedStaleCount}
          injectStaleCursor={(seq = 1) => connectionRef.current?.sendCursorMove(60, 60, seq)}
          injectStaleReaction={(seq = 1) => connectionRef.current?.sendReaction(200, 200, '⚠️', seq)}
        />
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
