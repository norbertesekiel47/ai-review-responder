'use client';

import type { AutoApprovalReadinessBlockReason } from '@/lib/auto-approval/types';
import type { AutoApprovalDiagnostics } from '../types';

const BLOCK_REASON_LABELS: Record<AutoApprovalReadinessBlockReason, string> = {
  auto_approval_disabled: 'Runtime flag off',
  autopilot_unavailable: 'Autopilot unavailable',
  provider_moderation_disabled: 'Moderation off',
  provider_moderation_not_validated: 'Moderation not validated',
  subscription_not_writable: 'Subscription read-only',
  policy_suspended: 'Policy suspended',
  preview_environment: 'Preview environment',
  impersonation_not_allowed: 'Impersonation',
};

// Same vocabulary as the owner UI's THRESHOLD_OPTIONS (AutoApprovalClient) so
// admin diagnostics and owner settings read identically. Off / 5★ only / 4–5★
// is the full WS4 domain; the fallback covers only out-of-domain legacy data.
function thresholdLabel(threshold: number | null): string {
  if (threshold === null) return 'Off';
  if (threshold === 5) return '5★ only';
  if (threshold === 4) return '4–5★';
  return `${threshold}–5★`;
}

function sourceLabel(source: string): string {
  if (source === 'location_override') return 'Location override';
  if (source === 'account_default') return 'Account default';
  return 'None';
}

function fmt(iso: string): string {
  return new Date(iso).toLocaleString();
}

export function AutoApprovalDiagnosticsPanel({
  diagnostics,
}: {
  diagnostics: AutoApprovalDiagnostics;
}) {
  return (
    <section className="mt-8 rounded-lg border border-gray-200 bg-white p-6">
      <DiagnosticsHeader canExpand={diagnostics.readiness.canExpand} />
      <DiagnosticsSummary diagnostics={diagnostics} />
      <LocationsTable diagnostics={diagnostics} />
      <AuditGrid diagnostics={diagnostics} />
    </section>
  );
}

function DiagnosticsHeader({ canExpand }: { canExpand: boolean }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 className="text-lg font-semibold text-gray-900">Auto-approval diagnostics</h2>
        <p className="mt-1 text-sm text-gray-500">
          Read-only policy state for owner settings and worker decisions.
        </p>
      </div>
      <span className={`rounded px-2 py-1 text-xs font-medium ${
        canExpand ? 'bg-green-100 text-green-800' : 'bg-yellow-100 text-yellow-800'
      }`}>
        {canExpand ? 'Expansion ready' : 'Expansion blocked'}
      </span>
    </div>
  );
}

function DiagnosticsSummary({ diagnostics }: { diagnostics: AutoApprovalDiagnostics }) {
  const { blockReasons } = diagnostics.readiness;

  return (
    <div className="mt-4 grid gap-3 sm:grid-cols-2">
      <div className="rounded border border-gray-100 bg-gray-50 p-3">
        <div className="text-xs font-medium uppercase tracking-wide text-gray-500">
          Account default
        </div>
        <div className="mt-1 text-sm font-semibold text-gray-900">
          {thresholdLabel(diagnostics.accountDefault.threshold)}
        </div>
        <div className="mt-1 text-xs text-gray-500">
          {diagnostics.accountDefault.exists ? diagnostics.accountDefault.policyId : 'No policy row'}
        </div>
      </div>
      <div className="rounded border border-gray-100 bg-gray-50 p-3">
        <div className="text-xs font-medium uppercase tracking-wide text-gray-500">
          Readiness
        </div>
        <div className="mt-2 flex flex-wrap gap-2">
          {blockReasons.length === 0 ? (
            <span className="rounded bg-white px-2 py-0.5 text-xs font-medium text-gray-700 ring-1 ring-gray-200">
              Ready for expansions
            </span>
          ) : (
            blockReasons.map((reason) => (
              <span
                key={reason}
                className="rounded bg-white px-2 py-0.5 text-xs font-medium text-gray-700 ring-1 ring-gray-200"
              >
                {BLOCK_REASON_LABELS[reason]}
              </span>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function LocationsTable({ diagnostics }: { diagnostics: AutoApprovalDiagnostics }) {
  return (
    <div className="mt-5 overflow-x-auto">
      <table className="min-w-full divide-y divide-gray-100 text-sm">
        <thead className="bg-gray-50">
          <tr>
            <th className="px-3 py-2 text-left font-medium text-gray-500">Location</th>
            <th className="px-3 py-2 text-left font-medium text-gray-500">Override</th>
            <th className="px-3 py-2 text-left font-medium text-gray-500">Effective</th>
            <th className="px-3 py-2 text-left font-medium text-gray-500">Source</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {diagnostics.locations.map((location) => (
            <tr key={location.locationId}>
              <td className="px-3 py-2 text-gray-900">
                {location.displayName}
                {location.isPrimary && <span className="ml-2 text-xs text-gray-400">primary</span>}
                {location.archivedAt && <span className="ml-2 text-xs text-gray-400">archived</span>}
              </td>
              <td className="px-3 py-2 text-gray-600">
                {location.override.exists ? thresholdLabel(location.override.threshold) : 'Inherits'}
              </td>
              <td className="px-3 py-2 text-gray-600">
                {thresholdLabel(location.effective.threshold)}
              </td>
              <td className="px-3 py-2 text-gray-500">
                {sourceLabel(location.effective.source)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AuditGrid({ diagnostics }: { diagnostics: AutoApprovalDiagnostics }) {
  return (
    <div className="mt-5 grid gap-4 md:grid-cols-2">
      <AuditList
        title="Recent auto decisions"
        empty="No auto approval audit entries."
        rows={diagnostics.recentApprovalAudit.map((row) => ({
          id: row.id,
          label: row.action.replace(/_/g, ' '),
          meta: `${row.responseId} · ${fmt(row.createdAt)}`,
        }))}
      />
      <AuditList
        title="Recent policy changes"
        empty="No policy change audit entries."
        rows={diagnostics.recentPolicyChanges.map((row) => ({
          id: row.id,
          label: row.eventType.replace(/_/g, ' '),
          meta: `${row.locationId ?? 'account'} · ${fmt(row.createdAt)}`,
        }))}
      />
    </div>
  );
}

function AuditList({
  title,
  empty,
  rows,
}: {
  title: string;
  empty: string;
  rows: Array<{ id: string; label: string; meta: string }>;
}) {
  return (
    <div>
      <h3 className="text-sm font-semibold text-gray-800">{title}</h3>
      {rows.length === 0 ? (
        <p className="mt-2 text-sm text-gray-400">{empty}</p>
      ) : (
        <ul className="mt-2 space-y-2">
          {rows.map((row) => (
            <li key={row.id} className="rounded border border-gray-100 bg-gray-50 px-3 py-2">
              <div className="text-sm font-medium text-gray-800">{row.label}</div>
              <div className="mt-0.5 text-xs text-gray-500">{row.meta}</div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
