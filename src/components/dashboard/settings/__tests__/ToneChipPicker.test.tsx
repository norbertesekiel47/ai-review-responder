// @vitest-environment jsdom

import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToneChipPicker } from '@/components/dashboard/settings/ToneChipPicker';
import { inferActiveTone } from '@/components/dashboard/settings/ToneChipPicker.helpers';

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
    expect(screen.getByRole('button', { name: /custom/i })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /professional/i })).toHaveAttribute('aria-pressed', 'false');
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
  it('clears the override when the tone prop changes externally (Discard / initial fetch)', async () => {
    // Harness mirrors the real flow: a parent owns the tone state, the
    // picker writes to it via onChange, and Discard resets it to the saved
    // initial value.
    function Harness({ initial }: { initial: string }) {
      const [tone, setTone] = React.useState(initial);
      return (
        <>
          <ToneChipPicker tone={tone} onChange={setTone} />
          <button onClick={() => setTone(initial)} type="button">
            DiscardSim
          </button>
        </>
      );
    }
    const user = userEvent.setup();
    render(<Harness initial="professional" />);
    expect(screen.getByRole('button', { name: /^professional$/i }).className).toContain('active');
    await user.click(screen.getByRole('button', { name: /warm \+ witty/i }));
    expect(screen.getByRole('button', { name: /warm \+ witty/i }).className).toContain('active');
    await user.click(screen.getByRole('button', { name: /discardsim/i }));
    // After Discard: Professional is active again, Warm + witty is not.
    expect(screen.getByRole('button', { name: /^professional$/i }).className).toContain('active');
    expect(screen.getByRole('button', { name: /warm \+ witty/i }).className).not.toContain('active');
  });
});
