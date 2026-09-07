'use client';

import { useCallback, useState } from 'react';
import { OwnerTelegramWidget } from '@/components/dashboard/channels/OwnerTelegramWidget';
import { OwnerWhatsAppWidget } from '@/components/dashboard/channels/OwnerWhatsAppWidget';
import { ComingSoonChannelRow } from '@/components/dashboard/channels/ComingSoonChannelRow';
import type { ChannelId } from '@/lib/notifications/channels/types';
import type { EnrollmentState } from '@/lib/notifications/channels/enrollment-reducer';
import type { MobileChannel } from '@/lib/channels/mobile-enrollment';

export interface InitialEnrollment {
  channel: ChannelId;
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

/** Per-channel enrollment state as reported by each mobile widget. */
export type MobileChannelStates = Record<MobileChannel, EnrollmentState>;

const MOBILE_CHANNEL_LABEL: Record<MobileChannel, string> = {
  telegram: 'Telegram',
  whatsapp: 'WhatsApp',
};

function otherMobileChannel(channel: MobileChannel): MobileChannel {
  return channel === 'telegram' ? 'whatsapp' : 'telegram';
}

/**
 * One mobile channel per account (the server enforces it with a 409 on the
 * second `start`). This mirrors the rule on the client so the second Connect
 * is disabled with a reason instead of failing after the fact (UX audit S12).
 * Returns null when `channel` may connect.
 */
export function otherChannelBlockedReason(
  states: MobileChannelStates,
  channel: MobileChannel,
): string | null {
  const other = otherMobileChannel(channel);
  const otherLabel = MOBILE_CHANNEL_LABEL[other];
  switch (states[other]) {
    case 'verified':
      return `Disconnect ${otherLabel} first. You can have one mobile channel at a time.`;
    case 'generating':
    case 'awaiting_scan':
      return `Finish or cancel the ${otherLabel} setup first. You can have one mobile channel at a time.`;
    default:
      return null;
  }
}

function findChannel(enrollments: InitialEnrollment[], channel: InitialEnrollment['channel']): InitialEnrollment | null {
  return enrollments.find((e) => e.channel === channel) ?? null;
}

/** Seed the occupancy map from SSR rows so the block applies on first paint, before the widgets report. */
export function initialMobileChannelStates(enrollments: InitialEnrollment[]): MobileChannelStates {
  const stateFor = (channel: MobileChannel): EnrollmentState =>
    findChannel(enrollments, channel)?.status === 'verified' ? 'verified' : 'idle';
  return { telegram: stateFor('telegram'), whatsapp: stateFor('whatsapp') };
}

export function ChannelsClient({ initialEnrollments, initialAvailability, ownerEmailFallback }: ChannelsClientProps) {
  const emailRow = findChannel(initialEnrollments, 'email');
  const emailHandle = emailRow?.handle ?? ownerEmailFallback;
  const emailReconciling = !emailRow;

  // Widgets own their own enrollment machines; this map only mirrors their
  // reported state so each can be told about its sibling.
  const [mobileStates, setMobileStates] = useState<MobileChannelStates>(() =>
    initialMobileChannelStates(initialEnrollments),
  );
  const onTelegramState = useCallback((state: EnrollmentState) => {
    setMobileStates((current) => (current.telegram === state ? current : { ...current, telegram: state }));
  }, []);
  const onWhatsAppState = useCallback((state: EnrollmentState) => {
    setMobileStates((current) => (current.whatsapp === state ? current : { ...current, whatsapp: state }));
  }, []);

  return (
    <div className="set-section">
      <div className="set-section-head">
        <div className="set-section-icon blue" aria-hidden>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="22 12 16 12 14 15 10 15 8 12 2 12" /><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" /></svg>
        </div>
        <div>
          <div className="set-section-title">Where to send approvals</div>
          <div className="set-section-sub">
            Choose where you receive review approval requests. Changes here apply immediately.
          </div>
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
          {emailReconciling ? 'Setting up…' : 'Always on'}
        </span>
      </div>

      {/* Pick one extra channel */}
      <div className="pick-extra">
        <div className="pick-extra-eyebrow">Pick one extra channel</div>

        {/* Telegram row — interactive if available, coming-soon otherwise */}
        {initialAvailability.telegram ? (
          <OwnerTelegramWidget
            initialEnrollment={findChannel(initialEnrollments, 'telegram')}
            blockedReason={otherChannelBlockedReason(mobileStates, 'telegram')}
            onStateChange={onTelegramState}
          />
        ) : (
          <ComingSoonChannelRow
            icon="💬"
            name="Telegram"
            reason="Available once Telegram channel is enabled"
          />
        )}

        {/* WhatsApp — interactive if available, coming-soon otherwise */}
        {initialAvailability.whatsapp ? (
          <OwnerWhatsAppWidget
            initialEnrollment={findChannel(initialEnrollments, 'whatsapp')}
            blockedReason={otherChannelBlockedReason(mobileStates, 'whatsapp')}
            onStateChange={onWhatsAppState}
          />
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
