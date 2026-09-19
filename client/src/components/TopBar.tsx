import React from 'react';
import { type ConnectionStatus } from '../connection.js';
import './TopBar.css';

export interface TopBarProps {
  status: ConnectionStatus;
  reconnectAttempt: number;
  onManualReconnect: () => void;
  children?: React.ReactNode;
}

export const TopBar: React.FC<TopBarProps> = ({
  status,
  reconnectAttempt,
  onManualReconnect,
  children,
}) => {
  const dotClass =
    status === 'connected'
      ? 'top-bar__status-dot--connected'
      : status === 'reconnecting'
      ? 'top-bar__status-dot--reconnecting'
      : 'top-bar__status-dot--disconnected';

  const statusText =
    status === 'reconnecting'
      ? `RECONNECTING (${reconnectAttempt}/5)`
      : status.toUpperCase();

  return (
    <header data-no-burst className="top-bar">
      <div data-no-burst className="top-bar__left">
        <span className="top-bar__brand">CURSORWIRE</span>
        <span className="top-bar__protocol-tag">RAW-WS // V1</span>
        <div className="top-bar__divider" />

        <div className="top-bar__status-badge">
          <span className={`top-bar__status-dot ${dotClass}`} />
          <span>{statusText}</span>
        </div>

        {status === 'disconnected' && (
          <button
            type="button"
            className="top-bar__reconnect-btn"
            onClick={onManualReconnect}
          >
            RECONNECT
          </button>
        )}
      </div>

      {children}
    </header>
  );
};
