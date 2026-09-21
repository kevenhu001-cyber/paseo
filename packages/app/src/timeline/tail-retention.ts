import type { StreamItem } from "@/types/stream";
import type { AgentTimelineCursorState } from "@/stores/session-store";

// Bound on the loaded transcript tail. Layout, tool grouping, turn timing and
// reducer passes are all O(tail) per commit, and nothing else shrinks the tail,
// so without a cap every pass gets slower the longer the app runs. Evicted
// items are not lost: the cursor's startSeq moves forward, hasOlder flips back
// on, and a "before" page refetches them on scroll-up.
export const MAX_LOADED_TAIL_ITEMS = 1500;

// ---------------------------------------------------------------------------
// Mounted-window protection
// ---------------------------------------------------------------------------
// The store cannot see the viewport, so mounted transcript views report the
// lowest timeline seq inside their mounted window. Eviction never removes items
// at or above the floor — dropping rows a user is reading would visibly tear
// the list. Multiple mounted views (retained panels) each register; the floor
// is the minimum across them.

const viewFloorSeqsByKey = new Map<string, Map<string, number>>();

function viewFloorKey(serverId: string, agentId: string): string {
  return `${serverId}${agentId}`;
}

export function reportTimelineViewFloor(params: {
  serverId: string;
  agentId: string;
  viewKey: string;
  floorSeq: number | null;
}): void {
  const key = viewFloorKey(params.serverId, params.agentId);
  if (params.floorSeq === null) {
    viewFloorSeqsByKey.get(key)?.delete(params.viewKey);
    return;
  }
  let floors = viewFloorSeqsByKey.get(key);
  if (!floors) {
    floors = new Map();
    viewFloorSeqsByKey.set(key, floors);
  }
  floors.set(params.viewKey, params.floorSeq);
}

export function releaseTimelineViewFloor(params: {
  serverId: string;
  agentId: string;
  viewKey: string;
}): void {
  const key = viewFloorKey(params.serverId, params.agentId);
  const floors = viewFloorSeqsByKey.get(key);
  if (!floors?.delete(params.viewKey)) return;
  if (floors.size === 0) viewFloorSeqsByKey.delete(key);
}

export function getTimelineViewFloorSeq(serverId: string, agentId: string): number | undefined {
  const floors = viewFloorSeqsByKey.get(viewFloorKey(serverId, agentId));
  if (!floors || floors.size === 0) return undefined;
  let min: number | undefined;
  for (const seq of floors.values()) {
    if (min === undefined || seq < min) min = seq;
  }
  return min;
}

// ---------------------------------------------------------------------------
// Eviction
// ---------------------------------------------------------------------------

interface LoadedSeqRange {
  startSeq: number;
  endSeq: number;
  hasOlder?: boolean;
}

export interface TrimLoadedTailInput {
  tail: StreamItem[];
  cursor: AgentTimelineCursorState | null | undefined;
  hasOlder: boolean;
  protectedFloorSeq: number | undefined;
}

export interface TrimmedTail {
  tail: StreamItem[];
  cursor: AgentTimelineCursorState;
  hasOlder: true;
}

/**
 * Evicts the oldest loaded prefix once the tail exceeds MAX_LOADED_TAIL_ITEMS.
 * An item is evictable only when it carries a timeline cursor in the current
 * epoch (so a "before" fetch can restore it) and sits below the mounted-window
 * floor. Returns null when nothing can be evicted.
 */
export function trimLoadedTail(input: TrimLoadedTailInput): TrimmedTail | null {
  const { tail, cursor } = input;
  const overflow = tail.length - MAX_LOADED_TAIL_ITEMS;
  if (overflow <= 0 || !cursor) {
    return null;
  }

  let evictEnd = 0;
  let evictedMaxSeq = -1;
  while (evictEnd < overflow) {
    const itemCursor = tail[evictEnd]?.timelineCursor;
    if (!itemCursor || itemCursor.epoch !== cursor.epoch) break;
    if (input.protectedFloorSeq !== undefined && itemCursor.seq >= input.protectedFloorSeq) {
      break;
    }
    evictedMaxSeq = itemCursor.seq;
    evictEnd += 1;
  }
  if (evictEnd === 0) {
    return null;
  }

  const unloadedBelow = evictedMaxSeq + 1;
  const clampRange = (range: LoadedSeqRange): LoadedSeqRange | null => {
    const startSeq = Math.max(range.startSeq, unloadedBelow);
    return startSeq <= range.endSeq ? { ...range, startSeq } : null;
  };

  const nextStartSeq = Math.max(cursor.startSeq, unloadedBelow);
  const retainedRanges = (cursor.retainedRanges ?? [])
    .map(clampRange)
    .filter((range): range is LoadedSeqRange => range !== null);

  return {
    tail: tail.slice(evictEnd),
    cursor: {
      epoch: cursor.epoch,
      startSeq: nextStartSeq,
      endSeq: cursor.endSeq,
      ...(retainedRanges.length > 0 ? { retainedRanges } : {}),
    },
    hasOlder: true,
  };
}
