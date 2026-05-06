import { HowItWorksContent } from '@/components/sections/how-it-works/HowItWorksContent';

export default function HowItWorksPage() {
  const selfServeEnabled = process.env.SELF_SERVE_SIGNUP_ENABLED === 'true';
  return <HowItWorksContent selfServeEnabled={selfServeEnabled} />;
}
