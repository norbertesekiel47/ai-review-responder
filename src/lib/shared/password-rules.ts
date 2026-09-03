/**
 * The password rules the server ENFORCES — the single owner of that fact.
 *
 * #1090: before this module existed the rules lived in two places that drifted.
 * `passwordRequirements` (`src/components/auth/shared/strength.ts`) DISPLAYED
 * three requirements including "A number"; the submit guard checked length
 * only; and `passwordSchema` was `z.string().min(8).max(128)`. An owner
 * following an invite link saw the number requirement marked unmet, submitted
 * anyway, and the server accepted it.
 *
 * Everything that validates or displays a password rule now derives from this
 * list, so the three cannot disagree again.
 *
 * WHAT BELONGS HERE: a rule that REJECTS a password.
 * WHAT DOES NOT: guidance. Mixed case, symbols and extra length are scored by
 * `strengthOf` as advice and must stay there — promoting one to a rule
 * silently tightens the policy for self-serve signup, not only for the invite
 * and reset pages, and locks out passwords that are legal today.
 *
 * Dependency-free ON PURPOSE. `schemas.ts` (which pulls in `url-parser` and
 * `tier-config`) and the auth-island bundle both import this, and the signup
 * island must not gain those transitive dependencies to learn a regex.
 */

/** Minimum password length — the length rule's threshold, and its own export
 *  because placeholder and hint copy interpolate the number directly. */
export const MIN_PASSWORD_LENGTH = 8;

/** Longest password accepted. Bcrypt-adjacent providers truncate far below
 *  this; the ceiling is a request-size guard, not a security control. */
export const MAX_PASSWORD_LENGTH = 128;

export interface PasswordRule {
  /** Shown in the requirements list beneath the field, before submit. */
  readonly label: string;
  /** Shown as the form-level error when submit is blocked on this rule. */
  readonly failureMessage: string;
  /**
   * A password that fails THIS rule and passes every other one. The eval suite
   * asserts the schema rejects each, which is what stops a rule being added to
   * the displayed list without being enforced — the exact #1090 defect.
   */
  readonly counterexample: string;
  readonly test: (password: string) => boolean;
}

/**
 * Ordered as the user sees them, and as the submit guard reports them: the
 * FIRST unmet rule is the one whose `failureMessage` is shown, so length comes
 * before the digit rule and a short digitless password is reported as short.
 */
export const PASSWORD_RULES: readonly PasswordRule[] = [
  {
    label: `At least ${MIN_PASSWORD_LENGTH} characters`,
    failureMessage: `Password must be at least ${MIN_PASSWORD_LENGTH} characters`,
    counterexample: 'abc1',
    test: (password) => password.length >= MIN_PASSWORD_LENGTH,
  },
  {
    label: 'A number',
    failureMessage: 'Password must contain at least one number',
    counterexample: 'abcdefghij',
    test: (password) => /\d/.test(password),
  },
];

/** The first rule the password fails, or `null` when it satisfies all of them.
 *  One helper so every client guard reports rules in the same order as the
 *  list the user is looking at. */
export function firstUnmetPasswordRule(password: string): PasswordRule | null {
  return PASSWORD_RULES.find((rule) => !rule.test(password)) ?? null;
}
