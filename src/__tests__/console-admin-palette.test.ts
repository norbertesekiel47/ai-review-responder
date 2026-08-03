import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
  // Admin tool
  'src/app/admin/overview/OverviewClient.tsx',
  'src/app/admin/jobs/JobsClient.tsx',
  'src/app/admin/costs/CostsClient.tsx',
  'src/app/admin/notifications/NotificationsClient.tsx',
  'src/app/admin/flagged/FlaggedClient.tsx',
  'src/app/admin/businesses/[id]/page.tsx',
  'src/app/admin/businesses/[id]/_components/PastDueExtensionPanel.tsx',
  'src/app/admin/businesses/[id]/_components/ReviewsList.tsx',
  'src/app/admin/businesses/[id]/_components/ZernioConnectionPanel.tsx',
  'src/app/admin/impersonate/ImpersonationStartClient.tsx',
  'src/app/admin/impersonate/[sessionId]/view/page.tsx',
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
