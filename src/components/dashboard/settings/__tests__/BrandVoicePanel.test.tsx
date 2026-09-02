// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BrandVoicePanel } from '../BrandVoicePanel';

const form = {
  tone: 'professional',
  productsServices: 'Coffee and pastries',
  avoidFacts: ['We never discount on weekends'],
  sampleResponses: [],
};

// S30: the control is a row-based list editor, not a textarea, so the hint
// describes rows — "one per line" described a control that is not there.
it('describes Things to avoid as one item per row', () => {
  render(<BrandVoicePanel form={form} set={vi.fn()} />);
  expect(screen.getByText(/Add one item per row\./)).toBeInTheDocument();
  expect(screen.queryByText(/One per line/)).not.toBeInTheDocument();
});

it('routes tone changes through the shared setter', () => {
  const set = vi.fn();
  render(<BrandVoicePanel form={form} set={set} />);
  screen.getByRole('radio', { name: /casual/i }).click();
  expect(set).toHaveBeenCalledWith('tone', 'casual');
});
