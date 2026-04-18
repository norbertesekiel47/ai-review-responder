'use client';

// Auth: Supabase session checked by src/middleware.ts (admin/sales_partner role required)

interface Scenario {
  id: string;
  customerSays: string;
  firstCheck: string;
  fix: string;
}

/**
 * When `NEXT_PUBLIC_DOCS_BASE_URL` is set (e.g. the GitHub blob URL for
 * the docs/ folder on main), doc filenames below become clickable links.
 * Otherwise they render as `<code>` text per original plan intent —
 * oncall engineers with a local clone can still find them by path.
 */
const DOCS_BASE_URL = process.env.NEXT_PUBLIC_DOCS_BASE_URL ?? '';

function DocRef({ filename }: { filename: string }) {
  const codeEl = (
    <code className="rounded bg-white px-1 text-xs">{filename}</code>
  );
  if (!DOCS_BASE_URL) return codeEl;
  const href = `${DOCS_BASE_URL.replace(/\/$/, '')}/${filename.replace(/^docs\//, '')}`;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="underline decoration-dotted underline-offset-2 hover:decoration-solid"
    >
      {codeEl}
    </a>
  );
}

const SCENARIOS: Scenario[] = [
  {
    id: 'A1',
    customerSays: 'I never got the approval email.',
    firstCheck:
      '/admin/notifications → filter by business → read failure_reason. If no row, check /admin/jobs for stuck send_notification outbox. Also check owner_email_bounced on the business detail page.',
    fix: 'Verify the owner email address. If wrong, update via Business Profile editor (Edit → Owner Email), then clear the bounce flag via the red banner button. Never clear the flag before verifying.',
  },
  {
    id: 'A2',
    customerSays: "The response doesn't sound like me.",
    firstCheck:
      'Business Profile → check tone, highlight_facts, avoid_facts, staff_names. Review recent owner edits — heavy edits signal a context gap.',
    fix: 'Update tone + facts in Business Profile. Voice learning activates automatically once ≥5 edited+posted responses exist.',
  },
  {
    id: 'A3',
    customerSays: "I approved it but it's not posted on Google.",
    firstCheck:
      'Business detail page → review list → status badge. Expected: awaiting_manual_post after approval in SerpAPI mode. Manual posting is normal for MVP.',
    fix: 'Sales partner copies approved text from Manual Post Section, pastes into Google Business Profile, then clicks "Mark as posted". GBP API auto-post lands in Phase 5.',
  },
  {
    id: 'A4',
    customerSays: "I'm getting too many emails.",
    firstCheck:
      'Owner controls opt-outs on /settings. Check weekly_summary_enabled, monthly_impact_enabled, notification_preference columns.',
    fix: 'Owner logs in → /settings → toggle off unwanted categories. Admins can UPDATE the same columns directly if needed.',
  },
  {
    id: 'A5',
    customerSays: "My reviews aren't being picked up.",
    firstCheck:
      'Business detail → last_sync_at (stale >6h?), subscription_status (cancelled?), place_id_verified (false?). Check /admin/jobs for failed sync_reviews.',
    fix: 'SerpAPI quota exhausted → top up or wait for reset. Place ID unverified → re-enter via PlaceAutocomplete. Billing issue → resolve in Stripe.',
  },
];

export default function RunbookPage() {
  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <header className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Operational Runbook</h1>
        <p className="mt-1 text-sm text-gray-600">
          Quick reference for the five most common customer-facing issues.
          For the full runbook (daily health check, debugging SQL,
          incident response, weekly maintenance), see{' '}
          <DocRef filename="docs/operational-runbook.md" /> in the repo.
        </p>
      </header>

      <section className="rounded-lg border border-gray-200 bg-white">
        <div className="border-b border-gray-200 px-6 py-4">
          <h2 className="text-lg font-semibold text-gray-800">
            &quot;Customer says X&quot; — quick reference
          </h2>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th
                  scope="col"
                  className="px-4 py-3 text-left font-mono text-xs font-semibold uppercase tracking-wider text-gray-600"
                >
                  #
                </th>
                <th
                  scope="col"
                  className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-600"
                >
                  Customer says
                </th>
                <th
                  scope="col"
                  className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-600"
                >
                  First check
                </th>
                <th
                  scope="col"
                  className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-600"
                >
                  Fix
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {SCENARIOS.map((s) => (
                <tr key={s.id} className="align-top">
                  <td className="px-4 py-3 font-mono text-xs text-gray-500">
                    {s.id}
                  </td>
                  <td className="px-4 py-3 font-medium text-gray-900">
                    {s.customerSays}
                  </td>
                  <td className="px-4 py-3 text-gray-700">{s.firstCheck}</td>
                  <td className="px-4 py-3 text-gray-700">{s.fix}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="mt-6 rounded-lg border border-blue-200 bg-blue-50 p-4 text-sm text-blue-900">
        <p className="font-semibold">Need more?</p>
        <ul className="mt-2 list-inside list-disc space-y-1">
          <li>
            Daily health check, debugging SQL, incident response, weekly
            maintenance → <DocRef filename="docs/operational-runbook.md" />
          </li>
          <li>
            Pre-launch verification →{' '}
            <DocRef filename="docs/smoke-test-checklist.md" />
          </li>
          <li>
            Email deliverability &amp; DNS →{' '}
            <DocRef filename="docs/email-deliverability.md" />
          </li>
        </ul>
      </section>
    </div>
  );
}
