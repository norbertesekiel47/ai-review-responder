'use client';

export default function SignupError({
  reset,
}: {
  error: Error;
  reset: () => void;
}) {
  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
      <div className="max-w-md w-full bg-white rounded-lg border border-gray-200 p-8 text-center">
        <h1 className="text-xl font-bold mb-4">Something went wrong</h1>
        <p className="text-gray-700 mb-6">
          We couldn&apos;t load the signup page. Please try again.
        </p>
        <button
          onClick={reset}
          className="bg-blue-600 text-white px-6 py-2 rounded-md hover:bg-blue-700"
        >
          Retry
        </button>
        <p className="text-sm text-gray-500 mt-4">
          Still having trouble?{' '}
          <a
            href="mailto:support@repworth.com"
            className="underline"
          >
            Contact support
          </a>
        </p>
      </div>
    </div>
  );
}
