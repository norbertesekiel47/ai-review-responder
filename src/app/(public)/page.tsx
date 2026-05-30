import type { Metadata } from 'next';
import { LandingContent } from '@/components/sections/landing/LandingContent';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'RepWorth — Automated Google review responses',
  description:
    'RepWorth drafts on-brand replies to your Google reviews and posts them only after you approve. Reply to every review without the busywork.',
};

export default function LandingPage() {
  const selfServeEnabled = process.env.SELF_SERVE_SIGNUP_ENABLED === 'true';
  return <LandingContent selfServeEnabled={selfServeEnabled} />;
}
