import { LegalPage } from '@/components/legal/LegalPage';
import { legalDocs } from '@/lib/legal/content';

export default function PrivacyLegalPage() {
  return <LegalPage doc={legalDocs.privacy} />;
}
