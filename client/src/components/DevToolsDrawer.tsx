import React from 'react';
import './DevToolsDrawer.css';

export interface DevToolsDrawerProps {
  isOpen: boolean;
  onToggle: () => void;
  discardedStaleCount: number;
  injectStaleCursor?: (seq?: number) => void;
  injectStaleReaction?: (seq?: number) => void;
}

export const DevToolsDrawer: React.FC<DevToolsDrawerProps> = ({
  isOpen,
  discardedStaleCount,
  injectStaleCursor,
  injectStaleReaction,
}) => {
  if (!isOpen) return null;

  return (
    <div data-no-burst className="dev-tools-drawer">
      <div className="dev-tools-drawer__title">DEV VERIFICATION CONTROLS</div>

      <div className="dev-tools-drawer__actions">
        <button
          type="button"
          className="dev-tools-drawer__btn"
          onClick={() => injectStaleCursor?.(1)}
        >
          Inject Stale Cursor (seq: 1)
        </button>

        <button
          type="button"
          className="dev-tools-drawer__btn"
          onClick={() => injectStaleReaction?.(1)}
        >
          Inject Stale Reaction (seq: 1)
        </button>
      </div>

      <div className="dev-tools-drawer__footer">
        <div>
          Stale packets dropped:{' '}
          <strong
            className={`dev-tools-drawer__count ${
              discardedStaleCount > 0
                ? 'dev-tools-drawer__count--warn'
                : 'dev-tools-drawer__count--ok'
            }`}
          >
            {discardedStaleCount}
          </strong>
        </div>
      </div>
    </div>
  );
};
