import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Launch audit (lines 75, 126): user-facing emails/URLs must use the canonical
// .net apex. The live sender is RESEND_FROM_EMAIL (env, Resend-verified) and is
// intentionally not asserted here. This scans non-test src for the .com apex.
const SRC = resolve(process.cwd(), 'src');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__') return [];
      return walk(full);
    }
    if (!/\.(ts|tsx)$/.test(entry)) return [];
    if (/\.test\.(ts|tsx)$/.test(entry)) return [];
    return [full];
  });
}

describe('canonical domain (.net) — no user-facing @repworth.com', () => {
  const files = walk(SRC);

  it('scans a non-trivial number of source files', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it.each(files)('%s contains no @repworth.com literal', (file) => {
    const src = readFileSync(file, 'utf-8');
    // Substring match; @repworth.example.com (the deliberate unsubscribe
    // placeholder) does NOT contain "@repworth.com" and is unaffected.
    expect(src.includes('@repworth.com')).toBe(false);
  });
});
