'use client';

import { OwnerTelegramWidget } from '@/components/dashboard/channels/OwnerTelegramWidget';
import { OwnerWhatsAppWidget } from '@/components/dashboard/channels/OwnerWhatsAppWidget';
import { ComingSoonChannelRow } from '@/components/dashboard/channels/ComingSoonChannelRow';

export interface InitialEnrollment {
  channel: 'email' | 'sms' | 'telegram' | 'whatsapp';
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
  initialAvailability: { telegram: boolean; whatsapp: boolean };
  ownerEmailFallback: string;
}

function findChannel(enrollments: InitialEnrollment[], channel: InitialEnrollment['channel']): InitialEnrollment | null {
  return enrollments.find((e) => e.channel === channel) ?? null;
}

export function ChannelsClient({ initialEnrollments, initialAvailability, ownerEmailFallback }: ChannelsClientProps) {
  const emailRow = findChannel(initialEnrollments, 'email');
  const emailHandle = emailRow?.handle ?? ownerEmailFallback;
  const emailReconciling = !emailRow;

  return (
    <div className="set-section">
      <div className="set-section-head">
        <div className="set-section-icon blue" aria-hidden>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="22 12 16 12 14 15 10 15 8 12 2 12" /><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" /></svg>
        </div>
        <div>
          <div className="set-section-title">Where to send approvals</div>
          <div className="set-section-sub">Choose where you receive review approval requests.</div>
        </div>
      </div>

      {/* Email row — always-on */}
      <div className="channel-row selected">
        <div className="channel-icon ch-email" aria-hidden>✉️</div>
        <div className="channel-meta">
          <div className="channel-name">Email</div>
          <div className="channel-handle">{emailHandle}</div>
        </div>
        <span className="channel-status cs-on">
          {emailReconciling ? 'Reconciling…' : 'Always on'}
        </span>
      </div>

      {/* Pick one extra channel */}
      <div className="pick-extra">
        <div className="pick-extra-eyebrow">Pick one extra channel</div>

        {/* Telegram row — interactive if available, coming-soon otherwise */}
        {initialAvailability.telegram ? (
          <OwnerTelegramWidget initialEnrollment={findChannel(initialEnrollments, 'telegram')} />
        ) : (
          <ComingSoonChannelRow
            icon="💬"
            name="Telegram"
            reason="Available once Telegram channel is enabled"
          />
        )}

        {/* SMS — owner self-service is post-launch. The CHANNELS_SMS_ENABLED flag
            gates backend dispatch + admin enrollment, NOT this owner row, so the
            row is intentionally flag-independent. */}
        <ComingSoonChannelRow
          icon="📱"
          name="SMS"
          reason="SMS notifications are coming soon"
        />

        {/* WhatsApp — interactive if available, coming-soon otherwise */}
        {initialAvailability.whatsapp ? (
          <OwnerWhatsAppWidget initialEnrollment={findChannel(initialEnrollments, 'whatsapp')} />
        ) : (
          <ComingSoonChannelRow
            icon="🟢"
            name="WhatsApp"
            reason="Available once Meta business verification clears"
          />
        )}
      </div>
    </div>
  );
}
