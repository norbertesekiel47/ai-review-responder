// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockUseMfaEnrollment, unenrollMock } = vi.hoisted(() => ({
  mockUseMfaEnrollment: vi.fn(),
  unenrollMock: vi.fn(async () => {}),
}));
vi.mock('@/components/auth/useMfaEnrollment', () => ({
  useMfaEnrollment: mockUseMfaEnrollment,
}));

import { AdminSecurityClient } from '../AdminSecurityClient';

function factor(id: string) {
  return { id, friendlyName: `Phone ${id}`, factorType: 'totp', status: 'verified', createdAt: null };
}

function hookState(factors: ReturnType<typeof factor>[]) {
  return {
    factors,
    verifiedFactors: factors,
    loading: false,
    busy: false,
    error: null,
    notice: null,
    enrollment: null,
    code: '',
    setCode: vi.fn(),
    startEnrollment: vi.fn(),
    verifyEnrollment: vi.fn(),
    cancelEnrollment: vi.fn(),
    unenrollFactor: unenrollMock,
  };
}

describe('AdminSecurityClient — removing a factor (X35)', () => {
  beforeEach(() => {
    unenrollMock.mockClear();
  });

  it('arms an inline confirm that spells out the lockout when it is the last factor', async () => {
    mockUseMfaEnrollment.mockReturnValue(hookState([factor('f1')]));
    render(<AdminSecurityClient />);

    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));

    expect(screen.getByText(/This is your only authenticator/)).toBeInTheDocument();
    expect(screen.getByText(/locks you out of every step-up \(AAL2\) page/)).toBeInTheDocument();
    expect(unenrollMock).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Remove authenticator' }));
    expect(unenrollMock).toHaveBeenCalledWith('f1');
  });

  it('states that step-up keeps working when other factors remain', async () => {
    mockUseMfaEnrollment.mockReturnValue(hookState([factor('f1'), factor('f2')]));
    render(<AdminSecurityClient />);

    await userEvent.click(screen.getAllByRole('button', { name: 'Remove' })[0]!);

    expect(screen.getByText(/Your 1 other keep step-up \(AAL2\) access working/)).toBeInTheDocument();
    expect(screen.queryByText(/only authenticator/)).toBeNull();
  });

  it('Cancel disarms without removing', async () => {
    mockUseMfaEnrollment.mockReturnValue(hookState([factor('f1')]));
    render(<AdminSecurityClient />);

    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.getByRole('button', { name: 'Remove' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove authenticator' })).toBeNull();
    expect(unenrollMock).not.toHaveBeenCalled();
  });
});
