'use client';

import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import { createBrowserSupabaseClient } from '@/lib/db/browser';
import { normalizeChallengeFactors, type ChallengeFactor } from '@/lib/auth/mfa';
import { fetchWithTimeout } from '@/components/auth/shared/fetchWithTimeout';

/**
 * Headless owner of the MFA step-up inside the password-recovery flow.
 *
 * The recovery OTP mints an AAL1 session, and GoTrue refuses a password write
 * on one whenever the account has a verified factor. This hook probes for that
 * situation at mount and, when it applies, challenges + verifies the factor
 * through `/api/auth/mfa/challenge` (which owns rate-limiting and audit) so the
 * session is already AAL2 by the time the card POSTs the new password.
 *
 * Both reset cards consume it, so the flow has one authoritative implementation
 * and each surface owns only its presentation.
 *
 * CONSUMER CONTRACT: disable your submit control while `busy` is true. A second
 * call mid-flight returns the first call's promise, which closed over the code
 * as it was then — so an un-disabled control can silently send a stale code and
 * report it as rejected.
 */
export type RecoveryStepUpStatus =
  | 'probing'
  | 'no-session'
  | 'no-factor'
  | 'code-required'
  | 'verified';

const RATE_LIMITED_COPY = 'Too many MFA attempts. Try again in 15 minutes.';
const REJECTED_COPY = 'The verification code was not accepted.';
const CHALLENGE_FAILED_COPY = 'Could not start MFA verification.';
const NETWORK_COPY =
  'Could not reach the server. Check your connection and try again.';
const NO_FACTOR_ID_COPY =
  'Could not load your security settings. Reload the page and try again.';
const EMPTY_CODE_COPY = 'Enter your verification code.';
const SESSION_LAPSED_COPY = 'Your reset link expired. Request a new one.';
const TEMPORARILY_UNAVAILABLE_COPY =
  'The verification service is temporarily unavailable. Try again in a moment.';
const STEP_UP_AGAIN_COPY = 'Your verification expired. Verify your code again.';

interface State {
  status: RecoveryStepUpStatus;
  factors: ChallengeFactor[];
  selectedFactorId: string;
  code: string;
  busy: boolean;
  error: string | null;
}

const initialState: State = {
  status: 'probing',
  factors: [],
  selectedFactorId: '',
  code: '',
  busy: false,
  error: null,
};

type Action =
  | { type: 'noSession' }
  | { type: 'probed'; factors: ChallengeFactor[] }
  | { type: 'probeFailed' }
  | { type: 'selectFactor'; factorId: string }
  | { type: 'setCode'; code: string }
  | { type: 'verifyStart' }
  | { type: 'verifyFailed'; error: string }
  | { type: 'verified' }
  | { type: 'stepUpInvalidated' };

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'noSession':
      return { ...state, status: 'no-session' };
    case 'probed':
      return {
        ...state,
        status: action.factors.length > 0 ? 'code-required' : 'no-factor',
        factors: action.factors,
        selectedFactorId: action.factors[0]?.id ?? '',
      };
    case 'probeFailed':
      // Fail TOWARD asking for a code, but with no factor id — `verify` turns
      // that into an honest "reload and try again" rather than posting a blank
      // factorId the challenge route would reject as a malformed body.
      return { ...state, status: 'code-required', factors: [], selectedFactorId: '' };
    case 'selectFactor':
      return { ...state, selectedFactorId: action.factorId };
    case 'setCode':
      return { ...state, code: action.code };
    case 'verifyStart':
      return { ...state, busy: true, error: null };
    case 'verifyFailed':
      return { ...state, busy: false, error: action.error };
    case 'verified':
      return { ...state, busy: false, error: null, status: 'verified' };
    case 'stepUpInvalidated':
      // The server route fails closed: it re-reads AAL on every password
      // write and returns 403 mfa_required whenever that read fails, even
      // after a prior successful verify. There is no page reload in this
      // flow to re-run the probe, so the card calls `requireStepUp()` to put
      // the hook back where a fresh code can clear it again.
      return {
        ...state,
        status: 'code-required',
        code: '',
        busy: false,
        error: STEP_UP_AGAIN_COPY,
      };
  }
}

