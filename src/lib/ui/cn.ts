type ClassValue = string | false | null | undefined;

/**
 * Join truthy class values into a single className string. Designed for the
 * `cn('base', cond && 'active', other ? 'x' : 'y')` conditional-composition
 * pattern; drops falsy entries so there are no empty/duplicate-space segments.
 */
export function cn(...values: ClassValue[]): string {
  return values.filter(Boolean).join(' ');
}
