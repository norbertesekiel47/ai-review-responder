// Unit half of the Auto-approval gate (#631 Task 1 scaffold, filled in Task 3
// per docs/superpowers/plans/2026-08-23-631-auto-approval-lane.md). Covers
// `evaluateAutoApproval`'s four-condition gate (D20) via a fake tagged-
// template `tx` in the `release.test.ts` mock-harness style (route on the
// distinctive fragment of each statement, never on an exact string), and the
// never-approve-on-any-single-failure invariant via a property test over the
// pure decision core `decideAutoApproval`. Live-DB verb/anchor coverage lives
// in `auto-approval.integration.test.ts` (Tasks 4 and 6).

import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TransactionSql } from 'postgres';
import { tierGrantsAutopilot, SubscriptionTier } from '@/lib/accounts/tier-config';
import {
  subscriptionGrantsFullAccess,
  SubscriptionStatus,
} from '@/lib/shared/subscription-status';
import {
  decideAutoApproval,
  evaluateAutoApproval,
  type AutoApprovalConditionSnapshot,
  type AutoApprovalDecision,
  type AutoApprovalDeclineReason,
} from '../auto-approval';

// ─────────────────────────────────────────────────────────────────────────────
// Fake `tx`: routes each tagged-template statement on its distinctive SQL
// fragment and answers from an in-memory model, exactly the
// `release.test.ts` idiom. `readAutoApprovalConditions` issues its accountId
// as the FIRST interpolated value on every one of its three statements, so
// `values[0]` is always the account being asked about.
// ─────────────────────────────────────────────────────────────────────────────

interface FakePolicyRow {
  account_id: string;
  persona: string;
  action_class: string;
  location_id: string | null;
  veto_window_minutes: number;
  suspended_at: Date | null;
}

interface FakeAccountsDb {
  accounts: Record<string, { subscription_status: string; subscription_tier: string }>;
  policies: FakePolicyRow[];
}

function createFakeTx(db: FakeAccountsDb): TransactionSql {
  const run = (text: string, values: unknown[]): unknown[] => {
    const sql = text.replace(/\s+/g, ' ');
    const accountId = values[0] as string;

    if (sql.includes('FROM accounts')) {
      const account = db.accounts[accountId];
      return account ? [account] : [];
    }
    if (sql.includes('any_suspended')) {
      const anySuspended = db.policies.some(
        (row) => row.account_id === accountId && row.suspended_at !== null,
      );
      return [{ any_suspended: anySuspended }];
    }
    if (sql.includes('veto_window_minutes')) {
      const row = db.policies.find(
        (candidate) =>
          candidate.account_id === accountId &&
          candidate.persona === 'solicitation' &&
          candidate.action_class === 'sending' &&
          candidate.location_id === null,
      );
      return row ? [{ veto_window_minutes: row.veto_window_minutes }] : [];
    }
    return [];
  };

  const tag = (strings: TemplateStringsArray, ...values: unknown[]): unknown =>
    Promise.resolve(run(Array.from(strings).join(' ? '), values));

  return tag as unknown as TransactionSql;
}

function solicitationAccountDefaultRow(
  accountId: string,
  vetoWindowMinutes = 60,
  suspendedAt: Date | null = null,
): FakePolicyRow {
  return {
    account_id: accountId,
    persona: 'solicitation',
    action_class: 'sending',
    location_id: null,
    veto_window_minutes: vetoWindowMinutes,
    suspended_at: suspendedAt,
  };
}

function replyAccountDefaultRow(accountId: string): FakePolicyRow {
  return {
    account_id: accountId,
    persona: 'reply',
    action_class: 'posting',
    location_id: null,
    veto_window_minutes: 15,
    suspended_at: null,
  };
}

function solicitationLocationOverrideRow(accountId: string, locationId: string): FakePolicyRow {
  return {
    account_id: accountId,
    persona: 'solicitation',
    action_class: 'sending',
    location_id: locationId,
    veto_window_minutes: 30,
    suspended_at: null,
  };
}

/** An account healthy on every condition: active/Autopilot, one unsuspended
 *  Solicitation account-default row. Individual tests break exactly one leg. */
function healthyDb(accountId: string): FakeAccountsDb {
  return {
    accounts: {
      [accountId]: {
        subscription_status: SubscriptionStatus.ACTIVE,
        subscription_tier: SubscriptionTier.AUTOPILOT,
      },
    },
    policies: [solicitationAccountDefaultRow(accountId)],
  };
}

function setFlags(sendEnabled: boolean, autoApprovalEnabled: boolean): void {
  if (sendEnabled) process.env.SOLICITATION_SEND_ENABLED = 'true';
  else delete process.env.SOLICITATION_SEND_ENABLED;
  if (autoApprovalEnabled) process.env.SOLICITATION_AUTO_APPROVAL_ENABLED = 'true';
  else delete process.env.SOLICITATION_AUTO_APPROVAL_ENABLED;
}

