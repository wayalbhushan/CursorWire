import React from 'react';

export interface RemoteCursorProps {
  id: string;
  x: number;
  y: number;
  color: string;
  domRef: (el: HTMLDivElement | null) => void;
}

/**
 * Pure rendering component for remote cursor pointers.
 * SVG tip is mathematically offset by (-5.5px, -3.5px) so the visual tip lands on (0, 0).
 */
export const RemoteCursorView: React.FC<RemoteCursorProps> = ({ id, x, y, color, domRef }) => {
  return (
    <div
      ref={domRef}
      style={{
        position: 'fixed',
        left: 0,
        top: 0,
        transform: `translate3d(${x}px, ${y}px, 0)`,
        pointerEvents: 'none',
        zIndex: 9999,
        transition: 'none',
        willChange: 'transform',
      }}
    >
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
        {id}
      </div>
    </div>
  );
};

export interface ReactionBurstProps {
  reactionKey: string;
  x: number;
  y: number;
  emoji: string;
}

/**
 * Pure rendering component for discrete reaction bursts.
 */
export const ReactionBurstView: React.FC<ReactionBurstProps> = ({ reactionKey, x, y, emoji }) => {
  return (
    <div
      key={reactionKey}
      style={{
        position: 'fixed',
        left: `${x}px`,
        top: `${y}px`,
        pointerEvents: 'none',
        zIndex: 10000,
        fontSize: '32px',
        animation: 'emojiBurst 900ms cubic-bezier(0.16, 1, 0.3, 1) forwards',
        filter: 'drop-shadow(0 2px 8px rgba(0,0,0,0.5))',
        userSelect: 'none',
      }}
    >
      {emoji}
    </div>
  );
};
