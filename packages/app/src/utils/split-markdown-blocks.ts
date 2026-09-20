import MarkdownIt from "markdown-it";

// Only block maps are needed here; inline parsing belongs to each rendered block.
const markdownBlockParser = new MarkdownIt();
markdownBlockParser.core.ruler.disable("inline");

export function splitMarkdownBlocks(text: string): string[] {
  if (text.length === 0) {
    return [];
  }

  const blocks: string[] = [];
  let currentLines: string[] = [];
  let sawBlockSeparator = false;
  const lines = text.split("\n");
  const structuralBlankLines = collectStructuralBlankLines(text, lines);

  for (const [index, line] of lines.entries()) {
    const lineIsBlank = isBlankLine(line);

    if (lineIsBlank && structuralBlankLines.has(index)) {
      currentLines.push(line);
      continue;
    }

    if (lineIsBlank) {
      if (currentLines.length > 0) {
        sawBlockSeparator = true;
      }
      continue;
    }

    if (sawBlockSeparator) {
      blocks.push(currentLines.join("\n"));
      currentLines = [];
      sawBlockSeparator = false;
    }

    currentLines.push(line);
  }

  if (currentLines.length > 0) {
    blocks.push(currentLines.join("\n"));
  }

  return blocks.filter((block) => block.length > 0);
}

function isBlankLine(line: string): boolean {
  return line.trim().length === 0;
}

// The streamed text reaches this function on every reveal frame, so the full
// markdown-it pass cannot run unconditionally. When every blank line sits
// inside a top-level fenced code block (or there are no blank lines at all),
// they are all structural and the parse adds nothing. Anything ambiguous —
// loose lists, indented code, fences nested in quotes — falls through to the
// real parse. Over-merging here is safe: a missed split only renders the same
// text as one markdown document, while an over-split would break a fence.
const FENCE_OPEN_PATTERN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE_PATTERN = /^ {0,3}(`{3,}|~{3,})\s*$/;

function blankLinesOnlyInsideFences(lines: string[]): Set<number> | null {
  const blankLines = new Set<number>();
  let fenceChar: string | null = null;
  let fenceLength = 0;

  for (const [index, line] of lines.entries()) {
    if (isBlankLine(line)) {
      if (fenceChar === null) {
        return null;
      }
      blankLines.add(index);
      continue;
    }

    if (fenceChar !== null) {
      const close = FENCE_CLOSE_PATTERN.exec(line);
      if (close && close[1][0] === fenceChar && close[1].length >= fenceLength) {
        fenceChar = null;
      }
      continue;
    }

    const open = FENCE_OPEN_PATTERN.exec(line);
    if (!open) {
      continue;
    }
    const marker = open[1];
    // A backtick fence's info string cannot itself contain a backtick.
    if (marker[0] === "`" && open[2].includes("`")) {
      continue;
    }
    fenceChar = marker[0];
    fenceLength = marker.length;
  }

  return blankLines;
}

function collectStructuralBlankLines(text: string, lines: string[]): Set<number> {
  const fenced = blankLinesOnlyInsideFences(lines);
  if (fenced !== null) {
    return fenced;
  }
  return getStructuralBlankLines(text, lines);
}

function getStructuralBlankLines(text: string, lines: string[]): Set<number> {
  const blankLines = new Set<number>();
  for (const token of markdownBlockParser.parse(text, {})) {
    if (token.level !== 0 || !token.map) {
      continue;
    }
    const [start, end] = token.map;
    for (let index = start; index < end - 1; index += 1) {
      if (lines[index]?.trim().length === 0) {
        blankLines.add(index);
      }
    }
  }
  return blankLines;
}
