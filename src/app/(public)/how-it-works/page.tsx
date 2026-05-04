import { headers } from 'next/headers';
import { HowItWorksContent } from '@/components/sections/how-it-works/HowItWorksContent';

export const dynamic = 'force-dynamic';

export default function HowItWorksPage() {
  const comingSoon = headers().get('x-coming-soon') === '1';
  return <HowItWorksContent comingSoon={comingSoon} />;
}
