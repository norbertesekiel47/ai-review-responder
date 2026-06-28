import type { Metadata } from 'next';
import { selfServeSignupEnabled } from '@/lib/auth/flags';
import { trialEnabled as isTrialEnabled } from '@/lib/payments/flags';
import { LandingContent } from '@/components/sections/landing/LandingContent';
import { VideoHero } from '@/components/sections/landing/VideoHero';
import { getServerConfig } from '@/lib/config/server';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'RepWorth — Automated Google review responses',
  description:
    'RepWorth drafts on-brand replies to your Google reviews and posts them only after you approve. Reply to every review without the busywork.',
};

function resolveTrialDays(): number {
  const parsed = Number.parseInt(getServerConfig().TRIAL_PERIOD_DAYS ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30;
}

export default function LandingPage() {
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
