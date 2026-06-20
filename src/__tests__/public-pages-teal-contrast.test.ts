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

  it('places no white text on a solid #97B3AE background (white-on-teal = 2.24:1)', () => {
    // A solid `bg-[#97B3AE]` (not the `/NN` opacity variants used for tints/dots)
    // carrying `text-white` fails AA. Bands/buttons that need white copy must use
    // `#557069`+ (ADR 0004 CTA case 2). The `(?!/)` excludes `bg-[#97B3AE]/15` etc.
    const SOLID_TEAL_BG = /bg-\[#97B3AE\](?!\/)/;
    const violations: string[] = [];
    for (const file of publicSourceFiles()) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (SOLID_TEAL_BG.test(line) && line.includes('text-white')) {
          violations.push(`${file}:${i + 1}`);
        }
      });
    }
    expect(violations, `White-on-#97B3AE fails AA — darken the background to #557069:\n${violations.join('\n')}`).toEqual([]);
  });

  it('uses no #97B3AE inline-gradient band background (bands carry copy → must be #557069+)', () => {
    // An inline `background: linear-gradient(... #97B3AE ...)` is a section band
    // that carries copy; white/ink on #97B3AE fails AA, so bands must darken to
    // #557069+. The pricing color swatch uses a `swatch:` key (not `background:`)
    // and is a decorative chip, so it is correctly excluded.
    const violations: string[] = [];
    for (const file of publicSourceFiles()) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (line.includes('background:') && line.includes('linear-gradient') && line.includes('#97B3AE')) {
          violations.push(`${file}:${i + 1}`);
        }
      });
    }
    expect(violations, `Teal gradient band must use #557069+ (white/ink on #97B3AE fails AA):\n${violations.join('\n')}`).toEqual([]);
  });

  it('the accessible token exists in globals.css', () => {
    const css = readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf8');
    expect(css).toContain('--rw-teal-strong: #557069');
  });
});
