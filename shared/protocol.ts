/**
 * Protocol Definitions for CursorWire
 *
 * Discriminated union of all messages sent over the WebSocket connection.
 * Every message has a literal `type` discriminant.
 */

export interface ClientInfo {
  id: string;
  color: string;
}

// 1. Join: Client announces its connection to the server
export interface JoinMessage {
  type: 'join';
}

// 2. Welcome: Server acknowledges join and assigns a unique client ID and color
export interface WelcomeMessage {
  type: 'welcome';
  id: string;
  color: string;
}

// 3. Presence Update: Server broadcasts full list of connected clients to everyone
export interface PresenceUpdateMessage {
  type: 'presence-update';
  clients: ClientInfo[];
}

// 4. Cursor Move: Client emits position updates, server relays to other clients
export interface CursorMoveMessage {
  type: 'cursor-move';
  id?: string; // Client ID stamped by server when broadcasting to other clients
  x: number;
  y: number;
  seq: number;
}

// 5. Reaction: Client emits emoji reaction burst, server relays to other clients
export interface ReactionMessage {
  type: 'reaction';
  id?: string; // Client ID stamped by server when broadcasting to other clients
  x: number;
  y: number;
  emoji: string;
  seq: number;
}

// 6. Leave: Server informs clients that a specific client has disconnected
export interface LeaveMessage {
  type: 'leave';
  id: string;
}

// 7. Error: Server informs client of an invalid, rejected, or malformed message
export interface ErrorMessage {
  type: 'error';
  message: string;
  reason?: string;
}

export type SocketMessage =
  | JoinMessage
  | WelcomeMessage
  | PresenceUpdateMessage
  | CursorMoveMessage
  | ReactionMessage
  | LeaveMessage
  | ErrorMessage;

export type MessageType = SocketMessage['type'];

export type ValidationResult =
  | { success: true; data: SocketMessage }
  | { success: false; error: string };

/**
 * Pure type-guard validator for incoming messages.
 * Verifies the structure, types, and constraints without external libraries.
 */
export function validateMessage(raw: unknown): ValidationResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { success: false, error: 'Message payload must be a non-null object' };
  }

  const obj = raw as Record<string, unknown>;

  if (typeof obj.type !== 'string') {
    return { success: false, error: 'Message must have a string "type" field' };
  }

  switch (obj.type) {
    case 'join': {
      return { success: true, data: { type: 'join' } };
    }

    case 'welcome': {
      if (typeof obj.id !== 'string' || obj.id.trim() === '') {
        return { success: false, error: 'Welcome message must include a non-empty string "id"' };
      }
      if (typeof obj.color !== 'string' || obj.color.trim() === '') {
        return { success: false, error: 'Welcome message must include a non-empty string "color"' };
      }
      return { success: true, data: { type: 'welcome', id: obj.id, color: obj.color } };
    }

    case 'presence-update': {
      if (!Array.isArray(obj.clients)) {
        return { success: false, error: 'Presence-update "clients" must be an array' };
      }
      for (let i = 0; i < obj.clients.length; i++) {
        const item = obj.clients[i];
        if (typeof item !== 'object' || item === null) {
          return { success: false, error: `Presence-update client at index ${i} must be an object` };
        }
        const clientObj = item as Record<string, unknown>;
        if (typeof clientObj.id !== 'string' || clientObj.id.trim() === '') {
          return { success: false, error: `Presence-update client at index ${i} missing valid "id"` };
        }
        if (typeof clientObj.color !== 'string' || clientObj.color.trim() === '') {
          return { success: false, error: `Presence-update client at index ${i} missing valid "color"` };
        }
      }
      return {
        success: true,
        data: {
          type: 'presence-update',
          clients: obj.clients as ClientInfo[],
        },
      };
    }

    case 'cursor-move': {
      if (typeof obj.x !== 'number' || !Number.isFinite(obj.x)) {
        return { success: false, error: 'Cursor move "x" must be a finite number' };
      }
      if (typeof obj.y !== 'number' || !Number.isFinite(obj.y)) {
        return { success: false, error: 'Cursor move "y" must be a finite number' };
      }
      if (typeof obj.seq !== 'number' || !Number.isInteger(obj.seq) || obj.seq < 0) {
        return { success: false, error: 'Cursor move "seq" must be a non-negative integer' };
      }
      if (obj.id !== undefined && typeof obj.id !== 'string') {
        return { success: false, error: 'Cursor move "id", if provided, must be a string' };
      }

      const msg: CursorMoveMessage = {
        type: 'cursor-move',
        x: obj.x,
        y: obj.y,
        seq: obj.seq,
      };
      if (typeof obj.id === 'string') {
        msg.id = obj.id;
      }
      return { success: true, data: msg };
    }

    case 'reaction': {
      if (typeof obj.x !== 'number' || !Number.isFinite(obj.x)) {
        return { success: false, error: 'Reaction "x" must be a finite number' };
      }
      if (typeof obj.y !== 'number' || !Number.isFinite(obj.y)) {
        return { success: false, error: 'Reaction "y" must be a finite number' };
      }
      if (typeof obj.seq !== 'number' || !Number.isInteger(obj.seq) || obj.seq < 0) {
        return { success: false, error: 'Reaction "seq" must be a non-negative integer' };
      }
      if (typeof obj.emoji !== 'string' || obj.emoji.trim().length === 0) {
        return { success: false, error: 'Reaction "emoji" must be a non-empty string' };
      }
      if (obj.id !== undefined && typeof obj.id !== 'string') {
        return { success: false, error: 'Reaction "id", if provided, must be a string' };
      }

      const msg: ReactionMessage = {
        type: 'reaction',
        x: obj.x,
        y: obj.y,
        emoji: obj.emoji,
        seq: obj.seq,
      };
      if (typeof obj.id === 'string') {
        msg.id = obj.id;
      }
      return { success: true, data: msg };
    }

    case 'leave': {
      if (typeof obj.id !== 'string' || obj.id.trim() === '') {
        return { success: false, error: 'Leave message must include a non-empty string "id"' };
      }
      return { success: true, data: { type: 'leave', id: obj.id } };
    }

    case 'error': {
      if (typeof obj.message !== 'string') {
        return { success: false, error: 'Error message must include a string "message"' };
      }
      const msg: ErrorMessage = {
        type: 'error',
        message: obj.message,
      };
      if (typeof obj.reason === 'string') {
        msg.reason = obj.reason;
      }
      return { success: true, data: msg };
    }

    default:
      return { success: false, error: `Unrecognized message type: "${obj.type}"` };
  }
}

/**
 * Safely parses raw text as JSON and validates against protocol types.
 */
export function parseAndValidateMessage(rawText: string): ValidationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    return {
      success: false,
      error: `Malformed JSON: ${err instanceof Error ? err.message : 'Parse error'}`,
    };
  }

  return validateMessage(parsed);
}