describe('evaluateAutoApproval', () => {
  beforeEach(() => {
    setFlags(false, false);
  });

  afterEach(() => {
    delete process.env.SOLICITATION_SEND_ENABLED;
    delete process.env.SOLICITATION_AUTO_APPROVAL_ENABLED;
  });

  it('leaves the batch in owner review when SOLICITATION_AUTO_APPROVAL_ENABLED is off', async () => {
    setFlags(true, false);
    const tx = createFakeTx(healthyDb('account-1'));

    const decision = await evaluateAutoApproval(tx, { accountId: 'account-1' });

    expect(decision).toEqual<AutoApprovalDecision>({ eligible: false, reason: 'auto_flag_off' });
  });

  it('leaves the batch in owner review when the tier does not grant Autopilot', async () => {
    setFlags(true, true);
    const db = healthyDb('account-1');
    db.accounts['account-1']!.subscription_tier = SubscriptionTier.COPILOT;
    const tx = createFakeTx(db);

    const decision = await evaluateAutoApproval(tx, { accountId: 'account-1' });

    expect(decision).toEqual<AutoApprovalDecision>({ eligible: false, reason: 'tier' });
  });

  it('leaves the batch in owner review when no solicitation policy row exists', async () => {
    setFlags(true, true);
    const db = healthyDb('account-1');
    db.policies = [];
    const tx = createFakeTx(db);

    const decision = await evaluateAutoApproval(tx, { accountId: 'account-1' });

    expect(decision).toEqual<AutoApprovalDecision>({ eligible: false, reason: 'no_policy_row' });
  });

  it('leaves the batch in owner review when any policy row for the account is suspended', async () => {
    setFlags(true, true);
    const db = healthyDb('account-1');
    // The Reply lane's own row for the same account, suspended — proves the
    // Governor read is account-wide (D19), not scoped to the Solicitation
    // persona whose own row here is perfectly healthy.
    db.policies.push({ ...replyAccountDefaultRow('account-1'), suspended_at: new Date() });
    const tx = createFakeTx(db);

    const decision = await evaluateAutoApproval(tx, { accountId: 'account-1' });

    expect(decision).toEqual<AutoApprovalDecision>({ eligible: false, reason: 'policy_suspended' });
  });

  it('a Reply policy row or location override alone never enables Solicitation auto approval', async () => {
    setFlags(true, true);
    const db: FakeAccountsDb = {
      accounts: {
        'account-1': {
          subscription_status: SubscriptionStatus.ACTIVE,
          subscription_tier: SubscriptionTier.AUTOPILOT,
        },
      },
      // No solicitation ACCOUNT-DEFAULT row: only a Reply row and a
      // solicitation LOCATION-OVERRIDE row exist for this account.
      policies: [
        replyAccountDefaultRow('account-1'),
        solicitationLocationOverrideRow('account-1', 'business-1'),
      ],
    };
    const tx = createFakeTx(db);

    const decision = await evaluateAutoApproval(tx, { accountId: 'account-1' });

    expect(decision).toEqual<AutoApprovalDecision>({ eligible: false, reason: 'no_policy_row' });
  });

  it('a suspended policy on another account never blocks this account', async () => {
    setFlags(true, true);
    const db = healthyDb('account-1');
    db.accounts['account-2'] = {
      subscription_status: SubscriptionStatus.ACTIVE,
      subscription_tier: SubscriptionTier.AUTOPILOT,
    };
    db.policies.push(solicitationAccountDefaultRow('account-2', 60, new Date()));
    const tx = createFakeTx(db);

    const decision = await evaluateAutoApproval(tx, { accountId: 'account-1' });

    expect(decision).toEqual<AutoApprovalDecision>({ eligible: true, vetoWindowMinutes: 60 });
  });
});

// Property tests (fast-check): the house style for invariant-level coverage —
// /feature requires at least one per declared invariant on billing/approval/
// escalation logic (feature.md step 5).
describe('invariants', () => {
  const arbitrarySnapshot: fc.Arbitrary<AutoApprovalConditionSnapshot> = fc.record({
    sendFlag: fc.boolean(),
    autoFlag: fc.boolean(),
    subscriptionStatus: fc.constantFrom(...Object.values(SubscriptionStatus)),
    // Real tier ids only (plan decision 15) — never an invented tier string.
    subscriptionTier: fc.constantFrom(SubscriptionTier.COPILOT, SubscriptionTier.AUTOPILOT),
    anySuspended: fc.boolean(),
    policy: fc.option(fc.record({ vetoWindowMinutes: fc.constantFrom(30, 60) }), { nil: null }),
  });

  it('invariants: the auto-approval gate never approves when any single condition fails', () => {
    fc.assert(
      fc.property(arbitrarySnapshot, (snapshot) => {
        const decision = decideAutoApproval(snapshot);

        // Decision order IS the reason precedence (plan Task 3): the FIRST
        // of these six that fails is the reason the gate must report, and
        // eligibility requires every one of them to hold at once.
        const failing: Record<AutoApprovalDeclineReason, boolean> = {
          send_flag_off: !snapshot.sendFlag,
          auto_flag_off: !snapshot.autoFlag,
          subscription: !subscriptionGrantsFullAccess(snapshot.subscriptionStatus),
          tier: !tierGrantsAutopilot(snapshot.subscriptionTier),
          policy_suspended: snapshot.anySuspended,
          no_policy_row: snapshot.policy === null,
        };
        const order: readonly AutoApprovalDeclineReason[] = [
          'send_flag_off',
          'auto_flag_off',
          'subscription',
          'tier',
          'policy_suspended',
          'no_policy_row',
        ];
        const firstFailing = order.find((reason) => failing[reason]) ?? null;

        if (firstFailing === null) {
          // Necessity: the gate approves ONLY when all six conditions hold.
          expect(decision).toEqual<AutoApprovalDecision>({
            eligible: true,
            vetoWindowMinutes: snapshot.policy!.vetoWindowMinutes,
          });
        } else {
          expect(decision).toEqual<AutoApprovalDecision>({
            eligible: false,
            reason: firstFailing,
          });
        }
      }),
    );

    // Positive-arm reachability (plan-review round 1, finding F6): the
    // arbitrary must actually be able to generate a fully-passing snapshot —
    // otherwise a gate that always returns `eligible: false` would satisfy
    // every assertion above vacuously.
    const approvedSomewhere = fc
      .sample(arbitrarySnapshot, 2000)
      .some((snapshot) => decideAutoApproval(snapshot).eligible);
    expect(approvedSomewhere).toBe(true);
  });
});
