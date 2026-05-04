'use client';

import { useState } from 'react';

interface StepConnectProps {
  onBack: () => void;
  onConnect: () => Promise<void>;
  onSkip: () => Promise<void>;
  submitting: boolean;
}

/**
 * Wizard Step 3 (post-pay flow) — connect Google Business Profile via Zernio.
 *
 * Either path is terminal for the wizard:
 *  - "Connect Google Business Profile" — saves Profile+Voice via the wizard
 *    submit, then kicks off Zernio OAuth (window.location → authUrl). After
 *    OAuth the user lands on /dashboard/connect/select-location, picks a
 *    location, and ends up at /dashboard with reviews flowing.
 *  - "Skip for now" — saves Profile+Voice, redirects to /dashboard. Dashboard
 *    will show the empty state until they connect later from /dashboard/connect.
 */
export function StepConnect({ onBack, onConnect, onSkip, submitting }: StepConnectProps) {
  const [error, setError] = useState<string | null>(null);

  async function handleConnect() {
    setError(null);
    try {
      await onConnect();
    } catch {
      setError('Could not start the Google connection. Please try again.');
    }
  }

  async function handleSkip() {
    setError(null);
    try {
      await onSkip();
    } catch {
      setError('Could not finish setup. Please try again.');
    }
  }

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-6 space-y-5">
      <div>
        <h2 className="text-lg font-medium text-gray-900">
          Connect your Google Business Profile
        </h2>
        <p className="mt-1 text-sm text-gray-600">
          We use Zernio to securely read your reviews and post your approved
          replies on Google. You&apos;ll be redirected to Google to grant
          access — only you ever see review content, and we never auto-post
          without your explicit approval.
        </p>
      </div>

      <ul className="space-y-2 text-sm text-gray-700">
        <li className="flex items-start gap-2">
          <span className="text-green-600 mt-0.5">✓</span>
          <span>Pulls in every review on the location you pick.</span>
        </li>
        <li className="flex items-start gap-2">
          <span className="text-green-600 mt-0.5">✓</span>
          <span>Drafts a reply for each new review using your voice.</span>
        </li>
        <li className="flex items-start gap-2">
          <span className="text-green-600 mt-0.5">✓</span>
          <span>You approve each reply before it goes live.</span>
        </li>
      </ul>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 pt-2">
        <button
          type="button"
          onClick={onBack}
          disabled={submitting}
          className="text-gray-600 font-medium py-2 px-4 hover:text-gray-900 disabled:opacity-50"
        >
          ← Back
        </button>

        <div className="flex flex-col sm:flex-row gap-3">
          <button
            type="button"
            onClick={handleSkip}
            disabled={submitting}
            className="text-gray-600 font-medium py-2 px-4 hover:text-gray-900 disabled:opacity-50"
          >
            Skip for now
          </button>
          <button
            type="button"
            onClick={handleConnect}
            disabled={submitting}
            className="bg-blue-600 text-white font-medium py-2 px-6 rounded-md hover:bg-blue-700 disabled:opacity-50"
          >
            {submitting ? 'Connecting…' : 'Connect Google Business Profile'}
          </button>
        </div>
      </div>
    </div>
  );
}
