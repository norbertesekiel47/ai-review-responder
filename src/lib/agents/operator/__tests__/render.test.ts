import { describe, it } from 'vitest';

describe('operator output validator', () => {
  it.todo('validator rejects a text segment that invents a count next to a metric word');
  it.todo('validator rejects a text segment that claims a change was applied before any click');
  it.todo('validator rejects a proposal_ref index with no proposal and a status_ref metric outside the snapshot');
  it.todo('validator rejects a scope_check that names the stored location or coexists with a proposal for the stored location');
  it.todo('validator rejects a proposal whose operation is outside the catalog or whose scope is neither the stored location nor the account default');
});

describe('pasted-review scrub', () => {
  it.todo('scrubber replaces a pasted review block with the marker and leaves ordinary owner text untouched');
});
