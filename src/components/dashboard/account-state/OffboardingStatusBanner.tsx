'use client';

import { Icon } from '@/components/dashboard/shell/Icon';

export interface OffboardingStatusView {
  id?: string | null;
  accountId?: string | null;
  mode: string;
  status: string;
  failedStep?: string | null;
  accessEndsAt?: string | Date | null;
  teardownStartedAt?: string | Date | null;
  purgeAfter?: string | Date | null;
  operationalUIBlocked?: boolean;
}

interface OffboardingStatusBannerProps {
  activeOffboarding: OffboardingStatusView;
  accountTimeZone?: string | null;
}

export function OffboardingStatusBanner({
  activeOffboarding,
  accountTimeZone,
}: OffboardingStatusBannerProps) {
  const title = offboardingTitle(activeOffboarding);
  const detail = offboardingDeadlineDetail(activeOffboarding, accountTimeZone);

  return (
    <div className="sub-status-banner sub-status-banner--cancelled">
      <div className="sub-status-banner__icon">
        <Icon name="alert" size={20} />
      </div>
      <div className="sub-status-banner__content">
        <div className="sub-status-banner__title">{title}</div>
        <div className="sub-status-banner__body">
          <p style={{ margin: 0 }}>
            Normal RepWorth access is paused while account offboarding is processed.
            {' '}Customer data is deleted or anonymized after the waiting period.
            {' '}Limited billing, security, and compliance records may be retained where required.
          </p>
          {detail ? (
            <p style={{ margin: '8px 0 0' }}>
              {detail.label} {detail.value}.
            </p>
          ) : (
            <p style={{ margin: '8px 0 0' }}>
              This page will update as each step finishes.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function offboardingTitle(active: OffboardingStatusView): string {
  if (active.status === 'failed') return 'Offboarding needs support review';
  if (active.mode === 'delete_data' && active.status === 'purge_scheduled') {
    return 'Account deletion is scheduled';
  }
  if (active.mode === 'delete_data') return 'Account deletion is in progress';
  if (active.status === 'purge_scheduled') return 'Account teardown is scheduled';
  return 'Account teardown is in progress';
}

function offboardingDeadlineDetail(
  active: OffboardingStatusView,
  timeZone?: string | null,
): { label: string; value: string } | null {
  if (active.purgeAfter) {
    return {
      label: 'Deletion window ends',
      value: formatOffboardingTimestamp(active.purgeAfter, timeZone),
    };
  }
  if (active.accessEndsAt) {
    return {
      label: active.status === 'scheduled' ? 'Access is scheduled to end' : 'Access ended',
      value: formatOffboardingTimestamp(active.accessEndsAt, timeZone),
    };
  }
  if (active.teardownStartedAt) {
    return {
      label: 'Teardown started',
      value: formatOffboardingTimestamp(active.teardownStartedAt, timeZone),
    };
  }
  return null;
}

function formatOffboardingTimestamp(value: string | Date, timeZone?: string | null): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return 'the server-provided deadline';
  // timeZone is per-call (account-specific); options are not module-static, so the constructor cannot be hoisted.
  // react-doctor-disable-next-line react-doctor/js-hoist-intl
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: timeZone || 'UTC',
    timeZoneName: 'short',
  }).format(date);
}
