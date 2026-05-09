'use client';

// src/components/dashboard/SubscriptionStatusBanner.tsx
//
// Renders a prominent banner for cancelled and past_due subscription states.
// VAL-CROSS-011: Cancelled account → read-only banner with grace period date.
// VAL-CROSS-012: Past-due account → payment warning banner with billing portal link.

import { Icon } from './Icon';

interface CancelledBannerProps {
  businessName: string;
  gracePeriodEndDate: string | null;
  readAccess: boolean;
}

interface PastDueBannerProps {
  businessName: string;
  billingPortalUrl: string | null;
}

export function CancelledBanner({ gracePeriodEndDate, readAccess }: CancelledBannerProps) {
  const formattedDate = gracePeriodEndDate
    ? new Date(gracePeriodEndDate).toLocaleDateString('en-US', {
        month: 'long',
        day: 'numeric',
        year: 'numeric',
      })
    : 'soon';

  return (
    <div className="sub-status-banner sub-status-banner--cancelled">
      <div className="sub-status-banner__icon">
        <Icon name="alert" size={20} />
      </div>
      <div className="sub-status-banner__content">
        <div className="sub-status-banner__title">
          Your subscription has been cancelled
        </div>
        <div className="sub-status-banner__body">
          {readAccess ? (
            <>
              Read-only access until <strong>{formattedDate}</strong>. All write
              actions (approve, regenerate, edit response) are disabled. Your
              data is preserved during the grace period.
            </>
          ) : (
            <>
              Your grace period has ended. Your data is preserved but no longer
              accessible. Contact support to reactivate your account.
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export function PastDueBanner({ billingPortalUrl }: PastDueBannerProps) {
  return (
    <div className="sub-status-banner sub-status-banner--past-due">
      <div className="sub-status-banner__icon">
        <Icon name="alert" size={20} />
      </div>
      <div className="sub-status-banner__content">
        <div className="sub-status-banner__title">
          Payment overdue — please update your payment method
        </div>
        <div className="sub-status-banner__body">
          Your subscription features continue to work during the 7-day grace
          period, but your payment method needs updating.{' '}
          {billingPortalUrl ? (
            <a
              href={billingPortalUrl}
              className="sub-status-banner__link"
              target="_blank"
              rel="noopener noreferrer"
            >
              Update payment method →
            </a>
          ) : (
            <span>Contact support to update your payment method.</span>
          )}
        </div>
      </div>
    </div>
  );
}
