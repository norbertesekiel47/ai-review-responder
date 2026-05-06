import { LandingContent } from '@/components/sections/landing/LandingContent';

export const dynamic = 'force-dynamic';

export default function LandingPage() {
  const selfServeEnabled = process.env.SELF_SERVE_SIGNUP_ENABLED === 'true';
  return <LandingContent selfServeEnabled={selfServeEnabled} />;
}
