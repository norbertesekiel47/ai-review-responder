'use client';

import { createContext, use, useMemo } from 'react';

/**
 * The signed-in owner's display identity, lifted to layout scope.
 *
 * The account menu renders in two places — the top of the desktop sidebar and,
 * below the shell breakpoint where the sidebar is hidden, the mobile top bar.
 * The sidebar already receives name and email as props; the top bar is
 * constructed per page and does not. Threading two more props through every
 * `TopBar` call site to reach one control would touch a dozen unrelated pages,
 * so the identity travels the same way location scope already does.
 *
 * Read-only by design: nothing in the Console renames the owner in place, and a
 * setter would invite a second source of truth beside the profile settings form.
 */
export interface OwnerIdentity {
  /** `users.name`, possibly empty — the menu falls back to the email local part. */
  name: string;
  email: string;
}

const OwnerIdentityContext = createContext<OwnerIdentity>({ name: '', email: '' });

export function OwnerIdentityProvider({
  name,
  email,
  children,
}: OwnerIdentity & { children: React.ReactNode }) {
  const value = useMemo(() => ({ name, email }), [name, email]);
  return (
    <OwnerIdentityContext.Provider value={value}>
      {children}
    </OwnerIdentityContext.Provider>
  );
}

export function useOwnerIdentity(): OwnerIdentity {
  return use(OwnerIdentityContext);
}

/** Two initials for the avatar: first + last word of the name, else the email's
 *  first character. Exported because the avatar is rendered by both the menu
 *  trigger and the menu header. */
export function deriveInitials({ name, email }: OwnerIdentity): string {
  const trimmed = name.trim();
  if (trimmed) {
    const parts = trimmed.split(/\s+/);
    return ((parts[0]?.[0] ?? '') + (parts[parts.length - 1]?.[0] ?? '')).toUpperCase();
  }
  return (email[0] ?? '?').toUpperCase();
}

/** The name the menu shows: the owner's name when set, else the email local part. */
export function deriveDisplayName({ name, email }: OwnerIdentity): string {
  return name.trim() || (email.split('@')[0] ?? '');
}
