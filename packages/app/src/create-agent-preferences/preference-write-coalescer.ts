import type { FormPreferences } from "./preferences";
import type { FormPreferenceUpdate } from "./service";

export function createPreferenceWriteCoalescer(input: {
  delayMs: number;
  persist: (update: FormPreferenceUpdate) => Promise<unknown>;
  onError: (error: unknown) => void;
}): {
  schedule: (update: FormPreferenceUpdate) => void;
  flush: () => void;
} {
  // Coalesce rapid model/mode switches into one persisted write. Each write pays
  // for JSON.stringify plus Zod validation plus an AsyncStorage flush, so firing
  // one per tap blocks the JS thread and drops frames on low-end Android devices.
  let timeout: ReturnType<typeof setTimeout> | null = null;
  let queued: FormPreferenceUpdate[] = [];

  const flush = () => {
    if (timeout !== null) {
      clearTimeout(timeout);
      timeout = null;
    }
    if (queued.length === 0) return;
    const pending = queued;
    queued = [];
    const folded: FormPreferenceUpdate = (current: FormPreferences) => {
      let next = current;
      for (const update of pending) {
        next = typeof update === "function" ? update(next) : { ...next, ...update };
      }
      return next;
    };
    void input.persist(folded).catch((error) => {
      // Validation/storage failures are rare, but a lost preference update is
      // silent and hard to debug, so surface it instead of swallowing it.
      input.onError(error);
    });
  };

  return {
    schedule: (update) => {
      queued.push(update);
      if (timeout !== null) {
        clearTimeout(timeout);
      }
      timeout = setTimeout(() => {
        timeout = null;
        flush();
      }, input.delayMs);
    },
    flush,
  };
}
