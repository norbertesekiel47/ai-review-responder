// @vitest-environment jsdom

import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToneChipPicker, nextChipIndex } from '@/components/dashboard/settings/ToneChipPicker';
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

describe('nextChipIndex', () => {
  it('moves right/down and wraps, left/up and wraps, Home/End to the ends', () => {
    expect(nextChipIndex('ArrowRight', 0, 6)).toBe(1);
    expect(nextChipIndex('ArrowDown', 5, 6)).toBe(0);
    expect(nextChipIndex('ArrowLeft', 0, 6)).toBe(5);
    expect(nextChipIndex('ArrowUp', 3, 6)).toBe(2);
    expect(nextChipIndex('Home', 4, 6)).toBe(0);
    expect(nextChipIndex('End', 1, 6)).toBe(5);
  });
  it('ignores every other key', () => {
    expect(nextChipIndex('Enter', 2, 6)).toBeNull();
    expect(nextChipIndex('Tab', 2, 6)).toBeNull();
  });
});

describe('ToneChipPicker', () => {
  // S29: one choice = one radiogroup. Screen readers hear "3 of 6, selected",
  // not six independent toggles.
  it('renders the six chips as a radiogroup with exactly one checked, plus the custom textarea when active="custom"', () => {
    render(<ToneChipPicker tone="thunderously regal" onChange={() => {}} />);
    const group = screen.getByRole('radiogroup', { name: 'Reply tone' });
    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(6);
    expect(radios.every((radio) => group.contains(radio))).toBe(true);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByRole('textbox')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /custom/i })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: /professional/i })).toHaveAttribute('aria-checked', 'false');
    expect(radios.filter((radio) => radio.getAttribute('aria-checked') === 'true')).toHaveLength(1);
  });

  it('uses a roving tabindex: only the checked chip is in the tab order', () => {
    render(<ToneChipPicker tone="professional" onChange={() => {}} />);
    expect(screen.getByRole('radio', { name: /^professional$/i })).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('radio', { name: /casual/i })).toHaveAttribute('tabindex', '-1');
  });

  it('arrow keys move focus AND selection, wrapping at the ends', async () => {
    // A controlling parent, as in the real form: the picker's onChange writes
    // the tone the next render reads back (a static prop would look like an
    // external reset and drop the selection).
    const onChange = vi.fn();
    function Harness() {
      const [tone, setTone] = React.useState('professional');
      return (
        <ToneChipPicker
          tone={tone}
          onChange={(next) => {
            onChange(next);
            setTone(next);
          }}
        />
      );
    }
    const user = userEvent.setup();
    render(<Harness />);

    const professional = screen.getByRole('radio', { name: /^professional$/i });
    professional.focus();
    await user.keyboard('{ArrowRight}');

    const casual = screen.getByRole('radio', { name: /casual/i });
    expect(casual).toHaveFocus();
    expect(casual).toHaveAttribute('aria-checked', 'true');
    expect(casual).toHaveAttribute('tabindex', '0');
    expect(professional).toHaveAttribute('aria-checked', 'false');
    expect(onChange).toHaveBeenLastCalledWith('casual');

    // Home goes to the first chip; Left from there wraps to Custom… and
    // reveals the textarea.
    await user.keyboard('{Home}');
    expect(screen.getByRole('radio', { name: /warm & friendly/i })).toHaveFocus();
    expect(onChange).toHaveBeenLastCalledWith('warm, friendly');
    await user.keyboard('{ArrowLeft}');
    expect(screen.getByRole('radio', { name: /custom/i })).toHaveFocus();
    expect(screen.getByRole('radio', { name: /custom/i })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });

  it('calls onChange with canonical tone when picking a preset', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<ToneChipPicker tone="" onChange={onChange} />);
    await user.click(screen.getByRole('radio', { name: /warm \+ witty/i }));
    expect(onChange).toHaveBeenCalledWith('warm, witty, occasionally cheeky');
  });

  it('clicking Custom reveals textarea even when current tone matches a preset', async () => {
    const user = userEvent.setup();
    // "professional and friendly" infers to 'professional' preset, so the textarea would be hidden.
    render(<ToneChipPicker tone="professional and friendly" onChange={() => {}} />);
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: /custom/i }));
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
    expect(screen.getByRole('radio', { name: /^professional$/i })).toHaveAttribute('aria-checked', 'true');
    await user.click(screen.getByRole('radio', { name: /warm \+ witty/i }));
    expect(screen.getByRole('radio', { name: /warm \+ witty/i })).toHaveAttribute('aria-checked', 'true');
    await user.click(screen.getByRole('button', { name: /discardsim/i }));
    // After Discard: Professional is active again, Warm + witty is not.
    expect(screen.getByRole('radio', { name: /^professional$/i })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: /warm \+ witty/i })).toHaveAttribute('aria-checked', 'false');
  });
});
