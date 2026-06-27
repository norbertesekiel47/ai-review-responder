import { describe, it, expect } from 'vitest';
import {
  ZernioAuthError, ZernioTransientError, ZernioRouteError,
} from '../errors';

describe('Zernio error classes', () => {
  it('ZernioAuthError carries status + body', () => {
    const err = new ZernioAuthError(401, 'unauthorized');
    expect(err.status).toBe(401);
    expect(err.body).toBe('unauthorized');
    expect(err.name).toBe('ZernioAuthError');
  });

  it('ZernioRouteError carries statusCode + code', () => {
    const err = new ZernioRouteError(409, 'finalize_unknown_admin_required');
    expect(err.statusCode).toBe(409);
    expect(err.code).toBe('finalize_unknown_admin_required');
  });

  it('ZernioTransientError preserves kind discriminator', () => {
    const err = new ZernioTransientError('request_timeout', { path: '/x' });
    expect(err.kind).toBe('request_timeout');
    expect(err.meta).toEqual({ path: '/x' });
  });
});
