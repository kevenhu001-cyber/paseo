import type { StreamItem } from "@/types/stream";
import { startsNewTurn } from "@/agent-stream/turn-membership";

export interface TurnTiming {
  completedAt: Date;
  durationMs: number | null;
}

export interface StreamTurnTiming {
  byAssistantId: Map<string, TurnTiming>;
  runningStartedAt: Date | null;
}

interface TurnFoldCarry {
  userAt: Date | null;
  lastItemAt: Date | null;
  assistantIds: string[];
  previousItem: StreamItem | null;
}

interface TailTurnFold {
  byAssistantId: Map<string, TurnTiming>;
  carry: TurnFoldCarry;
}

// The tail fold is keyed by array identity, so during streaming — when only the
// head array changes — deriveStreamTurnTiming replays just the head instead of
// rescanning the full history on every commit.
const tailTurnFoldCache = new WeakMap<StreamItem[], TailTurnFold>();

function foldTailTurnTiming(tail: StreamItem[]): TailTurnFold {
  const cached = tailTurnFoldCache.get(tail);
  if (cached) {
    return cached;
  }

  const byAssistantId = new Map<string, TurnTiming>();
  let currentUserAt: Date | null = null;
  let currentLastItemAt: Date | null = null;
  let currentAssistantIds: string[] = [];
  let previousItem: StreamItem | null = null;

  const flushCompletedTurn = () => {
    if (!currentLastItemAt || currentAssistantIds.length === 0) {
      return;
    }
    const timing: TurnTiming = {
      completedAt: currentLastItemAt,
      durationMs: currentUserAt
        ? Math.max(0, currentLastItemAt.getTime() - currentUserAt.getTime())
        : null,
    };
    for (const id of currentAssistantIds) {
      byAssistantId.set(id, timing);
    }
  };

  for (const item of tail) {
    if (startsNewTurn(item, previousItem)) {
      flushCompletedTurn();
      currentUserAt = item.kind === "user_message" ? item.timestamp : null;
      currentLastItemAt = null;
      currentAssistantIds = [];
    }
    currentLastItemAt = item.timestamp;
    if (item.kind === "assistant_message") {
      currentAssistantIds.push(item.id);
    }
    previousItem = item;
  }

  const fold: TailTurnFold = {
    byAssistantId,
    carry: {
      userAt: currentUserAt,
      lastItemAt: currentLastItemAt,
      assistantIds: currentAssistantIds,
      previousItem,
    },
  };
  tailTurnFoldCache.set(tail, fold);
  return fold;
}

export function deriveStreamTurnTiming(params: {
  isTurnActive: boolean;
  activeTurnStartedAt: Date | null;
  tail: StreamItem[];
  head: StreamItem[];
}): StreamTurnTiming {
  const fold = foldTailTurnTiming(params.tail);
  let byAssistantId = fold.byAssistantId;
  let currentUserAt = fold.carry.userAt;
  let currentLastItemAt = fold.carry.lastItemAt;
  let currentAssistantIds = fold.carry.assistantIds;
  let previousItem = fold.carry.previousItem;
  let mapCopied = false;

  const writableMap = () => {
    if (!mapCopied) {
      byAssistantId = new Map(byAssistantId);
      mapCopied = true;
    }
    return byAssistantId;
  };

  const flushCompletedTurn = () => {
    if (!currentLastItemAt || currentAssistantIds.length === 0) {
      return;
    }
    const timing: TurnTiming = {
      completedAt: currentLastItemAt,
      durationMs: currentUserAt
        ? Math.max(0, currentLastItemAt.getTime() - currentUserAt.getTime())
        : null,
    };
    const writable = writableMap();
    for (const id of currentAssistantIds) {
      writable.set(id, timing);
    }
  };

  const visitItem = (item: StreamItem) => {
    if (startsNewTurn(item, previousItem)) {
      flushCompletedTurn();
      currentUserAt = item.kind === "user_message" ? item.timestamp : null;
      currentLastItemAt = null;
      currentAssistantIds = [];
    }
    currentLastItemAt = item.timestamp;
    if (item.kind === "assistant_message") {
      // Copy-on-write: never mutate the cached open-turn id list.
      if (currentAssistantIds === fold.carry.assistantIds) {
        currentAssistantIds = [...currentAssistantIds];
      }
      currentAssistantIds.push(item.id);
    }
    previousItem = item;
  };

  for (const item of params.head) {
    visitItem(item);
  }

  const runningStartedAt = params.isTurnActive ? params.activeTurnStartedAt : null;
  if (!params.isTurnActive) {
    flushCompletedTurn();
  }

  return {
    byAssistantId,
    runningStartedAt,
  };
}
