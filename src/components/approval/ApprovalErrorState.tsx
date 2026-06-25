// Branded error + recovery island body for the public approval page.
// Shared by the server page (token pre-check failures) and the client
// component (post-load fetch/session failures) so the recovery UX has one owner.
// Presentational only — no hooks, no 'use client' — so it renders on both sides.
//
// Two visual variants, because a *consumed* link is not an error: it usually
// means the owner (or a teammate) already approved/edited/regenerated from this
// same link, and they may simply have re-opened it. That gets a neutral,
// reassuring treatment with no red alarm and no support CTA. Genuine failures
// (invalid/expired/revoked/5xx) keep the error icon + support recovery.

const DASHBOARD_HREF = '/dashboard';
const SUPPORT_HREF = '/help/contact';

export type ApprovalErrorVariant = 'used' | 'error';

// A consumed link can be reached via approve, edit, OR regenerate — so the copy
// must NOT assert "already approved". This neutral phrase covers all three.
const USED_LINK_MESSAGE = 'This link has already been used.';

function NeutralUsedIcon() {
  return (
    <div className="mx-auto mb-4 flex size-14 items-center justify-center rounded-full bg-rw-teal-strong/12">
      <svg
        className="size-7 text-rw-teal-strong"
        fill="none"
        viewBox="0 0 24 24"
        strokeWidth={2}
        stroke="currentColor"
        aria-hidden="true"
      >
        <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
      </svg>
    </div>
  );
}

function ErrorIcon() {
  return (
    <div className="mx-auto mb-4 flex size-14 items-center justify-center rounded-full bg-[#dc2626]/10">
      <svg
        className="size-7 text-[#dc2626]"
        fill="none"
        viewBox="0 0 24 24"
        strokeWidth={2}
        stroke="currentColor"
        aria-hidden="true"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z"
        />
      </svg>
    </div>
  );
}

export function ApprovalErrorState({
  message,
  variant = 'error',
}: {
  message: string;
  variant?: ApprovalErrorVariant;
}) {
  if (variant === 'used') {
    // Reassurance, not alarm. Most recipients are logged out, so /dashboard is
    // demoted to a quiet secondary link rather than the primary CTA.
    return (
      <div role="status" className="text-center">
        <NeutralUsedIcon />
        <p className="text-lg font-medium leading-relaxed text-rw-ink">
          {message || USED_LINK_MESSAGE}
        </p>
        <p className="mx-auto mt-3 max-w-sm text-sm leading-relaxed text-rw-ink-soft">
          No action is needed — you can safely close this page.
        </p>
        <a
          href={DASHBOARD_HREF}
          className="mt-6 inline-block rounded-sm text-xs font-semibold text-rw-teal-strong underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rw-teal-strong focus-visible:ring-offset-2"
        >
          Manage reviews in your dashboard →
        </a>
      </div>
    );
  }

  return (
    <div role="alert" className="text-center">
      <ErrorIcon />
      <p className="text-lg font-medium leading-relaxed text-rw-ink">
        {message}
      </p>
      <p className="mt-4 text-sm text-rw-ink-soft">
        Need a hand?{' '}
        <a
          href={SUPPORT_HREF}
          className="rounded-sm font-semibold text-rw-teal-strong underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rw-teal-strong focus-visible:ring-offset-1"
        >
          Contact support
        </a>
      </p>
      {/* Dashboard is a quiet secondary path — many recipients are logged out,
          so it must not be the universal primary CTA. */}
      <p className="mt-3 text-xs text-rw-ink-soft">
        Already signed in?{' '}
        <a
          href={DASHBOARD_HREF}
          className="rounded-sm font-semibold text-rw-teal-strong underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rw-teal-strong focus-visible:ring-offset-1"
        >
          Go to your dashboard
        </a>
      </p>
    </div>
  );
}

export { USED_LINK_MESSAGE };
