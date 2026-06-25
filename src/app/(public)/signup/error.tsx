'use client';

export default function SignupError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="min-h-screen bg-rw-sage flex items-center justify-center px-4">
      <div className="max-w-md w-full bg-white rounded-3xl shadow-2xl border border-rw-teal/15 p-8 text-center">
        <h1 className="text-xl font-bold mb-4 text-rw-ink">Something went wrong</h1>
        <p className="text-rw-ink-soft mb-6">
          We couldn&apos;t load the signup page. Please try again.
        </p>
        <button type="button"
          onClick={reset}
          className="bg-rw-teal-strong text-white px-6 py-2 rounded-full hover:bg-[#46645d] transition-colors"
        >
          Retry
        </button>
        <p className="text-sm text-rw-ink-soft mt-4">
          Still having trouble?{' '}
          <a href="mailto:support@repworth.net" className="text-rw-teal-strong underline">
            Contact support
          </a>
        </p>
      </div>
    </div>
  );
}
