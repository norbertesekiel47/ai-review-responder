'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { AuthFlow } from '@/lib/shared/auth-flow';
import {
  AuthCardShell,
  authFieldClass,
  authLabelClass,
  authPrimaryButtonClass,
} from './AuthCardShell';
import { LiveRegion } from '@/components/ui/LiveRegion';

export interface ResetPasswordFormProps {
  portal: AuthFlow;
  brandName: string;
}

interface AdminResetPasswordProps {
  brandName: string;
  password: string;
  setPassword: (v: string) => void;
  confirmPw: string;
  setConfirmPw: (v: string) => void;
  error: string;
  loading: boolean;
  handleSubmit: (e: React.FormEvent) => Promise<void>;
}

/** Renders the unchanged utilitarian gray/blue card for the admin portal. */
function AdminResetPassword({
  brandName,
  password,
  setPassword,
  confirmPw,
  setConfirmPw,
  error,
  loading,
  handleSubmit,
}: AdminResetPasswordProps) {
  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <h1 className="text-2xl font-bold text-gray-900 text-center mb-8">
          {brandName}
        </h1>
        <form
          onSubmit={handleSubmit}
          className="bg-white rounded-lg border border-gray-200 p-6 space-y-4"
        >
          <h2 className="text-base font-medium text-gray-900">
            Set a new password
          </h2>
          <div>
            <label
              htmlFor="new-password"
              className="block text-sm font-medium text-gray-700 mb-1"
            >
              New password
            </label>
            <input
              id="new-password"
              type="password"
              autoComplete="new-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="8+ characters"
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>
          <div>
            <label
              htmlFor="confirm-password"
              className="block text-sm font-medium text-gray-700 mb-1"
            >
              Confirm password
            </label>
            <input
              id="confirm-password"
              type="password"
              autoComplete="new-password"
              required
              value={confirmPw}
              onChange={(e) => setConfirmPw(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>
          {error && <p className="text-sm text-red-600">{error}</p>}
          <button
            type="submit"
            disabled={loading}
            className="w-full bg-blue-600 text-white font-medium py-2 rounded-md text-sm hover:bg-blue-700 disabled:opacity-50 transition-colors"
          >
            {loading ? 'Updating...' : 'Update password'}
          </button>
        </form>
      </div>
    </div>
  );
}

export function ResetPasswordFormClient({ portal, brandName }: ResetPasswordFormProps) {
  const [password, setPassword] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const router = useRouter();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (password !== confirmPw) {
      setError('Passwords do not match');
      return;
    }
    if (password.length < 8) {
      setError('Password must be at least 8 characters');
      return;
    }
    setLoading(true);
    try {
      const res = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      const body = (await res.json()) as {
        error?: string;
        redirectTo?: string;
      };
      if (!res.ok) {
        setError(body.error ?? 'Reset failed');
        return;
      }
      router.push(body.redirectTo ?? '/login');
    } catch {
      setError('Connection failed');
    } finally {
      setLoading(false);
    }
  }

  if (portal === 'admin') {
    return (
      <AdminResetPassword
        brandName={brandName}
        password={password}
        setPassword={setPassword}
        confirmPw={confirmPw}
        setConfirmPw={setConfirmPw}
        error={error}
        loading={loading}
        handleSubmit={handleSubmit}
      />
    );
  }

  return (
    <AuthCardShell width="sm">
      <LiveRegion level="assertive" message={error} />
      <form onSubmit={handleSubmit} className="space-y-4">
        <h1 className="text-2xl font-semibold text-[#2a2a2a]">Set a new password</h1>
        <div>
          <label htmlFor="new-password" className={authLabelClass}>New password</label>
          <input
            id="new-password"
            type="password"
            autoComplete="new-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="8+ characters"
            className={authFieldClass}
          />
        </div>
        <div>
          <label htmlFor="confirm-password" className={authLabelClass}>Confirm password</label>
          <input
            id="confirm-password"
            type="password"
            autoComplete="new-password"
            required
            value={confirmPw}
            onChange={(e) => setConfirmPw(e.target.value)}
            className={authFieldClass}
          />
        </div>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button type="submit" disabled={loading} className={authPrimaryButtonClass}>
          {loading ? 'Updating...' : 'Update password'}
        </button>
      </form>
    </AuthCardShell>
  );
}
