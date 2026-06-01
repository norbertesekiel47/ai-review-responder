export function uniqueSiblingKey(seen: Map<string, number>, base: string): string {
  const occurrence = seen.get(base) ?? 0;
  seen.set(base, occurrence + 1);
  return `${occurrence}:${base}`;
}
