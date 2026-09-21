import type { ReactNode } from "react";
import { deriveStreamTurnTiming, type StreamTurnTiming } from "@/timeline/turn-time";
import type { StreamItem } from "@/types/stream";
import { findMountedWindowStart, getMountedRecentStreamItems } from "./history-window";
import { getWebPartialVirtualizationThreshold } from "./web-virtualization";
import { orderHeadForStreamRenderStrategy, orderTailForStreamRenderStrategy } from "./strategy";
import { resolveStreamRenderStrategy } from "./strategy-resolver";

export interface StreamRenderSegments {
  historyVirtualized: StreamItem[];
  historyMounted: StreamItem[];
  liveHead: StreamItem[];
}

export interface StreamHistoryBoundary {
  hasVirtualizedHistory: boolean;
  hasMountedHistory: boolean;
  hasLiveHead: boolean;
}

export interface StreamRenderAuxiliary {
  pendingPermissions: ReactNode;
  turnFooter: ReactNode;
}

export interface AgentStreamRenderModel {
  history: StreamItem[];
  segments: StreamRenderSegments;
  turnTiming: StreamTurnTiming;
  boundary: StreamHistoryBoundary;
  auxiliary: StreamRenderAuxiliary;
}

export interface BuildAgentStreamRenderModelInput {
  isTurnActive: boolean;
  activeTurnStartedAt: Date | null;
  tail: StreamItem[];
  head: StreamItem[];
  platform: "web" | "native";
  isMobileBreakpoint: boolean;
  historyStart?: number;
}

const EMPTY_STREAM_ITEMS: StreamItem[] = [];
const EMPTY_AUXILIARY: StreamRenderAuxiliary = {
  pendingPermissions: null,
  turnFooter: null,
};

const orderedTailCache = new WeakMap<StreamItem[], Map<string, StreamItem[]>>();
const orderedHeadCache = new WeakMap<StreamItem[], Map<string, StreamItem[]>>();
const renderedTailCache = new WeakMap<StreamItem[], Map<number, StreamItem[]>>();
const splitHistoryCache = new WeakMap<
  StreamItem[],
  Map<string, Pick<AgentStreamRenderModel, "history" | "segments">>
>();

function getOrderedItems(params: {
  cache: WeakMap<StreamItem[], Map<string, StreamItem[]>>;
  source: StreamItem[];
  cacheKey: string;
  order: (items: StreamItem[]) => StreamItem[];
}): StreamItem[] {
  const { cache, source, cacheKey, order } = params;
  let cachedByKey = cache.get(source);
  if (!cachedByKey) {
    cachedByKey = new Map();
    cache.set(source, cachedByKey);
  }
  const cached = cachedByKey.get(cacheKey);
  if (cached) {
    return cached;
  }
  const ordered = order(source);
  cachedByKey.set(cacheKey, ordered);
  return ordered;
}

function splitOrderedTail(params: {
  orderedTail: StreamItem[];
  platform: "web" | "native";
  isMobileBreakpoint: boolean;
}): Pick<AgentStreamRenderModel, "history" | "segments"> {
  const { orderedTail, platform, isMobileBreakpoint } = params;
  const shouldSplitHistory =
    platform === "web" &&
    !isMobileBreakpoint &&
    orderedTail.length > getWebPartialVirtualizationThreshold();
  const cacheKey = `${platform}:${isMobileBreakpoint}:${getMountedRecentStreamItems()}:${shouldSplitHistory}`;
  let cachedByKey = splitHistoryCache.get(orderedTail);
  if (!cachedByKey) {
    cachedByKey = new Map();
    splitHistoryCache.set(orderedTail, cachedByKey);
  }
  const cached = cachedByKey.get(cacheKey);
  if (cached) {
    return cached;
  }

  if (!shouldSplitHistory) {
    const unsplit = {
      history: orderedTail,
      segments: {
        historyVirtualized: EMPTY_STREAM_ITEMS,
        historyMounted: orderedTail,
        liveHead: EMPTY_STREAM_ITEMS,
      },
    } satisfies Pick<AgentStreamRenderModel, "history" | "segments">;
    cachedByKey.set(cacheKey, unsplit);
    return unsplit;
  }

  const mountedWindowStart = findMountedWindowStart({
    items: orderedTail,
    minMountedCount: getMountedRecentStreamItems(),
  });
  const split = {
    history: orderedTail,
    segments: {
      historyVirtualized: orderedTail.slice(0, mountedWindowStart),
      historyMounted: orderedTail.slice(mountedWindowStart),
      liveHead: EMPTY_STREAM_ITEMS,
    },
  } satisfies Pick<AgentStreamRenderModel, "history" | "segments">;
  cachedByKey.set(cacheKey, split);
  return split;
}

// Once history exceeds the mounted window, historyStart > 0 and a naive
// tail.slice() would hand every downstream identity-keyed cache (ordered tail,
// split history, layoutStream) a fresh array on each commit — recomputing an
// O(history) layout per stream tick. The sliced array is pure, so it is cached
// per (tail, start) to keep downstream identities stable.
function getRenderedTail(tail: StreamItem[], historyStart: number | undefined): StreamItem[] {
  if (!historyStart) {
    return tail;
  }
  let cachedByStart = renderedTailCache.get(tail);
  if (!cachedByStart) {
    cachedByStart = new Map();
    renderedTailCache.set(tail, cachedByStart);
  }
  const cached = cachedByStart.get(historyStart);
  if (cached) {
    return cached;
  }
  const rendered = tail.slice(historyStart);
  cachedByStart.set(historyStart, rendered);
  return rendered;
}

export function buildAgentStreamRenderModel(
  input: BuildAgentStreamRenderModelInput,
): AgentStreamRenderModel {
  const strategy = resolveStreamRenderStrategy({
    platform: input.platform === "web" ? "web" : "native",
    isMobileBreakpoint: input.isMobileBreakpoint,
  });
  const orderingCacheKey = `${input.platform}:${input.isMobileBreakpoint}`;
  const renderedTail = getRenderedTail(input.tail, input.historyStart);
  const orderedTail = getOrderedItems({
    cache: orderedTailCache,
    source: renderedTail,
    cacheKey: orderingCacheKey,
    order: (items) =>
      orderTailForStreamRenderStrategy({
        strategy,
        streamItems: items,
      }),
  });
  const orderedHead = getOrderedItems({
    cache: orderedHeadCache,
    source: input.head,
    cacheKey: orderingCacheKey,
    order: (items) =>
      orderHeadForStreamRenderStrategy({
        strategy,
        streamHead: items,
      }),
  });
  const splitHistory = splitOrderedTail({
    orderedTail,
    platform: input.platform,
    isMobileBreakpoint: input.isMobileBreakpoint,
  });
  const turnTiming = deriveStreamTurnTiming({
    isTurnActive: input.isTurnActive,
    activeTurnStartedAt: input.activeTurnStartedAt,
    tail: renderedTail,
    head: input.head,
  });

  return {
    history: splitHistory.history,
    segments: {
      ...splitHistory.segments,
      liveHead: orderedHead,
    },
    turnTiming,
    boundary: {
      hasVirtualizedHistory: splitHistory.segments.historyVirtualized.length > 0,
      hasMountedHistory: splitHistory.segments.historyMounted.length > 0,
      hasLiveHead: orderedHead.length > 0,
    },
    auxiliary: EMPTY_AUXILIARY,
  };
}
