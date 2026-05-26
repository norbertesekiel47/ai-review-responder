'use client';

// src/components/dashboard/SubscriptionStatusBanner.tsx
//
// Renders a prominent banner for cancelled and past_due subscription states.
// VAL-CROSS-011: Cancelled account → read-only banner with grace period date.
// VAL-CROSS-012: Past-due account → payment warning banner with billing portal link.

import { useState } from 'react';
import { Icon } from './Icon';

interface CancelledBannerProps {
  gracePeriodEndDate: string | null;
  readAccess: boolean;
}

interface PastDueBannerProps {
  billingPortalUrl: string | null;
  pastDueAt: string | null;
  deadline: string | null;
  daysRemaining: number | null;
  isReadOnly: boolean;
  navigate?: (url: string) => void;
}

export async function openBillingPortal(
  billingPortalUrl: string,
  options: {
    fetchFn?: typeof fetch;
    navigate?: (url: string) => void;
  } = {},
): Promise<void> {
  const fetchFn = options.fetchFn ?? fetch;
  const navigate = options.navigate ?? ((url: string) => window.location.assign(url));
  const response = await fetchFn(billingPortalUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });

  if (!response.ok) {
    throw new Error('billing_portal_unavailable');
  }

  const body = (await response.json()) as { url?: string };
  if (!body.url) {
    throw new Error('billing_portal_url_missing');
  }

  navigate(body.url);
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

export function PastDueBanner({
  billingPortalUrl,
  deadline,
  daysRemaining,
  isReadOnly,
  navigate,
}: PastDueBannerProps) {
  const [isOpeningPortal, setIsOpeningPortal] = useState(false);
  const [portalError, setPortalError] = useState(false);
  const deadlineCopy = deadline
    ? new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(deadline))
    : null;
  const daysCopy = daysRemaining === null
    ? null
    : daysRemaining === 0
      ? 'Less than a day remains'
      : `${daysRemaining} ${daysRemaining === 1 ? 'day remains' : 'days remain'}`;
  const title = isReadOnly
    ? 'Payment overdue — account is read-only'
    : daysRemaining !== null && daysRemaining <= 2
      ? 'Final payment reminder'
      : daysRemaining !== null && daysRemaining <= 4
        ? 'Payment still overdue'
        : 'Payment needs attention';

  async function handleOpenPortal() {
    if (!billingPortalUrl) {
      return;
    }
    setIsOpeningPortal(true);
    setPortalError(false);
    try {
      await openBillingPortal(billingPortalUrl, { navigate });
    } catch {
      setPortalError(true);
    } finally {
      setIsOpeningPortal(false);
    }
  }

  return (
    <div className="sub-status-banner sub-status-banner--past-due">
      <div className="sub-status-banner__icon">
        <Icon name="alert" size={20} />
      </div>
      <div className="sub-status-banner__content">
        <div className="sub-status-banner__title">
          {title}
        </div>
        <div className="sub-status-banner__body">
          {isReadOnly ? (
            <>
              Actions are paused until payment is updated.
              {deadlineCopy ? <> The recovery deadline was <strong>{deadlineCopy}</strong>.</> : null}{' '}
            </>
          ) : (
            <>
              Your subscription features continue to work during the recovery
              period. {daysCopy ? <strong>{daysCopy}</strong> : null}
              {deadlineCopy ? <> before read-only mode starts on <strong>{deadlineCopy}</strong>.</> : null}{' '}
            </>
          )}
          {billingPortalUrl ? (
            <button
              type="button"
              className="sub-status-banner__link"
              aria-label="Update payment method"
              onClick={handleOpenPortal}
              disabled={isOpeningPortal}
            >
              Update payment method →
            </button>
          ) : (
            <a className="sub-status-banner__link" href="/help/contact">
              Contact support
            </a>
          )}
          {portalError ? (
            <span className="sub-status-banner__error">
              Unable to open billing portal. Try again from Settings.
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}
