import { LegalPage } from '@/components/legal/LegalPage';
import { legalDocs } from '@/lib/legal/content';

export default function CookiesLegalPage() {
  return <LegalPage doc={legalDocs.cookies} />;
}
