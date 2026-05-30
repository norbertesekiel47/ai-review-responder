import type { Metadata } from 'next';

/**
 * Robots directive for pages that must never be crawled or cached — sensitive
 * auth/account surfaces (login, signup, password reset, MFA). Single owner so
 * the directive can't drift across the ~7 surfaces that need it.
 * Launch audit #19.
 */
export const noindexRobots: NonNullable<Metadata['robots']> = {
  index: false,
  follow: false,
};
