'use client';

import {
  CONTACTS_CSV_TEMPLATE_FILENAME,
  buildContactsCsvTemplate,
} from '@/lib/solicitation/contacts-csv-template';

/**
 * Download lane of /dashboard/requests/contacts (#1091): a starting-point CSV
 * the owner fills in.
 *
 * Client-side Blob, no new endpoint — the same technique as UploadCard's
 * "Download rejected rows" button, which is the precedent in this folder. The
 * bytes come from `buildContactsCsvTemplate`, whose eval suite feeds them back
 * through `parseContactsCsv`, so the template cannot drift from the contract
 * that decides whether an upload is legal.
 *
 * It lives OUTSIDE `UploadCard` deliberately. That component swaps its form for
 * a report once an upload completes, and an owner who has just seen a rejected
 * row is exactly the one who wants the template.
 */
/**
 * Module scope, not a closure inside the component: it reads no props and no
 * state, so rebuilding it on every render is wasted work and defeats memoized
 * children (`react-doctor/prefer-module-scope-pure-function`).
 */
function downloadTemplate(): void {
  // The visit dates are measured back from today, because `parseContactsCsv`
  // rejects a `future_date`. Read at CLICK time, not render time — a tab left
  // open across midnight would otherwise hand out yesterday's arithmetic.
  const todayUtc = new Date().toISOString().slice(0, 10);
  const blob = new Blob([buildContactsCsvTemplate(todayUtc)], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = CONTACTS_CSV_TEMPLATE_FILENAME;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function TemplateCard() {
  return (
    <div className="card section-enter section-enter-1">
      <h2 className="card-h2">Start from a template</h2>
      <p style={{ fontSize: 14, color: 'var(--rw-app-text-muted)', margin: '0 0 16px' }}>
        A ready-made CSV with the right column headings and three example rows.
        Replace the examples with your own customers and upload it below. Each
        row needs a name, a visit date, and an email address or a phone number.
        The note is optional.
      </p>
      <button type="button" className="btn btn-secondary" onClick={downloadTemplate}>
        Download CSV template
      </button>
    </div>
  );
}
