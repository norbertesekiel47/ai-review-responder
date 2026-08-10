import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf-8');

describe('runbook + empty-state polish (P2 #28)', () => {
  it('admin runbook page renders inside the shared AdminPage chrome, not its own min-h-screen wrapper', () => {
    const src = read('src/app/admin/runbook/page.tsx');
    expect(src).toContain('<AdminPage');
    expect(src).not.toMatch(/min-h-screen/);
  });
  it('past-replies empty-state icon is brand teal, not blue', () => {
    const css = read('src/app/(authenticated)/_styles/past-replies.css');
    expect(css).toMatch(/\.pr-empty-icon\s*\{[^}]*var\(--rw-accent-fg\)/);
    expect(css).not.toMatch(/\.pr-empty-icon\s*\{[^}]*var\(--rw-accent-600\)/);
  });
});
