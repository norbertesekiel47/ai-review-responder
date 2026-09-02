import type { ReactNode } from 'react';
import Link from 'next/link';
import { sql } from '@/lib/db/server';
import { requireAdminPage } from '@/lib/auth/page-gate';
import { AdminPage } from '@/components/admin/ui/AdminPage';

export const dynamic = 'force-dynamic';

interface Scenario {
  id: string;
  customerSays: string;
  /** Ordered steps — what to look at, in the order that rules things out fastest. */
  firstCheck: ReactNode[];
  /** Ordered steps — what to do once the check has named the cause. */
  fix: ReactNode[];
}

/** A database column or enum value, set in `code` so it reads as a name, not prose (X34). */
function Col({ children }: { children: ReactNode }) {
  return <code className="rounded bg-gray-100 px-1 text-xs text-gray-900">{children}</code>;
}

/**
 * An ordered list of steps. A call rather than an array literal so the JSX
 * steps are positional arguments, not array members that would each need a
 * `key` — the list is rendered once, in order, by index.
 */
function steps(...items: ReactNode[]): ReactNode[] {
  return items;
}

/**
 * When `NEXT_PUBLIC_DOCS_BASE_URL` is set (e.g. the GitHub blob URL for
 * the docs/ folder on main), doc filenames below become clickable links.
 * Otherwise they render as `<code>` text per original plan intent —
 * oncall engineers with a local clone can still find them by path.
 */
// Validate the base URL at module load. NEXT_PUBLIC_DOCS_BASE_URL is a
// build-time env var controlled by operators, but a misconfiguration like
// `javascript:alert(1)//` would otherwise produce clickable anchors that
// execute on click. Require http:// or https:// explicitly — anything else
// falls back to the plain <code> rendering.
const RAW_DOCS_BASE_URL = process.env.NEXT_PUBLIC_DOCS_BASE_URL ?? '';
const DOCS_BASE_URL =
  RAW_DOCS_BASE_URL.startsWith('http://') ||
  RAW_DOCS_BASE_URL.startsWith('https://')
    ? RAW_DOCS_BASE_URL
    : '';

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

function AdminLink({ href }: { href: string }) {
  return (
    <Link href={href} className="underline decoration-dotted underline-offset-2 hover:decoration-solid">
      {href}
    </Link>
  );
}

