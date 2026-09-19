import React from 'react';
import type { ClientInfo } from '../connection.js';
import './PresenceRoster.css';

export interface PresenceRosterProps {
  clients: ClientInfo[];
  myId: string | null;
}

export const PresenceRoster: React.FC<PresenceRosterProps> = ({ clients, myId }) => {
  return (
    <div data-no-burst className="presence-roster">
      <span className="presence-roster__label">
        PEERS ({clients.length}):
      </span>

      <div className="presence-roster__chips">
        {clients.map((client) => {
          const isMe = myId === client.id;
          return (
            <div
              key={client.id}
              title={`${client.id}${isMe ? ' (local client)' : ''}`}
              className={`presence-chip ${isMe ? 'presence-chip--me' : ''}`}
              style={{ borderColor: isMe ? client.color : undefined }}
            >
              <span
                className="presence-chip__dot"
                style={{ backgroundColor: client.color }}
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
  );
};
