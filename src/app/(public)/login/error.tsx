'use client';

export default function LoginError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="min-h-screen bg-[#D2E0D3] flex items-center justify-center px-4">
      <div className="max-w-md w-full bg-white rounded-3xl shadow-2xl border border-[#97B3AE]/15 p-8 text-center">
        <h1 className="text-xl font-bold mb-4 text-[#2a2a2a]">Something went wrong</h1>
        <p className="text-[#6a6a6a] mb-6">
          We couldn&apos;t load the sign-in page. Please try again.
        </p>
        <button type="button"
          onClick={reset}
          className="bg-[#557069] text-white px-6 py-2 rounded-full hover:bg-[#46645d] transition-colors"
        >
          Retry
        </button>
        <p className="text-sm text-[#6a6a6a] mt-4">
          Still having trouble?{' '}
          <a href="mailto:support@repworth.net" className="text-[#557069] underline">
            Contact support
          </a>
        </p>
      </div>
    </div>
  );
}
