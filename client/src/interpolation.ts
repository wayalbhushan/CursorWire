import { type CursorSnapshot } from '../../server/src/protocol.js';

export interface CursorInterpolationState {
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  currX: number;
  currY: number;
  startTime: number;
}

/**
 * Custom linear interpolation (LERP) function:
 * Computes position between start and end based on normalized progress t ∈ [0, 1].
 */
export function lerp(start: number, end: number, t: number): number {
  return start + (end - start) * t;
}

/**
 * Jitter Buffer Window: 100ms (~3x the 33ms send interval)
 * Provides a stable trade-off between perceived smoothness and latency.
 */
export const INTERPOLATION_WINDOW_MS = 100;

/**
 * Client-Side Interpolation & Jitter Engine
 *
 * Manages remote cursor motion smoothing using linear interpolation
 * across a 100ms playback window driven by a shared render loop.
 * Also enforces strict sequence ordering to discard stale/out-of-order packets.
 */
export class CursorInterpolationManager {
  private interpolations = new Map<string, CursorInterpolationState>();
  private lastAppliedCursorSeq = new Map<string, number>();

  /**
   * Updates target position for a remote client upon receiving a valid cursor-move.
   * Returns false if the message is discarded as stale / out-of-order.
   */
  public updateTarget(id: string, x: number, y: number, seq: number, now: number): boolean {
    const lastSeq = this.lastAppliedCursorSeq.get(id) ?? -1;
    if (seq <= lastSeq) {
      return false; // Discard stale/duplicate packet
    }

    this.lastAppliedCursorSeq.set(id, seq);

    const existing = this.interpolations.get(id);

    if (!existing) {
      // First position received: start immediately at (x, y)
      this.interpolations.set(id, {
        fromX: x,
        fromY: y,
        toX: x,
        toY: y,
        currX: x,
        currY: y,
        startTime: now,
      });
    } else {
      // Transition from current rendered coordinate to new target coordinate
      existing.fromX = existing.currX;
      existing.fromY = existing.currY;
      existing.toX = x;
      existing.toY = y;
      existing.startTime = now;
    }

    return true;
  }

  /**
   * Initializes cursor positions from a late-join snapshot.
   */
  public initSnapshot(cursors: CursorSnapshot[], localId: string | null, now: number): void {
    for (const cursor of cursors) {
      if (cursor.id === localId) continue;

      this.interpolations.set(cursor.id, {
        fromX: cursor.x,
        fromY: cursor.y,
        toX: cursor.x,
        toY: cursor.y,
        currX: cursor.x,
        currY: cursor.y,
        startTime: now,
      });

      this.lastAppliedCursorSeq.set(cursor.id, cursor.seq);
    }
  }

  /**
   * Evaluates current interpolated coordinates for all active cursors on each animation frame.
   */
  public step(now: number, onUpdate: (id: string, x: number, y: number) => void): void {
    for (const [id, interp] of this.interpolations.entries()) {
      const elapsed = now - interp.startTime;
      const progress = Math.min(Math.max(elapsed / INTERPOLATION_WINDOW_MS, 0), 1);

      interp.currX = lerp(interp.fromX, interp.toX, progress);
      interp.currY = lerp(interp.fromY, interp.toY, progress);

      onUpdate(id, interp.currX, interp.currY);
    }
  }

  /**
   * Removes a disconnected client from the interpolation registry.
   */
  public removeClient(id: string): void {
    this.interpolations.delete(id);
    this.lastAppliedCursorSeq.delete(id);
  }

  /**
   * Cleans up all participants not in the active client ID set.
   */
  public syncActiveClients(activeIds: Set<string>): void {
    for (const id of Array.from(this.interpolations.keys())) {
      if (!activeIds.has(id)) {
        this.removeClient(id);
      }
    }
  }

  public clear(): void {
    this.interpolations.clear();
    this.lastAppliedCursorSeq.clear();
  }
}
