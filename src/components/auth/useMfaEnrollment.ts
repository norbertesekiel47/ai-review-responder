'use client';

import { useCallback, useEffect, useMemo, useReducer } from 'react';
import { createBrowserSupabaseClient } from '@/lib/db/browser';

export interface MfaFactor {
  id: string;
  friendlyName: string | null;
  factorType: string;
  status: string;
  createdAt: string | null;
}

export interface MfaEnrollmentState {
  factorId: string;
  qrCode: string | null;
  secret: string | null;
}

function normalizeFactor(raw: unknown): MfaFactor | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const id = typeof record.id === 'string' ? record.id : null;
  if (!id) return null;
  return {
    id,
    friendlyName:
      typeof record.friendly_name === 'string'
        ? record.friendly_name
        : typeof record.friendlyName === 'string'
          ? record.friendlyName
          : null,
    factorType:
      typeof record.factor_type === 'string'
        ? record.factor_type
        : typeof record.factorType === 'string'
          ? record.factorType
          : 'totp',
    status: typeof record.status === 'string' ? record.status : 'unknown',
    createdAt:
      typeof record.created_at === 'string'
        ? record.created_at
        : typeof record.createdAt === 'string'
          ? record.createdAt
          : null,
  };
}

function normalizeFactors(data: unknown): MfaFactor[] {
  if (!data || typeof data !== 'object') return [];
  const record = data as Record<string, unknown>;
  const candidates = [
    ...(Array.isArray(record.totp) ? record.totp : []),
    ...(Array.isArray(record.all) ? record.all : []),
  ];
  const unique = new Map<string, MfaFactor>();
  for (const candidate of candidates) {
    const factor = normalizeFactor(candidate);
    if (factor) unique.set(factor.id, factor);
  }
  return [...unique.values()];
}

interface InternalState {
  factors: MfaFactor[];
  loading: boolean;
  busy: boolean;
  error: string | null;
  notice: string | null;
  enrollment: MfaEnrollmentState | null;
  code: string;
}

type Action =
  | { type: 'loadStart' }
  | { type: 'loadError'; error: string }
  | { type: 'loadSuccess'; factors: MfaFactor[] }
  | { type: 'actionStart' }
  | { type: 'setError'; error: string }
  | { type: 'enrollmentStarted'; enrollment: MfaEnrollmentState }
  | { type: 'enrollmentVerified'; notice: string }
  | { type: 'setNotice'; notice: string }
  | { type: 'actionDone' }
  | { type: 'setCode'; value: string }
  | { type: 'cancelEnrollment' };

const initialState: InternalState = {
  factors: [],
  loading: true,
  busy: false,
  error: null,
  notice: null,
  enrollment: null,
  code: '',
};

function reducer(state: InternalState, action: Action): InternalState {
  switch (action.type) {
    case 'loadStart':
      return { ...state, loading: true, error: null };
    case 'loadError':
      return { ...state, error: action.error, loading: false };
    case 'loadSuccess':
      return { ...state, factors: action.factors, loading: false };
    case 'actionStart':
      return { ...state, busy: true, error: null, notice: null };
    case 'setError':
      return { ...state, error: action.error };
    case 'enrollmentStarted':
      return { ...state, enrollment: action.enrollment, code: '' };
    case 'enrollmentVerified':
      return { ...state, enrollment: null, code: '', notice: action.notice };
    case 'setNotice':
      return { ...state, notice: action.notice };
    case 'actionDone':
      return { ...state, busy: false };
    case 'setCode':
      return { ...state, code: action.value };
    case 'cancelEnrollment':
      return { ...state, enrollment: null };
  }
}

export interface UseMfaEnrollment {
  factors: MfaFactor[];
  verifiedFactors: MfaFactor[];
  loading: boolean;
  busy: boolean;
  error: string | null;
  notice: string | null;
  enrollment: MfaEnrollmentState | null;
  code: string;
  setCode: (value: string) => void;
  startEnrollment: () => Promise<void>;
  verifyEnrollment: () => Promise<void>;
  cancelEnrollment: () => void;
  unenrollFactor: (factorId: string) => Promise<void>;
}

/**
 * Headless owner of the client-side TOTP MFA enrollment flow: enroll via the
 * Supabase browser SDK, then challenge/verify/unenroll through the server route
 * `/api/auth/mfa/challenge` (which owns rate-limiting, the AAL2 gate on removal,
 * and audit). Both the owner settings surface and the admin security surface
 * consume this hook so the flow — and its error/notice semantics — has a single
 * authoritative implementation; each surface owns only its presentation.
 */
