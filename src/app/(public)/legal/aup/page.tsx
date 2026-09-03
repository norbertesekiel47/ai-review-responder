import type { Metadata } from 'next';
import { LegalPage } from '@/components/legal/LegalPage';
import { legalDocs } from '@/lib/legal/content';

export const metadata: Metadata = {
  // Bare name: the root layout's title template appends " · RepWorth".
  title: 'Acceptable Use Policy',
  description: 'The RepWorth Acceptable Use Policy.',
};

export default function AupLegalPage() {
  return <LegalPage doc={legalDocs.aup} />;
}
