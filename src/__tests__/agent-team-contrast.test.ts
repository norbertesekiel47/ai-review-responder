import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const CONSOLE = resolve(process.cwd(), 'src/app/(authenticated)/_styles/console.css');

describe('agent-team activity label contrast', () => {
  it('uses the readable muted text token, never the low-contrast soft token', () => {
    const css = readFileSync(CONSOLE, 'utf-8');
    const rule = css.match(/\.agent-team-activity span\s*\{([^}]*)\}/)?.[1] ?? '';

    expect(rule).toMatch(/color:\s*var\(--rw-app-text-muted\)/);
    expect(rule).not.toMatch(/var\(--rw-app-text-soft\)/);
  });
});
