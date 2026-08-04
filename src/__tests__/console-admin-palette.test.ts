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
//   - review stars: dashboard token --rw-star is Warm Editorial gold #D4A24C (2026-06 redesign);
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
  // Admin tool — the five Phase 2 pages, chrome converged onto the server page
  // (CF-4: page.tsx now carries the chrome + actions markup, so it is swept too)
  'src/app/admin/overview/page.tsx',
  'src/app/admin/overview/OverviewClient.tsx',
  'src/app/admin/jobs/page.tsx',
  'src/app/admin/jobs/JobsClient.tsx',
  'src/app/admin/costs/page.tsx',
  'src/app/admin/costs/CostsClient.tsx',
  'src/app/admin/notifications/page.tsx',
  'src/app/admin/notifications/NotificationsClient.tsx',
  'src/app/admin/flagged/page.tsx',
  'src/app/admin/flagged/FlaggedClient.tsx',
  // Shared shell states — re-chromed on this branch, and CF-4's rule covers
  // them even though they are not `page.tsx` so the derived check below cannot
  // find them.
  'src/app/admin/error.tsx',
  'src/app/admin/loading.tsx',
  'src/app/admin/autonomy/AutonomySuspensionsClient.tsx',
  'src/app/admin/runbook/page.tsx',
  'src/app/admin/businesses/page.tsx',
  'src/app/admin/businesses/BusinessesClient.tsx',
  'src/app/admin/businesses/[id]/BusinessDetailClient.tsx',
  'src/app/admin/businesses/[id]/_components/PastDueExtensionPanel.tsx',
  'src/app/admin/businesses/[id]/_components/ReviewsList.tsx',
  'src/app/admin/businesses/[id]/_components/ZernioConnectionPanel.tsx',
  'src/app/admin/businesses/[id]/_components/ChannelsPanel.tsx',
  'src/app/admin/businesses/[id]/_components/AutoApprovalDiagnosticsPanel.tsx',
  'src/app/admin/businesses/[id]/_components/ManualRankingSection.tsx',
  'src/app/admin/businesses/[id]/_components/TrackedKeywordsSection.tsx',
  'src/app/admin/businesses/[id]/_components/ProfileEditor.tsx',
  'src/app/admin/businesses/new/NewBusinessClient.tsx',
  'src/app/admin/businesses/new/_components/_shared.tsx',
  'src/app/admin/businesses/new/_components/BusinessInfoSection.tsx',
  'src/app/admin/businesses/new/_components/OwnerInfoSection.tsx',
  'src/app/admin/businesses/new/_components/VoiceContextSection.tsx',
  'src/app/admin/businesses/new/_components/SubscriptionTierSection.tsx',
  'src/app/admin/locations/csv-import/CsvImportClient.tsx',
  'src/app/admin/locations/csv-import/page.tsx',
  'src/app/admin/offboardings/OffboardingsClient.tsx',
  'src/app/admin/demos/DemosClient.tsx',
  'src/app/admin/impersonate/page.tsx',
  'src/app/admin/impersonate/ImpersonationStartClient.tsx',
  'src/app/admin/impersonate/[sessionId]/view/page.tsx',
  'src/app/admin/impersonate/[sessionId]/view/ImpersonationLocationsTable.tsx',
  'src/components/admin/TelegramEnrollmentWidget.tsx',
  'src/components/admin/WhatsAppEnrollmentWidget.tsx',
  // Admin tool — shared UI primitives (Phase 2 console migration)
  'src/components/admin/ui/AdminPage.tsx',
  'src/components/admin/ui/DataTable.tsx',
  'src/components/admin/ui/FilterBar.tsx',
  'src/components/admin/ui/StatTile.tsx',
  'src/components/admin/ui/StatusBadge.tsx',
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
 * gray; blue is reserved for the shared StatusBadge" — as an ENFORCED layer
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
 * 3. Exemptions are per-file with a written reason, so a failure message
 *    explains itself and adding one is a visible, reviewable act.
 */
const ADMIN_ROOTS = ['src/app/admin/', 'src/components/admin/'];
const isAdminFile = (relPath: string) => ADMIN_ROOTS.some((root) => relPath.startsWith(root));

const BLUE_EXEMPT: Record<string, string> = {
  // The one sanctioned blue in the console: `trialing` (subscription) and
  // `dispatching`/`dispatched` (outbox) — an in-flight state that has no other
  // colour in the green/yellow/red/gray vocabulary. Every page reads its badge
  // colours from here precisely so no page hand-picks one (spec §3).
  'src/components/admin/ui/StatusBadge.tsx':
    'blue is the legitimate trialing / dispatching status colour',
  // Channel BRAND identity, not a primary-action colour: this widget renders
  // beside WhatsAppEnrollmentWidget, whose `bg-green-600` is protected by the
  // semantic-green rule. Neutralising only the Telegram half leaves a gray/green
  // Connect pair that reads as a bug. The pair moves together or not at all.
  'src/components/admin/TelegramEnrollmentWidget.tsx':
    'Telegram brand blue, paired with the protected WhatsApp brand green',
};

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
    const exemptReason = BLUE_EXEMPT[relPath];
    const text = readFileSync(resolve(process.cwd(), relPath), 'utf-8');
    const hits = ADMIN_BANNED.filter(({ re }) => re.test(text));

    if (exemptReason) {
      // Assert the exemption is still LOAD-BEARING. A file that no longer
      // contains any blue has outgrown its exemption, and a dead BLUE_EXEMPT
      // entry would silently un-guard that file again later.
      expect(
        hits.length,
        `${relPath} is exempt ("${exemptReason}") but no longer contains blue or indigo — drop it from BLUE_EXEMPT`,
      ).toBeGreaterThan(0);
      return;
    }

    expect(
      hits.map(({ label }) => label),
      `${relPath} still contains a decorative blue/indigo Tailwind class`,
    ).toEqual([]);
  });

  it('every BLUE_EXEMPT entry is an admin file that is actually swept', () => {
    for (const relPath of Object.keys(BLUE_EXEMPT)) {
      expect(ADMIN_SWEPT_FILES, `${relPath} is exempt but not swept`).toContain(relPath);
    }
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
