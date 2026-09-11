import { afterEach, describe, expect, it, vi } from 'vitest';
import { adminAppUrl } from '../admin-app-url';

afterEach(() => vi.unstubAllEnvs());

describe('trusted Admin app origin', () => {
  it.each(['https://admin.example.com', 'https://admin.example.com/'])('normalizes %s', (value) => {
    vi.stubEnv('ADMIN_APP_URL', value);
    expect(adminAppUrl()).toBe('https://admin.example.com');
  });
  it('accepts an explicit local development origin', () => {
    vi.stubEnv('ADMIN_APP_URL', 'http://localhost:3101/');
    expect(adminAppUrl()).toBe('http://localhost:3101');
  });
  it.each([undefined, '', ' ', '//admin.example.com', 'javascript:alert(1)', 'https://user:password@admin.example.com', 'https://admin.example.com/path', 'https://admin.example.com?next=x', 'https://admin.example.com#x', 'https://*.example.com', 'https://admin.example.com/a/..', 'https://admin.example.com\\path'])('rejects invalid configuration without echoing it: %s', (value) => {
    vi.stubEnv('ADMIN_APP_URL', value);
    expect(() => adminAppUrl()).toThrow('ADMIN_APP_URL must be a configured HTTP(S) origin');
  });
  it('has no import-time configuration dependency', async () => {
    vi.stubEnv('ADMIN_APP_URL', undefined);
    vi.resetModules();
    await expect(import('../admin-app-url')).resolves.toBeDefined();
  });
});
