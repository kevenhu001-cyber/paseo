import { describe, expect, it } from "vitest";

import type { StreamItem } from "@/types/stream";
import type { AgentTimelineCursorState } from "@/stores/session-store";
import {
  getTimelineViewFloorSeq,
  MAX_LOADED_TAIL_ITEMS,
  releaseTimelineViewFloor,
  reportTimelineViewFloor,
  trimLoadedTail,
} from "./tail-retention";

function item(seq: number, epoch = "epoch-1"): StreamItem {
  return {
    kind: "assistant_message",
    id: `item-${epoch}-${seq}`,
    text: `item ${seq}`,
    timestamp: new Date("2026-08-11T10:00:00.000Z"),
    timelineCursor: { epoch, seq },
  };
}

function cursor(overrides: Partial<AgentTimelineCursorState> = {}): AgentTimelineCursorState {
  return { epoch: "epoch-1", startSeq: 1, endSeq: 2000, ...overrides };
}

function tailOf(count: number, startSeq = 1, epoch = "epoch-1"): StreamItem[] {
  return Array.from({ length: count }, (_, index) => item(startSeq + index, epoch));
}

describe("trimLoadedTail", () => {
  it("does nothing while the tail fits the cap", () => {
    const tail = tailOf(10);
    expect(
      trimLoadedTail({ tail, cursor: cursor(), hasOlder: false, protectedFloorSeq: undefined }),
    ).toBeNull();
  });

  it("does nothing without a cursor since evicted rows could not be refetched", () => {
    const tail = tailOf(MAX_LOADED_TAIL_ITEMS + 5);
    expect(
      trimLoadedTail({ tail, cursor: null, hasOlder: false, protectedFloorSeq: undefined }),
    ).toBeNull();
  });

  it("evicts only the overflowing prefix and advances startSeq", () => {
    const tail = tailOf(MAX_LOADED_TAIL_ITEMS + 10);
    const trimmed = trimLoadedTail({
      tail,
      cursor: cursor(),
      hasOlder: false,
      protectedFloorSeq: undefined,
    });
    expect(trimmed).not.toBeNull();
    expect(trimmed!.tail).toHaveLength(MAX_LOADED_TAIL_ITEMS);
    expect(trimmed!.tail[0]).toBe(tail[10]);
    expect(trimmed!.cursor).toEqual({ epoch: "epoch-1", startSeq: 11, endSeq: 2000 });
    expect(trimmed!.hasOlder).toBe(true);
  });

  it("stops evicting at the mounted-window floor", () => {
    const tail = tailOf(MAX_LOADED_TAIL_ITEMS + 10);
    const trimmed = trimLoadedTail({
      tail,
      cursor: cursor(),
      hasOlder: true,
      protectedFloorSeq: 6,
    });
    // Items with seq >= 6 are mounted; only seqs 1..5 are evictable.
    expect(trimmed).not.toBeNull();
    expect(trimmed!.tail).toHaveLength(MAX_LOADED_TAIL_ITEMS + 5);
    expect(trimmed!.tail[0]).toBe(tail[5]);
    expect(trimmed!.cursor.startSeq).toBe(6);
  });

  it("stops evicting at rows without a cursor or from another epoch", () => {
    const tail = tailOf(MAX_LOADED_TAIL_ITEMS + 10);
    const cursorless = { ...tail[3]! };
    delete cursorless.timelineCursor;
    tail[3] = cursorless;
    const trimmed = trimLoadedTail({
      tail,
      cursor: cursor(),
      hasOlder: true,
      protectedFloorSeq: undefined,
    });
    expect(trimmed!.tail[0]).toBe(tail[3]);
    expect(trimmed!.cursor.startSeq).toBe(4);

    const foreignEpoch = tailOf(MAX_LOADED_TAIL_ITEMS + 10, 1, "epoch-0");
    const trimmedForeign = trimLoadedTail({
      tail: foreignEpoch,
      cursor: cursor(),
      hasOlder: true,
      protectedFloorSeq: undefined,
    });
    expect(trimmedForeign).toBeNull();
  });

  it("clamps retained ranges and drops fully evicted ones", () => {
    const tail = tailOf(MAX_LOADED_TAIL_ITEMS + 10);
    const trimmed = trimLoadedTail({
      tail,
      cursor: cursor({
        retainedRanges: [
          { startSeq: 1, endSeq: 5, hasOlder: false },
          { startSeq: 8, endSeq: 12 },
          { startSeq: 100, endSeq: 120 },
        ],
      }),
      hasOlder: true,
      protectedFloorSeq: undefined,
    });
    expect(trimmed!.cursor.retainedRanges).toEqual([
      { startSeq: 11, endSeq: 12 },
      { startSeq: 100, endSeq: 120 },
    ]);
  });
});

describe("timeline view floor registry", () => {
  it("reports the minimum seq across mounted views and releases on unmount", () => {
    const base = { serverId: "srv", agentId: "agent" };
    expect(getTimelineViewFloorSeq("srv", "agent")).toBeUndefined();

    reportTimelineViewFloor({ ...base, viewKey: "a", floorSeq: 50 });
    reportTimelineViewFloor({ ...base, viewKey: "b", floorSeq: 30 });
    expect(getTimelineViewFloorSeq("srv", "agent")).toBe(30);

    reportTimelineViewFloor({ ...base, viewKey: "b", floorSeq: null });
    expect(getTimelineViewFloorSeq("srv", "agent")).toBe(50);

    releaseTimelineViewFloor({ ...base, viewKey: "a" });
    expect(getTimelineViewFloorSeq("srv", "agent")).toBeUndefined();
  });
});
