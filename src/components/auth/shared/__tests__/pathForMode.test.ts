import { describe, expect, it } from 'vitest';
import { pathForMode, modeForPath } from '../pathForMode';

describe('pathForMode', () => {
  it('login → /login', () => expect(pathForMode('login')).toBe('/login'));
  it('signup → /signup', () => expect(pathForMode('signup')).toBe('/signup'));
});

describe('modeForPath', () => {
  it('/login → login', () => expect(modeForPath('/login')).toBe('login'));
  it('/signup → signup', () => expect(modeForPath('/signup')).toBe('signup'));
  it('falls back to login for unknown paths', () => {
    expect(modeForPath('/anything-else')).toBe('login');
  });
});
