import { notFound } from 'next/navigation';
import { solicitationWatchEnabled } from '@/lib/solicitation/flags';
import {
  CONSENT_ATTESTATION_TEXT,
  CONSENT_ATTESTATION_VERSION,
} from '@/lib/solicitation/attestation';
import { ContactsClient } from './ContactsClient';

export const dynamic = 'force-dynamic';

export default function ContactsPage() {
  // Server-authoritative flag gate (invariant #13, mirrors the API routes):
  // when watch-mode is off this surface does not exist — 404, no client hint.
  if (!solicitationWatchEnabled()) notFound();

  // The attestation text/version are server-owned constants (#535 §4). They are
  // passed as props so the client bundle never imports the server-side
  // solicitation modules (mirrors reviews/page.tsx passing historyEnabled).
  return (
    <ContactsClient
      attestationText={CONSENT_ATTESTATION_TEXT}
      attestationVersion={CONSENT_ATTESTATION_VERSION}
    />
  );
}
