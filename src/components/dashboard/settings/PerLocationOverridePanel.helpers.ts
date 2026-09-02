// src/components/dashboard/settings/PerLocationOverridePanel.helpers.ts
//
// Pure, React-free pieces of the per-location override panel: channel labels
// and icons, the removal consequence sentence, the two groupings the panel
// renders (active locations vs. archived / orphaned), and the shared
// add/remove call. Kept out of the component so each is a testable function
// and the panel reads as composition.

import type { PerLocationOverride } from '@/lib/channels/overrides-view';

const CHANNEL_LABELS: Record<string, string> = {
  email: 'Email',
  telegram: 'Telegram',
  whatsapp: 'WhatsApp',
};

const CHANNEL_ICONS: Record<string, string> = {
  email: '✉️',
  telegram: '💬',
  whatsapp: '🟢',
};

export function channelLabel(channel: string): string {
  return CHANNEL_LABELS[channel] ?? channel;
}

export function channelIcon(channel: string): string {
  return CHANNEL_ICONS[channel] ?? '📡';
}

/** The location name, suffixed " (archived)" when the DTO says so (derived at render, never stored). */
export function formatOverrideLocationLabel(override: PerLocationOverride): string {
  return override.archived ? `${override.locationName} (archived)` : override.locationName;
}

/** The sentence the owner confirms before an override is removed. */
export function removeOverrideConsequence(override: PerLocationOverride): string {
  return `${override.locationName} will go back to your account-wide ${channelLabel(override.channel)} setting.`;
}

/** Every override, indexed by location id in first-seen order. */
export function groupOverridesByLocation(
  overrides: readonly PerLocationOverride[],
): Map<string, PerLocationOverride[]> {
  const byLocation = new Map<string, PerLocationOverride[]>();
  for (const o of overrides) {
    const list = byLocation.get(o.locationId) ?? [];
    list.push(o);
    byLocation.set(o.locationId, list);
  }
  return byLocation;
}

/**
 * The overrides that render in the inactive section, indexed by location id.
 *
 * Classification is driven by the DTO `archived` flag — NOT membership in the
 * active options — so an override on a still-active sole location renders in
 * the active section. Non-archived overrides whose location is missing from the
 * active ids (defensive) also land here so they never become invisible.
 */
export function groupInactiveOverrides(
  overrides: readonly PerLocationOverride[],
  activeLocationIds: ReadonlySet<string>,
): Map<string, PerLocationOverride[]> {
  return groupOverridesByLocation(
    overrides.filter((o) => o.archived || !activeLocationIds.has(o.locationId)),
  );
}

/**
 * Shared add/remove call to the override endpoint — POST creates, DELETE
 * removes. Throws with the server's error string (or a status fallback) so
 * each caller owns only its own UI failure handling.
 */
export async function mutateOverride(
  method: 'POST' | 'DELETE',
  failVerb: 'Add' | 'Remove',
  locationId: string,
  channel: string,
): Promise<void> {
  const res = await fetch('/api/settings/channels/override', {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ locationId, channel }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `${failVerb} failed (${res.status})`);
  }
}
