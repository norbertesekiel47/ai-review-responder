import { describe, expect, it } from 'vitest';
import {
  errorBannerClass,
  fieldClass,
  ghostButtonClass,
  infoBannerClass,
  labelClass,
  primaryButtonClass,
  textareaClass,
} from '../field-styles';

// ADR 0004: white text only ever sits on rw-teal-strong or darker. The funnel's
// primary CTA is the root of every "Generate my demo" / "Continue" / "Finish
// setup" button, so this is the one place the rule has to hold.
describe('field-styles (ADR 0004 tokens)', () => {
  it('fills the primary button with rw-teal-strong and hovers to rw-teal-strong-hover', () => {
    expect(primaryButtonClass).toContain('bg-rw-teal-strong');
    expect(primaryButtonClass).toContain('hover:bg-rw-teal-strong-hover');
    expect(primaryButtonClass).not.toMatch(/(?:^|\s)bg-rw-teal(?=\s|$)/);
    expect(primaryButtonClass).not.toMatch(/\bhover:bg-rw-teal-hover\b/);
  });

  it('uses no raw hex anywhere', () => {
    for (const cls of [
      fieldClass,
      textareaClass,
      labelClass,
      errorBannerClass,
      infoBannerClass,
      primaryButtonClass,
      ghostButtonClass,
    ]) {
      expect(cls).not.toMatch(/#[0-9a-fA-F]{3,6}/);
    }
  });

  it('keeps inputs at 16px (text-base) so iOS Safari does not zoom on focus', () => {
    expect(fieldClass).toContain('text-base');
  });

  it('renders the error banner in rw-error tokens, not raw red utilities', () => {
    expect(errorBannerClass).toContain('text-rw-error');
    expect(errorBannerClass).not.toMatch(/\b(text|bg|border)-red-\d+/);
  });
});
