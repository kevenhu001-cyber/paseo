import { useEffect, useMemo, useReducer, useRef } from "react";
import { highlightToKeyedLines, type KeyedLine } from "@/utils/highlight-cache";

// Fence info strings ("```ts", "```typescript", "```ts {1,3}") map to the
// extension-based parser table in @getpaseo/highlight. Aliases here only
// cover names that don't already match an extension key in parsers.ts.
const LANGUAGE_ALIASES: Record<string, string> = {
  typescript: "ts",
  javascript: "js",
  python: "py",
  rust: "rs",
  golang: "go",
  "c++": "cpp",
  csharp: "cs",
  "c#": "cs",
  objc: "m",
  "objective-c": "m",
  markdown: "md",
  elixir: "ex",
};

export function fenceLanguageToExtension(info: string | null | undefined): string | null {
  if (!info) return null;
  const first = info.trim().split(/\s+/)[0]?.toLowerCase();
  if (!first) return null;
  const normalized = first.replace(/^\./, "");
  return LANGUAGE_ALIASES[normalized] ?? normalized;
}

// A streaming fence's text grows on every reveal frame, so its
// (extension, code) tokenization cache key misses every time and the shared
// LRU fills with entries for prefixes that are already stale — a full parser
// pass per frame. While streaming, throttle tokenization: between passes,
// reuse the keyed lines whose text is unchanged (memoized token spans bail
// out) and paint the still-growing tail unstyled. A trailing timer runs one
// final pass after the text pauses so a settled stream never leaves the tail
// unstyled. Completed phases tokenize on every change, as before.
const STREAMING_HIGHLIGHT_REFRESH_MS = 200;

interface StreamingHighlightSnapshot {
  code: string;
  codeLines: string[];
  keyedLines: KeyedLine[] | null;
  highlightedAt: number;
}

function unstyledKeyedLine(text: string, index: number): KeyedLine {
  return {
    key: `line-${index}`,
    tokens: [{ key: `${index}-0`, token: { text, style: null } }],
  };
}

function reuseStreamingLines(snapshot: StreamingHighlightSnapshot, code: string): KeyedLine[] {
  return code.split("\n").map((text, index) => {
    const keyedLine = snapshot.keyedLines?.[index];
    return keyedLine !== undefined && snapshot.codeLines[index] === text
      ? keyedLine
      : unstyledKeyedLine(text, index);
  });
}

export function useStreamingKeyedLines(
  code: string,
  language: string | null | undefined,
  streaming: boolean,
): KeyedLine[] | null {
  const snapshotRef = useRef<StreamingHighlightSnapshot | null>(null);
  const servedStaleSnapshotRef = useRef(false);
  // refreshTick is the trailing-refresh epoch: the timer bumps it to force a
  // re-tokenization after the streamed text pauses mid-window.
  const [refreshTick, refreshHighlight] = useReducer((tick: number) => tick + 1, 0);

  const keyedLines = useMemo<KeyedLine[] | null>(() => {
    const extension = fenceLanguageToExtension(language);
    if (!streaming) {
      servedStaleSnapshotRef.current = false;
      return highlightToKeyedLines(code, extension);
    }
    const snapshot = snapshotRef.current;
    const now = Date.now();
    if (
      snapshot !== null &&
      code.startsWith(snapshot.code) &&
      now - snapshot.highlightedAt < STREAMING_HIGHLIGHT_REFRESH_MS
    ) {
      servedStaleSnapshotRef.current = true;
      return snapshot.keyedLines === null ? null : reuseStreamingLines(snapshot, code);
    }
    servedStaleSnapshotRef.current = false;
    const nextLines = highlightToKeyedLines(code, extension);
    snapshotRef.current = {
      code,
      codeLines: code.split("\n"),
      keyedLines: nextLines,
      highlightedAt: now,
    };
    return nextLines;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, language, streaming, refreshTick]);

  useEffect(() => {
    if (!streaming || !servedStaleSnapshotRef.current) {
      return;
    }
    const timer = setTimeout(refreshHighlight, STREAMING_HIGHLIGHT_REFRESH_MS);
    return () => clearTimeout(timer);
  }, [streaming, keyedLines, refreshTick]);

  return keyedLines;
}
