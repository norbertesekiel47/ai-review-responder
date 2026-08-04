'use client';

import type { ChallengeFactor } from '@/lib/auth/mfa';

const SUPPORT_EMAIL = 'support@repworth.net';

export interface RecoveryStepUpFieldProps {
  factors: ChallengeFactor[];
  selectedFactorId: string;
  onSelectFactor: (factorId: string) => void;
  code: string;
  onCodeChange: (code: string) => void;
  /** Portal-owned styling — the two reset cards use different design languages. */
  labelClassName: string;
  inputClassName: string;
  supportLinkClassName: string;
}

/**
 * The TOTP code field shown inline on the reset-password cards when the account
 * has a verified factor. Presentational only: all state lives in
 * `useRecoveryStepUp`, and all styling arrives via props so neither portal's
 * look has to migrate into a shared component.
 */
export function RecoveryStepUpField({
  factors,
  selectedFactorId,
  onSelectFactor,
  code,
  onCodeChange,
  labelClassName,
  inputClassName,
  supportLinkClassName,
}: RecoveryStepUpFieldProps) {
  return (
    <div>
      {factors.length > 1 ? (
        <div className="mb-3">
          <label className={labelClassName} htmlFor="recovery-mfa-factor">
            Authenticator
          </label>
          <select
            id="recovery-mfa-factor"
            className={inputClassName}
            value={selectedFactorId}
            onChange={(event) => onSelectFactor(event.target.value)}
          >
            {factors.map((factor) => (
              <option key={factor.id} value={factor.id}>
                {factor.label}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      <label className={labelClassName} htmlFor="recovery-mfa-code">
        Authenticator code
      </label>
      <input
        id="recovery-mfa-code"
        className={inputClassName}
        value={code}
        onChange={(event) => onCodeChange(event.target.value)}
        inputMode="numeric"
        pattern="[0-9]*"
        autoComplete="one-time-code"
        required
      />
      {/* No self-service factor removal: `unenroll` requires a currently
          stepped-up AAL2 session by design, which an AAL1 recovery session
          structurally cannot reach. Support is the correct answer here. */}
      <a className={supportLinkClassName} href={`mailto:${SUPPORT_EMAIL}`}>
        Lost your authenticator? Contact support
      </a>
    </div>
  );
}
