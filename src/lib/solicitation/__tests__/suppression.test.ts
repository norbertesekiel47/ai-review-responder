import { describe, expect, it } from 'vitest';
import {
  SUPPRESSION_CHANNELS,
  SUPPRESSION_SCOPES,
  SUPPRESSION_SOURCES,
  type RecordSuppressionInput,
  type SuppressionChannel,
  type SuppressionScope,
  type SuppressionSource,
} from '../suppression';

// Contract suite for the Suppression ledger's closed enums and the shape of
// `recordSuppression`'s input (#643; spec §3.1/§3.2, glossary "Suppression
// ledger" / "Suppression scope").
//
// The enums exist so no call site ever writes a bare string literal, and the
// input union exists so the source/scope pairing the DB CHECK enforces cannot
// even be TYPED. The `@ts-expect-error` cases below are therefore real
// assertions — `pnpm typecheck` fails if any of those illegal shapes ever
// starts compiling.
//
// The DB CHECK's behaviour lives in the live-DB suite: a type-level assertion
// cannot catch a reversed or two-directional constraint, which is the failure
// that matters most here.

describe('Suppression ledger closed enums', () => {
  it("exports §3.1's seven sources in the spec's table order", () => {
    expect(SUPPRESSION_SOURCES).toEqual([
      'unsubscribe_one_click',
      'unsubscribe_link',
      'bounce_permanent',
      'complaint',
      'provider_suppressed',
      'admin_manual',
      'owner_manual',
    ]);
  });

  it('keeps the two unsubscribe mechanisms distinct rather than collapsing them', () => {
    // They cost one enum member and tell us which mechanism recipients
    // actually use — the input to any later decision about the mailto (§7.5)
    // or the landing page copy.
    expect(SUPPRESSION_SOURCES).toContain('unsubscribe_one_click');
    expect(SUPPRESSION_SOURCES).toContain('unsubscribe_link');
  });

  it('admits no source for the §3.2 signals that must never suppress', () => {
    // A full mailbox is not an opt-out. Soft bounces, delivery delays and
    // send-side failures are retry/observability inputs; admitting any of them
    // as a source would make an ambiguous signal a permanent, cross-tenant
    // removal of a real customer.
    for (const nonSource of [
      'bounce_soft',
      'bounce_transient',
      'delivery_delayed',
      'email_failed',
      'reached_daily_quota',
      'unknown',
    ]) {
      expect(SUPPRESSION_SOURCES as readonly string[]).not.toContain(nonSource);
    }
  });

  it('exports both Suppression scopes, global first', () => {
    // Global first is not cosmetic: it is the precedence the §1.2 lookup
    // applies when a handle matches both (G3).
    expect(SUPPRESSION_SCOPES).toEqual(['global', 'account']);
  });

  it('exports email as the only channel — phone handles mint no rows today', () => {
    expect(SUPPRESSION_CHANNELS).toEqual(['email']);
  });

  it('derives a closed union type from each array, not a widened string', () => {
    // The whole reason the arrays are `as const`. If any of them widened to
    // `string[]`, the derived type would admit anything and the "no string
    // literals at call sites" rule would buy nothing — the assignments below
    // would still compile, but so would the rejected ones underneath.
    const scopes: readonly SuppressionScope[] = SUPPRESSION_SCOPES;
    const sources: readonly SuppressionSource[] = SUPPRESSION_SOURCES;
    const channels: readonly SuppressionChannel[] = SUPPRESSION_CHANNELS;

    // @ts-expect-error the Suppression scope names WHO AUTHORED the opt-out; there is no
    // third author, and a widened union is exactly what this pins against.
    const notAScope: SuppressionScope = 'both';
    // @ts-expect-error §3.2 — an ambiguous or send-side signal is not a source.
    const notASource: SuppressionSource = 'bounce_soft';
    // @ts-expect-error email is the only channel the ledger keys on today.
    const notAChannel: SuppressionChannel = 'sms';

    expect(scopes).not.toContain(notAScope);
    expect(sources).not.toContain(notASource);
    expect(channels).not.toContain(notAChannel);
  });
});

describe('RecordSuppressionInput makes the illegal source/scope pairings untypeable', () => {
  it('accepts the three legal shapes', () => {
    const machineAuthored: RecordSuppressionInput = {
      scope: 'global',
      channel: 'email',
      normalizedHandle: 'recipient@example.com',
      accountId: null,
      source: 'complaint',
    };
    const adminAuthored: RecordSuppressionInput = {
      scope: 'global',
      channel: 'email',
      normalizedHandle: 'recipient@example.com',
      accountId: null,
      source: 'admin_manual',
      createdByUserId: 'ac2f8d1e-0000-7000-8000-000000000000',
      note: 'Replied "remove me" to the ask thread',
    };
    const ownerAuthored: RecordSuppressionInput = {
      scope: 'account',
      channel: 'email',
      normalizedHandle: 'recipient@example.com',
      accountId: 'ac2f8d1e-1111-7000-8000-000000000000',
      source: 'owner_manual',
      createdByUserId: 'ac2f8d1e-0000-7000-8000-000000000000',
    };

    expect([machineAuthored.scope, adminAuthored.scope, ownerAuthored.scope]).toEqual([
      'global',
      'global',
      'account',
    ]);
  });

  it('rejects owner_manual at global scope — the cross-tenant write §1.2 exists to prevent', () => {
    // @ts-expect-error owner_manual is the only account-authored source; global would let one
    // owner degrade every other tenant's reach with no recipient having spoken.
    const illegal: RecordSuppressionInput = {
      scope: 'global',
      channel: 'email',
      normalizedHandle: 'recipient@example.com',
      accountId: null,
      source: 'owner_manual',
      createdByUserId: 'ac2f8d1e-0000-7000-8000-000000000000',
    };
    expect(illegal.source).toBe('owner_manual');
  });

  it('rejects an account-scoped row with no account_id — the scope IS the account', () => {
    // @ts-expect-error §1.2: an account row is keyed on account_id, so it is non-null by
    // construction. The DB CHECK is the last line of defence, not the first.
    const illegal: RecordSuppressionInput = {
      scope: 'account',
      channel: 'email',
      normalizedHandle: 'recipient@example.com',
      accountId: null,
      source: 'owner_manual',
      createdByUserId: 'ac2f8d1e-0000-7000-8000-000000000000',
    };
    expect(illegal.scope).toBe('account');
  });

  it('rejects admin_manual without the §7.3 actor and note', () => {
    // @ts-expect-error §7.3 REQUIRES both for admin entry; folding admin_manual in with the
    // machine sources let a global row omit them (G14).
    const illegal: RecordSuppressionInput = {
      scope: 'global',
      channel: 'email',
      normalizedHandle: 'recipient@example.com',
      accountId: null,
      source: 'admin_manual',
    };
    expect(illegal.source).toBe('admin_manual');
  });

  it('rejects a machine source claiming a human actor', () => {
    // @ts-expect-error no human authored a permanent bounce; `?: never` makes claiming one a
    // type error rather than a silently-accepted field.
    const illegal: RecordSuppressionInput = {
      scope: 'global',
      channel: 'email',
      normalizedHandle: 'recipient@example.com',
      accountId: null,
      source: 'bounce_permanent',
      createdByUserId: 'ac2f8d1e-0000-7000-8000-000000000000',
    };
    expect(illegal.source).toBe('bounce_permanent');
  });
});
