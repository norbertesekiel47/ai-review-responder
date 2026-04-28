'use client';

import { OwnerTelegramWidget } from '@/components/dashboard/OwnerTelegramWidget';
import { ComingSoonChannelRow } from '@/components/dashboard/ComingSoonChannelRow';

export interface InitialEnrollment {
  channel: string;
  handle: string | null;
  status: string;
  verified_at: string | null;
  disabled_at: string | null;
  unsubscribed_at: string | null;
  unsubscribed_reason: string | null;
  expires_at: string | null;
}

export interface ChannelsClientProps {
  initialEnrollments: InitialEnrollment[];
  initialAvailability: { telegram: boolean; sms: boolean; whatsapp: boolean };
  ownerEmailFallback: string;
}

function findChannel(enrollments: InitialEnrollment[], channel: string): InitialEnrollment | null {
  return enrollments.find((e) => e.channel === channel) ?? null;
}

export function ChannelsClient({ initialEnrollments, initialAvailability, ownerEmailFallback }: ChannelsClientProps) {
  const emailRow = findChannel(initialEnrollments, 'email');
  const emailHandle = emailRow?.handle ?? ownerEmailFallback;
  const emailReconciling = !emailRow;

  return (
    <div className="space-y-6">
      {/* Email row — always-on */}
      <div className="rounded-lg border border-slate-700 bg-slate-900 p-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="text-2xl" aria-hidden>✉️</div>
            <div>
              <div className="font-medium text-slate-100">Email</div>
              <p className="text-sm text-slate-400">{emailHandle}</p>
            </div>
          </div>
          <span className="rounded-full border border-cyan-400 px-3 py-1 text-xs text-cyan-400">
            {emailReconciling ? 'Reconciling…' : 'Always on'}
          </span>
        </div>
      </div>

      <div className="border-t border-slate-800 pt-4">
        <p className="text-xs uppercase tracking-wider text-slate-500">Pick one extra channel</p>
      </div>

      {/* Telegram row — interactive if available, coming-soon otherwise */}
      {initialAvailability.telegram ? (
        <OwnerTelegramWidget />
      ) : (
        <ComingSoonChannelRow
          icon={<span>💬</span>}
          name="Telegram"
          reason="Available once Telegram channel is enabled"
        />
      )}

      {/* SMS — always coming-soon in Phase 4 */}
      {initialAvailability.sms ? (
        <ComingSoonChannelRow
          icon={<span>📱</span>}
          name="SMS"
          reason="SMS owner widget ships in a follow-up phase"
        />
      ) : (
        <ComingSoonChannelRow
          icon={<span>📱</span>}
          name="SMS"
          reason="Available once 10DLC verification clears"
        />
      )}

      {/* WhatsApp — always coming-soon in Phase 4 */}
      {initialAvailability.whatsapp ? (
        <ComingSoonChannelRow
          icon={<span>🟢</span>}
          name="WhatsApp"
          reason="WhatsApp owner widget ships in a follow-up phase"
        />
      ) : (
        <ComingSoonChannelRow
          icon={<span>🟢</span>}
          name="WhatsApp"
          reason="Available once Meta business verification clears"
        />
      )}
    </div>
  );
}
