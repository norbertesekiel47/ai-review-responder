import { describe, it, expect } from 'vitest';
import { validateApproveEdit, MAX_EDIT_LENGTH } from '../validation';

describe('validateApproveEdit', () => {
  it('accepts a clean string and returns it sanitized', () => {
    const result = validateApproveEdit({ editedText: 'Thanks for visiting!' });
    expect(result).toEqual({ ok: true, editedText: 'Thanks for visiting!' });
  });

  it('rejects a missing editedText with the legacy message', () => {
    expect(validateApproveEdit({})).toEqual({ ok: false, error: 'editedText is required' });
  });

  it('rejects a non-string editedText with the legacy message', () => {
    expect(validateApproveEdit({ editedText: 123 })).toEqual({ ok: false, error: 'editedText is required' });
  });

  it('rejects an over-length editedText with the legacy message', () => {
    const result = validateApproveEdit({ editedText: 'a'.repeat(MAX_EDIT_LENGTH + 1) });
    expect(result).toEqual({ ok: false, error: `editedText exceeds ${MAX_EDIT_LENGTH} characters` });
  });

  it('rejects text that sanitizes to empty (only zero-width/bidi chars)', () => {
    // U+200B zero-width space + U+202E right-to-left override → stripped → empty
    const result = validateApproveEdit({ editedText: '​‮' });
    expect(result).toEqual({ ok: false, error: 'editedText is required' });
  });

  it('rejects a null body with the legacy message', () => {
    expect(validateApproveEdit(null)).toEqual({ ok: false, error: 'editedText is required' });
  });

  it('rejects a bare-string body with the legacy message', () => {
    expect(validateApproveEdit('just a string')).toEqual({ ok: false, error: 'editedText is required' });
  });

  it('returns the sanitized value on the ok path (strips zero-width chars)', () => {
    // U+200B zero-width space is stripped (not replaced with a space) by sanitizePublicResponseText
    const result = validateApproveEdit({ editedText: 'Hello​world' });
    expect(result).toEqual({ ok: true, editedText: 'Helloworld' });
  });
});
