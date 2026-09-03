import type { Metadata } from 'next';
import { LegalPage } from '@/components/legal/LegalPage';
import { legalDocs } from '@/lib/legal/content';

export const metadata: Metadata = {
  // Bare name: the root layout's title template appends " · RepWorth".
  title: 'Sub-processors',
  description: 'The third-party sub-processors RepWorth uses to provide the service.',
};

export default function SubProcessorsLegalPage() {
  return <LegalPage doc={legalDocs['sub-processors']} />;
}
