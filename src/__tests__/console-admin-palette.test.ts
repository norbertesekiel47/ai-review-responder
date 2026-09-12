import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// 2026-05 launch audit P1 #14 (doc retired) + repworth-brand-design rubric: amber, orange, and
// stone are banned. This guard locks the swept Console + Admin surfaces so the
// off-brand palette cannot silently regress. SCOPED to the cleaned file set —
// NOT global — so it never trips on the deliberately-excluded surfaces:
//   - src/app/(authenticated)/dashboard/connect/page.tsx        (P0 #10)
//   - chart SERIES color #ea580c (RankingChart, AggregateVelocityCard,
//     tokens.css --rw-chart-5)                                  (data-viz)
//   - review stars: dashboard token --rw-star is accessible Warm Editorial gold #9A691D;
//     marketing/auth/admin glyphs stay teal #97B3AE — all locked by no-yellow-star-colors.test.ts
const SWEPT_FILES = [
  // Owner Console — token system
  'src/app/(authenticated)/_styles/tokens.css',
  'src/app/(authenticated)/_styles/console.css',
  'src/components/dashboard/account-state/ConnectGoogleBanner.tsx',
  // Owner Console — edit-reply drawer
  'src/components/dashboard/reviews/EditReplyDrawer.tsx',
  'src/components/dashboard/reviews/edit-reply/DraftConflictPanel.tsx',
  'src/components/dashboard/reviews/edit-reply/RecoveryPanel.tsx',
  'src/components/dashboard/reviews/edit-reply/PreviewPanel.tsx',
  'src/components/dashboard/reviews/edit-reply/ManualEditor.tsx',
  'src/components/dashboard/reviews/edit-reply/ReviewChangedPanel.tsx',
  // Permanent legacy support pages and their minimal shell.
  'src/app/admin/error.tsx',
  'src/app/admin/loading.tsx',
  'src/app/admin/impersonate/page.tsx',
  'src/app/admin/impersonate/ImpersonationStartClient.tsx',
  'src/app/admin/impersonate/[sessionId]/view/page.tsx',
  'src/app/admin/impersonate/[sessionId]/view/ImpersonationLocationsTable.tsx',
  'src/components/admin/AdminShellFrame.tsx',
  'src/components/admin/AdminIdentity.tsx',
  // Shared UI primitives retained by the permanent support pages.
  'src/components/admin/ui/AdminPage.tsx',
  'src/components/admin/ui/DataTable.tsx',
  'src/components/admin/ui/states.tsx',
];

// Class-name / token-name patterns only (not raw hexes) — this avoids colliding
// with the allowlisted chart hex #ea580c and mirrors the island-overflow guard's
// approach of asserting on the offending declaration text.
const BANNED = [
  { label: 'amber Tailwind class', re: /\bamber-\d/ },
  { label: 'orange Tailwind class', re: /\borange-\d/ },
  { label: 'stone Tailwind class', re: /\bstone-\d/ },
  { label: 'banner-orange CSS class', re: /banner-orange/ },
  { label: 'legacy --rw-orange token', re: /--rw-orange/ },
];

describe('Console + Admin carry no banned amber/orange/stone palette (P1 #14)', () => {
  it.each(SWEPT_FILES)('%s uses no banned palette tokens', (relPath) => {
    const text = readFileSync(resolve(process.cwd(), relPath), 'utf-8');
    for (const { label, re } of BANNED) {
      expect(text, `${relPath} still contains a ${label}`).not.toMatch(re);
    }
  });
});

/**
 * Convention #5's second half — "blue/indigo used decoratively becomes neutral
 * gray" — as an ENFORCED layer
 * rather than an aspiration. It is deliberately NOT folded into `BANNED`:
 *
 * 1. SWEPT_FILES is a mixed set. Roughly a third of it is owner-console /
 *    dashboard surface (`_styles/tokens.css`, the edit-reply drawer, the
 *    connect banner) where blue is the legitimate accent. A global blue ban
 *    would either fail on those files or force them out of the amber/orange
 *    sweep they were added for. So this rule takes the same set and filters it
 *    to the admin console.
 * 2. The scope is DERIVED from the path, not a second hand-maintained list —
 *    any admin file added to SWEPT_FILES is covered by this rule the moment it
 *    is added, with no second edit to remember.
 * 3. The former StatusBadge and Telegram exceptions retired with those modules.
 *    Every surviving admin file in the set now has the same check.
 */
const ADMIN_ROOTS = ['src/app/admin/', 'src/components/admin/'];
const isAdminFile = (relPath: string) => ADMIN_ROOTS.some((root) => relPath.startsWith(root));

const ADMIN_BANNED = [
  { label: 'decorative blue Tailwind class', re: /\bblue-\d/ },
  { label: 'decorative indigo Tailwind class', re: /\bindigo-\d/ },
];

const ADMIN_SWEPT_FILES = SWEPT_FILES.filter(isAdminFile);

describe('Admin console carries no decorative blue/indigo (convention #5)', () => {
  it('the admin-scoped subset is non-empty and excludes the owner console', () => {
    expect(ADMIN_SWEPT_FILES.length).toBeGreaterThan(0);
    expect(ADMIN_SWEPT_FILES).not.toContain('src/app/(authenticated)/_styles/tokens.css');
  });

  it.each(ADMIN_SWEPT_FILES)('%s uses no decorative blue or indigo', (relPath) => {
    const text = readFileSync(resolve(process.cwd(), relPath), 'utf-8');
    const hits = ADMIN_BANNED.filter(({ re }) => re.test(text));

    expect(
      hits.map(({ label }) => label),
      `${relPath} still contains a decorative blue/indigo Tailwind class`,
    ).toEqual([]);
  });

});

/**
 * CF-4. Phases 2/3 moved chrome markup — and the `actions`-slot buttons — OUT of
 * the client components and INTO the server pages, so a SWEPT_FILES list that
 * only names `*Client.tsx` goes blind exactly where the Tailwind moved. This
 * derives the obligation from the filesystem instead of trusting the list:
 * every `src/app/admin/**\/page.tsx` that carries a `className` must be swept.
 */
function adminPagesWithClassNames(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === 'page.tsx' && readFileSync(full, 'utf-8').includes('className')) {
        out.push(relative(process.cwd(), full));
      }
    }
  };
  walk(resolve(process.cwd(), 'src/app/admin'));
  return out.sort();
}

describe('every admin page.tsx that carries Tailwind is swept (CF-4)', () => {
  it('finds admin pages to check', () => {
    expect(adminPagesWithClassNames().length).toBeGreaterThan(0);
  });

  it.each(adminPagesWithClassNames())('%s is listed in SWEPT_FILES', (relPath) => {
    expect(SWEPT_FILES, `${relPath} carries Tailwind but is not in SWEPT_FILES`).toContain(relPath);
  });
});
