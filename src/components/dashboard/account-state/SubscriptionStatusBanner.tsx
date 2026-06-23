'use client';

// src/components/dashboard/SubscriptionStatusBanner.tsx
//
// Renders a prominent banner for cancelled and past_due subscription states.
// VAL-CROSS-011: Cancelled account → read-only banner with grace period date.
// VAL-CROSS-012: Past-due account → payment warning banner with billing portal link.

import { useState } from 'react';
import Link from 'next/link';
import { Icon } from '@/components/dashboard/shell/Icon';
import { openBillingPortal } from '@/components/dashboard/account-state/billing-portal';

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

const PAST_DUE_DEADLINE_FORMATTER = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});

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
    ? PAST_DUE_DEADLINE_FORMATTER.format(new Date(deadline))
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
            <Link className="sub-status-banner__link" href="/help/contact">
              Contact support
            </Link>
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

interface TrialBannerProps {
  /** ISO timestamp when the trial ends. */
  trialEndsAt: string;
}

const TRIAL_DEADLINE_FORMATTER = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});

/**
 * "Trial — N days left" banner. Shown while the account is trialing. Calm and
 * truthful: states the days left, the charge date, and where to manage billing.
 * No urgency theatrics — the card is already captured and Stripe auto-charges
 * at trial end.
 */
function computeTrialDaysRemaining(trialEndsAt: string): number {
  const msRemaining = new Date(trialEndsAt).getTime() - Date.now();
  return Math.max(0, Math.ceil(msRemaining / 86_400_000));
}

export function TrialBanner({ trialEndsAt }: TrialBannerProps) {
  const endDate = new Date(trialEndsAt);
  // Snapshot "now" once at mount via a state initializer — reading Date.now()
  // directly in the render body is impure (react-hooks/purity). The banner does
  // not need a live ticking countdown; a per-render value is fine and stable.
  const [daysRemaining] = useState(() => computeTrialDaysRemaining(trialEndsAt));
  const daysCopy =
    daysRemaining === 0
      ? 'Your trial ends today'
      : daysRemaining === 1
        ? '1 day left in your free trial'
        : `${daysRemaining} days left in your free trial`;
  const deadlineCopy = TRIAL_DEADLINE_FORMATTER.format(endDate);

  return (
    <div className="sub-status-banner sub-status-banner--trial">
      <div className="sub-status-banner__icon">
        <Icon name="sparkle" size={20} />
      </div>
      <div className="sub-status-banner__content">
        <div className="sub-status-banner__title">{daysCopy}</div>
        <div className="sub-status-banner__body">
          You have full access to RepWorth. Your card is charged automatically on{' '}
          <strong>{deadlineCopy}</strong> unless you cancel before then.{' '}
          <Link className="sub-status-banner__link" href="/settings/billing">
            Manage billing →
          </Link>
        </div>
      </div>
    </div>
  );
}
