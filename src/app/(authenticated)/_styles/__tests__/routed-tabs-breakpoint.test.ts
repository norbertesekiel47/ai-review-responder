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

// `.rq-subnav` is owned by the ROUTE stylesheet, not the layout one. That is
// not a detail: `requests.css` is page-imported by `RequestsTabs`, so it loads
// AFTER console.css, and an equal-specificity rule over there is silently
// overridden. The first version of this fix put `display: none` in console.css
// and had no effect in a browser while this test — which read only console.css
// — passed (round-2 review, 2026-09-03). Reading both files is the point.
const requestsCss = readFileSync(
  resolve(process.cwd(), 'src/app/(authenticated)/dashboard/requests/requests.css'),
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
    //
    // Asserting the NUMBER, not a selector count: the earlier version counted
    // `.tabs--routed` occurrences, so changing 768px to 900px still passed
    // while a harmless third rule failed a working feature (standards review,
    // 2026-09-03).
    const block = sidebarBreakpointBlock();
    expect(block.startsWith('@media (max-width: 768px)')).toBe(true);
    // No OTHER media query may govern the routed bars.
    for (const match of consoleCss.matchAll(/@media\s*\(([^)]*)\)\s*\{/g)) {
      const start = match.index!;
      const body = consoleCss.slice(start, start + 4000);
      if (!/\.tabs--routed|\.rq-subnav|\.reviews-subnav--tabs-only/.test(body.split('@media')[1] ?? body)) continue;
      expect(match[1]!.trim(), 'a second breakpoint governs the routed bars').toBe(
        'max-width: 768px',
      );
    }
  });

  it('hides the ROWS that hold nothing but a routed bar', () => {
    // Hiding the nav alone leaves its row's `padding: 20px 32px 0` as an
    // unexplained band on desktop (standards + spec review, 2026-09-03).
    const reviewsRow = /^\.reviews-subnav--tabs-only\s*\{([^}]*)\}/m.exec(consoleCss);
    expect(reviewsRow, 'no base rule for .reviews-subnav--tabs-only').not.toBeNull();
    expect(reviewsRow![1]).toMatch(/display:\s*none/);
    expect(sidebarBreakpointBlock()).toMatch(
      /\.reviews-subnav--tabs-only\s*\{[^}]*display:\s*flex/,
    );

    // `.rq-subnav` is asserted in ITS OWN stylesheet. Asserting it in
    // console.css is what let the broken version pass.
    const rqRow = /^\.rq-subnav\s*\{([^}]*)\}/m.exec(requestsCss);
    expect(rqRow, 'no base .rq-subnav rule in requests.css').not.toBeNull();
    expect(rqRow![1]).toMatch(/display:\s*none/);
    expect(requestsCss).toMatch(
      /@media\s*\(max-width:\s*768px\)\s*\{[^}]*\.rq-subnav\s*\{[^}]*display:\s*flex/,
    );
  });

  it('does not try to govern .rq-subnav from the layout stylesheet', () => {
    // The regression this test exists for: console.css loads BEFORE
    // requests.css, so any display rule for `.rq-subnav` there is dead.
    const stray = /^\.rq-subnav\s*\{([^}]*)\}/m.exec(consoleCss);
    expect(stray, '.rq-subnav display rule is back in console.css, where it loses').toBeNull();
  });

  it('never hides the Reviews history row, which carries more than tabs', () => {
    // `.reviews-subnav` also holds "Showing: <location>" on the history route.
    // Hiding it would hide real information; it is re-aligned instead.
    const base = /^\.reviews-subnav\s*\{([^}]*)\}/m.exec(consoleCss);
    expect(base, 'no base .reviews-subnav rule').not.toBeNull();
    const desktopOverride = /^\.reviews-subnav\s*\{\s*justify-content:\s*flex-end;\s*\}/m.exec(consoleCss);
    expect(desktopOverride, 'the lone Showing span is not re-aligned').not.toBeNull();
    expect(sidebarBreakpointBlock()).toMatch(
      /\.reviews-subnav\s*\{[^}]*justify-content:\s*space-between/,
    );
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
