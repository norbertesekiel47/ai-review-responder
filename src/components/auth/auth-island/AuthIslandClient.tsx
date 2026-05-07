'use client';

import { Suspense, useState } from 'react';
import type { AuthMode } from '@/components/auth/shared/pathForMode';
import './auth-island.css';
import { ParallaxField } from './ParallaxField';
import { Showcase } from './Showcase';
import { Tabs } from './Tabs';
import { LoginForm } from './LoginForm';
import { SignupForm } from './SignupForm';

export interface AuthIslandClientProps {
  initialMode: AuthMode;
}

export function AuthIslandClient(props: AuthIslandClientProps) {
  return (
    <Suspense fallback={<div className="rw-auth" aria-hidden="true" />}>
      <AuthIslandInner {...props} />
    </Suspense>
  );
}

// Exported for unit testing only. The public component is AuthIslandClient,
// which wraps this in a Suspense boundary so useSearchParams() inside
// LoginForm can resolve. Tests render AuthIslandInner directly because
// renderToStaticMarkup runs outside an app/ context and would otherwise see
// only the Suspense fallback. Mirrors the LoginFormClient/LoginFormInner
// pattern from Task 9.
export function AuthIslandInner({ initialMode }: AuthIslandClientProps) {
  const [prefilledEmail, setPrefilledEmail] = useState('');

  return (
    <div className="rw-auth">
      <ParallaxField />
      <div className="rw-page">
        <div className="rw-island">
          <Showcase mode={initialMode} />
          <div className="rw-form-pane">
            <Tabs mode={initialMode} onChange={() => setPrefilledEmail('')} />
            {initialMode === 'signup' ? (
              <>
                <h1 className="rw-form-h">Create your account</h1>
                <p className="rw-form-sub">Free for 14 days. No credit card required.</p>
                <SignupForm onAccountExists={(email) => setPrefilledEmail(email)} />
                <p className="rw-foot">
                  Already have an account?{' '}
                  <a className="rw-link" href="/login">
                    Sign in
                  </a>
                </p>
              </>
            ) : (
              <>
                <h1 className="rw-form-h">Sign in to RepWorth</h1>
                <p className="rw-form-sub">Pick up where you left off.</p>
                <LoginForm initialEmail={prefilledEmail} />
                <p className="rw-foot">
                  New to RepWorth?{' '}
                  <a className="rw-link" href="/signup">
                    Create an account
                  </a>
                </p>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
