import type { Metadata } from 'next';
import { LandingContent } from '@/components/sections/landing/LandingContent';
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
  const selfServeEnabled = process.env.SELF_SERVE_SIGNUP_ENABLED === 'true';
  // Server-authoritative trial flag (invariant #13: no NEXT_PUBLIC_* companion).
  // The hero CTA only switches to the trial offer when self-serve signup is also
  // live — there is no signup to start a trial from otherwise.
  const trialEnabled = process.env.TRIAL_ENABLED === 'true' && selfServeEnabled;
  return (
    <LandingContent
      selfServeEnabled={selfServeEnabled}
      trialEnabled={trialEnabled}
      trialDays={resolveTrialDays()}
    />
  );
}
