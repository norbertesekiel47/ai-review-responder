import { headers } from 'next/headers';
import { FeaturesContent } from './FeaturesContent';

export const dynamic = 'force-dynamic';

export default function FeaturesPage() {
  const comingSoon = headers().get('x-coming-soon') === '1';
  return <FeaturesContent comingSoon={comingSoon} />;
}
