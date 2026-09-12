// @vitest-environment jsdom
// The card contracts (spec §3.3). Every assertion reads from a stored-row
// fixture, never from prose, and never from the browser's location selector.
import { describe, it } from 'vitest';

describe('ProposalCard', () => {
  it.todo('proposal card renders the target from the stored location and shows Prepared for the location when the selector moved');
  it.todo('proposal card shows the receipt after Apply and the stale wording with Refresh plan after a version mismatch');
  // Round-1 addition (RB-04).
  it.todo('proposal previews expose exact fact replacements before approval');
});

describe('RequestedCapabilityCard', () => {
  it.todo('requested capability card has no Apply button');
});
