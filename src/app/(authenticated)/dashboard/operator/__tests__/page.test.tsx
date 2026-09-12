// @vitest-environment jsdom
// The Operator screen's flag gate, both halves in one title: the server page
// throws Next's not-found when OWNER_OPERATOR_ENABLED is off, and neither nav
// renders an entry when the server-authoritative prop is false. They are one
// fact — "with the flag off the surface does not exist" — so they are asserted
// together rather than in two files that can drift.
import { describe, it } from 'vitest';

describe('operator page and nav flag gate', () => {
  it.todo('operator page calls notFound when the flag is off and the nav omits the entry');
});
