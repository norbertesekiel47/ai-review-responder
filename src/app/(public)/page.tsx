import type { Metadata } from 'next';
import { CLOSED_NOTICE_CTA } from '@/components/ui/marketing-links';
import { LandingExperience } from '@/components/sections/landing/LandingExperience';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  // The root layout's `title.template` appends ' · RepWorth', so this title
  // carries no brand of its own (#1102).
  title: 'The AI agent team for your reputation',
  description:
    'A supervised fleet of AI agents answers your Google reviews in your voice, asks your customers for new ones, briefs you every Monday, and keeps the score. Nothing posts outside the gate you control.',
};

export default function LandingPage() {
  // RepWorth has shut down (2026-10). Every CTA on the page is the closed door
  // to the `/closed` notice, and the nav's Log in / Sign up pair stays hidden:
  // signup, login and the lead-capture route all redirect to the notice
  // (next.config.mjs), so offering them would only bounce the visitor there.
  return (
    <LandingExperience
      primaryCtaHref={CLOSED_NOTICE_CTA.href}
      primaryCtaLabel={CLOSED_NOTICE_CTA.label}
      selfServeEnabled={false}
    />
  );
}
