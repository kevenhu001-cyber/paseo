import { useMemo } from "react";
import type { StreamItem } from "@/types/stream";
import type { StreamHistoryRowRevision } from "./strategy";

interface HistoryRowDisplayVariants {
  regular?: StreamItem;
  compact?: StreamItem;
}

const historyRowDisplayVariants = new WeakMap<StreamItem, HistoryRowDisplayVariants>();

function getHistoryRowDisplayVariant(item: StreamItem, compact: boolean): StreamItem {
  let variants = historyRowDisplayVariants.get(item);
  if (!variants) {
    variants = {};
    historyRowDisplayVariants.set(item, variants);
  }
  const key = compact ? "compact" : "regular";
  variants[key] ??= { ...item };
  return variants[key];
}

// Item identity is the render signal for history rows: the row boundary in view.tsx bails out
// until its item changes. Every viewport runs its history through this hook so a history host
// whose tool-call group keeps updating from the live head, a group whose expanded state changed,
// or a breakpoint change reaches the row as a fresh identity. Unchanged rows keep their identity,
// which is what limits a live update to the rows it touched.
export function useRevisedHistoryRows(
  items: StreamItem[],
  revision: StreamHistoryRowRevision | undefined,
): StreamItem[] {
  const globalDisplayState = revision?.globalDisplayState ?? false;
  const displayStateById = revision?.displayStateById;
  const contentById = revision?.contentById;
  const globallyRevisedRows = useMemo(
    () => items.map((item) => getHistoryRowDisplayVariant(item, globalDisplayState)),
    [items, globalDisplayState],
  );
  const displayStateRevisedRows = useMemo(() => {
    if (displayStateById?.size === 0) {
      return globallyRevisedRows;
    }
    let changed = false;
    const next = globallyRevisedRows.map((item) => {
      if (!displayStateById?.has(item.id)) {
        return item;
      }
      changed = true;
      return { ...item };
    });
    // Keep the input array identity when no row changed so the viewport's data
    // prop stays stable.
    return changed ? next : globallyRevisedRows;
  }, [globallyRevisedRows, displayStateById]);
  return useMemo(() => {
    if (contentById?.size === 0) {
      return displayStateRevisedRows;
    }
    let changed = false;
    const next = displayStateRevisedRows.map((item) => {
      if (!contentById?.has(item.id)) {
        return item;
      }
      changed = true;
      return { ...item };
    });
    return changed ? next : displayStateRevisedRows;
  }, [displayStateRevisedRows, contentById]);
}
