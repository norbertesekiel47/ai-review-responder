import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// 2026-05 launch audit P2 #27 (doc retired): interactive controls need a ≥44×44 hit area.
const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf-8');

describe('44×44 tap targets (P2 #27)', () => {
  it('.mtab declares min-height: 44px', () => {
    const css = read('src/app/(authenticated)/_styles/console.css');
    expect(css).toMatch(/\.mtab\s*\{[\s\S]*?min-height:\s*44px[\s\S]*?\}/);
  });
  it('marketing .rw-dot-nav button has a 44px transparent hit area (::after)', () => {
    // Island chrome moved out of globals.css into (public)/_styles by PR 3b.
    const css = read('src/app/(public)/_styles/island.css');
    expect(css).toMatch(/\.rw-dot-nav button::after\s*\{[\s\S]*?(min-width|width):\s*44px[\s\S]*?\}/);
  });
  it('PageShell dot-nav button expands its hit area to 44px', () => {
    const tsx = read('src/components/ui/PageShell.tsx');
    expect(tsx).toMatch(/after:-inset-4|after:w-11|min-w-11/);
  });
  it('EditReplyDrawer close button is at least 44px', () => {
    const tsx = read('src/components/dashboard/reviews/EditReplyDrawer.tsx');
    expect(tsx).toMatch(/min-h-11/);
    expect(tsx).toMatch(/min-w-11/);
  });
  it.each(['scheduled-post-chip', 'review-timeline-link'])(
    'review-card .%s has a 44px mobile touch target',
    (className) => {
      const css = read('src/app/(authenticated)/_styles/console.css');
      const mobileRules = css.match(/@media \(max-width: 768px\)\s*\{[\s\S]*?\n\}/g)?.join('\n') ?? '';
      expect(mobileRules).toMatch(new RegExp(`\\.${className}[\\s\\S]*?min-height:\\s*44px`));
      expect(mobileRules).toMatch(new RegExp(`\\.${className}[\\s\\S]*?min-width:\\s*44px`));
    },
  );
});
