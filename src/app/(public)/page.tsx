import { headers } from 'next/headers';
import { LandingContent } from './components/landing/LandingContent';

export default function LandingPage() {
  const comingSoon = headers().get('x-coming-soon') === '1';
  return <LandingContent comingSoon={comingSoon} />;
}
