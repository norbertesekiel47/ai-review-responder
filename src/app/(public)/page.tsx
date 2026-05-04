import { headers } from 'next/headers';
import { LandingContent } from '@/components/sections/landing/LandingContent';

export const dynamic = 'force-dynamic';

export default function LandingPage() {
  const comingSoon = headers().get('x-coming-soon') === '1';
  const selfServeEnabled = process.env.SELF_SERVE_SIGNUP_ENABLED === 'true';
  return <LandingContent comingSoon={comingSoon} selfServeEnabled={selfServeEnabled} />;
}
