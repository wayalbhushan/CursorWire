import React from 'react';

/**
 * Global CSS styles injection helper:
 * Injects required keyframe animations and reset tokens without external CSS files.
 */
let stylesInjected = false;
export function injectGlobalStyles(): void {
  if (stylesInjected || typeof document === 'undefined') return;
  stylesInjected = true;

  const styleEl = document.createElement('style');
  styleEl.textContent = `
    :root {
      --bg-canvas: #0b0c10;
      --panel-bg: #12141a;
      --panel-border: #1e222d;
      --text-primary: #f3f4f6;
      --text-secondary: #9ca3af;
      --text-muted: #6b7280;
      --sans: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Inter', Oxygen, Ubuntu, sans-serif;
      --mono: 'JetBrains Mono', 'SF Mono', SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace;
      font-family: var(--sans);
      color-scheme: dark;
      color: var(--text-primary);
      background-color: var(--bg-canvas);
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
    }
    * { box-sizing: border-box; }
    html, body, #root {
      margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden;
      background-color: var(--bg-canvas);
    }
    @keyframes emojiBurst {
      0% { transform: translate3d(-50%, -50%, 0) scale(0.4); opacity: 0; }
      15% { transform: translate3d(-50%, -50%, 0) scale(1.2); opacity: 1; }
      70% { transform: translate3d(-50%, -40px, 0) scale(1.05); opacity: 0.95; }
      100% { transform: translate3d(-50%, -65px, 0) scale(0.8); opacity: 0; }
    }
    @keyframes liveDot {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.4; }
    }
  `;
  document.head.appendChild(styleEl);
}

export interface RemoteCursorProps {
  id: string;
  x: number;
  y: number;
  color: string;
  domRef: (el: HTMLDivElement | null) => void;
}

/**
 * Pure Rendering Component: Remote Cursor
 *
 * Written with React.createElement to keep file purely TypeScript (.ts)
 * per assignment specification.
 * Renders the SVG pointer arrow with a fixed (-5.5px, -3.5px) tip offset
 * ensuring the visual tip lands precisely on the transmitted coordinate.
 */
export const RemoteCursorView: React.FC<RemoteCursorProps> = ({ id, x, y, color, domRef }) => {
  return React.createElement(
    'div',
    {
      ref: domRef,
      style: {
        position: 'fixed',
        left: 0,
        top: 0,
        transform: `translate3d(${x}px, ${y}px, 0)`,
        pointerEvents: 'none',
        zIndex: 9999,
        transition: 'none',
        willChange: 'transform',
      },
    },
    // SVG cursor arrow
    React.createElement(
      'svg',
      {
        width: '22',
        height: '22',
        viewBox: '0 0 24 24',
        fill: 'none',
        style: {
          position: 'absolute',
          left: '-5.5px',
          top: '-3.5px',
          overflow: 'visible',
          filter: 'drop-shadow(0 1px 3px rgba(0,0,0,0.4))',
        },
      },
      React.createElement('path', {
        d: 'M5.5 3.5L18.5 11L12 13L9 20L5.5 3.5Z',
        fill: color,
        stroke: '#0a0c10',
        strokeWidth: '1.5',
        strokeLinejoin: 'round',
      })
    ),
    // Monospace client ID nameplate
    React.createElement(
      'div',
      {
        style: {
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
        },
      },
      id
    )
  );
};

export interface ReactionBurstProps {
  reactionKey: string;
  x: number;
  y: number;
  emoji: string;
}

/**
 * Pure Rendering Component: Discrete Reaction Burst
 */
export const ReactionBurstView: React.FC<ReactionBurstProps> = ({ reactionKey, x, y, emoji }) => {
  return React.createElement(
    'div',
    {
      key: reactionKey,
      style: {
        position: 'fixed',
        left: `${x}px`,
        top: `${y}px`,
        pointerEvents: 'none',
        zIndex: 10000,
        fontSize: '32px',
        animation: 'emojiBurst 900ms cubic-bezier(0.16, 1, 0.3, 1) forwards',
        filter: 'drop-shadow(0 2px 8px rgba(0,0,0,0.5))',
        userSelect: 'none',
      },
    },
    emoji
  );
};
