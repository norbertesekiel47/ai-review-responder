// @vitest-environment jsdom
// Launch-audit part2 ♿: wizard errors were visible but silent to screen
// readers. The shell now renders an assertive LiveRegion fed by the three
// error fields (submitError / displayLabelError / placeIdDuplicateError).
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AddLocationWizard } from '../AddLocationWizard';
import type { Props } from '../wizard/types';

const baseWiz = {
  step: 1,
  stepInfo: { title: 'Add location', subtitle: 'Step 1' },
  displayLabel: '',
  displayLabelError: null as string | null,
  inputMode: 'autocomplete',
  googleMapsUrl: '',
  placeIdDuplicateError: null as string | null,
  submitError: null as string | null,
  step1HasLocationDetails: false,
  setDisplayLabel: vi.fn(),
  selectPlace: vi.fn(),
  clearPlace: vi.fn(),
  setMapsUrl: vi.fn(),
  toggleInputMode: vi.fn(),
  goNext: vi.fn(),
  goBack: vi.fn(),
};

const mockUseWizard = vi.fn(() => baseWiz);

vi.mock('../wizard/useAddLocationWizard', () => ({
  useAddLocationWizard: () => mockUseWizard(),
}));
vi.mock('@/components/dashboard/shell/TopBar', () => ({ TopBar: () => null }));
vi.mock('@/components/dashboard/shell/Icon', () => ({ Icon: () => null }));
vi.mock('../wizard/steps/Step1Location', () => ({ Step1Location: () => null }));
vi.mock('../wizard/steps/Step2GoogleBusiness', () => ({ Step2GoogleBusiness: () => null }));
vi.mock('../wizard/steps/Step3Voice', () => ({ Step3Voice: () => null }));
vi.mock('../wizard/steps/Step4Confirm', () => ({ Step4Confirm: () => null }));

const props = {} as Props;

describe('AddLocationWizard error live region', () => {
  it('announces submit errors assertively', () => {
    mockUseWizard.mockReturnValueOnce({ ...baseWiz, submitError: 'Payment failed' });
    render(<AddLocationWizard {...props} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Payment failed');
  });

  it('announces display-label validation errors', () => {
    mockUseWizard.mockReturnValueOnce({
      ...baseWiz,
      displayLabelError: 'Location name is required',
    });
    render(<AddLocationWizard {...props} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Location name is required');
  });

  it('announces duplicate Place ID errors', () => {
    mockUseWizard.mockReturnValueOnce({
      ...baseWiz,
      placeIdDuplicateError: 'This location is already added',
    });
    render(<AddLocationWizard {...props} />);
    expect(screen.getByRole('alert')).toHaveTextContent('This location is already added');
  });

  it('announces nothing when there is no error', () => {
    render(<AddLocationWizard {...props} />);
    expect(screen.getByRole('alert')).toBeEmptyDOMElement();
  });
});