export interface UseRecoveryStepUp {
  status: RecoveryStepUpStatus;
  factors: ChallengeFactor[];
  selectedFactorId: string;
  selectFactor: (factorId: string) => void;
  code: string;
  setCode: (code: string) => void;
  busy: boolean;
  error: string | null;
  /** Resolves true when the session is (or already was) cleared to write a password. */
  verify: () => Promise<boolean>;
  /** Escape hatch for a server-side re-check that invalidates a prior `verified`. */
  requireStepUp: () => void;
}

export function useRecoveryStepUp(): UseRecoveryStepUp {
  const supabase = useMemo(() => createBrowserSupabaseClient(), []);
  const [state, dispatch] = useReducer(reducer, initialState);

  useEffect(() => {
    let cancelled = false;
    async function probe() {
      try {
        const {
          data: { user },
          error: userError,
        } = await supabase.auth.getUser();
        if (cancelled) return;
        if (userError) {
          // getUser() surfaces a network/CORS/5xx failure as a *resolved*
          // AuthRetryableFetchError, not a throw — so that specific error is
          // not proof the recovery link expired, only that this attempt to
          // check couldn't complete. Any other AuthError (e.g. a missing or
          // invalid refresh token) does mean the session is genuinely gone.
          dispatch(
            userError.name === 'AuthRetryableFetchError'
              ? { type: 'probeFailed' }
              : { type: 'noSession' },
          );
          return;
        }
        if (!user) {
          dispatch({ type: 'noSession' });
          return;
        }
        // listFactors() makes its own internal getUser() call — a second
        // round trip after the one above. Reading factors off `user` directly
        // would halve probe latency; deliberately not done here since it
        // would ripple into the mocked client shape this file's tests and
        // ResetPasswordFormClient's tests both depend on.
        const { data, error } = await supabase.auth.mfa.listFactors();
        if (cancelled) return;
        if (error) {
          dispatch({ type: 'probeFailed' });
          return;
        }
        dispatch({ type: 'probed', factors: normalizeChallengeFactors(data) });
      } catch {
        // Exceptions the SDK raises outside its normal AuthError contract —
        // e.g. a Web Locks API timeout acquiring the session lock. Not
        // identifiable as a network blip, but not proof the link expired
        // either, so this fails the same direction as the resolved
        // AuthRetryableFetchError branch above.
        if (!cancelled) dispatch({ type: 'probeFailed' });
      }
    }
    void probe();
    return () => {
      cancelled = true;
    };
  }, [supabase]);

  const inFlight = useRef<Promise<boolean> | null>(null);

  const verify = useCallback((): Promise<boolean> => {
    // One challenge+verify pair per user action. Without this a double-click
    // fires two, burning two of the challenge route's 15/hr for one intent —
    // and worse, a click that lands after the user has already corrected a
    // mistyped code would resolve against the FIRST run's stale code.
    // Concurrent callers share the in-flight result rather than racing.
    if (inFlight.current) return inFlight.current;

    // Each branch maps one distinct challenge/verify HTTP outcome
    // (429/401/503/ok on two separate fetches, plus the pre-flight
    // state/factor/code guards) to its own status copy; collapsing any pair
    // would make two different failure modes show the user the same
    // message, which is the class of bug this hook exists to avoid (see
    // STEP_UP_AGAIN_COPY's history above).
    // fallow-ignore-next-line complexity
    const run = async (): Promise<boolean> => {
      // Already cleared, or never needed clearing. Idempotent by design: the
      // route does not signOut on a failed password write, so a retry must
      // not demand a second code.
      if (state.status === 'verified' || state.status === 'no-factor') return true;
      if (state.status !== 'code-required') return false;
      if (!state.selectedFactorId) {
        // Only reachable via `probeFailed` — we know a code is probably needed
        // but never learned which factor to challenge.
        dispatch({ type: 'verifyFailed', error: NO_FACTOR_ID_COPY });
        return false;
      }
      const code = state.code.trim();
      if (!code) {
        // A blank submit currently spends one of the 15/hr challenges to earn
        // a misleading "code was not accepted" — reject before the fetch.
        dispatch({ type: 'verifyFailed', error: EMPTY_CODE_COPY });
        return false;
      }

      dispatch({ type: 'verifyStart' });
      try {
        // A fresh challenge per attempt. The verify budget (8/hr) is tighter
        // than the challenge budget (15/hr), so reusing a challenge id saves
        // nothing and only adds a stale-challenge failure mode.
        const challengeRes = await fetchWithTimeout('/api/auth/mfa/challenge', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            action: 'challenge',
            factorId: state.selectedFactorId,
          }),
        });
        if (challengeRes.status === 429) {
          dispatch({ type: 'verifyFailed', error: RATE_LIMITED_COPY });
          return false;
        }
        if (challengeRes.status === 401) {
          // The cookie-bound session is gone. Recovery sessions are
          // short-lived and the user just walked away to grab their phone —
          // this is an expected mid-flow lapse, not a wrong code.
          dispatch({ type: 'verifyFailed', error: SESSION_LAPSED_COPY });
          return false;
        }
        if (challengeRes.status === 503) {
          dispatch({ type: 'verifyFailed', error: TEMPORARILY_UNAVAILABLE_COPY });
          return false;
        }
        const challenge: unknown = await challengeRes.json().catch(() => ({}));
        const challengeId =
          challenge && typeof challenge === 'object' && 'challengeId' in challenge
            ? (challenge as { challengeId: unknown }).challengeId
            : undefined;
        if (!challengeRes.ok || typeof challengeId !== 'string') {
          dispatch({ type: 'verifyFailed', error: CHALLENGE_FAILED_COPY });
          return false;
        }

        const verifyRes = await fetchWithTimeout('/api/auth/mfa/challenge', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            action: 'verify',
            factorId: state.selectedFactorId,
            challengeId,
            code,
          }),
        });
        if (verifyRes.status === 429) {
          dispatch({ type: 'verifyFailed', error: RATE_LIMITED_COPY });
          return false;
        }
        if (verifyRes.status === 401) {
          dispatch({ type: 'verifyFailed', error: SESSION_LAPSED_COPY });
          return false;
        }
        if (verifyRes.status === 503) {
          dispatch({ type: 'verifyFailed', error: TEMPORARILY_UNAVAILABLE_COPY });
          return false;
        }
        if (!verifyRes.ok) {
          dispatch({ type: 'verifyFailed', error: REJECTED_COPY });
          return false;
        }

        dispatch({ type: 'verified' });
        return true;
      } catch {
        dispatch({ type: 'verifyFailed', error: NETWORK_COPY });
        return false;
      }
    };

    const promise = run().finally(() => {
      inFlight.current = null;
    });
    inFlight.current = promise;
    return promise;
  }, [state.status, state.selectedFactorId, state.code]);

  const selectFactor = useCallback(
    (factorId: string) => dispatch({ type: 'selectFactor', factorId }),
    [],
  );
  const setCode = useCallback((code: string) => dispatch({ type: 'setCode', code }), []);
  const requireStepUp = useCallback(() => {
    // Null the in-flight ref first: without this, calling requireStepUp() mid-
    // flight leaves the stale promise in place, and the old run's `verified`
    // dispatch (once it settles) overwrites the invalidation it was meant to
    // apply. Unreachable from the card today — it's only called after
    // `await verify()` and after the reset fetch resolves — but cheap to make
    // permanently correct.
    inFlight.current = null;
    dispatch({ type: 'stepUpInvalidated' });
  }, []);

  return {
    status: state.status,
    factors: state.factors,
    selectedFactorId: state.selectedFactorId,
    selectFactor,
    code: state.code,
    setCode,
    busy: state.busy,
    error: state.error,
    verify,
    requireStepUp,
  };
}
