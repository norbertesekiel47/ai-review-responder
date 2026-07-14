import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('admin security page source', () => {
  it('keeps the page as an SSR root and delegates interactivity to the client component', async () => {
    const source = await readFile('src/app/admin/security/page.tsx', 'utf8');

    expect(source).not.toContain("'use client'");
    expect(source).toContain('AdminSecurityClient');
    expect(source).not.toMatch(/gradient|bg-\[#|text-\[#/);
  });

  it('links the admin MFA surface into the admin nav', async () => {
    const nav = await readFile('src/components/admin/AdminNav.tsx', 'utf8');
    expect(nav).toContain('/admin/security');
  });
});
