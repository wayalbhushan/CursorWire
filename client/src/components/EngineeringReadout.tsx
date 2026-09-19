import React from 'react';
import './EngineeringReadout.css';

export interface EngineeringReadoutProps {
  wsUrl: string;
  discardedStaleCount: number;
  txSeq: number;
  localCoords: { x: number; y: number };
  children?: React.ReactNode;
}

export const EngineeringReadout: React.FC<EngineeringReadoutProps> = ({
  wsUrl,
  discardedStaleCount,
  txSeq,
  localCoords,
  children,
}) => {
  const protocol = wsUrl.startsWith('wss') ? 'WSS' : 'WS';
  const host = wsUrl.replace(/^wss?:\/\//, '');

  return (
    <footer className="engineering-readout">
      <div className="engineering-readout__telemetry">
        <span>
          {protocol}: {host}
        </span>
        <span className="engineering-readout__sep">|</span>
        <span>RATE: 30HZ THROTTLED</span>
        <span className="engineering-readout__sep">|</span>
        <span>INTERP: 100MS LERP</span>
        <span className="engineering-readout__sep">|</span>
        <span>TX SEQ: #{txSeq}</span>
        <span className="engineering-readout__sep">|</span>
        <span>
          DROPPED STALE:{' '}
          <strong
            className={
              discardedStaleCount > 0
                ? 'engineering-readout__stale--warn'
                : 'engineering-readout__stale--clean'
            }
          >
            {discardedStaleCount}
          </strong>
        </span>
        <span className="engineering-readout__sep">|</span>
        <span>
          POS: X:{localCoords.x} Y:{localCoords.y}
        </span>
      </div>

      {children && (
        <div data-no-burst className="engineering-readout__actions">
          {children}
        </div>
      )}
    </footer>
  );
};
