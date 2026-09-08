import { afterEach, describe, expect, it, vi } from "vitest";
import { mergeSelectedComposerPreferences } from "../provider-selection/resolve-agent-form";
import { createPreferenceWriteCoalescer } from "./preference-write-coalescer";
import type { FormPreferences } from "./preferences";
import type { FormPreferenceUpdate } from "./service";

interface RecordedPersist {
  updates: FormPreferenceUpdate[];
  persist: (update: FormPreferenceUpdate) => Promise<unknown>;
}

function createRecordedPersist(): RecordedPersist {
  const updates: FormPreferenceUpdate[] = [];
  return {
    updates,
    persist: (update) => {
      updates.push(update);
      return Promise.resolve();
    },
  };
}

function createFailingPersist(failure: Error): RecordedPersist {
  const updates: FormPreferenceUpdate[] = [];
  return {
    updates,
    persist: (update) => {
      updates.push(update);
      return Promise.reject(failure);
    },
  };
}

interface ErrorCollector {
  errors: Error[];
  onError: (error: unknown) => void;
}

function createErrorCollector(): ErrorCollector {
  const errors: Error[] = [];
  return {
    errors,
    onError: (error) => {
      errors.push(error instanceof Error ? error : new Error(String(error)));
    },
  };
}

function applyPersistedUpdates(
  base: FormPreferences,
  updates: FormPreferenceUpdate[],
): FormPreferences {
  let next = base;
  for (const update of updates) {
    next = typeof update === "function" ? update(next) : { ...next, ...update };
  }
  return next;
}

function selectModel(provider: "codex", model: string): FormPreferenceUpdate {
  return (current) =>
    mergeSelectedComposerPreferences({ preferences: current, provider, updates: { model } });
}

describe("preference write coalescer", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("persists rapid model switches as a single write with the last switch winning", () => {
    vi.useFakeTimers();
    const recorded = createRecordedPersist();
    const collector = createErrorCollector();
    const coalescer = createPreferenceWriteCoalescer({
      delayMs: 250,
      persist: recorded.persist,
      onError: collector.onError,
    });

    coalescer.schedule(selectModel("codex", "gpt-5.4"));
    coalescer.schedule(selectModel("codex", "gpt-5.5"));
    coalescer.schedule((current) =>
      mergeSelectedComposerPreferences({
        preferences: current,
        provider: "codex",
        updates: { mode: "full-access" },
      }),
    );
    vi.advanceTimersByTime(249);

    expect(recorded.updates).toEqual([]);

    vi.advanceTimersByTime(1);

    expect(recorded.updates).toHaveLength(1);
    expect(applyPersistedUpdates({}, recorded.updates)).toEqual({
      provider: "codex",
      providerPreferences: {
        codex: { model: "gpt-5.5", mode: "full-access" },
      },
    });
    expect(collector.errors).toEqual([]);
  });

  it("restarts the debounce window on every switch", () => {
    vi.useFakeTimers();
    const recorded = createRecordedPersist();
    const collector = createErrorCollector();
    const coalescer = createPreferenceWriteCoalescer({
      delayMs: 250,
      persist: recorded.persist,
      onError: collector.onError,
    });

    coalescer.schedule(selectModel("codex", "gpt-5.4"));
    vi.advanceTimersByTime(200);
    coalescer.schedule(selectModel("codex", "gpt-5.5"));
    vi.advanceTimersByTime(200);

    expect(recorded.updates).toEqual([]);

    vi.advanceTimersByTime(50);

    expect(recorded.updates).toHaveLength(1);
    expect(applyPersistedUpdates({}, recorded.updates)).toEqual({
      provider: "codex",
      providerPreferences: {
        codex: { model: "gpt-5.5" },
      },
    });
    expect(collector.errors).toEqual([]);
  });

  it("flushes pending switches immediately without waiting for the timer", () => {
    vi.useFakeTimers();
    const recorded = createRecordedPersist();
    const collector = createErrorCollector();
    const coalescer = createPreferenceWriteCoalescer({
      delayMs: 250,
      persist: recorded.persist,
      onError: collector.onError,
    });

    coalescer.schedule(selectModel("codex", "gpt-5.4"));
    coalescer.schedule(selectModel("codex", "gpt-5.5"));
    coalescer.flush();

    expect(recorded.updates).toHaveLength(1);
    expect(applyPersistedUpdates({}, recorded.updates)).toEqual({
      provider: "codex",
      providerPreferences: {
        codex: { model: "gpt-5.5" },
      },
    });

    vi.runAllTimers();

    expect(recorded.updates).toHaveLength(1);
    expect(collector.errors).toEqual([]);
  });

  it("persists nothing when the queue is empty", () => {
    vi.useFakeTimers();
    const recorded = createRecordedPersist();
    const collector = createErrorCollector();
    const coalescer = createPreferenceWriteCoalescer({
      delayMs: 250,
      persist: recorded.persist,
      onError: collector.onError,
    });

    coalescer.flush();
    vi.runAllTimers();

    expect(recorded.updates).toEqual([]);
    expect(collector.errors).toEqual([]);
  });

  it("keeps thinking preferences when a later switch changes only the model", () => {
    vi.useFakeTimers();
    const recorded = createRecordedPersist();
    const collector = createErrorCollector();
    const coalescer = createPreferenceWriteCoalescer({
      delayMs: 250,
      persist: recorded.persist,
      onError: collector.onError,
    });

    coalescer.schedule((current) =>
      mergeSelectedComposerPreferences({
        preferences: current,
        provider: "codex",
        updates: { model: "gpt-5.5", thinkingByModel: { "gpt-5.5": "high" } },
      }),
    );
    coalescer.schedule(selectModel("codex", "gpt-5.6"));
    coalescer.flush();

    expect(recorded.updates).toHaveLength(1);
    expect(applyPersistedUpdates({}, recorded.updates)).toEqual({
      provider: "codex",
      providerPreferences: {
        codex: { model: "gpt-5.6", thinkingByModel: { "gpt-5.5": "high" } },
      },
    });
    expect(collector.errors).toEqual([]);
  });

  it("reports a failed persist instead of dropping it silently", async () => {
    vi.useFakeTimers();
    const recorded = createFailingPersist(new Error("disk full"));
    const collector = createErrorCollector();
    const coalescer = createPreferenceWriteCoalescer({
      delayMs: 250,
      persist: recorded.persist,
      onError: collector.onError,
    });

    coalescer.schedule(selectModel("codex", "gpt-5.5"));
    vi.advanceTimersByTime(250);
    await Promise.resolve();

    expect(collector.errors.map((error) => error.message)).toEqual(["disk full"]);

    coalescer.flush();

    expect(recorded.updates).toHaveLength(1);
  });
});
