import { describe, expect, it } from 'vitest';
import { BAR_SPRING, chartTransition } from '@/components/dashboard/charts/motion-presets';

describe('chartTransition', () => {
  it('passes the base transition through when motion is allowed', () => {
    expect(chartTransition(false, BAR_SPRING)).toEqual(BAR_SPRING);
  });

  it('applies a stagger delay when motion is allowed', () => {
    expect(chartTransition(false, BAR_SPRING, 0.09)).toEqual({ ...BAR_SPRING, delay: 0.09 });
  });

  it('collapses to an instant cut under prefers-reduced-motion, dropping any delay', () => {
    expect(chartTransition(true, BAR_SPRING, 0.09)).toEqual({ duration: 0 });
  });
});
