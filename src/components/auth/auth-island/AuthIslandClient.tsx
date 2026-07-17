'use client';

import { Suspense } from 'react';
import Link from 'next/link';
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

// Inner component split out so the public export can wrap it in Suspense for useSearchParams().
function AuthIslandInner({ initialMode }: AuthIslandClientProps) {
  return (
    <main id="main-content" className="rw-auth">
      <ParallaxField />
      <div className="rw-page">
        <div className="rw-island">
          <Showcase mode={initialMode} />
          <div className="rw-form-pane">
            <Tabs mode={initialMode} />
            {initialMode === 'signup' ? (
              <>
                <h1 className="rw-form-h">Create your account</h1>
                <p className="rw-form-sub">Create your account, then choose your monthly plan explicitly.</p>
                <SignupForm />
                <p className="rw-foot">
                  Already have an account?{' '}
                  <Link className="rw-link" href="/login" replace>
                    Sign in
                  </Link>
                </p>
              </>
            ) : (
              <>
                <h1 className="rw-form-h">Sign in to RepWorth</h1>
                <p className="rw-form-sub">Pick up where you left off.</p>
                <LoginForm />
                <p className="rw-foot">
                  New to RepWorth?{' '}
                  <Link className="rw-link" href="/signup" replace>
                    Create an account
                  </Link>
                </p>
              </>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}
