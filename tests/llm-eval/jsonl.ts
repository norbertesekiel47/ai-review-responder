export interface ParsedJsonLine {
  lineNumber: number;
  value: unknown;
}

/** Parse non-empty JSONL lines while preserving their one-based source line. */
export function* parseJsonLines(
  jsonl: string,
  label: string,
): Generator<ParsedJsonLine, void, void> {
  for (const [index, line] of jsonl.split('\n').entries()) {
    const trimmed = line.trim();
    if (trimmed === '') continue;

    let value: unknown;
    try {
      value = JSON.parse(trimmed) as unknown;
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'unknown JSON error';
      throw new Error(`${label} line ${index + 1} is not valid JSON: ${detail}`);
    }
    yield { lineNumber: index + 1, value };
  }
}
