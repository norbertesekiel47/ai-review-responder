type ClassValue = string | number | false | null | undefined;

/** Join truthy class values into a single className string. */
export function cn(...values: ClassValue[]): string {
  return values.filter(Boolean).join(' ');
}
