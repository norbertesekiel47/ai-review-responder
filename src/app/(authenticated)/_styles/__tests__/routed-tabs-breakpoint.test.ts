import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Static guard for the #1092 / #1089 navigation contract. Same pattern as
// auth-island.css.test.ts and pricing-css.test.ts.
//
// Why a SOURCE test and not a render test: jsdom does not apply media queries,
// so a rendered pill bar looks identical above and below the breakpoint. The
// only place the rule exists is the stylesheet, so the stylesheet is what gets
// asserted.
//
// What it protects: below 768px `.sidebar` is hidden and `MobileTabBar` has no
// children mechanism, so the routed pill bars are the ONLY path to
// /dashboard/reviews/history, /dashboard/requests/contacts,
// /dashboard/requests/qr and /dashboard/analytics/restraint on a phone. Hiding
// them at every width strands four routes on every phone — the regression
// #1089 exists to prevent.
const consoleCss = readFileSync(
  resolve(process.cwd(), 'src/app/(authenticated)/_styles/console.css'),
  'utf-8',
);

/** The body of the `@media (max-width: 768px)` block that hides `.sidebar`. */
function sidebarBreakpointBlock(): string {
  const start = consoleCss.indexOf('@media (max-width: 768px)', consoleCss.indexOf('.mobile-tabbar'));
  expect(start, 'the sidebar breakpoint block was not found').toBeGreaterThan(-1);
  // Balanced-brace scan: the block contains nested rules.
  let depth = 0;
  for (let i = consoleCss.indexOf('{', start); i < consoleCss.length; i += 1) {
    if (consoleCss[i] === '{') depth += 1;
    else if (consoleCss[i] === '}') {
      depth -= 1;
      if (depth === 0) return consoleCss.slice(start, i + 1);
    }
  }
  throw new Error('unterminated media block');
}

describe('routed tab bars are scoped to the sidebar breakpoint', () => {
  it('no in-page tab pill bar is visible above the sidebar breakpoint', () => {
    // The base (desktop) rule hides the routed bars. Desktop navigation is the
    // sidebar children instead.
    const base = /^\.tabs--routed\s*\{([^}]*)\}/m.exec(consoleCss);
    expect(base, 'no base .tabs--routed rule').not.toBeNull();
    expect(base![1]).toMatch(/display:\s*none/);
  });

  it('every sub-route reachable by a pill today is still reachable below the breakpoint', () => {
    // The same media block that hides `.sidebar` must restore the routed bars,
    // so the two can never disagree about where the boundary is.
    const block = sidebarBreakpointBlock();
    expect(block).toMatch(/\.sidebar\s*\{\s*display:\s*none/);
    const restored = /\.tabs--routed\s*\{([^}]*)\}/.exec(block);
    expect(restored, '.tabs--routed is never restored below the breakpoint').not.toBeNull();
    expect(restored![1]).not.toMatch(/display:\s*none/);
  });

  it('uses ONE breakpoint number, not a second copy', () => {
    // #1089's accepted cost is two navigation models, bounded by ONE boundary.
    // A second number is how they start disagreeing.
    const routedRules = consoleCss.match(/\.tabs--routed/g) ?? [];
    expect(routedRules.length).toBe(2);
  });

  it('does not hide the bare .tabs container, which a future bar may reuse', () => {
    // CardViewTabs is a VIEW switch and must stay on desktop. It uses
    // `card-view-tabs` today, so hiding `.tabs` would work by luck; the marker
    // class is what makes the intent explicit.
    const bare = /^\.tabs\s*\{([^}]*)\}/m.exec(consoleCss);
    expect(bare, 'no .tabs rule').not.toBeNull();
    expect(bare![1]).not.toMatch(/display:\s*none/);
  });
});
