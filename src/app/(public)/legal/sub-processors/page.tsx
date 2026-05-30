import type { Metadata } from 'next';
import { LegalPage } from '@/components/legal/LegalPage';
import { legalDocs } from '@/lib/legal/content';

export const metadata: Metadata = {
  title: 'Sub-processors · RepWorth',
  description: 'The third-party sub-processors RepWorth uses to provide the service.',
};

export default function SubProcessorsLegalPage() {
  return <LegalPage doc={legalDocs['sub-processors']} />;
}
