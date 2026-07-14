import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('admin autonomy page source', () => {
  it('keeps the page as an SSR root and delegates interactivity to the client component', async () => {
    const source = await readFile('src/app/admin/autonomy/page.tsx', 'utf8');

    expect(source).not.toContain("'use client'");
    expect(source).toContain('AutonomySuspensionsClient');
    expect(source).not.toMatch(/gradient|bg-\[#|text-\[#/);
  });
});
