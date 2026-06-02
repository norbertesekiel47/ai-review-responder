'use client';

import { useState } from 'react';
import { LazyMotion, m, domAnimation } from 'motion/react';
import {
  errorBannerClass,
  primaryButtonClass,
  ghostButtonClass,
  buttonMotion,
} from '../_shared/field-styles';

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
    <LazyMotion features={domAnimation}>
    <div className="space-y-5">
      <div>
        <h2 className="text-xl font-medium text-[#2a2a2a]">
          Connect your Google Business Profile
        </h2>
        <p className="mt-1 text-sm text-[#6a6a6a]">
          We use Zernio to securely read your reviews and post your approved
          replies on Google. You&apos;ll be redirected to Google to grant
          access, only you ever see review content, and we never auto-post
          without your explicit approval.
        </p>
      </div>

      <ul className="space-y-2 text-sm text-[#6a6a6a]">
        <li className="flex items-start gap-2">
          <span className="text-[#97B3AE] mt-0.5">✓</span>
          <span>Pulls in every review on the location you pick.</span>
        </li>
        <li className="flex items-start gap-2">
          <span className="text-[#97B3AE] mt-0.5">✓</span>
          <span>Drafts a reply for each new review using your voice.</span>
        </li>
        <li className="flex items-start gap-2">
          <span className="text-[#97B3AE] mt-0.5">✓</span>
          <span>You approve each reply before it goes live.</span>
        </li>
      </ul>

      {error && <div className={errorBannerClass}>{error}</div>}

      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 pt-2">
        <button
          type="button"
          onClick={onBack}
          disabled={submitting}
          className={ghostButtonClass}
        >
          ← Back
        </button>

        <div className="flex flex-col sm:flex-row gap-3">
          <button
            type="button"
            onClick={handleSkip}
            disabled={submitting}
            className={ghostButtonClass}
          >
            Skip for now
          </button>
          <m.button
            type="button"
            onClick={handleConnect}
            disabled={submitting}
            {...buttonMotion}
            className={primaryButtonClass}
          >
            {submitting ? 'Connecting…' : 'Connect Google Business Profile'}
          </m.button>
        </div>
      </div>
    </div>
    </LazyMotion>
  );
}
