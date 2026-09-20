// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { highlightToKeyedLines } from "@/utils/highlight-cache";
import { fenceLanguageToExtension, useStreamingKeyedLines } from "./streaming-keyed-lines";

vi.mock("@/utils/highlight-cache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/utils/highlight-cache")>();
  return { ...actual, highlightToKeyedLines: vi.fn(actual.highlightToKeyedLines) };
});

const highlightSpy = vi.mocked(highlightToKeyedLines);

const FIRST_LINE = "const a = 1;";
const SECOND_LINE = "const b = 2;";
const CODE_ONE_LINE = FIRST_LINE;
const CODE_TWO_LINES = `${FIRST_LINE}\n${SECOND_LINE}`;

function renderStreamingHook(code: string, streaming = true, language: string | null = "ts") {
  return renderHook(({ text }) => useStreamingKeyedLines(text, language, streaming), {
    initialProps: { text: code },
  });
}

describe("useStreamingKeyedLines", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    highlightSpy.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("tokenizes the first streamed snapshot", () => {
    const { result } = renderStreamingHook(CODE_ONE_LINE);
    expect(highlightSpy).toHaveBeenCalledTimes(1);
    expect(result.current).toHaveLength(1);
    expect(result.current?.[0].tokens.some(({ token }) => token.style !== null)).toBe(true);
  });

  it("reuses the snapshot for appended frames instead of retokenizing", () => {
    const { result, rerender } = renderStreamingHook(CODE_ONE_LINE);
    const firstLines = result.current;

    rerender({ text: CODE_TWO_LINES });

    expect(highlightSpy).toHaveBeenCalledTimes(1);
    expect(result.current).toHaveLength(2);
    // The unchanged line keeps its tokenized object so memoized spans bail out;
    // the still-growing tail renders unstyled until the next pass.
    expect(result.current?.[0]).toBe(firstLines?.[0]);
    expect(result.current?.[1].tokens).toEqual([
      { key: "1-0", token: { text: SECOND_LINE, style: null } },
    ]);
  });

  it("retokenizes after the refresh interval elapses", () => {
    const { rerender } = renderStreamingHook(CODE_ONE_LINE);
    vi.advanceTimersByTime(200);
    rerender({ text: CODE_TWO_LINES });
    expect(highlightSpy).toHaveBeenCalledTimes(2);
  });

  it("runs a trailing retokenization when the stream pauses mid-window", () => {
    const { result, rerender } = renderStreamingHook(CODE_ONE_LINE);
    rerender({ text: CODE_TWO_LINES });
    expect(highlightSpy).toHaveBeenCalledTimes(1);
    expect(result.current?.[1].tokens[0].token.style).toBeNull();

    act(() => vi.advanceTimersByTime(200));

    expect(highlightSpy).toHaveBeenCalledTimes(2);
    expect(result.current?.[1].tokens.some(({ token }) => token.style !== null)).toBe(true);
  });

  it("retokenizes immediately when the streamed text is not an append", () => {
    const { rerender } = renderStreamingHook(CODE_ONE_LINE);
    rerender({ text: "let a = 1;" });
    expect(highlightSpy).toHaveBeenCalledTimes(2);
  });

  it("tokenizes on every change while not streaming", () => {
    const { rerender } = renderStreamingHook(CODE_ONE_LINE, false);
    expect(highlightSpy).toHaveBeenCalledTimes(1);
    rerender({ text: CODE_TWO_LINES });
    expect(highlightSpy).toHaveBeenCalledTimes(2);
  });

  it("returns null for an unhighlighted language without rechecking per frame", () => {
    const { result, rerender } = renderStreamingHook("line one", true, null);
    expect(result.current).toBeNull();
    rerender({ text: "line one\nline two" });
    expect(result.current).toBeNull();
    expect(highlightSpy).toHaveBeenCalledTimes(1);
  });
});

describe("fenceLanguageToExtension", () => {
  it("maps aliases and ignores trailing info-string arguments", () => {
    expect(fenceLanguageToExtension("typescript")).toBe("ts");
    expect(fenceLanguageToExtension("ts {1,3}")).toBe("ts");
    expect(fenceLanguageToExtension(".js")).toBe("js");
    expect(fenceLanguageToExtension(null)).toBeNull();
    expect(fenceLanguageToExtension("  ")).toBeNull();
  });
});
