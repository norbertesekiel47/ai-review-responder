'use client';

import { TelegramEnrollmentWidget } from '@/components/admin/TelegramEnrollmentWidget';
import { WhatsAppEnrollmentWidget } from '@/components/admin/WhatsAppEnrollmentWidget';
import { subscriptionGrantsFullAccess } from '@/lib/shared/subscription-status';
import type { BusinessDetail, ChannelEnrollmentRow } from '../types';
import { formatAdminDateTime } from '@/components/admin/ui/format';
import { ErrorState } from '@/components/admin/ui/states';

// Deliberately NOT the shared `StatusBadge` (src/components/admin/ui/StatusBadge.tsx):
// none of these four keys exist in the shared map, so every one of them would
// fall through to its neutral-gray default. Channel enrollment is a
// notifications-domain lifecycle, not a console status — it keeps a named local
// owner rather than importing four foreign keys into the shared vocabulary.
// Named distinctly so it no longer shadows the shared primitive.
const CHANNEL_ENROLLMENT_BADGE_STYLES: Record<ChannelEnrollmentRow['status'], string> = {
  verified: 'bg-green-100 text-green-800',
  pending_verification: 'bg-yellow-100 text-yellow-800',
  disabled: 'bg-gray-100 text-gray-800',
  unsubscribed: 'bg-red-100 text-red-800',
};

function ChannelEnrollmentBadge({ status }: { status: ChannelEnrollmentRow['status'] }) {
  return (
    <span className={`px-2 py-0.5 rounded text-xs ${CHANNEL_ENROLLMENT_BADGE_STYLES[status]}`}>
      {status}
    </span>
  );
}

// Channel enrollment is available to entitled accounts (active or trialing) —
// approval delivery is core to the trial. Gated with the shared
// `subscriptionGrantsFullAccess` predicate, mirroring the API gate at
// admin/channels/_shared/start.ts.

interface ChannelsPanelProps {
  business: BusinessDetail;
  businessId: string;
  enrollments: ChannelEnrollmentRow[];
  /** The channels query is separate from the detail query — see useBusinessDetail. */
  channelsLoading: boolean;
  channelsError: boolean;
}

export function ChannelsPanel({
  business,
  businessId,
  enrollments,
  channelsLoading,
  channelsError,
}: ChannelsPanelProps) {
  return (
    <>
      {/* Channels */}
      <section className="mt-8 rounded-lg border border-gray-200 bg-white p-6">
        <h2 className="text-lg font-semibold text-gray-800 mb-3">Channels</h2>
        {/* An empty list and a failed fetch are NOT the same fact: "no
            enrollments" means this business cannot be notified, which is an
            operational finding; a 500 means we do not know. `useBusinessDetail`
            has always exposed these two flags separately — this is the panel
            that consumes them. */}
        {enrollments.length === 0 && channelsError ? (
          <ErrorState
            title="Channels failed to load"
            detail={`GET /api/admin/businesses/${businessId}/channels failed — enrollment state is unknown, not empty.`}
          />
        ) : enrollments.length === 0 && channelsLoading ? (
          <p className="text-sm text-gray-500">Loading channel enrollments…</p>
        ) : enrollments.length === 0 ? (
          <p className="text-sm text-gray-500">
            No channel enrollments; business cannot receive approval notifications.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 text-left text-gray-500">
                  <th className="pb-2 font-medium">Channel</th>
                  <th className="pb-2 font-medium">Handle</th>
                  <th className="pb-2 font-medium">Status</th>
                  <th className="pb-2 font-medium">Last activity</th>
                </tr>
              </thead>
              <tbody>
                {enrollments.map((e) => (
                  <tr key={e.channel} className="border-b border-gray-100">
                    <td className="py-2 text-gray-700">{e.channel}</td>
                    <td className="py-2 font-mono text-gray-700">{e.handle}</td>
                    <td className="py-2"><ChannelEnrollmentBadge status={e.status} /></td>
                    <td className="py-2 text-gray-700">
                      {formatAdminDateTime(e.last_activity_at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Telegram enrollment (flag-gated) */}
      {business.telegramEnabled && (
        <section className="mt-8 rounded-lg border border-gray-200 bg-white p-6">
          <h2 className="text-lg font-semibold text-gray-800 mb-3">Telegram enrollment</h2>
          {!subscriptionGrantsFullAccess(business.subscriptionStatus) ? (
            <p className="text-sm text-gray-500">
              Subscription not active. Telegram enrollment unlocks once the business&apos;s subscription is active or trialing.
            </p>
          ) : (
            <TelegramEnrollmentWidget businessId={businessId} />
          )}
        </section>
      )}

      {/* WhatsApp enrollment (flag-gated) */}
      {business.whatsappEnabled && (
        <section className="mt-8 rounded-lg border border-gray-200 bg-white p-6">
          <h2 className="text-lg font-semibold text-gray-800 mb-3">WhatsApp enrollment</h2>
          {!subscriptionGrantsFullAccess(business.subscriptionStatus) ? (
            <p className="text-sm text-gray-500">
              Subscription not active. WhatsApp enrollment unlocks once the business&apos;s subscription is active or trialing.
            </p>
          ) : (
            <WhatsAppEnrollmentWidget businessId={businessId} />
          )}
        </section>
      )}
    </>
  );
}
