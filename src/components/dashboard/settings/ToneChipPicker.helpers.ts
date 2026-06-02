/**
 * Best-effort guess of which preset tone matches an existing string. Used to
 * highlight a chip on first render. The picker tracks active mode in local
 * state so it can switch to "custom" regardless of what `tone` infers to.
 */
export function inferActiveTone(tone: string): string {
  const lower = tone.toLowerCase();
  if (lower.includes('witty') || lower.includes('cheeky')) return 'witty';
  if (lower.includes('professional')) return 'professional';
  if (lower.includes('warm') || lower.includes('friendly')) return 'warm';
  if (lower.includes('casual')) return 'casual';
  if (lower.includes('concise')) return 'concise';
  return 'custom';
}
