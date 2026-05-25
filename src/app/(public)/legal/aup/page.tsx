import { LegalPage } from '@/components/legal/LegalPage';
import { legalDocs } from '@/lib/legal/content';

export default function AupLegalPage() {
  return <LegalPage doc={legalDocs.aup} />;
}
