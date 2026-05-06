import { FeaturesContent } from '@/components/sections/features/FeaturesContent';

export default function FeaturesPage() {
  const selfServeEnabled = process.env.SELF_SERVE_SIGNUP_ENABLED === 'true';
  return <FeaturesContent selfServeEnabled={selfServeEnabled} />;
}
