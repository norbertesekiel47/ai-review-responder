import { describe, it } from 'vitest';

describe('POST /api/dashboard/solicitation/batch/approve', () => {
  it.todo('returns 404 from the approve route when send mode is off');
  it.todo('rejects an approval when the subscription does not grant full access');
  it.todo('treats a trialing subscription as full access at approval');
  it.todo('rejects an approval that carries no location scope');
  it.todo('rejects a cross-origin approval post');
});

describe('POST /api/dashboard/solicitation/batch/halt', () => {
  it.todo('returns 404 from the halt route when send mode is off');
});
