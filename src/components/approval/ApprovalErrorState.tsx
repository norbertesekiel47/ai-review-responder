// Branded error + recovery island body for the public approval page.
// Shared by the server page (token pre-check failures) and the client
// component (post-load fetch/session failures) so the recovery UX has one owner.
// Presentational only — no hooks, no 'use client' — so it renders on both sides.

const DASHBOARD_HREF = '/dashboard';
const SUPPORT_HREF = '/help/contact';

export function ApprovalErrorState({ message }: { message: string }) {
  return (
    <div role="alert" className="text-center">
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
      <p className="text-lg font-medium leading-relaxed text-[#2a2a2a]">
        {message}
      </p>
      <a
        href={DASHBOARD_HREF}
        className="mt-6 inline-block rounded-full bg-[#97B3AE] px-6 py-3 text-sm font-semibold text-white shadow-lg transition hover:bg-[#97B3AE]/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#97B3AE] focus-visible:ring-offset-2"
      >
        Go to your dashboard →
      </a>
      <p className="mt-4 text-sm text-[#6a6a6a]">
        Need a hand?{' '}
        <a href={SUPPORT_HREF} className="rounded-sm font-semibold text-[#97B3AE] underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#97B3AE] focus-visible:ring-offset-1">
          Contact support
        </a>
      </p>
    </div>
  );
}
