'use client';

import { LazyMotion, m, domAnimation } from 'motion/react';

import { OnboardingFunnelShell } from './_shared/OnboardingFunnelShell';
import { primaryButtonClass, buttonMotion } from './_shared/field-styles';

export default function OnboardingError({
  reset,
}: {
  error: Error;
  reset: () => void;
}) {
  return (
    <LazyMotion features={domAnimation}>
    <OnboardingFunnelShell>
      <div className="max-w-md mx-auto text-center py-6">
        <h1 className="text-2xl font-medium text-rw-ink mb-3">
          Something went wrong
        </h1>
        <p className="text-rw-ink-soft mb-8">
          We couldn&apos;t load the onboarding page. Please try again.
        </p>
        <m.button
          onClick={reset}
          {...buttonMotion}
          className={primaryButtonClass}
        >
          Retry
        </m.button>
        <p className="text-sm text-rw-warm-gray mt-6">
          Still having trouble?{' '}
          <a
            href="mailto:support@repworth.net"
            className="text-rw-teal underline hover:text-rw-teal-hover"
          >
            Contact support
          </a>
        </p>
      </div>
    </OnboardingFunnelShell>
    </LazyMotion>
  );
}
