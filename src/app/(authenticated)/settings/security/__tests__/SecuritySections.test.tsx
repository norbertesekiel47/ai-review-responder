// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { MfaEnrollmentState, MfaFactor } from '@/components/auth/useMfaEnrollment';

vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));
vi.mock('next/image', () => ({
  // eslint-disable-next-line @next/next/no-img-element -- test stub for next/image
  default: (props: { src: string; alt: string }) => <img src={props.src} alt={props.alt} />,
}));

import {
  CHANGE_PASSWORD_HREF,
  PasswordSection,
  STEP_UP_HREF,
  SecurityEnrollForm,
  SecurityErrorNotice,
  SecurityFactorList,
  addFactorLabel,
} from '../SecuritySections';

const FACTOR: MfaFactor = {
  id: 'factor-1',
  friendlyName: 'RepWorth',
  factorType: 'totp',
  status: 'verified',
  createdAt: '2026-03-03T10:15:00.000Z',
};

afterEach(cleanup);

describe('addFactorLabel', () => {
  it('says what the button does, or that it is doing it', () => {
    expect(addFactorLabel(false, false)).toBe('Add authenticator app');
    expect(addFactorLabel(false, true)).toBe('Add another authenticator app');
    expect(addFactorLabel(true, false)).toBe('Starting…');
    expect(addFactorLabel(true, true)).toBe('Starting…');
  });
});

describe('SecurityErrorNotice', () => {
  it('renders nothing without an error', () => {
    const { container } = render(<SecurityErrorNotice error={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('attaches the step-up link only to the AAL2 refusal', () => {
    render(<SecurityErrorNotice error="Sign in again with your authenticator first." />);
    expect(screen.getByRole('alert')).toHaveTextContent(/sign in again/i);
    expect(screen.getByRole('link', { name: 'Verify with your authenticator' })).toHaveAttribute(
      'href',
      STEP_UP_HREF,
    );
    cleanup();

    render(<SecurityErrorNotice error="Could not load MFA factors." />);
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load MFA factors.');
    expect(screen.queryByRole('link')).toBeNull();
  });
});

describe('SecurityFactorList', () => {
  it('shows the skeleton while loading', () => {
    render(<SecurityFactorList loading factors={[]} busy={false} onRemove={vi.fn()} />);
    expect(screen.getByRole('status')).toHaveAttribute('aria-busy', 'true');
  });

  it('says two-step sign-in is off when there is no factor', () => {
    render(<SecurityFactorList loading={false} factors={[]} busy={false} onRemove={vi.fn()} />);
    expect(screen.getByText(/two-step sign-in is off/i)).toBeInTheDocument();
  });

  it('renders one row per factor and hands the factor to onRemove', () => {
    const onRemove = vi.fn();
    render(<SecurityFactorList loading={false} factors={[FACTOR]} busy={false} onRemove={onRemove} />);
    expect(screen.getByText('RepWorth')).toBeInTheDocument();
    expect(screen.getByText('Authenticator app · Added Mar 3, 2026')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(onRemove).toHaveBeenCalledWith(FACTOR);
  });

  it('disables Remove while busy', () => {
    render(<SecurityFactorList loading={false} factors={[FACTOR]} busy onRemove={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Remove' })).toBeDisabled();
  });
});

describe('SecurityEnrollForm', () => {
  const ENROLLMENT: MfaEnrollmentState = {
    factorId: 'factor-2',
    qrCode: 'data:image/svg+xml;base64,QQ==',
    secret: 'JBSWY3DPEHPK3PXP',
  };

  function arrange(overrides: Partial<Parameters<typeof SecurityEnrollForm>[0]> = {}) {
    const props = {
      enrollment: ENROLLMENT,
      code: '',
      busy: false,
      onCodeChange: vi.fn(),
      onSubmit: vi.fn((event: React.FormEvent<HTMLFormElement>) => event.preventDefault()),
      onCancel: vi.fn(),
      ...overrides,
    };
    render(<SecurityEnrollForm {...props} />);
    return props;
  }

  it('shows the QR image and the manual key', () => {
    arrange();
    expect(screen.getByAltText('Authenticator setup QR code')).toHaveAttribute('src', ENROLLMENT.qrCode);
    expect(screen.getByText(ENROLLMENT.secret as string)).toBeInTheDocument();
  });

  it('omits the QR image for a non-data URL and the key line when there is no secret', () => {
    arrange({ enrollment: { factorId: 'factor-2', qrCode: 'https://evil.example/qr.png', secret: null } });
    expect(screen.queryByAltText('Authenticator setup QR code')).toBeNull();
    expect(screen.queryByText(/enter this key by hand/i)).toBeNull();
  });

  it('keeps the submit disabled until a code is typed, and reports edits', () => {
    const props = arrange();
    expect(screen.getByRole('button', { name: 'Turn on two-step sign-in' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('6-digit code'), { target: { value: '123456' } });
    expect(props.onCodeChange).toHaveBeenCalledWith('123456');
    cleanup();

    arrange({ code: '123456' });
    expect(screen.getByRole('button', { name: 'Turn on two-step sign-in' })).toBeEnabled();
  });

  it('submits through onSubmit and cancels through onCancel', () => {
    const props = arrange({ code: '123456' });
    fireEvent.click(screen.getByRole('button', { name: 'Turn on two-step sign-in' }));
    expect(props.onSubmit).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(props.onCancel).toHaveBeenCalledTimes(1);
  });
});

describe('PasswordSection', () => {
  it('links Change password to the existing reset flow', () => {
    render(<PasswordSection />);
    expect(screen.getByRole('link', { name: 'Change password' })).toHaveAttribute('href', CHANGE_PASSWORD_HREF);
    expect(CHANGE_PASSWORD_HREF).toBe('/forgot-password');
  });
});
