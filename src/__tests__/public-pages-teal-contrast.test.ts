import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Enforceable contrast guard for the public surface — see
 * docs/adr/0004-accessible-teal-token-split.md.
 *
 * `#97B3AE` (--rw-teal) is DECORATION only. As a foreground TEXT color it is
 * 2.24:1 on white — fails WCAG AA. Text/links/actionable teal must use
 * `#557069` (--rw-teal-strong, 5.37:1). The personal `repworth-brand-design`
 * skill is NOT source-controlled, so this test is the regression guard.
 *
 * Rule: no `text-[#97B3AE]` in public source EXCEPT on an `aria-hidden`
 * element (a decorative rating glyph whose accessible name lives on its
 * labelled container). Out-of-scope surfaces (admin/onboarding/mfa/dashboard)
 * are governed separately and not scanned here.
 */
const ROOTS = [
  'src/app/(public)',
  'src/components/sections',
  'src/components/approval',
  'src/components/legal',
  'src/components/auth',
];
const CHROME_FILES = [
  'src/components/ui/SiteNav.tsx',
  'src/components/ui/SiteFooter.tsx',
  'src/components/ui/SiteShell.tsx',
  'src/components/ui/PageShell.tsx',
  'src/components/ui/MarqueeBackground.tsx',
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === '__tests__' || entry === 'node_modules') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else if (/\.tsx$/.test(entry) && !/\.test\.tsx$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

function publicSourceFiles(): string[] {
  const root = process.cwd();
  const files: string[] = [];
  for (const r of ROOTS) {
    const abs = join(root, r);
    if (existsSync(abs)) files.push(...walk(abs));
  }
  for (const f of CHROME_FILES) {
    const abs = join(root, f);
    if (existsSync(abs)) files.push(abs);
  }
  return files;
}

describe('public pages teal contrast (ADR 0004)', () => {
  it('uses no #97B3AE as foreground text (only aria-hidden decorative glyphs may)', () => {
    const violations: string[] = [];
    for (const file of publicSourceFiles()) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (line.includes('text-[#97B3AE]') && !line.includes('aria-hidden')) {
          violations.push(`${file}:${i + 1}`);
        }
      });
    }
    expect(violations, `Replace #97B3AE text with #557069 (--rw-teal-strong):\n${violations.join('\n')}`).toEqual([]);
  });

  it('the accessible token exists in globals.css', () => {
    const css = readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf8');
    expect(css).toContain('--rw-teal-strong: #557069');
  });
});
