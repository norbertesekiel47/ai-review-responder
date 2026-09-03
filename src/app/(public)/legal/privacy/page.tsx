import type { Metadata } from 'next';
import { LegalPage } from '@/components/legal/LegalPage';
import { legalDocs } from '@/lib/legal/content';

export const metadata: Metadata = {
  // Bare name: the root layout's title template appends " · RepWorth".
  title: 'Privacy Policy',
  description: 'How RepWorth collects, uses, and protects your data.',
};

export default function PrivacyLegalPage() {
  return <LegalPage doc={legalDocs.privacy} />;
}
