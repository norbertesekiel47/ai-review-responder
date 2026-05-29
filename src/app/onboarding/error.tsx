'use client';

import { motion } from 'motion/react';

import { OnboardingFunnelShell } from './_shared/OnboardingFunnelShell';
import { primaryButtonClass, buttonMotion } from './_shared/field-styles';

export default function OnboardingError({
  reset,
}: {
  error: Error;
  reset: () => void;
}) {
  return (
    <OnboardingFunnelShell>
      <div className="max-w-md mx-auto text-center py-6">
        <h1 className="text-2xl font-medium text-[#2a2a2a] mb-3">
          Something went wrong
        </h1>
        <p className="text-[#6a6a6a] mb-8">
          We couldn&apos;t load the onboarding page. Please try again.
        </p>
        <motion.button
          onClick={reset}
          {...buttonMotion}
          className={primaryButtonClass}
        >
          Retry
        </motion.button>
        <p className="text-sm text-[#9a948a] mt-6">
          Still having trouble?{' '}
          <a
            href="mailto:support@repworth.com"
            className="text-[#97B3AE] underline hover:text-[#7e9b96]"
          >
            Contact support
          </a>
        </p>
      </div>
    </OnboardingFunnelShell>
  );
}
