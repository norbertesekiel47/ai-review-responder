// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToneChipPicker, inferActiveTone } from '@/components/dashboard/settings/ToneChipPicker';

describe('inferActiveTone', () => {
  it('matches "warm, witty" tone to witty chip', () => {
    expect(inferActiveTone('warm, witty, occasionally cheeky')).toBe('witty');
  });
  it('matches "professional and friendly" to professional chip (professional wins over warm)', () => {
    expect(inferActiveTone('professional and friendly')).toBe('professional');
  });
  it('falls back to custom for unrecognised tones', () => {
    expect(inferActiveTone('thunderously regal')).toBe('custom');
  });
});

describe('ToneChipPicker', () => {
  it('renders 6 chips and the custom textarea when active="custom"', () => {
    render(<ToneChipPicker tone="thunderously regal" onChange={() => {}} />);
    expect(screen.getAllByRole('button')).toHaveLength(6);
    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });
  it('calls onChange with canonical tone when picking a preset', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<ToneChipPicker tone="" onChange={onChange} />);
    await user.click(screen.getByRole('button', { name: /warm \+ witty/i }));
    expect(onChange).toHaveBeenCalledWith('warm, witty, occasionally cheeky');
  });
  it('clicking Custom reveals textarea even when current tone matches a preset', async () => {
    const user = userEvent.setup();
    // "professional and friendly" infers to 'professional' preset, so the textarea would be hidden.
    render(<ToneChipPicker tone="professional and friendly" onChange={() => {}} />);
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /custom/i }));
    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });
});
