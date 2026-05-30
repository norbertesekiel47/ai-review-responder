import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf-8');

describe('runbook + empty-state polish (P2 #28)', () => {
  it('admin runbook root wrapper carries min-h-screen', () => {
    const src = read('src/app/admin/runbook/page.tsx');
    expect(src).toMatch(/className="[^"]*min-h-screen[^"]*"/);
  });
  it('past-replies empty-state icon is brand teal, not blue', () => {
    const css = read('src/app/(authenticated)/_styles/past-replies.css');
    expect(css).toMatch(/\.pr-empty-icon\s*\{[^}]*#97B3AE/i);
    expect(css).not.toMatch(/\.pr-empty-icon\s*\{[^}]*var\(--rw-blue-600\)/);
  });
});
