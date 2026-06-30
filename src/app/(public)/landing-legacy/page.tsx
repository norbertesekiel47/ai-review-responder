import type { Metadata } from 'next';
import { selfServeSignupEnabled } from '@/lib/auth/flags';
import { trialEnabled as isTrialEnabled } from '@/lib/payments/flags';
import { LandingContent } from '@/components/sections/landing-legacy/LandingContent';
import { VideoHero } from '@/components/sections/landing-legacy/VideoHero';
import { getServerConfig } from '@/lib/config/server';

export const dynamic = 'force-dynamic';

/**
 * Archived previous landing page, preserved verbatim so it can be restored if
 * the rebuilt landing (`(public)/page.tsx`) is ever rolled back. Kept out of
 * search indexes and the sitemap — it is an internal preview, not a public
 * destination. To restore: move this body back into `(public)/page.tsx` and
 * point the imports at `sections/landing-legacy` (or rename that folder back).
 */
export const metadata: Metadata = {
  title: 'RepWorth — Automated Google review responses (legacy)',
  description:
    'Archived previous RepWorth landing page, kept for reference and rollback.',
  robots: { index: false, follow: false },
};

function resolveTrialDays(): number {
  const parsed = Number.parseInt(getServerConfig().TRIAL_PERIOD_DAYS ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30;
}

export default function LegacyLandingPage() {
  const selfServeEnabled = selfServeSignupEnabled();
  // Server-authoritative trial flag (invariant #13: no NEXT_PUBLIC_* companion).
  // The hero CTA only switches to the trial offer when self-serve signup is also
  // live — there is no signup to start a trial from otherwise.
  const trialEnabled = isTrialEnabled() && selfServeEnabled;
  return (
    <div className="rw-has-video-hero">
      <VideoHero />
      <LandingContent
        selfServeEnabled={selfServeEnabled}
        trialEnabled={trialEnabled}
        trialDays={resolveTrialDays()}
      />
    </div>
  );
}
