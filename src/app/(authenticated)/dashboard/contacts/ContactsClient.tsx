'use client';

import { useCallback, useState } from 'react';
import { TopBar } from '@/components/dashboard/shell/TopBar';
import { useLocationScope } from '@/contexts/LocationContext';
import { UploadCard } from './UploadCard';
import { ContactList } from './ContactList';

/**
 * /dashboard/contacts — contacts/visits CSV upload + report + contact list
 * (#541, contract #535). Thin composition of the two lanes: UploadCard (form,
 * polling, report) and ContactList (list, delete, pagination). The server
 * component (page.tsx) owns the flag gate and the attestation constants;
 * every read/write goes through the Task 4/6 API routes, scoped by the
 * LocationContext scope (mirrors ReviewsContent's useLocationScope idiom).
 * The lanes' only coupling is `listEpoch`: a completed ingest or a delete
 * bumps it to refetch the list.
 */

interface ContactsClientProps {
  /** Server-authoritative attestation copy (#535 §4) — never bundled client-side. */
  attestationText: string;
  attestationVersion: string;
}

export function ContactsClient({
  attestationText,
  attestationVersion,
}: ContactsClientProps) {
  const { currentScope } = useLocationScope();

  // Bumped after a completed ingest or a delete to refetch the list. Stable
  // callback so UploadCard's polling effect doesn't restart on re-render.
  const [listEpoch, setListEpoch] = useState(0);
  const bumpListEpoch = useCallback(() => setListEpoch((epoch) => epoch + 1), []);

  // ── Aggregate scope has no meaning for per-location contacts ──────────────

  if (currentScope === 'all') {
    return (
      <>
        <TopBar title="Contacts" subtitle="Customer visit history for review-request evaluation." />
        <div className="content">
          <div className="card section-enter section-enter-1">
            <h2 className="card-h2">Choose a location</h2>
            <p style={{ fontSize: 14, color: 'var(--rw-app-text-muted)', margin: 0 }}>
              Contacts are kept per location. Pick a location from the switcher to
              upload a CSV or browse its contacts.
            </p>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <TopBar
        title="Contacts"
        subtitle="Upload customer visit history — watch-mode only, no review requests are sent."
      />
      <div className="content">
        <UploadCard
          attestationText={attestationText}
          attestationVersion={attestationVersion}
          onIngestCompleted={bumpListEpoch}
        />
        <ContactList epoch={listEpoch} onRefresh={bumpListEpoch} />
      </div>
    </>
  );
}