export function useMfaEnrollment(): UseMfaEnrollment {
  const supabase = useMemo(() => createBrowserSupabaseClient(), []);
  const [state, dispatch] = useReducer(reducer, initialState);

  const loadFactors = useCallback(async () => {
    dispatch({ type: 'loadStart' });
    const { data, error: listError } = await supabase.auth.mfa.listFactors();
    if (listError) {
      dispatch({ type: 'loadError', error: 'Could not load MFA factors.' });
      return;
    }
    dispatch({ type: 'loadSuccess', factors: normalizeFactors(data) });
  }, [supabase]);

  useEffect(() => {
    void loadFactors();
  }, [loadFactors]);

  const startEnrollment = useCallback(async () => {
    dispatch({ type: 'actionStart' });
    try {
      const { data, error: enrollError } = await supabase.auth.mfa.enroll({
        factorType: 'totp',
        friendlyName: 'RepWorth',
      });
      if (enrollError || !data) {
        dispatch({ type: 'setError', error: 'Could not start MFA enrollment.' });
        return;
      }
      const record = data as unknown as Record<string, unknown>;
      const totp = record.totp as Record<string, unknown> | undefined;
      dispatch({
        type: 'enrollmentStarted',
        enrollment: {
          factorId: String(record.id),
          qrCode: typeof totp?.qr_code === 'string' ? totp.qr_code : null,
          secret: typeof totp?.secret === 'string' ? totp.secret : null,
        },
      });
    } finally {
      dispatch({ type: 'actionDone' });
    }
  }, [supabase]);

  const verifyEnrollment = useCallback(async () => {
    const enrollment = state.enrollment;
    if (!enrollment) return;
    dispatch({ type: 'actionStart' });
    try {
      const challengeRes = await fetch('/api/auth/mfa/challenge', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'challenge', factorId: enrollment.factorId }),
      });
      if (challengeRes.status === 429) {
        dispatch({ type: 'setError', error: 'Too many MFA attempts. Try again in a few minutes.' });
        return;
      }
      const challenge = await challengeRes.json().catch(() => ({}));
      if (!challengeRes.ok || typeof challenge.challengeId !== 'string') {
        dispatch({ type: 'setError', error: 'Could not create MFA challenge.' });
        return;
      }
      const verifyRes = await fetch('/api/auth/mfa/challenge', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'verify',
          factorId: enrollment.factorId,
          challengeId: challenge.challengeId,
          code: state.code,
        }),
      });
      if (verifyRes.status === 429) {
        dispatch({ type: 'setError', error: 'Too many MFA attempts. Try again in a few minutes.' });
        return;
      }
      if (!verifyRes.ok) {
        dispatch({ type: 'setError', error: 'The verification code was not accepted.' });
        return;
      }
      dispatch({ type: 'enrollmentVerified', notice: 'MFA factor enrolled.' });
      await loadFactors();
    } finally {
      dispatch({ type: 'actionDone' });
    }
  }, [state.enrollment, state.code, loadFactors]);

  const unenrollFactor = useCallback(
    async (factorId: string) => {
      dispatch({ type: 'actionStart' });
      try {
        // Routed through the server so removal requires a current AAL2 session and
        // is audit-logged — never a direct AAL1 client-side unenroll.
        const res = await fetch('/api/auth/mfa/challenge', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'unenroll', factorId }),
        });
        if (res.status === 403) {
          dispatch({
            type: 'setError',
            error: 'Sign in again with your authenticator before removing this factor.',
          });
          return;
        }
        if (res.status === 429) {
          dispatch({ type: 'setError', error: 'Too many attempts. Try again in a few minutes.' });
          return;
        }
        if (!res.ok) {
          dispatch({
            type: 'setError',
            error: 'Could not remove MFA factor. Verify your current session and try again.',
          });
          return;
        }
        dispatch({ type: 'setNotice', notice: 'MFA factor removed.' });
        await loadFactors();
      } finally {
        dispatch({ type: 'actionDone' });
      }
    },
    [loadFactors],
  );

  const setCode = useCallback((value: string) => {
    dispatch({ type: 'setCode', value });
  }, []);

  const cancelEnrollment = useCallback(() => {
    dispatch({ type: 'cancelEnrollment' });
  }, []);

  const verifiedFactors = state.factors.filter((factor) => factor.status === 'verified');

  return {
    factors: state.factors,
    verifiedFactors,
    loading: state.loading,
    busy: state.busy,
    error: state.error,
    notice: state.notice,
    enrollment: state.enrollment,
    code: state.code,
    setCode,
    startEnrollment,
    verifyEnrollment,
    cancelEnrollment,
    unenrollFactor,
  };
}