const SCENARIOS: Scenario[] = [
  {
    id: 'A1',
    customerSays: 'I never got the approval email.',
    firstCheck: steps(
      <>
        <AdminLink href="/admin/notifications" /> → filter by business → read the failure reason on the
        failed row.
      </>,
      <>
        No row at all? Check <AdminLink href="/admin/jobs" /> for a stuck <Col>send_notification</Col>{' '}
        outbox row.
      </>,
      <>
        Check <Col>owner_email_bounced</Col> on the business detail page (the red notice).
      </>,
    ),
    fix: steps(
      'Verify the owner email address with the owner.',
      'If it is wrong, update it via Business Profile (Edit → Owner Email).',
      'Then clear the bounce flag from the notice. Never clear the flag before verifying.',
    ),
  },
  {
    id: 'A2',
    customerSays: "The response doesn't sound like me.",
    firstCheck: steps(
      <>
        Business Profile → check <Col>tone</Col>, <Col>highlight_facts</Col>, <Col>avoid_facts</Col>,{' '}
        <Col>staff_names</Col>.
      </>,
      'Review recent owner edits — heavy edits signal a context gap.',
    ),
    fix: steps(
      'Update tone + facts in Business Profile.',
      'Voice learning activates automatically once ≥5 edited+posted responses exist.',
    ),
  },
  {
    id: 'A3',
    customerSays: "I approved it but it's not posted on Google.",
    firstCheck: steps(
      'Business detail page → Zernio Connection panel → awaiting reconnect count.',
      <>
        If <Col>awaiting_owner_connect</Col>: the owner has not connected or reconnected Google via Zernio.
      </>,
    ),
    fix: steps(
      'Owner logs in → /settings/channels → Connect Google.',
      <>
        Once connected, <Col>DrainOwnerConnectWorker</Col> automatically re-queues the approved response for
        publishing.
      </>,
    ),
  },
  {
    id: 'A4',
    customerSays: "I'm getting too many emails.",
    firstCheck: steps(
      'Owner controls opt-outs on /settings.',
      <>
        Check <Col>accounts.weekly_summary_enabled</Col> / <Col>accounts.monthly_impact_enabled</Col>{' '}
        (account-level since migration 063; the per-business columns on <Col>businesses</Col> are
        deprecated), plus <Col>channel_enrollments.status</Col> / <Col>unsubscribed_at</Col>.
      </>,
    ),
    fix: steps(
      'Owner logs in → /settings → toggle off unwanted categories.',
      'Admins can UPDATE the same columns directly if needed.',
    ),
  },
  {
    id: 'A5',
    customerSays: "My reviews aren't being picked up.",
    firstCheck: steps(
      <>
        Business detail → Zernio Connection panel (<Col>active</Col> / <Col>disconnected</Col> /{' '}
        <Col>finalize_unknown</Col>?), <Col>subscription_status</Col> (<Col>cancelled</Col>?).
      </>,
      <>
        Check <AdminLink href="/admin/jobs" /> for failed <Col>ingest_zernio_review</Col> or{' '}
        <Col>zernio_initial_backfill</Col> rows.
      </>,
      <>
        Check <Col>zernio_backfill_runs.completed_at</Col> for first-connect status.
      </>,
      <>
        For a missing Review import, read <Col>businesses.import_decision</Col> +{' '}
        <Col>businesses.import_offer_expires_at</Col> first — that is what separates an Import consent
        block from an outage.
      </>,
    ),
    fix: steps(
      'Zernio disconnected → owner must reconnect via /settings/channels.',
      'Webhook delivery failing → check Zernio dashboard webhook URL + signature secret.',
      'Billing issue → resolve in Stripe.',
      <>
        Review import: re-enqueue a <Col>zernio_initial_backfill</Col> outbox row ONLY when{' '}
        <Col>{"import_decision = 'accepted'"}</Col> AND no initial run completed (
        <Col>zernio_backfill_runs.completed_at IS NULL</Col> for <Col>{"run_reason = 'initial'"}</Col>). The
        worker fails closed — on any other state the row no-op-completes and imports nothing.
      </>,
      <>
        A declined or expired decision is permanent, admin path included: no re-enqueue, no re-offer,
        nothing to route around it. Expired is derived, never stored —{' '}
        <Col>{"import_decision = 'pending' AND import_offer_expires_at <= now()"}</Col>; there is no{' '}
        <Col>{"'expired'"}</Col> value to look for.
      </>,
    ),
  },
];


export default async function RunbookPage() {
  // Defense-in-depth behind src/proxy.ts's /admin gate — the only non-auth admin
  // page that was missing it. Plain gate, no `aal2`: this page renders static
  // prose reference content, holds no tenant data, and calls no API route, so
  // there is nothing here for a step-up to protect.
  await requireAdminPage(sql, { from: '/admin/runbook' });

  return (
    <AdminPage group="Operate" title="Runbook" description="First-response playbook for support scenarios">
      <p className="mb-6 text-sm text-gray-600">
        Quick reference for the five most common customer-facing issues. For
        the full runbook (daily health check, debugging SQL, incident
        response, weekly maintenance), see{' '}
        <DocRef filename="docs/operational-runbook.md" /> in the repo.
      </p>

      <section aria-labelledby="scenarios-heading">
        <h2 id="scenarios-heading" className="text-lg font-semibold text-gray-800">
          &quot;Customer says X&quot;: quick reference
        </h2>
        {/* One card per scenario (X34): the two lists an operator actually follows
            read top-to-bottom with their own labels, instead of four columns of
            prose with raw column names buried in the sentences. */}
        <ol className="mt-3 space-y-4">
          {SCENARIOS.map((s) => (
            <li key={s.id} className="rounded-lg border border-gray-200 bg-white p-5">
              <h3 className="flex items-baseline gap-3 text-base font-semibold text-gray-900">
                <span className="font-mono text-xs font-medium text-gray-500">{s.id}</span>
                <span>&ldquo;{s.customerSays}&rdquo;</span>
              </h3>
              <div className="mt-4 grid gap-6 md:grid-cols-2">
                <div>
                  <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-600">First check</h4>
                  <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-sm text-gray-700">
                    {s.firstCheck.map((step, index) => (
                      <li key={index}>{step}</li>
                    ))}
                  </ol>
                </div>
                <div>
                  <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-600">Fix</h4>
                  <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-sm text-gray-700">
                    {s.fix.map((step, index) => (
                      <li key={index}>{step}</li>
                    ))}
                  </ol>
                </div>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section className="mt-6 rounded-lg border border-gray-200 bg-gray-50 p-4 text-sm text-gray-800">
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
    </AdminPage>
  );
}
